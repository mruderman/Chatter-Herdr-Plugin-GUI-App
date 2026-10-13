// T16 (F17): Chatter's `resolveRecipient` also counts the live named agents Herdr reports for the repo
// (`teamAgents`, from `herdr agent list`), which the agents table the bridge reads need not hold.
// No test here starts, stops or reaches a real Herdr. Herdr is a fake executable in a temp directory
// (helpers.js, makeFakeHerdr) or a path that does not exist, and every host built here is given its whole
// environment, with only the fake's directory on PATH: the real `herdr` is on this machine's PATH.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ChatterHost } from '../src/chatter.js';
import { agentListJson, haveChatter, makeEnv, makeFakeHerdr } from './helpers.js';

const SKIP = !haveChatter && 'set CHATTER_JS to a built Chatter checkout';
const LIVE = { ok: 'ok', unknown: 'unknown' };
const ERR = {
  agentsNotAllowed: 'agents_not_allowed', ambiguous: 'ambiguous_recipient', unknownRecipient: 'unknown_recipient',
  unverifiable: 'agents_unverifiable',
};
const HIDDEN = 'zed-helper';
const HIDDEN_PANE = 'w1:p9';
// Text in Herdr's answer that may reach the operator's log and nothing else.
const SECRET = 'HERDR-DETAIL-7f3a';
const NO_SERVER = JSON.stringify({ error: { code: 'server_not_running', message: 'herdr server is not running' } });

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

/** Holds the repo's write lock; `queued` settles once a send is waiting behind it (as in hardening.test.js). */
function holdWriteLock(x) {
  const gate = deferred();
  const queued = deferred();
  const withLock = x.host.withLock.bind(x.host);
  withLock(x.key, () => gate.promise);
  x.host.withLock = (key, fn) => { queued.resolve(); return withLock(key, fn); };
  return { queued: queued.promise, release: () => { x.host.withLock = withLock; gate.resolve(); } };
}

const audits = async (x) => (await x.api('flan', 'GET', '/v1/audit?limit=500')).body.entries;
/** A live agent of the scratch repo, as `herdr agent list` reports one, that never ran a chatter command. */
const hiddenAgent = (x) => ({ pane_id: HIDDEN_PANE, name: HIDDEN, workspace_id: 'w1', cwd: x.repo, branch: null, agent: 'pi', agent_status: 'idle' });

/**
 * A host used only for liveAgents(), in a temp directory: its environment is exactly `env` over a PATH that
 * holds the fake's directory (or nothing), so it can never find the real herdr. `undefined` removes a key.
 */
