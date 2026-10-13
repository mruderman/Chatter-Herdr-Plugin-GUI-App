// Contract tests: the bridge against the real Chatter CLI (no Herdr running).
// Set CHATTER_JS to the built Chatter entry point (dist/bin/chatter.js).
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { haveChatter, makeEnv, openSse } from './helpers.js';

describe('bridge against Chatter CLI', { skip: !haveChatter && 'set CHATTER_JS to a built Chatter checkout' }, () => {
  let e;
  before(async () => {
    e = await makeEnv();
    e.addMember('thom');
    e.addMember('grace');
    e.addMember('kieran');
  });
  after(async () => { await e.stop(); });

  test('health is open; everything else needs credentials', async () => {
    assert.equal((await e.api(null, 'GET', '/healthz')).body.ok, true);
    assert.equal((await e.api(null, 'GET', '/v1/me')).status, 401);
    assert.equal((await e.api('cb_wrong', 'GET', '/v1/me')).body.error.code, 'bad_token');
    const me = await e.api('thom', 'GET', '/v1/me');
    assert.equal(me.body.handle, 'thom');
    assert.equal(me.body.kind, 'computational');
  });

  test('a member posts to #chat and Chatter records that member as sender', async () => {
    const r = await e.post('thom', '#chat', 'hello from outside Herdr');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(Number.isInteger(r.body.id));
    const page = await e.messages('grace');
    const m = page.body.messages.find((x) => x.id === r.body.id);
    assert.equal(m.from, 'thom');
    assert.equal(m.to, '#chat');
    assert.equal(m.body, 'hello from outside Herdr');
    assert.match(m.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.ok(page.body.epoch);
  });

  test('@everyone from a member is refused and writes nothing; admin may, and it is audited', async () => {
    const before = e.count();
    for (const body of ['@everyone wake up', 'x @Everyone y']) {
      const r = await e.post('thom', '#chat', body);
      assert.equal(r.status, 403);
      assert.equal(r.body.error.code, 'everyone_admin_only');
    }
    assert.equal(e.count(), before, 'nothing was written');
    const ok = await e.post('flan', '#chat', '@everyone standup in five');
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const audit = await e.api('flan', 'GET', '/v1/audit');
    assert.ok(audit.body.entries.some((x) => x.action === 'everyone' && x.actor === 'flan' && x.message_id === ok.body.id));
  });

  test('DMs are visible to the two parties and the admin only', async () => {
    const dm = await e.post('thom', 'grace', 'private note for grace');
    assert.equal(dm.status, 201, JSON.stringify(dm.body));
    const has = async (who) => (await e.messages(who, '?limit=500')).body.messages.some((m) => m.id === dm.body.id);
    assert.equal(await has('thom'), true);
    assert.equal(await has('grace'), true);
    assert.equal(await has('flan'), true, 'admin sees all DMs');
    assert.equal(await has('kieran'), false, 'a third member does not');
    assert.equal((await e.post('thom', 'nobody', 'x')).body.error.code, 'unknown_recipient');
    assert.equal((await e.post('thom', 'thom', 'x')).body.error.code, 'self_dm');
  });

  test('awkward bodies survive verbatim', async () => {
    for (const body of ['--queue', '--json', '-h', '--help me', 'line one\nline two\n  indented', 'quotes "double" and \'single\' and $HOME `tick`', 'ünïcödé ✓ 🙂']) {
      const r = await e.post('thom', '#chat', body);
      assert.equal(r.status, 201, `${JSON.stringify(body)} -> ${JSON.stringify(r.body)}`);
      const m = (await e.messages('thom', '?limit=500')).body.messages.find((x) => x.id === r.body.id);
      assert.equal(m.body, body.trim(), `post body ${JSON.stringify(body)}`);
    }
    for (const body of ['--queue', '--json']) {
      const r = await e.post('thom', 'grace', body);
      assert.equal(r.status, 201, `${JSON.stringify(body)} -> ${JSON.stringify(r.body)}`);
      const m = (await e.messages('grace', '?limit=500')).body.messages.find((x) => x.id === r.body.id);
      assert.equal(m.body, body, `dm body ${JSON.stringify(body)}`);
    }
  });

  test('mentioning a member reports it and hides Chatter\'s "matches no agent" warning', async () => {
    const r = await e.post('thom', '#chat', 'ping @grace and @kieran');
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.mentioned_members.sort(), ['grace', 'kieran']);
    assert.deepEqual(r.body.warnings, []);
    const m = (await e.messages('grace', '?limit=500')).body.messages.find((x) => x.id === r.body.id);
    assert.deepEqual(m.mentions, ['grace', 'kieran']);
    const unknown = await e.post('thom', '#chat', 'ping @ghost');
    assert.equal(unknown.body.warnings.length, 1);
  });

  test('paging: after_id walks forward, before_id walks back, no overlap', async () => {
    const all = (await e.messages('flan', '?limit=500')).body.messages;
    assert.ok(all.length >= 10);
    const first = (await e.messages('flan', '?after_id=0&limit=4')).body;
    assert.equal(first.messages.length, 4);
    assert.equal(first.has_more, true);
    const second = (await e.messages('flan', `?after_id=${first.messages.at(-1).id}&limit=4`)).body;
    assert.ok(second.messages[0].id > first.messages.at(-1).id);
    const back = (await e.messages('flan', `?before_id=${all.at(-1).id}&limit=3`)).body.messages;
    assert.deepEqual(back.map((m) => m.id), all.slice(-4, -1).map((m) => m.id));
    assert.equal((await e.messages('flan', '?after_id=abc')).status, 400);
  });

  test('stream: live delivery, visibility, and resume from Last-Event-ID', async () => {
    const url = `${e.base}/v1/repos/${e.key}/stream`;
    const auth = (w) => ({ Authorization: `Bearer ${e.tokens[w]}` });
    const sGrace = await openSse(url, auth('grace'));
    const sKieran = await openSse(url, auth('kieran'));
    await sGrace.waitFor((ev) => ev.event === 'hello');
    await sKieran.waitFor((ev) => ev.event === 'hello');

    const pub = await e.post('thom', '#chat', 'stream test, public');
    const dm = await e.post('thom', 'grace', 'stream test, private');
    const got = await sGrace.waitFor((ev) => ev.event === 'message' && ev.data.id === dm.body.id);
    assert.equal(got.data.body, 'stream test, private');
    await sGrace.waitFor((ev) => ev.event === 'message' && ev.data.id === pub.body.id);
    await sKieran.waitFor((ev) => ev.event === 'message' && ev.data.id === pub.body.id);
    await sKieran.quiet();
    assert.ok(!sKieran.events.some((ev) => ev.event === 'message' && ev.data.id === dm.body.id), 'kieran must not see the DM');

    // Resume: miss two messages while disconnected, reconnect with Last-Event-ID.
    sGrace.close();
    const m1 = await e.post('thom', '#chat', 'missed one');
    const m2 = await e.post('thom', 'grace', 'missed two (dm)');
    const resumed = await openSse(url, { ...auth('grace'), 'Last-Event-ID': String(pub.body.id) });
    await resumed.waitFor((ev) => ev.event === 'message' && ev.data.id === m1.body.id);
    await resumed.waitFor((ev) => ev.event === 'message' && ev.data.id === m2.body.id);
    const ids = resumed.events.filter((ev) => ev.event === 'message').map((ev) => ev.data.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'in order');
    assert.equal(new Set(ids).size, ids.length, 'no duplicates');
    assert.ok(!ids.includes(pub.body.id), 'nothing at or before Last-Event-ID is replayed');
    resumed.close();
    sKieran.close();
  });

  test('revoking a member kills their token and closes their stream', async () => {
    e.addMember('temp');
    const s = await openSse(`${e.base}/v1/repos/${e.key}/stream`, { Authorization: `Bearer ${e.tokens.temp}` });
    await s.waitFor((ev) => ev.event === 'hello');
    const r = await e.api('flan', 'DELETE', '/v1/members/temp');
    assert.equal(r.status, 200);
    const bye = await s.waitFor((ev) => ev.event === 'bye');
    assert.equal(bye.data.reason, 'revoked');
    assert.equal((await e.api('temp', 'GET', '/v1/me')).status, 401);
    assert.equal((await e.api('thom', 'GET', '/v1/members')).status, 403, 'members cannot manage members');
    s.close();
  });

  test('admin can manage members; handle may not collide with a Herdr agent', async () => {
    e.seedAgent('codex');
    const clash = await e.api('flan', 'POST', '/v1/members', { handle: 'codex', kind: 'computational' });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.error.code, 'handle_is_agent');
    const ok = await e.api('flan', 'POST', '/v1/members', { handle: 'ezra', kind: 'computational', display_name: 'Ezra' });
    assert.equal(ok.status, 201);
    assert.match(ok.body.token, /^cb_/);
    const rot = await e.api('flan', 'POST', '/v1/members/ezra/token');
    assert.notEqual(rot.body.token, ok.body.token);
    assert.equal((await e.api(ok.body.token, 'GET', '/v1/me')).status, 401, 'old token is dead');
    assert.equal((await e.api(rot.body.token, 'GET', '/v1/me')).body.handle, 'ezra');
    const dir = (await e.api('thom', 'GET', '/v1/directory')).body;
    assert.ok(dir.members.some((m) => m.handle === 'ezra' && m.kind === 'computational'));
    assert.ok(dir.agents.includes('codex'));
  });

  test('addressing agents: allowed by default and audited; refused once the flag is off', async () => {
    e.seedAgent('pi');
    const r = await e.post('thom', '#chat', 'hey @pi, can you look at this');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const dm = await e.post('thom', 'pi', 'direct to pi');
    assert.equal(dm.status, 201, JSON.stringify(dm.body));
    const audit = (await e.api('flan', 'GET', '/v1/audit?limit=200')).body.entries;
    assert.ok(audit.some((a) => a.action === 'dm_agent' && a.target === 'pi' && a.actor === 'thom' && a.message_id === dm.body.id));

    await e.api('flan', 'PATCH', '/v1/members/thom', { can_address_agents: false });
    const before = e.count();
    assert.equal((await e.post('thom', '#chat', 'hey @pi again')).body.error.code, 'agents_not_allowed');
    assert.equal((await e.post('thom', 'pi', 'again')).body.error.code, 'agents_not_allowed');
    assert.equal(e.count(), before);
    assert.equal((await e.post('thom', '#chat', 'members are still fine @grace')).status, 201);
    await e.api('flan', 'PATCH', '/v1/members/thom', { can_address_agents: true });
  });

  test('board, directory and read pointers', async () => {
    await e.host.run({ handle: 'flan', cwd: e.repo, args: ['ask', 'who owns the auth migration?'] });
    const board = (await e.api('grace', 'GET', `/v1/repos/${e.key}/board`)).body;
    for (const k of ['agents', 'tasks', 'notes', 'questions', 'handoffs']) assert.ok(Array.isArray(board[k]), k);
    assert.ok(board.questions.some((q) => q.text.includes('auth migration')));
    const max = (await e.messages('grace')).body.max_id;
    assert.equal((await e.api('grace', 'POST', `/v1/repos/${e.key}/read`, { up_to_id: max })).body.last_read_id, max);
    assert.equal((await e.api('grace', 'POST', `/v1/repos/${e.key}/read`, { up_to_id: 1 })).body.last_read_id, max, 'never moves backward');
    const repos = (await e.api('grace', 'GET', '/v1/repos')).body.repos;
    assert.equal(repos[0].last_read_id, max);
    assert.equal(repos[0].repo_root, null, 'repo paths are admin only');
    assert.ok((await e.api('flan', 'GET', '/v1/repos')).body.repos[0].repo_root);
  });

  // F15. Own env: the bridge caches the CLI's agent rows for 2 s, so rows seeded after an earlier
  // board request in the shared env could be hidden by a stale (empty) cache entry.
  test('board agent rows carry no host paths for a non-admin; an admin keeps them; the shared cache leaks neither way', async () => {
    const x = await makeEnv();
    try {
      x.addMember('grace');
      x.seedAgent('codex-1');
      // seedAgent leaves cwd null; give it a real value so a leaked value cannot hide behind null.
      const cwd = path.join(x.repo, 'packages', 'app');
      const db = new DatabaseSync(path.join(x.repoInfo.dir, 'chatter.db'));
      db.prepare('UPDATE agents SET cwd = ? WHERE name = ?').run(cwd, 'codex-1');
      db.close();

      const board = async (who) => {
        const r = await x.api(who, 'GET', `/v1/repos/${x.key}/board`);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.agents_error, null);
        assert.ok(r.body.agents.length >= 1, 'the seeded agent is listed');
        return r;
      };
      const seen = (who, r) => {
        const row = r.body.agents.find((a) => a.name === 'codex-1');
        assert.ok(row, `${who} sees codex-1`);
        return row;
      };
      const asMember = (r) => {
        for (const a of r.body.agents) {
          assert.equal('repo_root' in a, false, 'repo_root key is absent for a non-admin');
          assert.equal('cwd' in a, false, 'cwd key is absent for a non-admin');
        }
        const row = seen('grace', r);
        assert.equal(row.kind, 'codex', 'the other fields survive');
        assert.equal(row.status, 'offline');
        assert.ok(row.registered_at);
        assert.ok(!JSON.stringify(r.body).includes(x.root), 'no host path anywhere in the response');
      };
      const asAdmin = (r) => {
        const row = seen('flan', r);
        assert.equal(row.repo_root, x.repo);
        assert.equal(row.cwd, cwd);
      };

      // The first request fills the cache; the rest are served from it. The order covers rows
      // redacted before caching, redacted in place, and redaction skipped on a cache hit.
      asMember(await board('grace'));
      asAdmin(await board('flan'));
      asMember(await board('grace'));
      asAdmin(await board('flan'));
    } finally { await x.stop(); }
  });

  // A column a later Chatter adds must not reach a non-admin until someone has judged it safe.
  test('board agent rows for a non-admin keep only known non-path keys; an admin\'s rows are untouched', async () => {
    const x = await makeEnv();
    try {
      x.addMember('grace');
      const row = {
        name: 'codex-1', pane_id: 'w1:2', workspace_id: 'w1', cwd: '/srv/work/app', repo_root: '/srv/work',
        worktree_path: '/srv/work/.wt/codex-1', branch: 'main', kind: 'codex', role: 'reviewer',
        registered_at: '2026-10-09 00:00:00', last_seen_at: '2026-10-09 00:00:00', departed_at: null,
        status: 'offline', task: { assignee: 'codex-1', id: 't1', title: 'review' },
      };
      const sparse = { name: 'codex-2', repo_root: '/srv/work', worktree_path: '/srv/work/.wt/codex-2' };
      const realRun = x.host.run.bind(x.host);
      // Stub only `chatter agents`, with rows the installed Chatter does not produce.
      x.host.run = (o) => (o.args[0] === 'agents'
        ? Promise.resolve({ code: 0, stdout: JSON.stringify([row, sparse]), stderr: '' })
        : realRun(o));
      const { repo_root, cwd, worktree_path, ...kept } = row;
      const board = async (who) => (await x.api(who, 'GET', `/v1/repos/${x.key}/board`)).body.agents;
      // grace first fills the cache; flan and the second grace are served from it.
      assert.deepEqual(await board('grace'), [kept, { name: 'codex-2' }], 'keys absent in a row stay absent, none are added as null');
      assert.deepEqual(await board('flan'), [row, sparse], 'an admin gets the rows exactly as Chatter printed them');
      assert.deepEqual(await board('grace'), [kept, { name: 'codex-2' }]);
    } finally { await x.stop(); }
  });

  // T13 item 4: Chatter's stderr and a failed run's error can name host paths, so a member gets a fixed message.
  test('board agents_error: a member gets a fixed message, an admin the detail', async () => {
    const x = await makeEnv();
    try {
      x.addMember('grace');
      const realRun = x.host.run.bind(x.host);
      let fail = null;
      // Stub only `chatter agents`; the repo lookup and everything else still use the real CLI.
      x.host.run = (o) => (o.args[0] === 'agents' && fail ? fail() : realRun(o));
      const cases = [
        ['a non-zero exit', () => Promise.resolve({ code: 1, stdout: '', stderr: 'agents failed\n' }), 'agents failed'],
        ['a spawn error', () => Promise.reject(new Error('could not start chatter')), 'could not start chatter'],
      ];
      for (const [name, stub, message] of cases) {
        fail = stub;
        for (const [who, expected] of [['grace', 'Chatter could not list agents'], ['flan', message]]) {
          const r = await x.api(who, 'GET', `/v1/repos/${x.key}/board`);
          assert.equal(r.status, 200, `${name} as ${who}`);
          assert.deepEqual(r.body.agents, [], `${name} as ${who}`);
          assert.equal(r.body.agents_error, expected, `${name} as ${who}`);
        }
      }
    } finally { await x.stop(); }
  });

  test('rate limit answers 429', async () => {
    const small = await makeEnv({ limits: { maxBody: 8000, postsPerMinute: 3 } });
    try {
      small.addMember('thom');
      const codes = [];
      for (let i = 0; i < 5; i++) codes.push((await small.post('thom', '#chat', `m${i}`)).status);
      assert.deepEqual(codes, [201, 201, 201, 429, 429]);
    } finally { await small.stop(); }
  });

  test('Tailscale identity: header accepted only when trusted and verified', async () => {
    const ts = await makeEnv({ trustTailscale: true, whois: async (ip) => (ip === '100.64.0.7' ? 'flan@example.com' : null) });
    try {
      const h = { 'Tailscale-User-Login': 'flan@example.com', 'X-Forwarded-For': '100.64.0.7' };
      const ok = await ts.api(null, 'GET', '/v1/me', null, h);
      assert.equal(ok.body.handle, 'flan');
      const spoof = await ts.api(null, 'GET', '/v1/me', null, { ...h, 'X-Forwarded-For': '100.64.0.9' });
      assert.equal(spoof.status, 401);
    } finally { await ts.stop(); }
  });

  test('a purged and recreated universe gets a new epoch', async () => {
    const x = await makeEnv();
    try {
      x.addMember('thom');
      const e1 = (await x.messages('thom')).body.epoch;
      const purge = await x.host.run({ handle: 'flan', cwd: x.repo, args: ['purge', x.key, '--yes'] });
      assert.equal(purge.code, 0, purge.stderr);
      const again = await x.host.run({ handle: 'flan', cwd: x.repo, args: ['post', 'fresh start'] });
      assert.equal(again.code, 0, again.stderr);
      await x.host.repos({ fresh: true });
      const e2 = (await x.messages('thom')).body.epoch;
      assert.notEqual(e1, e2);
    } finally { await x.stop(); }
  });
});
