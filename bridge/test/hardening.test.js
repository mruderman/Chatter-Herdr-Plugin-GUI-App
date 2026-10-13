// T13: bridge hardening from the G2 review, against the real Chatter CLI (no Herdr running).
// Every test builds its own universe: the shared one in integration.test.js posts as members against
// the rate limit, and agents seeded here would change how its names resolve.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
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

  test('a DM to a member whose handle is the start of an agent name is refused with 409, for an admin too', async () => {
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

// ---------------------------------------------------------------------------------------------------------
// T13c: authorization is decided where it is used. Each case lets a request in at the door and then changes
// the registry, through the API or as the CLI does from another process, before the request uses what the
// door decided.

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'chatter-bridge.js');
const ERR = {
  badToken: 'bad_token', adminOnly: 'admin_only', ambiguous: 'ambiguous_recipient', badRequest: 'bad_request',
  agentsNotAllowed: 'agents_not_allowed', rateLimited: 'rate_limited',
};
const tailnetOf = (login) => ({ 'Tailscale-User-Login': login, 'X-Forwarded-For': TAILNET_IP });
const lastAuditId = (x) => x.store.listAudit({ limit: 1 })[0]?.id ?? 0;
const tokenCount = (store, handle) => store.db.prepare('SELECT COUNT(*) AS n FROM tokens WHERE handle = ?').get(handle).n;

/** Runs `change` on a second Store on the bridge's database file, as the CLI does from its own process. */
function asAnotherProcess(x, change) {
  const cli = new Store(path.join(x.root, 'bridge.db'));
  try { change(cli); } finally { cli.close(); }
}

/** Settles once the door has accepted `handle`: `identify` touches the member right after accepting the credential. */
function doorPassed(x, handle) {
  const passed = deferred();
  const touch = x.store.touch;
  x.store.touch = function touched(h) {
    if (h === handle) { x.store.touch = touch; passed.resolve(); }
    return touch.call(this, h);
  };
  return passed.promise;
}

/** A request whose headers and the first half of its body go now; the rest goes on `finish()`. */
function heldBody(x, who, method, p, body) {
  const text = JSON.stringify(body);
  const half = Math.floor(text.length / 2);
  const req = http.request(`${x.base}${p}`, {
    method,
    headers: { ...bearer(x, who), 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) },
  });
  const answer = new Promise((resolve, reject) => {
    req.on('response', (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
  });
  req.write(text.slice(0, half));
  return { answer, finish: () => req.end(text.slice(half)) };
}

/** Holds the next call of `obj[name]` for which `when` holds until `release()`; every other call runs as usual. */
function pauseNext(obj, name, when = () => true) {
  const entered = deferred();
  const gate = deferred();
  const real = obj[name];
  obj[name] = function paused(...args) {
    if (!when(...args)) return real.apply(this, args);
    obj[name] = real;
    entered.resolve();
    return gate.promise.then(() => real.apply(this, args));
  };
  return { entered: entered.promise, release: () => gate.resolve() };
}

/** Runs `change` just before the next registry transaction begins, in the window after the door. */
function beforeNextTransaction(x, change) {
  const transaction = x.store.transaction;
  x.store.transaction = function late(fn) {
    x.store.transaction = transaction;
    change();
    return transaction.call(this, fn);
  };
}

describe('T13c item 1: a registry change is authorised inside its transaction', { skip: SKIP }, () => {
  const BACKDOOR = { handle: 'backdoor', display_name: 'Backdoor', kind: 'computational', role: 'admin' };
  // Each lands after the door has let ada in and while her body is still arriving.
  const losses = [
    ['revoked through the API', (x) => x.api('flan', 'DELETE', '/v1/members/ada'), 401, ERR.badToken],
    ['demoted through the API', (x) => x.api('flan', 'PATCH', '/v1/members/ada', { role: 'member' }), 403, ERR.adminOnly],
    ['whose token another process rotated', (x) => rotateLikeTheCli(x, 'ada'), 401, ERR.badToken],
  ];

  for (const [how, lose, status, code] of losses) {
    test(`add: an admin ${how} while the body is still arriving gets ${status}; no member, token or audit entry`, async () => {
      const x = await makeEnv();
      try {
        x.addMember('ada', { role: 'admin' });
        const passed = doorPassed(x, 'ada');
        const adding = heldBody(x, 'ada', 'POST', '/v1/members', BACKDOOR);
        await passed;
        const changed = await lose(x);
        if (changed) assert.equal(changed.status, 200);
        const audited = lastAuditId(x);
        adding.finish();
        const r = await adding.answer;
        // Never print the body: an add that went through carries the new member's token.
        assert.equal(r.status, status);
        assert.equal(r.body.error.code, code);
        assert.equal(x.store.getMember(BACKDOOR.handle), null, 'no member');
        assert.equal(tokenCount(x.store, BACKDOOR.handle), 0, 'no token');
        assert.equal(lastAuditId(x), audited, 'no audit entry');
      } finally { await x.stop(); }
    });
  }

  test('add: an admin revoked while the agent names are read gets 401; no member, token or audit entry', async () => {
    const x = await makeEnv();
    try {
      x.addMember('ada', { role: 'admin' });
      const pause = pauseNext(x.host, 'agentNames');
      const adding = x.api('ada', 'POST', '/v1/members', BACKDOOR);
      await pause.entered;
      assert.equal((await x.api('flan', 'DELETE', '/v1/members/ada')).status, 200);
      const audited = lastAuditId(x);
      pause.release();
      const r = await adding;
      assert.equal(r.status, 401);
      assert.equal(r.body.error.code, ERR.badToken);
      assert.equal(x.store.getMember(BACKDOOR.handle), null, 'no member');
      assert.equal(tokenCount(x.store, BACKDOOR.handle), 0, 'no token');
      assert.equal(lastAuditId(x), audited, 'no audit entry');
    } finally { await x.stop(); }
  });

  test('a delayed PATCH that would restore its sender\'s own admin role after a demotion gets 403', async () => {
    const x = await makeEnv();
    try {
      x.addMember('ada', { role: 'admin' });
      const passed = doorPassed(x, 'ada');
      const restoring = heldBody(x, 'ada', 'PATCH', '/v1/members/ada', { role: 'admin' });
      await passed;
      assert.equal((await x.api('flan', 'PATCH', '/v1/members/ada', { role: 'member' })).status, 200);
      const audited = lastAuditId(x);
      restoring.finish();
      const r = await restoring.answer;
      assert.equal(r.status, 403, JSON.stringify(r.body));
      assert.equal(r.body.error.code, ERR.adminOnly);
      assert.equal(x.store.getMember('ada').role, 'member');
      assert.equal(lastAuditId(x), audited, 'no audit entry');
    } finally { await x.stop(); }
  });

  // Neither route awaits after the door, but the CLI in another process can commit between the door's read
  // and the transaction: the change runs just before the transaction begins.
  const routes = [
    ['rotate', 'POST', '/v1/members/thom/token'],
    ['revoke', 'DELETE', '/v1/members/thom'],
  ];
  const cliLosses = [
    ['revoked', (s) => s.revokeMember('ada'), 401, ERR.badToken],
    ['demoted', (s) => s.updateMember('ada', { role: 'member' }), 403, ERR.adminOnly],
  ];
  for (const [route, method, p] of routes) {
    for (const [how, lose, status, code] of cliLosses) {
      test(`${route}: an admin ${how} by another process between the door and the transaction gets ${status}; thom is untouched`, async () => {
        const x = await makeEnv();
        try {
          x.addMember('ada', { role: 'admin' });
          x.addMember('thom');
          const tokens = tokenCount(x.store, 'thom');
          const audited = lastAuditId(x);
          beforeNextTransaction(x, () => asAnotherProcess(x, lose));
          const r = await x.api('ada', method, p);
          // Never print the body: a rotation that went through carries thom's new token.
          assert.equal(r.status, status);
          assert.equal(r.body.error.code, code);
          assert.equal(x.store.getMember('thom').status, 'active');
          assert.equal((await x.api('thom', 'GET', '/v1/me')).status, 200, 'thom\'s token still works');
          assert.equal(tokenCount(x.store, 'thom'), tokens, 'no token was issued');
          assert.equal(lastAuditId(x), audited, 'no audit entry');
        } finally { await x.stop(); }
      });
    }
  }
});

describe('T13c item 2: a read decides with the member as they are once its data is read', { skip: SKIP }, () => {
  test('history: an admin demoted while the repo is looked up gets no DM between two other members', async () => {
    const x = await makeEnv();
    try {
      x.addMember('ada', { role: 'admin' });
      x.addMember('thom');
      x.addMember('grace');
      const dm = await x.post('thom', 'grace', 'private, posted before the request');
      assert.equal(dm.status, 201);
      const pause = pauseNext(x.host, 'repo');
      const reading = x.messages('ada', '?limit=500');
      await pause.entered;
      assert.equal((await x.api('flan', 'PATCH', '/v1/members/ada', { role: 'member' })).status, 200);
      pause.release();
      const r = await reading;
      assert.equal(r.status, 200);
      assert.ok(!r.body.messages.some((m) => m.id === dm.body.id), 'the demoted admin gets no other members\' DM');
      assert.ok(r.body.messages.some((m) => m.to === '#chat'), 'the channel is still there');
    } finally { await x.stop(); }
  });

  test('history: a request whose token another process rotated while the repo is looked up gets 401', async () => {
    const x = await makeEnv();
    try {
      x.addMember('grace');
      const pause = pauseNext(x.host, 'repo');
      const reading = x.messages('grace');
      await pause.entered;
      rotateLikeTheCli(x, 'grace');
      pause.release();
      const r = await reading;
      assert.equal(r.status, 401);
      assert.equal(r.body.error.code, ERR.badToken);
    } finally { await x.stop(); }
  });

  test('board: a member revoked while Chatter lists the agents gets 401', async () => {
    const x = await makeEnv();
    try {
      x.addMember('grace');
      const pause = pauseNext(x.host, 'run', (o) => o.args[0] === 'agents');
      const reading = x.api('grace', 'GET', `/v1/repos/${x.key}/board`);
      await pause.entered;
      assert.equal((await x.api('flan', 'DELETE', '/v1/members/grace')).status, 200);
      pause.release();
      const r = await reading;
      assert.equal(r.status, 401);
      assert.equal(r.body.error.code, ERR.badToken);
    } finally { await x.stop(); }
  });

  test('repo list: an admin demoted while the repos are listed gets no repo_root', async () => {
    const x = await makeEnv();
    try {
      x.addMember('ada', { role: 'admin' });
      const pause = pauseNext(x.host, 'repos');
      const reading = x.api('ada', 'GET', '/v1/repos');
      await pause.entered;
      assert.equal((await x.api('flan', 'PATCH', '/v1/members/ada', { role: 'member' })).status, 200);
      pause.release();
      const r = await reading;
      assert.equal(r.status, 200);
      assert.ok(r.body.repos.length >= 1);
      assert.ok(r.body.repos.every((repo) => repo.repo_root === null), 'repo paths are admin only');
    } finally { await x.stop(); }
  });

  test('repo list: an admin revoked while the repos are listed gets 401 and no repo_root', async () => {
    const x = await makeEnv();
    try {
      x.addMember('ada', { role: 'admin' });
      const pause = pauseNext(x.host, 'repos');
      const reading = x.api('ada', 'GET', '/v1/repos');
      await pause.entered;
      assert.equal((await x.api('flan', 'DELETE', '/v1/members/ada')).status, 200);
      pause.release();
      const r = await reading;
      // A revoked member keeps the role they had, so a record that is read without its status would still
      // show them the paths.
      assert.equal(r.status, 401);
      assert.equal(r.body.error.code, ERR.badToken);
      assert.equal(JSON.stringify(r.body).includes(x.repo), false, 'no repo path in the answer');
    } finally { await x.stop(); }
  });

  test('directory: a member revoked while the agent names are read gets 401', async () => {
    const x = await makeEnv();
    try {
      x.addMember('grace');
      const pause = pauseNext(x.host, 'agentNames');
      const reading = x.api('grace', 'GET', '/v1/directory');
      await pause.entered;
      assert.equal((await x.api('flan', 'DELETE', '/v1/members/grace')).status, 200);
      pause.release();
      const r = await reading;
      assert.equal(r.status, 401);
      assert.equal(r.body.error.code, ERR.badToken);
    } finally { await x.stop(); }
  });

  test('read pointer: a member revoked while the repo is looked up gets 401 and the pointer stays', async () => {
    const x = await makeEnv();
    try {
      x.addMember('grace');
      const pause = pauseNext(x.host, 'repo');
      const reading = x.api('grace', 'POST', `/v1/repos/${x.key}/read`, { up_to_id: 1 });
      await pause.entered;
      assert.equal((await x.api('flan', 'DELETE', '/v1/members/grace')).status, 200);
      pause.release();
      const r = await reading;
      assert.equal(r.status, 401);
      assert.equal(r.body.error.code, ERR.badToken);
      assert.equal(x.store.getRead('grace', x.key), 0, 'the pointer did not move');
    } finally { await x.stop(); }
  });
});

describe('T13c item 3: a replay checks its member before every page', { skip: SKIP }, () => {
  // Rows written straight into Chatter's database after the setup message, as a fixture (the bridge itself
  // never writes there): every tenth a DM from thom to grace, the rest channel posts.
  const backlog = (x, n) => {
    const db = new DatabaseSync(path.join(x.repoInfo.dir, 'chatter.db'));
    try {
      const insert = db.prepare('INSERT INTO messages (from_agent, to_agent, body, kind, created_at) VALUES (?,?,?,?,?)');
      db.exec('BEGIN');
      for (let i = 0; i < n; i++) {
        const dm = i % 10 === 0;
        insert.run('thom', dm ? 'grace' : '#chat', `backlog ${i}`, dm ? 'chat' : 'post', '2026-10-12 00:00:00');
      }
      db.exec('COMMIT');
    } finally { db.close(); }
  };

  // The page boundary: the replay reads its pages through the repo's read-only handle, and its page query is
  // the only one bounded above (by the watcher's cursor). `between` runs once, after page 1 has been read and
  // delivered and before page 2 is read; the pages read are recorded.
  const atSecondPage = (x, between) => {
    const pages = [];
    const openRO = x.host.openRO;
    x.host.openRO = function proxied(repo) {
      const db = openRO.call(this, repo);
      return new Proxy(db, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (key !== 'prepare') return typeof value === 'function' ? value.bind(target) : value;
          return (sql) => {
            const statement = target.prepare(sql);
            if (!/id <= \?/.test(sql)) return statement;
            return {
              all: (...args) => {
                if (pages.length === 1) between();
                const rows = statement.all(...args);
                pages.push(rows);
                return rows;
              },
            };
          };
        },
      });
    };
    return { pages, restore: () => { x.host.openRO = openRO; } };
  };
  const dmsIn = (rows) => rows.filter((r) => r.to_agent === 'grace').map((r) => r.id);
  const messageIds = (s) => new Set(s.events.filter((ev) => ev.event === 'message').map((ev) => ev.data.id));

  test('an admin demoted by another process between two pages gets the DMs of the first and none of the second', async () => {
    // 1 s ticks: the watcher's own refresh cannot run while the stream opens.
    const x = await makeEnv({ pollMs: 1000 });
    try {
      x.addMember('ada', { role: 'admin' });
      x.addMember('thom');
      x.addMember('grace');
      backlog(x, 600);
      const replay = atSecondPage(x, () => asAnotherProcess(x, (s) => s.updateMember('ada', { role: 'member' })));
      const s = await openSse(streamUrl(x), { ...bearer(x, 'ada'), 'Last-Event-ID': '0' });
      try {
        await s.waitFor(isHello);
      } finally { replay.restore(); }
      assert.ok(replay.pages.length >= 2 && replay.pages[1].length > 0, 'the backlog spans two pages');
      const [first, second] = replay.pages;
      const got = messageIds(s);
      assert.ok(dmsIn(first).length > 0 && dmsIn(first).every((id) => got.has(id)), 'page 1 went out while ada was an admin');
      assert.ok(dmsIn(second).length > 0 && !dmsIn(second).some((id) => got.has(id)), 'page 2 carries no DM between two other members');
      assert.ok(second.filter((r) => r.to_agent === '#chat').every((r) => got.has(r.id)), 'the channel still arrives');
      assert.ok(!s.events.some(isBye), 'a demotion does not end the stream');
      s.close();
    } finally { await x.stop(); }
  });

  test('a member revoked by another process between two pages gets bye revoked and nothing of the second', async () => {
    const x = await makeEnv({ pollMs: 1000 });
    try {
      x.addMember('thom');
      x.addMember('grace');
      backlog(x, 600);
      const replay = atSecondPage(x, () => asAnotherProcess(x, (s) => s.revokeMember('grace')));
      const s = await openSse(streamUrl(x), { ...bearer(x, 'grace'), 'Last-Event-ID': '0' });
      let bye;
      try {
        bye = await s.waitFor(isBye, 2000);
      } finally { replay.restore(); }
      assert.equal(bye.data.reason, BYE.revoked);
      const got = messageIds(s);
      assert.ok(replay.pages[0].some((r) => got.has(r.id)), 'page 1 went out');
      assert.ok(!replay.pages[1].some((r) => got.has(r.id)), 'nothing of page 2 went out');
      assert.ok(!s.events.some(isHello), 'the stream ended before its hello');
      s.close();
    } finally { await x.stop(); }
  });
});