function hostFor({ fake = null, env = {}, ...options } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-live-'));
  const lines = [];
  const full = { PATH: fake ? fake.dir : path.join(dir, 'empty'), HERDR_BIN_PATH: fake ? fake.bin : path.join(dir, 'no-herdr'), ...env };
  for (const k of Object.keys(full)) if (full[k] === undefined) delete full[k];
  const host = new ChatterHost({ cmd: [path.join(dir, 'no-chatter')], memberConfigRoot: path.join(dir, 'members'), env: full, log: (l) => { lines.push(l); }, ...options });
  return { host, lines, dir, stop: () => { host.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

/** A fake herdr in its own temp directory, removed by `stop`. */
function fakeIn() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-fake-herdr-'));
  const fake = makeFakeHerdr(path.join(dir, 'bin'));
  return { fake, stop: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('T16 item 1: the bridge reads `herdr agent list` as Chatter reads it', () => {
  let f;
  before(() => { f = fakeIn(); });
  after(() => { f.stop(); });

  test('the names are the non-empty string names of the entries with a string pane_id, in any repo (Chatter\'s agentList)', async () => {
    f.fake.answer({
      stdout: agentListJson([
        { pane_id: 'w1:p1', name: 'alpha', cwd: '/somewhere', agent: 'pi', agent_status: 'idle' },
        { pane_id: 'w2:p1', name: 'outsider', cwd: '/another/repo', agent: 'codex', agent_status: 'working' },
        { pane_id: 'w1:p2', name: null }, { pane_id: 'w1:p3' }, { pane_id: 'w1:p4', name: '' }, { pane_id: 'w1:p5', name: 42 },
        { name: 'no-pane' }, { pane_id: 7, name: 'numeric-pane' }, 'a string', null, ['an', 'array'],
      ]),
    });
    const h = hostFor({ fake: f.fake });
    try {
      assert.deepEqual(await h.host.liveAgents(), { names: ['alpha', 'outsider'], status: LIVE.ok });
      assert.deepEqual(h.lines, [], 'nothing to log');
    } finally { h.stop(); }
  });

  test('the binary is HERDR_BIN_PATH, or herdr from PATH when that is unset or empty', async () => {
    f.fake.answer({ stdout: agentListJson([{ pane_id: 'w1:p1', name: 'alpha' }]) });
    for (const bin of [undefined, '']) {
      const h = hostFor({ fake: f.fake, env: { HERDR_BIN_PATH: bin } });
      try {
        assert.deepEqual(await h.host.liveAgents(), { names: ['alpha'], status: LIVE.ok }, JSON.stringify(bin));
      } finally { h.stop(); }
    }
  });

  test('it runs with the host\'s own Herdr variables, as the Chatter the host runs does, and without a pane id', async () => {
    f.fake.answer({ stdout: agentListJson([]) });
    const before = f.fake.calls().length;
    const env = { HERDR_SOCKET_PATH: '/run/user/0/nowhere/herdr.sock', HERDR_SESSION: 'scratch', HERDR_PANE_ID: 'w9:p9', HERDR_PANE_LABEL: 'x' };
    const h = hostFor({ fake: f.fake, env });
    try {
      await h.host.liveAgents();
      const calls = f.fake.calls().slice(before);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].args, ['agent', 'list']);
      assert.deepEqual(calls[0].env, { HERDR_SOCKET_PATH: env.HERDR_SOCKET_PATH, HERDR_SESSION: env.HERDR_SESSION, HERDR_PANE_ID: null });
    } finally { h.stop(); }
  });

  test('no herdr where HERDR_BIN_PATH points (ENOENT) is no live agents, status ok, nothing logged', async () => {
    const h = hostFor();
    try {
      assert.deepEqual(await h.host.liveAgents(), { names: [], status: LIVE.ok });
      assert.deepEqual(h.lines, []);
    } finally { h.stop(); }
  });

  test('Herdr\'s "server_not_running", on stdout or on stderr, is no live agents, status ok', async () => {
    for (const answer of [{ stdout: NO_SERVER, code: 1 }, { stderr: NO_SERVER, code: 1 }]) {
      f.fake.answer(answer);
      const h = hostFor({ fake: f.fake });
      try {
        assert.deepEqual(await h.host.liveAgents(), { names: [], status: LIVE.ok }, JSON.stringify(answer));
      } finally { h.stop(); }
    }
  });
});

describe('T16 item 1: an answer that cannot be read is unknown, and its detail goes to the log only', () => {
  let f;
  before(() => { f = fakeIn(); });
  after(() => { f.stop(); });

  const unknownWith = async (answer, options = {}) => {
    f.fake.answer(answer);
    const h = hostFor({ fake: f.fake, ...options });
    try {
      const live = await h.host.liveAgents();
      return { live, lines: h.lines };
    } finally { h.stop(); }
  };

  test('a hang past the timeout: unknown, answered at the timeout, and logged', async () => {
    const t0 = Date.now();
    const { live, lines } = await unknownWith({ stdout: agentListJson([{ pane_id: 'w1:p1', name: 'alpha' }]), hangMs: 20_000 }, { herdrTimeoutMs: 200 });
    const took = Date.now() - t0;
    assert.deepEqual(live, { names: [], status: LIVE.unknown });
    assert.ok(took < 5000, `answered after ${took} ms`);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /200 ms/);
  });

  test('a non-zero exit with any other answer: unknown, the answer in the log', async () => {
    const answers = [
      { stderr: JSON.stringify({ error: { code: 'protocol_mismatch', message: `${SECRET} /some/host/path` } }), code: 1 },
      { stdout: agentListJson([{ pane_id: 'w1:p1', name: SECRET }]), code: 2 },
      { stderr: `panic: ${SECRET}`, code: 101 },
    ];
    for (const answer of answers) {
      const { live, lines } = await unknownWith(answer);
      assert.deepEqual(live, { names: [], status: LIVE.unknown }, JSON.stringify(answer));
      assert.ok(lines.some((l) => l.includes(SECRET)), 'the log has what Herdr said');
    }
  });

  test('a failure to run it other than a missing binary (not executable): unknown, logged', { skip: process.getuid?.() === 0 && 'root ignores file modes' }, async () => {
    const plain = path.join(f.fake.dir, 'not-executable');
    fs.writeFileSync(plain, '#!/bin/sh\n', { mode: 0o644 });
    const { live, lines } = await unknownWith({ stdout: agentListJson([]) }, { env: { HERDR_BIN_PATH: plain } });
    assert.deepEqual(live, { names: [], status: LIVE.unknown });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /EACCES/);
  });

  test('output that is not the JSON of an agent list, with exit 0: unknown, logged', async () => {
    for (const stdout of [`garbage ${SECRET}`, '', 'null', '[]', '{"result":{}}', '{"result":{"agents":{}}}', JSON.stringify({ agents: [{ pane_id: 'w1:p1', name: 'alpha' }] })]) {
      const { live, lines } = await unknownWith({ stdout });
      assert.deepEqual(live, { names: [], status: LIVE.unknown }, stdout);
      assert.equal(lines.length, 1, stdout);
    }
  });
});

