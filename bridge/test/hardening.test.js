// T13: bridge hardening from the G2 review, against the real Chatter CLI (no Herdr running).
// Every test builds its own universe: the shared one in integration.test.js posts as members against
// the rate limit, and agents seeded here would change how its names resolve.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { Store } from '../src/store.js';
import { haveChatter, makeEnv, openSse } from './helpers.js';

const SKIP = !haveChatter && 'set CHATTER_JS to a built Chatter checkout';
const BYE = { revoked: 'revoked', tokenRotated: 'token_rotated' };
const TAILNET_IP = '100.64.0.7';
const MEMBER_AGENTS_ERROR = 'Chatter could not list agents';

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

/** Holds the repo's write lock; `queued` settles once a send is waiting behind it. */
function holdWriteLock(x) {
  const gate = deferred();
  const queued = deferred();
  const withLock = x.host.withLock.bind(x.host);
  withLock(x.key, () => gate.promise);
  x.host.withLock = (key, fn) => { queued.resolve(); return withLock(key, fn); };
  return { queued: queued.promise, release: () => { x.host.withLock = withLock; gate.resolve(); } };
}

const bearer = (x, who) => ({ Authorization: `Bearer ${x.tokens[who]}` });
const streamUrl = (x) => `${x.base}/v1/repos/${x.key}/stream`;
const isMessage = (id) => (ev) => ev.event === 'message' && ev.data.id === id;
const isBye = (ev) => ev.event === 'bye';
const isHello = (ev) => ev.event === 'hello';
const audits = async (x) => (await x.api('flan', 'GET', '/v1/audit?limit=500')).body.entries;

/** What `chatter-bridge token rotate` does: its own Store on the bridge's database file, then the audit entry. */
function rotateLikeTheCli(x, handle) {
  const cli = new Store(path.join(x.root, 'bridge.db'));
  try {
    cli.issueToken(handle);
    cli.audit({ actor: 'cli', action: 'token_rotate', target: handle });
  } finally { cli.close(); }
}

describe('item 1: a queued send is decided again when its turn comes', { skip: SKIP }, () => {
  test('a send waiting at the lock is refused with 401 once its sender is revoked, and nothing is written', async () => {
    const x = await makeEnv();
    try {
      x.addMember('thom');
      const before = x.count();
      const lock = holdWriteLock(x);
      const sending = x.post('thom', '#chat', 'sent before the revocation, run after it');
      await lock.queued;
      assert.equal((await x.api('flan', 'DELETE', '/v1/members/thom')).status, 200);
      lock.release();
      const r = await sending;
      assert.equal(r.status, 401);
      assert.equal(r.body.error.code, 'bad_token');
      assert.equal(x.count(), before, 'nothing was written');
    } finally { await x.stop(); }
  });

  test('a send that mentions an agent is refused when can_address_agents is removed while it waits', async () => {
    const x = await makeEnv();
    try {
      x.addMember('thom');
      x.seedAgent('pi');
      const before = x.count();
      const lock = holdWriteLock(x);
      const sending = x.post('thom', '#chat', 'hey @pi, queued');
      await lock.queued;
      assert.equal((await x.api('flan', 'PATCH', '/v1/members/thom', { can_address_agents: false })).status, 200);
      lock.release();
      const r = await sending;
      assert.equal(r.status, 403);
      assert.equal(r.body.error.code, 'agents_not_allowed');
      assert.equal(x.count(), before, 'nothing was written');
      assert.ok(!(await audits(x)).some((a) => a.action === 'push_agent' && a.actor === 'thom'), 'no push was audited');
    } finally { await x.stop(); }
  });

  test('an @everyone is refused when its admin sender is demoted while it waits', async () => {
    const x = await makeEnv();
    try {
      x.addMember('ada', { role: 'admin' });
      const before = x.count();
      const lock = holdWriteLock(x);
      const sending = x.post('ada', '#chat', '@everyone queued');
      await lock.queued;
      assert.equal((await x.api('flan', 'PATCH', '/v1/members/ada', { role: 'member' })).status, 200);
      lock.release();
      const r = await sending;
      assert.equal(r.status, 403);
      assert.equal(r.body.error.code, 'everyone_admin_only');
      assert.equal(x.count(), before, 'nothing was written');
    } finally { await x.stop(); }
  });
});