describe('T13c item 4: a queued send also checks the credential it came with', { skip: SKIP }, () => {
  test('a send waiting at the lock is refused with 401 once another process rotates its token, and nothing is written', async () => {
    const x = await makeEnv();
    try {
      x.addMember('thom');
      const before = x.count();
      const lock = holdWriteLock(x);
      const sending = x.post('thom', '#chat', 'sent with a token rotated while it waited');
      await lock.queued;
      rotateLikeTheCli(x, 'thom');
      lock.release();
      const r = await sending;
      assert.equal(r.status, 401);
      assert.equal(r.body.error.code, ERR.badToken);
      assert.equal(x.count(), before, 'nothing was written');
    } finally { await x.stop(); }
  });

  test('a tailnet member\'s queued send has no token to rotate and goes through', async () => {
    const x = await makeEnv({ trustTailscale: true, whois: async (ip) => (ip === TAILNET_IP ? 'flan@example.com' : null) });
    try {
      const lock = holdWriteLock(x);
      const sending = x.api(null, 'POST', `/v1/repos/${x.key}/messages`, { to: '#chat', body: 'from the tailnet' }, tailnetOf('flan@example.com'));
      await lock.queued;
      rotateLikeTheCli(x, 'flan');
      lock.release();
      const r = await sending;
      assert.equal(r.status, 201, JSON.stringify(r.body));
    } finally { await x.stop(); }
  });
});