describe('T16 item 1: the answer is kept about 2 s, and callers meanwhile share one run', () => {
  let f;
  before(() => { f = fakeIn(); });
  after(() => { f.stop(); });

  test('concurrent calls share one run, a call within the TTL runs nothing, a call after it runs again', async () => {
    f.fake.answer({ stdout: agentListJson([{ pane_id: 'w1:p1', name: 'alpha' }]) });
    const h = hostFor({ fake: f.fake, liveTtlMs: 400 });
    try {
      const runs = () => f.fake.ownListRuns().length;
      const before = runs();
      const [a, b] = await Promise.all([h.host.liveAgents(), h.host.liveAgents()]);
      assert.deepEqual(a, { names: ['alpha'], status: LIVE.ok });
      assert.deepEqual(b, a);
      assert.equal(runs() - before, 1, 'one run for both');
      await h.host.liveAgents();
      assert.equal(runs() - before, 1, 'none within the TTL');
      await new Promise((r) => setTimeout(r, 450));
      await h.host.liveAgents();
      assert.equal(runs() - before, 2, 'one more after it');
    } finally { h.stop(); }
  });

  test('the default TTL is about 2 s', async () => {
    const h = hostFor({ fake: f.fake });
    try {
      const runs = () => f.fake.ownListRuns().length;
      const before = runs();
      await h.host.liveAgents();
      await new Promise((r) => setTimeout(r, 1000));
      await h.host.liveAgents();
      assert.equal(runs() - before, 1, 'kept after 1 s');
      await new Promise((r) => setTimeout(r, 1300));
      await h.host.liveAgents();
      assert.equal(runs() - before, 2, 'run again after 2.3 s');
    } finally { h.stop(); }
  });
});

