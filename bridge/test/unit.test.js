import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { makeAuthenticator } from '../src/auth.js';
import { checkSchema } from '../src/chatter.js';
import { RateLimiter, checkWrite } from '../src/policy.js';
import { Store } from '../src/store.js';
import { mentionsOf, chatterTime } from '../src/util.js';

const member = (o = {}) => ({ handle: 'thom', role: 'member', can_address_agents: true, ...o });
const admin = member({ handle: 'flan', role: 'admin' });
const ctx = { agentNames: new Set(['codex', 'pi']), repoAgents: [], memberHandles: new Set(['flan', 'thom', 'grace']) };
const refused = (fn, code) => assert.throws(fn, (e) => e.code === code, `expected ${code}`);

test('mentionsOf follows Chatter grammar and finds @everyone case-insensitively', () => {
  assert.deepEqual(mentionsOf('hi @codex and @Thom, @everyone'), { handles: ['codex', 'thom'], everyone: true });
  assert.deepEqual(mentionsOf('mail me at a@b.com'), { handles: ['b'], everyone: false }); // same quirk as Chatter
  assert.deepEqual(mentionsOf('@everyone-ish'), { handles: ['everyone-ish'], everyone: false });
});

// T13b. Chatter's postToChat reads mentions case-sensitively, so a capital letter ends its token: "@codX" is
// "@cod" to Chatter, which then reaches the agent "codex-worker" by prefix.
test('mentionsOf also reads each mention as Chatter does, where a capital letter ends the token', () => {
  assert.deepEqual(mentionsOf('@everyoneX'), { handles: ['everyonex'], everyone: true });
  assert.deepEqual(mentionsOf('@codX'), { handles: ['cod', 'codx'], everyone: false });
  assert.deepEqual(mentionsOf('hi @codex-workerZ'), { handles: ['codex-worker', 'codex-workerz'], everyone: false });
  assert.deepEqual(mentionsOf('@gracE and @codX'), { handles: ['grac', 'cod', 'grace', 'codx'], everyone: false });
});

test('mentionsOf keeps reading each mention whole and case-insensitively', () => {
  for (const body of ['@Everyone', '@EVERYONE', 'a@everyone']) {
    assert.deepEqual(mentionsOf(body), { handles: [], everyone: true }, body);
  }
  // Chatter reads nothing after "@C"; the whole-token reading still sees the agent's name.
  assert.deepEqual(mentionsOf('hey @Codex-worker'), { handles: ['codex-worker'], everyone: false });
  assert.deepEqual(mentionsOf('plain @codex @kai'), { handles: ['codex', 'kai'], everyone: false });
  assert.deepEqual(mentionsOf('nothing to see here'), { handles: [], everyone: false });
  // Neither reading takes a letter outside ASCII, and both run to the end of the body.
  assert.deepEqual(mentionsOf('hey @codéx'), { handles: ['cod'], everyone: false });
  assert.deepEqual(mentionsOf('ends with @cod'), { handles: ['cod'], everyone: false });
});

test('policy: a mention is checked as Chatter reads it as well as whole', () => {
  const p = { agentNames: new Set(['codex-worker']), repoAgents: ['codex-worker'], memberHandles: new Set(['flan', 'thom', 'kai']) };
  const off = member({ can_address_agents: false });
  for (const body of ['hey @codX', 'hey @codex-workerZ']) {
    refused(() => checkWrite({ member: off, to: '#chat', body, ...p }), 'agents_not_allowed');
  }
  refused(() => checkWrite({ member: member(), to: '#chat', body: '@everyoneX hi', ...p }), 'everyone_admin_only');
  assert.equal(checkWrite({ member: admin, to: '#chat', body: '@everyoneX hi', ...p }).everyone, true);
});

test('chatterTime turns Chatter UTC strings into ISO', () => {
  assert.equal(chatterTime('2026-10-09 06:00:19'), '2026-10-09T06:00:19Z');
});

test('policy: @everyone is admin only, in any case', () => {
  for (const body of ['@everyone stand up', 'ping @Everyone', 'x @EVERYONE y']) {
    refused(() => checkWrite({ member: member(), to: '#chat', body, ...ctx }), 'everyone_admin_only');
  }
  assert.equal(checkWrite({ member: admin, to: '#chat', body: '@everyone hi', ...ctx }).everyone, true);
});