describe('T13c item 5: a DM to an agent name is checked against the roster of the repo it is sent in', { skip: SKIP }, () => {
  let x;
  let other; // a second repo of the same Chatter universe
  const countIn = (repo) => {
    const db = new DatabaseSync(path.join(repo.dir, 'chatter.db'), { readOnly: true });
    try { return db.prepare('SELECT COUNT(*) AS n FROM messages').get().n; } finally { db.close(); }
  };
  const seedIn = (repo, name, departedAt = null) => {
    const db = new DatabaseSync(path.join(repo.dir, 'chatter.db'));
    try {
      db.prepare('INSERT INTO agents (name, kind, repo_root, registered_at, last_seen_at, departed_at) VALUES (?,?,?,?,?,?)')
        .run(name, 'codex', repo.repo_root, '2026-10-09 00:00:00', '2026-10-09 00:00:00', departedAt);
    } finally { db.close(); }
  };
  const rowOf = async (repo, id) => (await x.api('flan', 'GET', `/v1/repos/${repo.key}/messages?limit=500`)).body.messages.find((m) => m.id === id);

  before(async () => {
    x = await makeEnv();
    x.addMember('kai');
    x.addMember('thom', { can_address_agents: false });
    // Here: codex-worker and renata are live; cod and zz-old departed, and no live name begins with zz-old.
    seedIn(x.repoInfo, 'codex-worker');
    seedIn(x.repoInfo, 'renata');
    seedIn(x.repoInfo, 'cod', '2026-10-09 01:00:00');
    seedIn(x.repoInfo, 'zz-old', '2026-10-09 01:00:00');
    // There: ren is live.
    const dir = path.join(x.root, 'other');
    fs.mkdirSync(dir);
    const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir, stdio: 'ignore' });
    git('init', '-q');
    git('commit', '--allow-empty', '-q', '-m', 'init');
    const r = await x.host.run({ handle: 'flan', cwd: dir, args: ['post', 'setup message of the other repo'] });
    assert.equal(r.code, 0, r.stderr);
    other = (await x.host.repos({ fresh: true })).find((repo) => repo.key !== x.key);
    seedIn(other, 'ren');
  });
  after(async () => { await x.stop(); });

  test('a departed name that is the start of a live agent\'s name is refused with 409 for everyone, and nothing is written', async () => {
    const before = x.count();
    // The restricted thom is told it is ambiguous too: that is decided before whether he may address agents.
    for (const who of ['kai', 'flan', 'thom']) {
      const r = await x.post(who, 'cod', 'for cod, not codex-worker');
      assert.equal(r.status, 409, who);
      assert.equal(r.body.error.code, ERR.ambiguous, who);
      assert.match(r.body.error.message, /^"cod" is the start of the name of the Herdr agent codex-worker,/, who);
    }
    assert.equal(x.count(), before, 'nothing was written');
    assert.ok(!(await audits(x)).some((a) => a.action === 'dm_agent' && a.target === 'cod'), 'no DM to an agent was audited');
  });

  test('a name that is a live agent in one repo and only the start of one in another is refused there and written where it lives', async () => {
    const here = x.count();
    const refused = await x.post('kai', 'ren', 'for ren, sent where only renata lives');
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error.code, ERR.ambiguous);
    assert.match(refused.body.error.message, /renata/);
    assert.equal(x.count(), here, 'nothing was written here');

    const there = countIn(other);
    const r = await x.api('kai', 'POST', `/v1/repos/${other.key}/messages`, { to: 'ren', body: 'for ren, where ren lives' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.delivery, 'queued');
    assert.equal(countIn(other), there + 1);
    assert.equal((await rowOf(other, r.body.id)).to, 'ren');
  });

  test('a departed name that no live name begins with is unchanged: written to that name, and still an agent', async () => {
    const r = await x.post('kai', 'zz-old', 'for a departed agent');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal((await rowOf(x, r.body.id)).to, 'zz-old');
    assert.equal((await x.post('thom', 'zz-old', 'not allowed')).body.error.code, ERR.agentsNotAllowed);
  });
});