describe('item 2: a stream refreshes its member before it delivers', { skip: SKIP }, () => {
  test('a demoted admin\'s open stream does not carry a DM between two other members', async () => {
    // 1 s ticks: the every-fourth-tick refresh cannot run in the time this test waits.
    const x = await makeEnv({ pollMs: 1000 });
    try {
      x.addMember('ada', { role: 'admin' });
      x.addMember('thom');
      x.addMember('grace');
      const s = await openSse(streamUrl(x), bearer(x, 'ada'));
      await s.waitFor(isHello);
      assert.equal((await x.api('flan', 'PATCH', '/v1/members/ada', { role: 'member' })).status, 200);
      const dm = await x.post('thom', 'grace', 'private, sent after the demotion');
      assert.equal(dm.status, 201);
      await s.quiet(1500);
      assert.ok(!s.events.some(isMessage(dm.body.id)), 'the demoted member does not receive the DM');
      // The stream is alive and still carries what a member may see.
      const pub = await x.post('thom', '#chat', 'public, sent after the demotion');
      await s.waitFor(isMessage(pub.body.id));
      assert.ok(!s.events.some(isBye));
      s.close();
    } finally { await x.stop(); }
  });
});

describe('item 3: addressing by prefix, fail closed', { skip: SKIP }, () => {
  let x;
  before(async () => {
    x = await makeEnv();
    x.addMember('thom', { can_address_agents: false });
    for (const h of ['kai', 'grace', 'zed', 'zedd', 'kieran']) x.addMember(h);
    for (const a of ['codex-worker', 'grace-worker', 'kieran-old']) x.seedAgent(a);
    const db = new DatabaseSync(path.join(x.repoInfo.dir, 'chatter.db'));
    db.prepare('UPDATE agents SET departed_at = ? WHERE name = ?').run('2026-10-09 01:00:00', 'kieran-old');
    db.close();
  });
  after(async () => { await x.stop(); });

  test('a restricted member is refused an agent by exact name and by any prefix of a live agent name', async () => {
    const before = x.count();
    for (const body of ['hey @codex-worker', 'hey @codex please', 'hey @CODEX please', 'ping @grace']) {
      const r = await x.post('thom', '#chat', body);
      assert.equal(r.status, 403, body);
      assert.equal(r.body.error.code, 'agents_not_allowed', body);
    }
    assert.equal(x.count(), before, 'nothing was written');
  });

  test('a permitted member\'s prefix mention is allowed, pushes to the agent and is audited', async () => {
    const r = await x.post('kai', '#chat', 'hey @codex please');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.pushed, ['codex-worker (queued)']);
    assert.ok((await audits(x)).some((a) => a.action === 'push_agent' && a.actor === 'kai' && a.target === 'codex-worker' && a.message_id === r.body.id));
  });

  test('a DM to a member whose handle begins an agent name is refused with 409, for an admin too', async () => {
    const before = x.count();
    for (const who of ['kai', 'flan']) {
      const r = await x.post(who, 'grace', 'for grace, not grace-worker');
      assert.equal(r.status, 409, who);
      assert.equal(r.body.error.code, 'ambiguous_recipient', who);
      assert.match(r.body.error.message, /grace-worker/, who);
    }
    assert.equal(x.count(), before, 'nothing was written');
  });

  test('a DM to a member no agent name begins with is written to that member', async () => {
    const r = await x.post('kai', 'zed', 'for zed');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const m = (await x.messages('zed', '?limit=500')).body.messages.find((row) => row.id === r.body.id);
    assert.equal(m.to, 'zed');
  });

  test('a DM to an exact agent name is unchanged', async () => {
    const r = await x.post('kai', 'codex-worker', 'for the agent');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.delivery, 'queued');
    assert.equal((await x.post('thom', 'codex-worker', 'not allowed')).body.error.code, 'agents_not_allowed');
  });

  test('a departed agent\'s name does not count', async () => {
    const dm = await x.post('thom', 'kieran', 'for kieran');
    assert.equal(dm.status, 201, JSON.stringify(dm.body));
    const m = (await x.messages('kieran', '?limit=500')).body.messages.find((row) => row.id === dm.body.id);
    assert.equal(m.to, 'kieran');
    assert.equal((await x.post('thom', '#chat', 'hello @kieran')).status, 201);
  });

  test('a DM to a proper prefix of the sender\'s own handle is refused with 409', async () => {
    const before = x.count();
    const r = await x.post('zedd', 'zed', 'for zed, from zedd');
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'ambiguous_recipient');
    assert.equal(x.count(), before, 'nothing was written');
  });
});