test('policy: addressing agents follows the member flag; admin always may', () => {
  const off = member({ can_address_agents: false });
  refused(() => checkWrite({ member: off, to: '#chat', body: 'hey @codex', ...ctx }), 'agents_not_allowed');
  refused(() => checkWrite({ member: off, to: 'codex', body: 'hey', ...ctx }), 'agents_not_allowed');
  // @grace is a member, not an agent: the restricted member may still mention her.
  assert.equal(checkWrite({ member: off, to: '#chat', body: 'hey @grace', ...ctx }).mode, 'post');
  assert.deepEqual(checkWrite({ member: member(), to: '#chat', body: 'hey @codex @grace', ...ctx }).memberTargets, ['grace']);
  assert.equal(checkWrite({ member: { ...admin, can_address_agents: false }, to: 'pi', body: 'x', ...ctx }).toAgent, true);
  // a member with the flag off may still talk to other members
  assert.equal(checkWrite({ member: off, to: 'grace', body: 'hello', ...ctx }).toMember, true);
});

// T13 item 3. Chatter resolves a name it does not know exactly to the one roster name it is the start of (case-insensitive).
test('policy: a name that is the start of a live agent name of the repo counts as that agent, fail closed', () => {
  const p = {
    agentNames: new Set(['codex-worker', 'grace-worker', 'old']),
    memberHandles: new Set(['flan', 'thom', 'grace', 'zed', 'zedd']),
    repoAgents: ['codex-worker', 'grace-worker'],
  };
  const off = member({ can_address_agents: false });
  for (const body of ['@codex', '@CODEX-w', 'ping @grace', '@codex-worker']) {
    refused(() => checkWrite({ member: off, to: '#chat', body, ...p }), 'agents_not_allowed');
  }
  // "old" is an agent name, but not of a live agent of this repo: only an exact match counts for it.
  assert.equal(checkWrite({ member: off, to: '#chat', body: '@zed @old-ish', ...p }).mode, 'post');
  refused(() => checkWrite({ member: off, to: '#chat', body: '@old', ...p }), 'agents_not_allowed');
  refused(() => checkWrite({ member: off, to: '#chat', body: 'hi @zed @codex', ...p }), 'agents_not_allowed');
  assert.equal(checkWrite({ member: member(), to: '#chat', body: 'hi @codex @zed', ...p }).mode, 'post');
  for (const who of [member(), admin]) refused(() => checkWrite({ member: who, to: 'grace', body: 'x', ...p }), 'ambiguous_recipient');
  refused(() => checkWrite({ member: member({ handle: 'zedd' }), to: 'zed', body: 'x', ...p }), 'ambiguous_recipient');
  assert.equal(checkWrite({ member: member({ handle: 'zed' }), to: 'zedd', body: 'x', ...p }).to, 'zedd');
  assert.equal(checkWrite({ member: member(), to: 'zed', body: 'x', ...p }).toMember, true);
  assert.equal(checkWrite({ member: member(), to: 'codex-worker', body: 'x', ...p }).toAgent, true);
});

// T13c item 5. Chatter resolves a DM against the roster of the repo it is sent in: a name that is not a live
// agent's exactly goes to the one live name it is the start of.
test('policy: a DM to an agent name counts as that agent only if it is a live name of the repo', () => {
  const p = { agentNames: new Set(['codex-worker', 'cod', 'zz-old', 'ren']), repoAgents: ['codex-worker'], memberHandles: new Set(['flan', 'thom']) };
  // Ambiguity is decided before permission, and for an admin too.
  for (const who of [member(), admin, member({ can_address_agents: false })]) {
    refused(() => checkWrite({ member: who, to: 'cod', body: 'x', ...p }), 'ambiguous_recipient');
  }
  assert.equal(checkWrite({ member: member(), to: 'codex-worker', body: 'x', ...p }).toAgent, true);
  assert.equal(checkWrite({ member: member(), to: 'zz-old', body: 'x', ...p }).toAgent, true, 'no live name begins with it: as before');
  refused(() => checkWrite({ member: member({ can_address_agents: false }), to: 'zz-old', body: 'x', ...p }), 'agents_not_allowed');
  // An exact name in one repo is only the start of a name in another.
  assert.equal(checkWrite({ member: member(), to: 'ren', body: 'x', ...p, repoAgents: ['ren'] }).toAgent, true);
  refused(() => checkWrite({ member: member(), to: 'ren', body: 'x', ...p, repoAgents: ['renata'] }), 'ambiguous_recipient');
  // Case does not matter to Chatter once it compares by prefix.
  assert.equal(checkWrite({ member: member(), to: 'ren', body: 'x', ...p, repoAgents: ['Ren'] }).toAgent, true);
  refused(() => checkWrite({ member: member(), to: 'cod', body: 'x', ...p, repoAgents: ['CODEX'] }), 'ambiguous_recipient');
});