describe('T13c item 6: the rate limit counts admitted sends', { skip: SKIP }, () => {
  test('a send admitted, then refused when it is decided again, keeps its slot', async () => {
    const x = await makeEnv({ limits: { maxBody: 8000, postsPerMinute: 1 } });
    try {
      x.addMember('thom');
      x.seedAgent('pi');
      const lock = holdWriteLock(x);
      const sending = x.post('thom', '#chat', 'hey @pi, admitted before the change');
      await lock.queued;
      assert.equal((await x.api('flan', 'PATCH', '/v1/members/thom', { can_address_agents: false })).status, 200);
      lock.release();
      const r = await sending;
      assert.equal(r.status, 403);
      assert.equal(r.body.error.code, ERR.agentsNotAllowed);
      const next = await x.post('thom', '#chat', 'a valid send');
      assert.equal(next.status, 429, JSON.stringify(next.body));
      assert.equal(next.body.error.code, ERR.rateLimited);
    } finally { await x.stop(); }
  });
});

describe('T13c item 7: can_address_agents is a boolean when present', { skip: SKIP }, () => {
  let x;
  before(async () => {
    x = await makeEnv();
    x.addMember('thom');
  });
  after(async () => { await x.stop(); });

  for (const [i, value] of ['false', 0, null].entries()) {
    test(`add: ${JSON.stringify(value)} answers 400 and adds nobody`, async () => {
      const handle = `ezra${i}`;
      const audited = lastAuditId(x);
      const r = await x.api('flan', 'POST', '/v1/members', { handle, kind: 'human', can_address_agents: value });
      assert.equal(r.status, 400);
      assert.equal(r.body.error.code, ERR.badRequest);
      assert.equal(x.store.getMember(handle), null);
      assert.equal(lastAuditId(x), audited);
    });

    test(`PATCH: ${JSON.stringify(value)} answers 400 and changes nothing`, async () => {
      const was = x.store.getMember('thom');
      const audited = lastAuditId(x);
      const r = await x.api('flan', 'PATCH', '/v1/members/thom', { can_address_agents: value });
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(r.body.error.code, ERR.badRequest);
      assert.deepEqual(x.store.getMember('thom'), was);
      assert.equal(lastAuditId(x), audited);
    });
  }

  test('true and false are taken as they are', async () => {
    assert.equal((await x.api('flan', 'PATCH', '/v1/members/thom', { can_address_agents: false })).body.member.can_address_agents, false);
    assert.equal((await x.api('flan', 'PATCH', '/v1/members/thom', { can_address_agents: true })).body.member.can_address_agents, true);
    const added = await x.api('flan', 'POST', '/v1/members', { handle: 'zoe', kind: 'human', can_address_agents: false });
    assert.equal(added.status, 201);
    assert.equal(added.body.member.can_address_agents, false);
    assert.equal((await x.api('flan', 'POST', '/v1/members', { handle: 'yan', kind: 'human' })).body.member.can_address_agents, true, 'absent means true');
  });
});