describe('item 4: agents_error carries no host path for a non-admin', { skip: SKIP }, () => {
  const asRoot = process.getuid?.() === 0;
  test('an unusable member config root: the member gets a fixed message, the admin the detail with the path', { skip: asRoot && 'root ignores file modes' }, async () => {
    const x = await makeEnv();
    const configRoot = path.join(x.root, 'members');
    try {
      x.addMember('grace');
      fs.chmodSync(configRoot, 0o000);
      const member = await x.api('grace', 'GET', `/v1/repos/${x.key}/board`);
      assert.equal(member.status, 200);
      assert.deepEqual(member.body.agents, []);
      assert.equal(member.body.agents_error, MEMBER_AGENTS_ERROR);
      assert.ok(!JSON.stringify(member.body).includes(x.root), 'no host path anywhere in the response');
      const admin = await x.api('flan', 'GET', `/v1/repos/${x.key}/board`);
      assert.equal(admin.status, 200);
      assert.ok(admin.body.agents_error.includes(configRoot), 'the admin keeps the detail');
    } finally {
      fs.chmodSync(configRoot, 0o755);
      await x.stop();
    }
  });
});

describe('item 5: PATCH /v1/members/{h} validates as adding does', { skip: SKIP }, () => {
  let x;
  before(async () => {
    x = await makeEnv();
    x.addMember('grace', { tailscale_login: 'grace@example.com' });
    x.addMember('thom', { display_name: 'Thom' });
  });
  after(async () => { await x.stop(); });

  const patch = (body) => x.api('flan', 'PATCH', '/v1/members/thom', body);
  const snapshot = () => ({ member: x.store.getMember('thom'), lastAudit: x.store.listAudit({ limit: 1 })[0]?.id });
  const refusedUnchanged = async (body, status, code) => {
    const was = snapshot();
    const r = await patch(body);
    assert.equal(r.status, status, JSON.stringify(r.body));
    assert.equal(r.body.error.code, code);
    assert.deepEqual(snapshot(), was, 'neither the member nor the audit log changed');
  };

  test('a bad kind answers 400 bad_kind', async () => { await refusedUnchanged({ kind: 'robot' }, 400, 'bad_kind'); });
  test('a bad role answers 400 bad_role', async () => { await refusedUnchanged({ role: 'owner' }, 400, 'bad_role'); });
  test('a login another active member holds answers 409 login_taken', async () => {
    await refusedUnchanged({ tailscale_login: 'grace@example.com' }, 409, 'login_taken');
  });
  test('an empty patch answers 400 and logs nothing', async () => {
    await refusedUnchanged({}, 400, 'bad_request');
    await refusedUnchanged({ status: 'revoked', handle: 'x' }, 400, 'bad_request');
  });
  test('a display name that is empty after trimming answers 400', async () => {
    await refusedUnchanged({ display_name: '   ' }, 400, 'bad_request');
    await refusedUnchanged({ display_name: 42 }, 400, 'bad_request');
  });
  test('a body that is not a JSON object answers 400', async () => {
    // A JSON string: `in` throws on it, so without a check this is a 500.
    await refusedUnchanged('display_name', 400, 'bad_request');
  });
  test('a login of "" is stored as null, a display name trimmed, and the audit records what was stored', async () => {
    assert.equal((await patch({ tailscale_login: 'thom@example.com' })).status, 200);
    const r = await patch({ tailscale_login: '  ', display_name: '  Thom R.  ' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.member.tailscale_login, null);
    assert.equal(r.body.member.display_name, 'Thom R.');
    assert.equal(x.store.getMember('thom').tailscale_login, null);
    assert.deepEqual(x.store.listAudit({ limit: 1 })[0].detail, { tailscale_login: null, display_name: 'Thom R.' });
    assert.equal((await patch({ tailscale_login: '' })).body.member.tailscale_login, null);
  });
  test('a member\'s own login is not refused as taken', async () => {
    const r = await x.api('flan', 'PATCH', '/v1/members/grace', { tailscale_login: 'grace@example.com', display_name: 'Grace' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.member.tailscale_login, 'grace@example.com');
  });
});

describe('item 6: a registry change and its audit entry are one transaction', { skip: SKIP }, () => {
  let x;
  // One member per route, so a route that does commit early cannot break the next test's setup.
  before(async () => {
    x = await makeEnv();
    for (const h of ['grace', 'kai', 'ivo']) x.addMember(h);
  });
  after(async () => { await x.stop(); });

  // A real SQLite error from the audit insert, on the bridge's own connection.
  const breakAudit = () => x.store.db.exec("CREATE TRIGGER t13_audit_fails BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'audit insert failed'); END");
  const mendAudit = () => x.store.db.exec('DROP TRIGGER IF EXISTS t13_audit_fails');
  const tokenRows = (h) => x.store.db.prepare('SELECT COUNT(*) AS n FROM tokens WHERE handle = ?').get(h).n;

  test('rotate: a failed audit insert answers 500, the old token still works and its stream stays open', async () => {
    const s = await openSse(streamUrl(x), bearer(x, 'grace'));
    await s.waitFor(isHello);
    const rows = tokenRows('grace');
    breakAudit();
    try {
      const r = await x.api('flan', 'POST', '/v1/members/grace/token');
      assert.equal(r.status, 500);
      assert.equal(r.body.error.code, 'internal');
    } finally { mendAudit(); }
    assert.equal((await x.api('grace', 'GET', '/v1/me')).status, 200, 'the old token still works');
    assert.equal(tokenRows('grace'), rows, 'no token was issued');
    await s.quiet(300);
    assert.ok(!s.events.some(isBye), 'the old token\'s stream was not closed');
    s.close();
  });

  test('add: a failed audit insert answers 500 and the member does not exist; the same add then succeeds', async () => {
    breakAudit();
    try {
      const r = await x.api('flan', 'POST', '/v1/members', { handle: 'ezra', kind: 'computational' });
      assert.equal(r.status, 500);
    } finally { mendAudit(); }
    assert.equal(x.store.getMember('ezra'), null);
    assert.equal(tokenRows('ezra'), 0);
    const again = await x.api('flan', 'POST', '/v1/members', { handle: 'ezra', kind: 'computational' });
    assert.equal(again.status, 201, 'not 409 handle_taken');
  });

  test('update: a failed audit insert answers 500 and the member is unchanged', async () => {
    const was = x.store.getMember('kai');
    breakAudit();
    try {
      assert.equal((await x.api('flan', 'PATCH', '/v1/members/kai', { display_name: 'Kai H.', can_address_agents: false })).status, 500);
    } finally { mendAudit(); }
    assert.deepEqual(x.store.getMember('kai'), was);
  });

  test('revoke: a failed audit insert answers 500, the member stays active, its token works and its stream stays open', async () => {
    const s = await openSse(streamUrl(x), bearer(x, 'ivo'));
    await s.waitFor(isHello);
    breakAudit();
    try {
      assert.equal((await x.api('flan', 'DELETE', '/v1/members/ivo')).status, 500);
    } finally { mendAudit(); }
    assert.equal(x.store.getMember('ivo').status, 'active');
    assert.equal((await x.api('ivo', 'GET', '/v1/me')).status, 200);
    await s.quiet(300);
    assert.ok(!s.events.some(isBye));
    s.close();
  });
});

describe('item 7: a stream opened with a token ends when that token is no longer current', { skip: SKIP }, () => {
  const tailnet = { 'Tailscale-User-Login': 'flan@example.com', 'X-Forwarded-For': TAILNET_IP };
  const whois = async (ip) => (ip === TAILNET_IP ? 'flan@example.com' : null);

  test('rotated by another process, then traffic: the old stream closes with token_rotated before it carries anything', async () => {
    // 1 s ticks: only the refresh made before a delivery can close the stream in time.
    const x = await makeEnv({ pollMs: 1000, trustTailscale: true, whois });
    try {
      x.addMember('grace');
      x.addMember('thom');
      const sGrace = await openSse(streamUrl(x), bearer(x, 'grace'));
      const sThom = await openSse(streamUrl(x), bearer(x, 'thom'));
      const sFlan = await openSse(streamUrl(x), tailnet);
      for (const s of [sGrace, sThom, sFlan]) await s.waitFor(isHello);

      rotateLikeTheCli(x, 'grace');
      rotateLikeTheCli(x, 'flan'); // flan's tailnet stream has no token, so this must not touch it
      const pub = await x.post('thom', '#chat', 'public, after the rotation');
      const dm = await x.post('thom', 'grace', 'private, after the rotation');
      assert.equal(pub.status, 201);
      assert.equal(dm.status, 201);

      const bye = await sGrace.waitFor(isBye);
      assert.equal(bye.data.reason, BYE.tokenRotated);
      await sThom.waitFor(isMessage(pub.body.id));
      await sFlan.waitFor(isMessage(pub.body.id));
      await sFlan.waitFor(isMessage(dm.body.id));
      assert.ok(!sGrace.events.some((ev) => ev.event === 'message' && [pub.body.id, dm.body.id].includes(ev.data.id)), 'the old stream carried nothing sent after the rotation');
      assert.ok(!sThom.events.some(isBye), 'another member\'s stream stays open');
      assert.ok(!sFlan.events.some(isBye), 'a tailnet-identity stream stays open');
      assert.equal((await x.api('grace', 'GET', '/v1/me')).status, 401, 'the old token is dead');
      for (const s of [sGrace, sThom, sFlan]) s.close();
    } finally { await x.stop(); }
  });

  test('rotated while the stream is being opened: the open is refused with 401 and nothing is replayed', async () => {
    const x = await makeEnv({ pollMs: 1000 });
    try {
      x.addMember('grace');
      const dm = await x.post('flan', 'grace', 'replayed on resume');
      assert.equal(dm.status, 201);
      // Hold the open after the door has accepted the old token, at the repo lookup that precedes the replay.
      const entered = deferred();
      const gate = deferred();
      const repo = x.host.repo.bind(x.host);
      x.host.repo = async (key) => { entered.resolve(); await gate.promise; return repo(key); };
      const opening = openSse(streamUrl(x), { ...bearer(x, 'grace'), 'Last-Event-ID': '0' });
      await entered.promise;
      rotateLikeTheCli(x, 'grace');
      gate.resolve();
      const s = await opening;
      x.host.repo = repo;
      assert.equal(s.status, 401);
      await s.quiet(200);
      assert.ok(!s.events.some((ev) => ev.event === 'message'), 'nothing was replayed');
      s.close();
    } finally { await x.stop(); }
  });

  test('rotated by another process with no traffic: the old stream closes within a few ticks', async () => {
    const x = await makeEnv({ pollMs: 50, trustTailscale: true, whois });
    try {
      x.addMember('grace');
      x.addMember('thom');
      const sGrace = await openSse(streamUrl(x), bearer(x, 'grace'));
      const sThom = await openSse(streamUrl(x), bearer(x, 'thom'));
      const sFlan = await openSse(streamUrl(x), tailnet);
      for (const s of [sGrace, sThom, sFlan]) await s.waitFor(isHello);
      rotateLikeTheCli(x, 'grace');
      rotateLikeTheCli(x, 'flan');
      const bye = await sGrace.waitFor(isBye, 1000);
      assert.equal(bye.data.reason, BYE.tokenRotated);
      await sThom.quiet(300);
      assert.ok(!sThom.events.some(isBye));
      assert.ok(!sFlan.events.some(isBye));
      // A revocation by another process still reads as one, not as a rotation.
      const cli = new Store(path.join(x.root, 'bridge.db'));
      try { cli.revokeMember('thom'); } finally { cli.close(); }
      assert.equal((await sThom.waitFor(isBye, 1000)).data.reason, BYE.revoked);
      for (const s of [sGrace, sThom, sFlan]) s.close();
    } finally { await x.stop(); }
  });
});