// T13c item 7. The predicate is that the agent's name begins with the handle, so the message says it that way.
test('policy: a prefix refusal says the handle is the start of the name', () => {
  const p = { agentNames: new Set(['codex-worker', 'grace-worker']), repoAgents: ['codex-worker', 'grace-worker'], memberHandles: new Set(['thom', 'grace', 'zed', 'zedd']) };
  const message = (fn) => {
    try { fn(); } catch (e) { return e.message; }
    return assert.fail('expected a refusal');
  };
  assert.match(message(() => checkWrite({ member: member({ can_address_agents: false }), to: '#chat', body: '@codex', ...p })),
    /^@codex is the start of the name of the Herdr agent codex-worker, /);
  assert.match(message(() => checkWrite({ member: member(), to: 'grace', body: 'x', ...p })),
    /^"grace" is the start of the name of the Herdr agent grace-worker, /);
  assert.match(message(() => checkWrite({ member: member({ handle: 'zedd' }), to: 'zed', body: 'x', ...p })),
    /^"zed" is the start of your own handle, /);
});

test('policy: DM recipients and body limits', () => {
  refused(() => checkWrite({ member: member(), to: 'nobody', body: 'x', ...ctx }), 'unknown_recipient');
  refused(() => checkWrite({ member: member(), to: 'thom', body: 'x', ...ctx }), 'self_dm');
  refused(() => checkWrite({ member: member(), to: '#chat', body: '   ', ...ctx }), 'empty_body');
  refused(() => checkWrite({ member: member(), to: '#chat', body: 'a\0b', ...ctx }), 'invalid_body');
  refused(() => checkWrite({ member: member(), to: '#chat', body: 'x'.repeat(8001), ...ctx }), 'body_too_long');
  refused(() => checkWrite({ member: member(), to: '#chat', body: 42, ...ctx }), 'bad_request');
  assert.equal(checkWrite({ member: member(), to: '#chat', body: 'x'.repeat(8000), ...ctx }).mode, 'post');
  assert.equal(checkWrite({ member: member(), to: '#chat', body: '  padded  ', ...ctx }).body, 'padded');
});

test('rate limiter refills over time', () => {
  let t = 0;
  const rl = new RateLimiter(2, () => t);
  rl.take('a'); rl.take('a');
  refused(() => rl.take('a'), 'rate_limited');
  rl.take('b'); // separate bucket
  t += 30_000; // half a minute buys one token at 2/min
  rl.take('a');
  refused(() => rl.take('a'), 'rate_limited');
});

test('store: members, tokens, revocation, last-admin protection', () => {
  const s = new Store(':memory:');
  s.addMember({ handle: 'flan', kind: 'human', role: 'admin', tailscale_login: 'flan@example.com' });
  s.addMember({ handle: 'thom', kind: 'computational' });
  refused(() => s.addMember({ handle: 'thom', kind: 'computational' }), 'handle_taken');
  refused(() => s.addMember({ handle: 'Bad Name', kind: 'human' }), 'bad_handle');
  refused(() => s.addMember({ handle: 'everyone', kind: 'human' }), 'bad_handle');
  refused(() => s.addMember({ handle: 'x', kind: 'robot' }), 'bad_kind');
  refused(() => s.addMember({ handle: 'y', kind: 'human', tailscale_login: 'flan@example.com' }), 'login_taken');

  const t1 = s.issueToken('thom');
  // assert.ok, not assert.match: a failing match would print the token.
  assert.ok(/^cb_/.test(t1), 'a token starts with cb_');
  assert.equal(s.memberByToken(t1).handle, 'thom');
  const t2 = s.issueToken('thom'); // rotation kills the old token
  assert.equal(s.memberByToken(t1), null);
  assert.equal(s.memberByToken(t2).handle, 'thom');
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM tokens WHERE token_hash = ?').get(t2).n, 0, 'plaintext token is never stored');

  s.revokeMember('thom');
  assert.equal(s.memberByToken(t2), null);
  refused(() => s.issueToken('thom'), 'no_such_member');
  refused(() => s.revokeMember('flan'), 'last_admin');
  refused(() => s.updateMember('flan', { role: 'member' }), 'last_admin');
  assert.equal(s.memberByLogin('flan@example.com').handle, 'flan');
});