describe('T16 item 2: a live agent only Herdr knows counts as an agent in every decision (7a, 7b)', { skip: SKIP }, () => {
  let x;
  const promptsTo = (pane) => x.herdr.prompts().filter((p) => p.pane === pane);
  before(async () => {
    x = await makeEnv({ fakeHerdr: true });
    x.addMember('rex', { can_address_agents: false });
    x.addMember('ada');
    x.addMember('zed', { kind: 'human' });
    x.herdr.answer({ stdout: agentListJson([hiddenAgent(x)]) });
    // The premise: Herdr reports zed-helper, the agents table does not hold it, so neither does the directory.
    const dir = await x.api('ada', 'GET', '/v1/directory');
    assert.ok(!dir.body.agents.includes(HIDDEN), 'zed-helper is not in the agents table');
  });
  after(async () => { await x.stop(); });

  test('7b: a restricted member\'s @zed-h, @zed and @zed-helper are refused 403; nothing written, typed or audited', async () => {
    const before = { rows: x.count(), prompts: promptsTo(HIDDEN_PANE).length };
    for (const [mention, named] of [['@zed-h', true], ['@zed', true], [`@${HIDDEN}`, false]]) {
      const r = await x.post('rex', '#chat', `${mention} from a member who may not address agents`);
      assert.equal(r.status, 403, `${mention}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error.code, ERR.agentsNotAllowed, mention);
      if (named) assert.match(r.body.error.message, new RegExp(`^${mention} is the start of the name of the Herdr agent ${HIDDEN}, `), mention);
    }
    assert.equal(x.count(), before.rows, 'nothing was written');
    assert.equal(promptsTo(HIDDEN_PANE).length, before.prompts, 'nothing was typed into zed-helper\'s terminal');
    assert.ok(!(await audits(x)).some((a) => a.actor === 'rex'), 'nothing audited for rex');
  });

  test('7a: a DM to the member zed, the start of the live name, is refused 409 for a restricted member, a permitted one and the admin', async () => {
    const before = { rows: x.count(), prompts: promptsTo(HIDDEN_PANE).length };
    for (const who of ['rex', 'ada', 'flan']) {
      const r = await x.post(who, 'zed', `for zed, from ${who}`);
      assert.equal(r.status, 409, `${who}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error.code, ERR.ambiguous, who);
      assert.match(r.body.error.message, /^"zed" is the start of the name of the Herdr agent zed-helper, /, who);
    }
    assert.equal(x.count(), before.rows, 'nothing was written');
    assert.equal(promptsTo(HIDDEN_PANE).length, before.prompts, 'nothing was typed into zed-helper\'s terminal');
  });

  test('a DM to the exact live name is a DM to an agent: delivered and audited as dm_agent for a permitted member, 403 for a restricted one', async () => {
    const refused = await x.post('rex', HIDDEN, 'from a member who may not address agents');
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    assert.equal(refused.body.error.code, ERR.agentsNotAllowed);

    const body = 'a DM from ada to the live agent';
    const r = await x.post('ada', HIDDEN, body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.delivery, 'delivered');
    assert.ok(promptsTo(HIDDEN_PANE).some((p) => p.text.includes(body)), 'Chatter typed it into zed-helper\'s terminal');
    assert.ok((await audits(x)).some((a) => a.actor === 'ada' && a.action === 'dm_agent' && a.target === HIDDEN && a.message_id === r.body.id), 'audited as a DM to an agent');
  });

  test('a DM to the bare prefix zed-h is refused 404, as before', async () => {
    for (const who of ['rex', 'ada']) {
      const r = await x.post(who, 'zed-h', 'for nobody');
      assert.equal(r.status, 404, who);
      assert.equal(r.body.error.code, ERR.unknownRecipient, who);
    }
  });

  test('a permitted member\'s @zed reaches zed-helper, as Chatter resolves it, and the push is audited', async () => {
    const r = await x.post('ada', '#chat', '@zed hello, from ada');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.pushed, [HIDDEN]);
    assert.deepEqual(r.body.mentioned_members, ['zed']);
    assert.ok((await audits(x)).some((a) => a.actor === 'ada' && a.action === 'push_agent' && a.target === HIDDEN && a.message_id === r.body.id));
  });
});

describe('T16 item 1: the bridge asks the same Herdr as the Chatter it runs', { skip: SKIP }, () => {
  test('within one send, the bridge\'s agent list and Chatter\'s own see the same Herdr variables, and no pane id', async () => {
    const x = await makeEnv({ fakeHerdr: true });
    try {
      // As if the bridge ran inside a Herdr pane: Chatter's runs drop the pane id, and so must the bridge's.
      Object.assign(x.host.env, { HERDR_SOCKET_PATH: path.join(x.root, 'herdr.sock'), HERDR_SESSION: 'scratch', HERDR_PANE_ID: 'w9:p9' });
      x.addMember('ada');
      x.herdr.answer({ stdout: agentListJson([hiddenAgent(x)]) });
      const r = await x.post('ada', '#chat', '@zed-helper hello');
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const own = x.herdr.ownListRuns();
      const chatter = x.herdr.otherListRuns();
      assert.ok(own.length >= 1, 'the bridge asked');
      assert.ok(chatter.length >= 1, 'Chatter asked');
      const expected = { HERDR_SOCKET_PATH: path.join(x.root, 'herdr.sock'), HERDR_SESSION: 'scratch', HERDR_PANE_ID: null };
      for (const c of [...own, ...chatter]) assert.deepEqual(c.env, expected);
    } finally { await x.stop(); }
  });
});