describe('T13c item 7: the add route commits nothing when the member config cannot be made', { skip: SKIP }, () => {
  test('a failing ensureMemberConfig answers 500 with no member, no token and no audit entry', async () => {
    const x = await makeEnv();
    try {
      const ensure = x.host.ensureMemberConfig;
      x.host.ensureMemberConfig = function failing(handle) {
        if (handle === 'ezra') throw new Error('could not create the member config directory');
        return ensure.call(this, handle);
      };
      const audited = lastAuditId(x);
      const r = await x.api('flan', 'POST', '/v1/members', { handle: 'ezra', kind: 'computational' });
      x.host.ensureMemberConfig = ensure;
      assert.equal(r.status, 500);
      assert.equal(x.store.getMember('ezra'), null, 'no member');
      assert.equal(tokenCount(x.store, 'ezra'), 0, 'no token');
      assert.equal(lastAuditId(x), audited, 'no audit entry');
    } finally { await x.stop(); }
  });
});

// No Chatter needed: these commands touch only the bridge's own database.
describe('T13c item 7: the CLI makes each change and its audit entry one transaction', () => {
  const FAIL_AUDIT = "CREATE TRIGGER audit_fails BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'audit insert failed'); END";
  /** A bridge state directory with the admin flan and thom, who holds a token. */
  const stateDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-cli-'));
    const s = new Store(path.join(dir, 'bridge.db'));
    try {
      s.addMember({ handle: 'flan', kind: 'human', role: 'admin', tailscale_login: 'flan@example.com' });
      s.addMember({ handle: 'thom', kind: 'computational' });
      return { dir, token: s.issueToken('thom') };
    } finally { s.close(); }
  };
  const withStore = (dir, fn) => {
    const s = new Store(path.join(dir, 'bridge.db'));
    try { return fn(s); } finally { s.close(); }
  };
  // Only the exit code is kept: `token rotate` prints the new token.
  const cli = (dir, ...args) => new Promise((resolve) => {
    execFile(process.execPath, ['--no-warnings', BIN, ...args], { env: { ...process.env, CHATTER_BRIDGE_STATE_DIR: dir } }, (err) => resolve(err ? err.code : 0));
  });

  const commands = [
    ['token rotate', ['token', 'rotate', 'thom']],
    ['member revoke', ['member', 'revoke', 'thom']],
    ['member set', ['member', 'set', 'thom', '--agents', 'off', '--name', 'Thom R.']],
  ];
  for (const [name, args] of commands) {
    test(`${name}: a failed audit insert changes nothing`, async () => {
      const { dir, token } = stateDir();
      try {
        const was = withStore(dir, (s) => {
          s.db.exec(FAIL_AUDIT);
          return { member: s.getMember('thom'), tokens: tokenCount(s, 'thom') };
        });
        assert.equal(await cli(dir, ...args), 1, 'the command fails');
        withStore(dir, (s) => {
          assert.deepEqual(s.getMember('thom'), was.member, 'the member is unchanged');
          assert.equal(tokenCount(s, 'thom'), was.tokens, 'no token was issued');
          assert.ok(s.memberByToken(token)?.handle === 'thom', 'the old token still works');
          assert.equal(s.listAudit().length, 0, 'no audit entry');
        });
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
  }

  test('without a failure each command makes its change and writes its entry', async () => {
    const { dir, token } = stateDir();
    try {
      assert.equal(await cli(dir, 'member', 'set', 'thom', '--agents', 'off'), 0);
      assert.equal(await cli(dir, 'token', 'rotate', 'thom'), 0);
      withStore(dir, (s) => {
        assert.equal(s.getMember('thom').can_address_agents, false);
        assert.equal(s.memberByToken(token), null, 'the old token is dead');
        assert.equal(tokenCount(s, 'thom'), 2);
      });
      assert.equal(await cli(dir, 'member', 'revoke', 'thom'), 0);
      withStore(dir, (s) => {
        assert.equal(s.getMember('thom').status, 'revoked');
        assert.deepEqual(s.listAudit().map((e) => [e.actor, e.action, e.target]), [
          ['cli', 'member_revoke', 'thom'], ['cli', 'token_rotate', 'thom'], ['cli', 'member_update', 'thom'],
        ]);
      });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