test('store: read pointers only move forward; audit is newest first', () => {
  const s = new Store(':memory:');
  assert.equal(s.setRead('thom', 'repo-1', 10), 10);
  assert.equal(s.setRead('thom', 'repo-1', 4), 10);
  assert.equal(s.setRead('thom', 'repo-1', 12), 12);
  assert.equal(s.getRead('thom', 'repo-2'), 0);
  s.audit({ actor: 'a', action: 'x' });
  s.audit({ actor: 'a', action: 'y', detail: { n: 1 } });
  const log = s.listAudit();
  assert.deepEqual(log.map((e) => e.action), ['y', 'x']);
  assert.deepEqual(log[0].detail, { n: 1 });
});

test('authentication: bearer, and Tailscale headers only when trusted and verified', async () => {
  const s = new Store(':memory:');
  s.addMember({ handle: 'flan', kind: 'human', role: 'admin', tailscale_login: 'flan@example.com' });
  s.addMember({ handle: 'grace', kind: 'computational' });
  const token = s.issueToken('grace');
  const req = (headers, remote = '127.0.0.1') => ({ headers, socket: { remoteAddress: remote } });
  const whois = async (ip) => (ip === '100.64.0.7' ? 'flan@example.com' : 'someone@else.com');

  const trusting = makeAuthenticator({ store: s, trustTailscale: true, whois });
  assert.equal((await trusting(req({ authorization: `Bearer ${token}` }))).handle, 'grace');
  await assert.rejects(trusting(req({ authorization: 'Bearer cb_nope' })), (e) => e.code === 'bad_token');

  const ts = { 'tailscale-user-login': 'flan@example.com', 'x-forwarded-for': '100.64.0.7' };
  assert.equal((await trusting(req(ts))).handle, 'flan');
  // header does not match what whois says about the address
  await assert.rejects(trusting(req({ ...ts, 'x-forwarded-for': '100.64.0.8' })), (e) => e.code === 'unauthenticated');
  // header without a forwarded address
  await assert.rejects(trusting(req({ 'tailscale-user-login': 'flan@example.com' })), (e) => e.code === 'unauthenticated');
  // header from a non-loopback peer is a forgery
  await assert.rejects(trusting(req(ts, '203.0.113.9')), (e) => e.code === 'unauthenticated');
  // verified login that is not a member
  const stranger = makeAuthenticator({ store: s, trustTailscale: true, whois: async () => 'stranger@example.com' });
  await assert.rejects(stranger(req({ ...ts, 'tailscale-user-login': 'stranger@example.com' })), (e) => e.code === 'not_registered');
  // trust switched off
  const off = makeAuthenticator({ store: s, trustTailscale: false, whois });
  await assert.rejects(off(req(ts)), (e) => e.code === 'unauthenticated');
});

test('schema check names drifted columns', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE messages (id INTEGER, from_agent TEXT, to_agent TEXT, text TEXT, kind TEXT, ref_id TEXT, created_at TEXT, delivered_at TEXT, read_at TEXT);
    CREATE TABLE agents (name TEXT, pane_id TEXT, repo_root TEXT, branch TEXT, kind TEXT, role TEXT, registered_at TEXT, last_seen_at TEXT, departed_at TEXT);
    CREATE TABLE notes (id INTEGER, author TEXT, type TEXT, text TEXT, task_id TEXT, status TEXT, created_at TEXT);
    CREATE TABLE tasks (id TEXT, title TEXT, status TEXT, assignee TEXT, created_by TEXT, created_at TEXT, updated_at TEXT);`);
  const problems = checkSchema(db);
  assert.ok(problems.some((p) => p.includes('messages lacks body')));
  assert.ok(problems.some((p) => p.includes('table handoffs missing')));
});

test('the skill ships the same client script as clients/', async () => {
  const fs = await import('node:fs');
  const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
  assert.equal(read('../../skills/chatter-gui/scripts/chatter-member.mjs'), read('../../clients/chatter-member.mjs'));
});