describe('T16 item 3: while Herdr\'s answer cannot be read, a member who may not address agents may name no one', { skip: SKIP }, () => {
  // The bridge's own run hangs; Chatter's own runs answer at once (with no live agent, as Chatter reads them).
  const kinds = [
    ['a hang past the timeout', () => ({ stdout: agentListJson([]), hangMs: 20_000, hangParent: process.pid }), /200 ms/],
    ['an unexpected error', () => ({ stderr: JSON.stringify({ error: { code: 'protocol_mismatch', message: `${SECRET} at /var/host/path` } }), code: 1 }), new RegExp(SECRET)],
    ['garbage', () => ({ stdout: `garbage ${SECRET}` }), new RegExp(SECRET)],
  ];
  for (const [kind, answer, logged] of kinds) {
    test(`${kind}: a mention or a DM by a restricted member is refused 503 before it takes a slot; nothing else changes`, async () => {
      const lines = [];
      const x = await makeEnv({ fakeHerdr: true, log: (l) => { lines.push(l); }, limits: { maxBody: 8000, postsPerMinute: 1 }, hostOptions: { herdrTimeoutMs: 200 } });
      try {
        x.addMember('rex', { can_address_agents: false });
        for (const h of ['ada', 'ivo', 'kai']) x.addMember(h);
        x.herdr.answer(answer());
        const before = x.count();
        for (const [to, body] of [['#chat', 'hey @kai'], ['kai', 'a DM for kai']]) {
          const r = await x.post('rex', to, body);
          assert.equal(r.status, 503, `${to}: ${JSON.stringify(r.body)}`);
          assert.equal(r.body.error.code, ERR.unverifiable);
          const text = JSON.stringify(r.body);
          assert.ok(!text.includes(SECRET) && !text.includes(x.root) && !text.includes('/var/host'), 'nothing of Herdr\'s answer in the answer');
        }
        assert.equal(x.count(), before, 'nothing was written');
        assert.ok(lines.some((l) => logged.test(l)), 'the log has the detail');
        // Neither refusal took rex's one slot a minute: a plain post goes through.
        const plain = await x.post('rex', '#chat', 'a plain post names no one');
        assert.equal(plain.status, 201, JSON.stringify(plain.body));
        // Members who may address agents, and the admin, are unaffected.
        for (const [who, to, body] of [['ada', '#chat', 'hey @kai'], ['ivo', 'kai', 'a DM for kai'], ['flan', '#chat', 'hey @kai']]) {
          const r = await x.post(who, to, body);
          assert.equal(r.status, 201, `${who}: ${JSON.stringify(r.body)}`);
        }
      } finally { await x.stop(); }
    });
  }
});

describe('T16 item 1: no Herdr, or no Herdr server, is no live agents, and nothing changes', { skip: SKIP }, () => {
  const restrictedStillTalksToMembers = async (x) => {
    x.addMember('rex', { can_address_agents: false });
    x.addMember('kai');
    assert.deepEqual(await x.host.liveAgents(), { names: [], status: LIVE.ok });
    for (const [to, body] of [['#chat', 'hey @kai'], ['kai', 'a DM for kai']]) {
      const r = await x.post('rex', to, body);
      assert.equal(r.status, 201, `${to}: ${JSON.stringify(r.body)}`);
    }
  };

  test('no herdr binary (ENOENT, as in every other test): a restricted member mentions and messages members as before', async () => {
    const x = await makeEnv();
    try { await restrictedStillTalksToMembers(x); } finally { await x.stop(); }
  });

  test('Herdr says no server is running: the same', async () => {
    const x = await makeEnv({ fakeHerdr: true });
    try {
      x.herdr.answer({ stderr: NO_SERVER, code: 1 });
      await restrictedStillTalksToMembers(x);
    } finally { await x.stop(); }
  });
});

describe('T16 item 2: the live agents are loaded with the agent names, before each decision of a send', { skip: SKIP }, () => {
  test('two sends within the TTL run herdr agent list once: the first send\'s two decisions share it, the second send reuses it', async () => {
    // A TTL no runner is slow enough to outlast: the test is about reuse, not about how long; the default
    // is checked at the host level above.
    const x = await makeEnv({ fakeHerdr: true, hostOptions: { liveTtlMs: 60_000 } });
    try {
      x.addMember('ada');
      const runs = () => x.herdr.ownListRuns().length;
      assert.equal((await x.post('ada', '#chat', 'one')).status, 201);
      assert.equal(runs(), 1, 'the decision before the lock and the one inside it share one run');
      assert.equal((await x.post('ada', '#chat', 'two')).status, 201);
      assert.equal(runs(), 1, 'the second send runs nothing');
    } finally { await x.stop(); }
  });

  test('an agent that goes live while a send waits at the lock is seen by the decision inside the lock', async () => {
    const x = await makeEnv({ fakeHerdr: true, hostOptions: { liveTtlMs: 0 } });
    try {
      x.addMember('rex', { can_address_agents: false });
      x.addMember('zed', { kind: 'human' });
      const before = x.count();
      const lock = holdWriteLock(x);
      // Admitted: no agent is live yet, and zed is a member.
      const sending = x.post('rex', '#chat', '@zed hello, admitted before zed-helper started');
      await lock.queued;
      x.herdr.answer({ stdout: agentListJson([hiddenAgent(x)]) });
      lock.release();
      const r = await sending;
      assert.equal(r.status, 403, JSON.stringify(r.body));
      assert.equal(r.body.error.code, ERR.agentsNotAllowed);
      assert.equal(x.count(), before, 'nothing was written');
      assert.equal(x.herdr.prompts().length, 0, 'nothing was typed into any terminal');
    } finally { await x.stop(); }
  });

  test('each decision follows a finished load of the live agents, and from the second decision to the spawn nothing awaits', async () => {
    const x = await makeEnv({ fakeHerdr: true });
    try {
      x.addMember('ada');
      const events = [];
      const liveAgents = x.host.liveAgents;
      x.host.liveAgents = function loading(...args) {
        return liveAgents.apply(this, args).then((live) => { events.push('live'); return live; });
      };
      // Each decision reads the repo's roster, once before the lock and once inside it.
      let decisions = 0;
      const rosterNames = x.host.rosterNames;
      x.host.rosterNames = function deciding(repo) {
        decisions += 1;
        events.push('decide');
        // The earliest that anything else in this process can run after the decision.
        if (decisions === 2) queueMicrotask(() => events.push('next'));
        return rosterNames.call(this, repo);
      };
      const run = x.host.run;
      x.host.run = function spawning(o) {
        if (o.args[0] === 'post') events.push('spawn');
        return run.call(this, o);
      };
      const r = await x.post('ada', '#chat', 'ordered');
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual(events, ['live', 'decide', 'live', 'decide', 'spawn', 'next']);
    } finally { await x.stop(); }
  });
});

describe('T16b: an exact name that only Herdr\'s session-wide list offers does not waive the wrong-recipient check', { skip: SKIP }, () => {
  // Here: zed-helper, registered and live, and kit-runner, live only, nothing else beginning with it. In another
  // repo: a live, unregistered agent named zed, which Chatter's `teamAgents` leaves out here. And the member zed.
  const FOREIGN_PANE = 'w2:p1';
  const ALONE = 'kit-runner';
  const ALONE_PANE = 'w1:p3';
  let x;
  before(async () => {
    x = await makeEnv({ fakeHerdr: true });
    x.addMember('ada');
    x.addMember('zed', { kind: 'human' });
    x.seedAgent(HIDDEN);
    const other = path.join(x.root, 'other-repo');
    fs.mkdirSync(other);
    const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: other, stdio: 'ignore' });
    git('init', '-q');
    git('commit', '--allow-empty', '-q', '-m', 'init');
    x.herdr.answer({
      stdout: agentListJson([
        hiddenAgent(x),
        { pane_id: FOREIGN_PANE, name: 'zed', workspace_id: 'w2', cwd: other, branch: null, agent: 'pi', agent_status: 'idle' },
        { pane_id: ALONE_PANE, name: ALONE, workspace_id: 'w1', cwd: x.repo, branch: null, agent: 'pi', agent_status: 'idle' },
      ]),
    });
  });
  after(async () => { await x.stop(); });

  test('a DM to zed is refused 409: Chatter here would take it for zed-helper; nothing is written or typed', async () => {
    const before = { rows: x.count(), prompts: x.herdr.prompts().length };
    const r = await x.post('ada', 'zed', 'private, for the member zed');
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error.code, ERR.ambiguous);
    assert.match(r.body.error.message, /^"zed" is the start of the name of the Herdr agent zed-helper, zed, /);
    assert.equal(x.count(), before.rows, 'nothing was written');
    assert.equal(x.herdr.prompts().length, before.prompts, 'nothing was typed into any terminal');
    assert.ok(!(await audits(x)).some((a) => a.actor === 'ada' && a.target === 'zed'), 'nothing audited');
  });

  test('a DM to an exact live name nothing else begins with is still a DM to that agent: delivered and audited', async () => {
    const body = 'a DM from ada to the live kit-runner';
    const r = await x.post('ada', ALONE, body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.delivery, 'delivered');
    assert.ok(x.herdr.prompts().some((p) => p.pane === ALONE_PANE && p.text.includes(body)), 'Chatter typed it into kit-runner\'s terminal');
    assert.ok((await audits(x)).some((a) => a.actor === 'ada' && a.action === 'dm_agent' && a.target === ALONE && a.message_id === r.body.id), 'audited as a DM to an agent');
  });
});
