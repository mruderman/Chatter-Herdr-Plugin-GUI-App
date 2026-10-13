#!/usr/bin/env node
// V3 of docs/plans/deploy-verify.md: the bridge, started as it is deployed, against a real Herdr that this script
// starts under a throwaway HOME, with dummy panes that only print what they receive. Read
// docs/runbooks/real-herdr-smoke.md first. Run:
//   CHATTER_JS=/home/cyanfam/src/chatter-prod/dist/bin/chatter.js node deploy/smoke/real-herdr-smoke.mjs
// It prints one table (id, expected, observed, verdict) and exits non-zero on any fail or blocked row.
//
// An admin `@everyone` types into every live agent's terminal. Nothing here is sent until the interlocks in
// ./interlocks.mjs have shown that the only Herdr in play is the one this script started, and every child runs
// with HOME and HERDR_SOCKET_PATH inside the throwaway home.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Abort, SendGate, childEnv, dirsHash, envProblems, herdrCount, herdrPids, isUnder, pidsWithHome, preflight,
  readEnviron, realDirs, realHome, realSocket,
} from './interlocks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const BRIDGE_BIN = path.join(ROOT, 'bridge', 'bin', 'chatter-bridge.js');
const EXPECTED_SHA = path.join(ROOT, 'docs', 'runbooks', 'chatter-prod', 'EXPECTED_SHA256');

// Short on purpose: a Unix socket path over about 100 characters fails (docs/runbooks/herdr-test-env.md).
const ISO = `/run/user/${process.getuid()}/hv-smoke`;
const SOCK = path.join(ISO, '.config', 'herdr', 'herdr.sock');
const HERDR_CONFIG = path.join(ISO, '.config', 'herdr', 'config.toml');
// Where Herdr keeps the plugin's config and state under this home; the bridge is pointed at the same two, as
// production's bridge is pointed at letta's, so the plugin's hooks and the bridge share one Chatter universe.
const PLUGIN_CFG = path.join(ISO, '.config', 'herdr', 'plugins', 'config', 'chatter');
const PLUGIN_STATE = path.join(ISO, '.local', 'state', 'herdr', 'plugins', 'chatter');
const BRIDGE_STATE = path.join(ISO, 'bridge-state');
const LOGS = path.join(ISO, 'logs');
const REPO = path.join(ISO, 'repo');
const OTHER = path.join(ISO, 'other');
// The dummy agent: `cat` under the name of a kind Herdr supports. Herdr 0.9.1 prompts only an agent whose
// kind's process owns the pane's foreground (a custom label is "not an active named agent").
const PI = path.join(ISO, 'bin', 'pi');
const KIND = 'pi';
const SOURCE = 'custom:hv-smoke';
const ADMIN = 'flan';
const RUN = crypto.randomBytes(3).toString('hex');
const FIXED_REPOS_FAILED = { error: { code: 'chatter_error', message: 'Chatter could not list the repositories' } };
const TRUNCATION = (n) => `[TRUNCATED: showing 700 of ${n} chars; read the full message with: chatter inbox --all]`;

const S = {
  rows: [], secrets: new Set(), gate: new SendGate(), createdIso: false, bridges: [], streams: [],
  startHash: null, startEntries: 0, startHerdr: null, tornDown: false, printed: false, facts: [],
  pushesSeen: [], audit4: null,
};
const T = {}; // tokens by handle; every value is also in S.secrets and never printed
const P = {}; // pane ids by dummy name
let CHATTER_JS = null;
let CHATTER_ROOT = null;
let HERDR_BIN = null;
let ENV = null;
let BRIDGE_ENV = null;
let B = null; // the bridge under test
let KEY = null;
let DatabaseSync = null;
let dirs = [];
let sockets = [];

// ------------------------------------------------------------------ helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const mark = (tag) => `${tag}-${RUN}`;
const clip = (s, n = 220) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}...` : t;
};
const sameSet = (a, b) => Array.isArray(a) && a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Alive and not a zombie: a child that exited but was not reaped yet is gone for every purpose here. */
function alive(pid) {
  try { return !/^\d+ \(.*\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; }
}

function waitSync(pred, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    sleepSync(100);
  }
  return pred();
}

async function until(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms} ms: ${what}`);
    await sleep(200);
  }
}

// Not resolved through symlinks: a multi-call binary picks its behaviour from the name it was run as.
function which(cmd) {
  for (const dir of (process.env.PATH || '').split(':')) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const p = path.join(dir, cmd);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch { /* not here */ }
  }
  return null;
}

/** Every printed byte goes through this: a token, or a token's SHA-256, never leaves the process. */
function redact(s) {
  let t = String(s ?? '');
  for (const x of S.secrets) t = t.split(x).join('<token>').split(sha256(x)).join('<token-hash>');
  return t;
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

// ------------------------------------------------------------------ rows
function row(id, expected, observed, verdict, reason = '') { S.rows.push({ id, expected, observed, verdict, reason }); }

function judge() {
  const bad = [];
  return {
    that(cond, msg) { if (!cond) bad.push(msg); return !!cond; },
    done(observed) { return { ok: bad.length === 0, observed, why: bad.join('; ') }; },
  };
}

/** A check: pass or fail on what it observed, blocked if it could not be carried out. */
async function check(id, expected, fn) {
  try {
    const { ok, observed, why } = await fn();
    row(id, expected, observed, ok ? 'pass' : 'fail', ok ? '' : why);
  } catch (e) {
    row(id, expected, '', 'blocked', e.message);
    if (e instanceof Abort) throw e;
  }
}

/** A setup step or interlock: anything short of a pass stops the run before (or without) another send. */
async function step(id, expected, fn) {
  try {
    const { ok, observed, why } = await fn();
    row(id, expected, observed, ok ? 'pass' : 'blocked', ok ? '' : why);
    if (!ok) throw new Abort(`${id}: ${why}`);
  } catch (e) {
    if (!S.rows.some((r) => r.id === id)) row(id, expected, '', 'blocked', e.message);
    throw e instanceof Abort ? e : new Abort(`${id}: ${e.message}`);
  }
}

// ------------------------------------------------------------------ herdr (throwaway only)
function herdrRaw(args, { timeout = 30_000 } = {}) {
  // The one way this script reaches Herdr: always the throwaway home and socket, whatever the caller's env.
  if (!ENV || ENV.HOME !== ISO || ENV.HERDR_SOCKET_PATH !== SOCK) throw new Abort('herdr was called without the throwaway environment');
  const r = spawnSync(HERDR_BIN, args, { env: ENV, cwd: ISO, encoding: 'utf8', timeout });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

function herdrJson(args) {
  const r = herdrRaw(args);
  const text = r.out.trim() || r.err.trim();
  let json = null;
  try { json = JSON.parse(text); } catch { /* some commands print nothing */ }
  if (r.code !== 0) throw new Error(`herdr ${args.slice(0, 2).join(' ')} failed: ${json?.error ? `${json.error.code} ${json.error.message}` : clip(text, 160)}`);
  return json;
}

const paneText = (pane) => herdrRaw(['pane', 'read', pane, '--source', 'recent-unwrapped', '--lines', '3000']).out;
const agentList = () => herdrJson(['agent', 'list']).result.agents;
const agentOf = (pane) => agentList().find((a) => a.pane_id === pane) || null;
const foreground = (pane) => herdrJson(['pane', 'process-info', '--pane', pane]).result.process_info.foreground_processes.map((p) => p.name);
const herdrOfIso = () => herdrPids().filter((pid) => { try { return readEnviron(pid).HOME === ISO; } catch { return false; } });

function lineOf(text, marker) {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.includes(marker));
  return i < 0 ? '' : lines.slice(i, i + 2).map((l) => l.trim()).join(' / ');
}

async function waitPane(pane, marker, ms = 10_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const t = paneText(pane);
    if (t.includes(marker)) return t;
    // A hard wrap the reader could not undo still counts, read as one line.
    const flat = t.replace(/\n/g, '');
    if (flat.includes(marker)) return flat;
    await sleep(250);
  }
  return null;
}

const snapshot = () => Object.fromEntries(Object.entries(P).map(([n, id]) => [n, paneText(id)]));
const changedPanes = (a, b) => Object.keys(a).filter((k) => a[k] !== b[k]);

async function setState(pane, state) {
  herdrJson(['pane', 'report-agent', pane, '--source', SOURCE, '--agent', KIND, '--state', state]);
  await until(() => agentOf(pane)?.agent_status === state, 5000, `${pane} reported ${state}`);
}

/**
 * How a dummy pane becomes a live, named Chatter agent: report it as an agent of a supported kind, name it, run
 * `chatter whoami` inside it (which writes its row in the repo's agents table), then replace the shell with the
 * dummy. With `register: false` it stays an agent only Herdr knows.
 */
async function makeDummy(pane, name, { register }) {
  herdrJson(['pane', 'report-agent', pane, '--source', SOURCE, '--agent', KIND, '--state', 'idle']);
  herdrJson(['agent', 'rename', pane, name]);
  const tail = `stty -echo && exec ${q(PI)}`;
  const cmd = register ? `${q(process.execPath)} --no-warnings --experimental-sqlite ${q(CHATTER_JS)} whoami && ${tail}` : tail;
  herdrJson(['pane', 'run', pane, cmd]);
  await until(() => foreground(pane).includes(KIND), 20_000, `${name}'s pane never ran the dummy`);
}

async function shellReady(pane) {
  await until(() => paneText(pane).trim().length > 0, 15_000, `${pane} never showed a prompt`);
}

// ------------------------------------------------------------------ chatter's database (read-only)
function readChatter(key, sql, ...params) {
  const db = new DatabaseSync(path.join(PLUGIN_STATE, 'repos', key, 'chatter.db'), { readOnly: true });
  try { return db.prepare(sql).all(...params); } finally { db.close(); }
}

function universeOf(root) {
  const dir = path.join(PLUGIN_STATE, 'repos');
  if (!fs.existsSync(dir)) return null;
  for (const k of fs.readdirSync(dir)) {
    if (!fs.existsSync(path.join(dir, k, 'chatter.db'))) continue;
    const v = readChatter(k, "SELECT value FROM ui_marks WHERE agent = '_repo' AND mark = 'root'")[0]?.value;
    if (v === root) return k;
  }
  return null;
}

const rowsWith = (marker) => readChatter(KEY, 'SELECT id, from_agent, to_agent, kind, ref_id, delivered_at, read_at FROM messages WHERE instr(body, ?) > 0 ORDER BY id', marker);

// ------------------------------------------------------------------ the bridge
function bridgeCli(args) {
  return spawnSync(process.execPath, ['--no-warnings', BRIDGE_BIN, ...args], { env: BRIDGE_ENV, cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
}

/** The CLI prints a token on its last line; the output itself is never shown, since it holds one. */
function tokenFrom(r, what) {
  if (r.status !== 0) throw new Error(`${what} failed (exit ${r.status}): ${clip(r.stderr, 200)}`);
  const t = (r.stdout || '').split('\n').map((l) => l.trim()).filter((l) => /^cb_[A-Za-z0-9_-]{20,}$/.test(l)).pop();
  if (!t) throw new Error(`${what} printed no token`);
  S.secrets.add(t);
  return t;
}

async function startBridge(name, env) {
  const port = await freePort();
  const log = path.join(LOGS, `${name}.log`);
  const fd = fs.openSync(log, 'a');
  const child = spawn(process.execPath, ['--no-warnings', BRIDGE_BIN, 'serve', '--host', '127.0.0.1', '--port', String(port)], { env, cwd: ROOT, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  child.on('error', () => {});
  const b = { name, pid: child.pid, port, log, base: `http://127.0.0.1:${port}` };
  S.bridges.push(b);
  await until(async () => {
    try { await fetch(`${b.base}/healthz`); return true; } catch { return false; }
  }, 15_000, `${name} never answered`);
  return b;
}

async function api(base, token, method, p, body) {
  if (method !== 'GET') S.gate.assertOpen(`${method} ${p}`);
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${base}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: json, text };
}

const send = (token, to, body) => api(B.base, token, 'POST', `/v1/repos/${KEY}/messages`, { to, body });
const said = (r) => `${r.status}${r.body?.error ? ` ${r.body.error.code}` : ''}`;
const maxAuditId = async () => (await api(B.base, T[ADMIN], 'GET', '/v1/audit?limit=1')).body.entries[0]?.id ?? 0;
const auditAll = async () => (await api(B.base, T[ADMIN], 'GET', '/v1/audit?limit=500')).body.entries;

async function openStream(token) {
  const ctrl = new AbortController();
  const res = await fetch(`${B.base}/v1/repos/${KEY}/stream`, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal });
  const events = [];
  if (res.status === 200) {
    (async () => {
      let buf = '';
      for await (const chunk of res.body) {
        buf += Buffer.from(chunk).toString('utf8');
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const ev = {};
          for (const line of buf.slice(0, i).split('\n')) {
            if (!line || line.startsWith(':')) continue;
            const j = line.indexOf(':');
            const k = line.slice(0, j);
            const v = line.slice(j + 1).trim();
            if (k === 'data') { try { ev.data = JSON.parse(v); } catch { ev.data = v; } } else ev[k] = v;
          }
          buf = buf.slice(i + 2);
          if (ev.event) events.push(ev);
        }
      }
    })().catch(() => {});
  }
  const s = {
    status: res.status,
    events,
    close: () => ctrl.abort(),
    async waitFor(pred, ms = 5000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const f = events.find(pred);
        if (f) return f;
        await sleep(50);
      }
      return null;
    },
  };
  S.streams.push(s);
  return s;
}

// ------------------------------------------------------------------ setup
async function preconditions() {
  await step('I1', 'Preconditions, before anything starts: nothing accepts a connection on the real default socket; the real Herdr directories are hashed; no herdr process runs; $ISO does not exist; CHATTER_JS is the production-identical copy with the upstream manifest', async () => {
    const j = judge();
    const home = realHome();
    const extra = (process.env.SMOKE_EXTRA_GUARD_SOCKETS || '').split(':').filter(Boolean);
    // Additive only: a test can add a socket to the guard, never take the real one away.
    sockets = [realSocket(home), ...extra];
    dirs = realDirs(home);
    CHATTER_JS = process.env.CHATTER_JS || null;
    j.that(CHATTER_JS && fs.existsSync(CHATTER_JS), 'CHATTER_JS is not set to an existing chatter.js');
    if (!CHATTER_JS || !fs.existsSync(CHATTER_JS)) return j.done('');
    CHATTER_ROOT = path.resolve(path.dirname(CHATTER_JS), '..', '..');
    let matched = 0;
    const expected = fs.readFileSync(EXPECTED_SHA, 'utf8').split('\n').filter(Boolean).map((l) => l.split(/\s+/));
    for (const [hash, rel] of expected) {
      const f = path.join(CHATTER_ROOT, rel);
      if (fs.existsSync(f) && sha256(fs.readFileSync(f)) === hash) matched += 1;
    }
    j.that(matched === expected.length, `CHATTER_JS's tree matches ${matched} of ${expected.length} production hashes`);
    const toml = fs.readFileSync(path.join(CHATTER_ROOT, 'herdr-plugin.toml'), 'utf8');
    const upstream = !toml.includes('/home/letta') && /"dist\/bin\/chatter\.js", "_startup"/.test(toml);
    j.that(upstream, 'herdr-plugin.toml is not the upstream one (absolute paths, or no relative _startup)');
    HERDR_BIN = which('herdr');
    j.that(HERDR_BIN, 'no herdr on PATH');
    S.startHerdr = herdrCount();
    j.that(S.startHerdr === 0, `${S.startHerdr} herdr process(es) already run; every herdr process must be this run's own`);
    j.that(!fs.existsSync(ISO), `${ISO} already exists (a run that did not finish?): check that nothing runs from it, then remove it`);
    const h = dirsHash(dirs);
    S.startHash = h.hash;
    S.startEntries = h.entries;
    let states = [];
    try { states = (await preflight({ sockets, dirs, startHash: S.startHash })).states; } catch (e) { j.that(false, e.message); }
    return j.done(`sockets: ${states.join(', ') || 'not judged'}; herdr processes: ${S.startHerdr}; real dirs: ${h.entries} entries, sha256 ${h.hash.slice(0, 16)}; chatter: ${matched}/${expected.length} production hashes, manifest upstream: ${upstream ? 'yes' : 'no'}; herdr: ${HERDR_BIN}`);
  });
}

async function setupHerdr() {
  await step('I2', 'A Herdr server under HOME=$ISO only, update and manifest checks off, Chatter linked from the production-identical copy, its startup hook run', async () => {
    const j = judge();
    fs.mkdirSync(ISO, { mode: 0o700 });
    S.createdIso = true;
    for (const d of [LOGS, path.dirname(PI), path.dirname(HERDR_CONFIG)]) fs.mkdirSync(d, { recursive: true });
    fs.symlinkSync(which('cat'), PI);
    ENV = childEnv(process.env, ISO, { HERDR_BIN_PATH: HERDR_BIN });
    fs.writeFileSync(HERDR_CONFIG, '[update]\nversion_check = false\nmanifest_check = false\n');
    const version = herdrRaw(['--version']).out.trim();
    S.facts.push(`herdr: ${version}`);
    const link = herdrJson(['plugin', 'link', CHATTER_ROOT]).result.plugin;
    j.that(link.plugin_root === CHATTER_ROOT && link.enabled && link.source?.kind === 'local', 'plugin link did not register the local copy, enabled');
    j.that(link.startup?.length === 1 && link.events?.length === 3, 'the manifest has no startup hook or not the three event hooks');
    // The hooks' human (Chatter's `humanName`) is the admin, as on production.
    fs.mkdirSync(PLUGIN_CFG, { recursive: true });
    fs.writeFileSync(path.join(PLUGIN_CFG, 'name'), `${ADMIN}\n`);
    // Not a child of this process (setsid -f), so a stopped server leaves no zombie that a count could mistake.
    const out = fs.openSync(path.join(LOGS, 'herdr-server.out'), 'a');
    const setsid = which('setsid');
    const r = spawnSync(setsid, ['-f', HERDR_BIN, 'server'], { env: ENV, cwd: ISO, stdio: ['ignore', out, out] });
    fs.closeSync(out);
    j.that(r.status === 0, `setsid -f herdr server exited ${r.status}`);
    const status = await until(() => {
      const s = herdrRaw(['status']).out;
      return /status: running/.test(s) && s.includes(`socket: ${SOCK}`) ? s : null;
    }, 20_000, 'the throwaway server never reported running on its socket');
    const ours = herdrOfIso();
    j.that(ours.length === 1, `${ours.length} herdr processes with HOME=$ISO`);
    const startup = await until(() => herdrJson(['plugin', 'log', 'list', '--plugin', 'chatter']).result.logs.find((l) => l.event === 'startup' && l.status !== 'running'), 20_000, 'the startup hook never finished');
    j.that(startup.status === 'succeeded', `startup hook ${startup.status}`);
    const pointer = fs.readFileSync(path.join(PLUGIN_CFG, 'state-dir'), 'utf8').trim();
    j.that(pointer === PLUGIN_STATE, 'the plugin state directory is not the one the bridge will use');
    const proto = /private_protocol: (\d+)/.exec(status)?.[1];
    S.facts.push(`server protocol ${proto}`);
    return j.done(`${version}, protocol ${proto}, server pid ${ours.join(',')}, socket ${SOCK}; config.toml [update] version_check=false manifest_check=false; plugin linked (local, enabled) from ${CHATTER_ROOT}; startup hook ${startup.status}: "${clip(startup.stdout, 60)}"; state-dir pointer = ${pointer}`);
  });
}

async function setupPanes() {
  await step('I3', 'Dummy panes: alpha and coder (agents of the repo), plain (cat, not an agent), outsider (an agent of another repo); each agent registered by `chatter whoami` in its own pane, then replaced by the dummy', async () => {
    const j = judge();
    const git = (dir, ...a) => spawnSync('git', ['-C', dir, '-c', 'user.email=smoke@example.test', '-c', 'user.name=smoke', ...a], { env: ENV, encoding: 'utf8' });
    for (const d of [REPO, OTHER]) {
      fs.mkdirSync(d);
      j.that(git(d, 'init', '-q').status === 0 && git(d, 'commit', '--allow-empty', '-q', '-m', 'init').status === 0, `git init in ${d} failed`);
    }
    const ws = herdrJson(['workspace', 'create', '--cwd', REPO, '--label', 'hv-smoke', '--no-focus']).result;
    P.alpha = ws.root_pane.pane_id;
    P.coder = herdrJson(['pane', 'split', P.alpha, '--direction', 'right', '--cwd', REPO, '--no-focus']).result.pane.pane_id;
    P.plain = herdrJson(['pane', 'split', P.alpha, '--direction', 'down', '--cwd', REPO, '--no-focus']).result.pane.pane_id;
    P.outsider = herdrJson(['workspace', 'create', '--cwd', OTHER, '--label', 'hv-other', '--no-focus']).result.root_pane.pane_id;
    for (const p of Object.values(P)) await shellReady(p);
    await makeDummy(P.alpha, 'alpha', { register: true });
    await makeDummy(P.coder, 'coder', { register: true });
    await makeDummy(P.outsider, 'outsider', { register: true });
    herdrJson(['pane', 'run', P.plain, 'stty -echo && exec cat']);
    await until(() => foreground(P.plain).includes('cat'), 15_000, 'the plain pane never ran cat');
    const list = agentList();
    const show = [];
    for (const n of ['alpha', 'coder', 'outsider']) {
      const a = list.find((x) => x.pane_id === P[n]);
      j.that(a && a.name === n && a.agent === KIND && a.agent_status === 'idle', `${n} is not a named, idle ${KIND} agent`);
      show.push(`${n} ${P[n]} agent=${a?.agent} status=${a?.agent_status} fg=${foreground(P[n]).join(',')}`);
    }
    j.that(!list.some((x) => x.pane_id === P.plain), 'the plain pane is listed as an agent');
    show.push(`plain ${P.plain} fg=${foreground(P.plain).join(',')}, not an agent`);
    KEY = universeOf(REPO);
    const otherKey = universeOf(OTHER);
    j.that(KEY && otherKey, 'chatter whoami created no universe for the repos');
    const reg = KEY ? readChatter(KEY, 'SELECT name, pane_id FROM agents WHERE departed_at IS NULL ORDER BY name').map((r) => `${r.name}@${r.pane_id}`) : [];
    const regOther = otherKey ? readChatter(otherKey, 'SELECT name FROM agents WHERE departed_at IS NULL').map((r) => r.name) : [];
    j.that(sameSet(reg, [`alpha@${P.alpha}`, `coder@${P.coder}`]), `repo's agents table holds ${reg.join(', ')}`);
    j.that(sameSet(regOther, ['outsider']), `other repo's agents table holds ${regOther.join(', ')}`);
    return j.done(`${show.join('; ')}; agents table: repo [${reg.join(', ')}], other [${regOther.join(', ')}]`);
  });
}

async function setupBridge() {
  await step('I4', 'The bridge as deployed: `node bridge/bin/chatter-bridge.js serve --host 127.0.0.1 --port <free>` with HOME=$ISO, the throwaway socket, state, admin config and CHATTER_CMD of the production-identical Chatter; the admin made by the CLI', async () => {
    const j = judge();
    BRIDGE_ENV = Object.freeze({
      ...ENV,
      CHATTER_BRIDGE_STATE_DIR: BRIDGE_STATE,
      CHATTER_CMD: JSON.stringify([process.execPath, '--no-warnings', '--experimental-sqlite', CHATTER_JS]),
      CHATTER_ADMIN_CONFIG_DIR: PLUGIN_CFG,
      CHATTER_STATE_DIR: PLUGIN_STATE,
    });
    const init = bridgeCli(['init', '--login', 'flan@example.test', '--handle', ADMIN, '--name', 'Flan']);
    j.that(init.status === 0, `init failed: ${clip(init.stderr)}`);
    T[ADMIN] = tokenFrom(bridgeCli(['token', 'rotate', ADMIN]), 'token rotate (admin)');
    B = await startBridge('bridge', BRIDGE_ENV);
    const h = await api(B.base, null, 'GET', '/healthz');
    j.that(h.status === 200 && h.body?.ok === true && h.body?.repos === 2, `/healthz ${h.status} ${clip(h.text, 80)}`);
    return j.done(`pid ${B.pid}, port ${B.port}; CHATTER_CMD [node, --no-warnings, --experimental-sqlite, ${CHATTER_JS}]; CHATTER_STATE_DIR = plugin state dir; admin "${ADMIN}" by \`init\`, its token by \`token rotate\` (captured, not printed); /healthz ${h.status} ${JSON.stringify(h.body)}`);
  });
}

async function sendGate() {
  await step('I5', 'Pre-send gate: the bridge\'s /proc/<pid>/environ has HOME=$ISO, HERDR_SOCKET_PATH under $ISO, no HERDR_PANE_*; nothing accepts on the real socket; the real dirs are unchanged; every herdr process runs with HOME=$ISO; every dummy agent is deliverable', async () => {
    const j = judge();
    const env = readEnviron(B.pid);
    const problems = envProblems(env, ISO);
    j.that(problems.length === 0, `bridge env: ${problems.join(', ')}`);
    j.that(env.HERDR_SOCKET_PATH === SOCK && env.CHATTER_STATE_DIR === PLUGIN_STATE, 'bridge env points elsewhere');
    let pre = null;
    try { pre = await preflight({ sockets, dirs, startHash: S.startHash }); } catch (e) { j.that(false, e.message); }
    const all = herdrPids();
    const ours = herdrOfIso();
    j.that(all.length === ours.length && ours.length === 1, `${all.length} herdr process(es), ${ours.length} with HOME=$ISO`);
    const list = agentList();
    for (const n of ['alpha', 'coder', 'outsider']) {
      const a = list.find((x) => x.pane_id === P[n]);
      j.that(a?.name === n && ['idle', 'done', 'working', 'unknown'].includes(a?.agent_status) && foreground(P[n]).includes(KIND), `${n} is not deliverable`);
    }
    const keys = Object.keys(env).filter((k) => k.startsWith('HERDR_')).sort();
    const r = j.done(`bridge env: HOME=$ISO, HERDR_SOCKET_PATH=${env.HERDR_SOCKET_PATH}, Herdr keys [${keys.join(', ')}], CHATTER_STATE_DIR, CHATTER_BRIDGE_STATE_DIR and CHATTER_ADMIN_CONFIG_DIR under $ISO; ${pre ? `${pre.states.join(', ')}; real dirs sha256 ${pre.hash.slice(0, 16)} (unchanged)` : 'preflight refused (see verdict)'}; herdr processes ${all.length}, all HOME=$ISO; dummies deliverable`);
    if (r.ok) S.gate.pass();
    return r;
  });
}

async function setupMembers() {
  await step('I6', 'Members added through the API by the admin: ada (computational, may address agents), rex (computational, can_address_agents off), grace and thom (computational), zed (human, no token); the repo is listed', async () => {
    const j = judge();
    const add = async (body) => {
      const r = await api(B.base, T[ADMIN], 'POST', '/v1/members', body);
      j.that(r.status === 201, `add ${body.handle}: ${said(r)}`);
      if (r.body?.token) { S.secrets.add(r.body.token); T[body.handle] = r.body.token; }
      return r;
    };
    await add({ handle: 'ada', display_name: 'Ada', kind: 'computational' });
    await add({ handle: 'rex', display_name: 'Rex', kind: 'computational', can_address_agents: false });
    await add({ handle: 'grace', display_name: 'Grace', kind: 'computational' });
    await add({ handle: 'thom', display_name: 'Thom', kind: 'computational' });
    await add({ handle: 'zed', display_name: 'Zed', kind: 'human' });
    const repos = await api(B.base, T[ADMIN], 'GET', '/v1/repos');
    const mine = repos.body?.repos?.find((r) => r.key === KEY);
    j.that(mine && mine.repo_root === REPO, 'the repo is not listed with its root');
    const me = await api(B.base, T.rex, 'GET', '/v1/me');
    j.that(me.body?.can_address_agents === false, 'rex may address agents');
    return j.done(`5 members added (201 each), tokens captured for ada, rex, grace, thom; repo ${KEY} (${repos.body?.repos?.length} repos listed); rex can_address_agents=${me.body?.can_address_agents}`);
  });
}

// ------------------------------------------------------------------ the checks
async function check1() {
  await check('1a', 'A permitted member\'s @mention of an idle agent: 201, pushed ["alpha"], delivery null (a post); alpha\'s pane shows it as a #chat mention from ada', async () => {
    const j = judge();
    const m = mark('M1A');
    const r = await send(T.ada, '#chat', `@alpha ${m} hello from the smoke`);
    j.that(r.status === 201, `status ${said(r)}`);
    j.that(sameSet(r.body?.pushed, ['alpha']), `pushed ${JSON.stringify(r.body?.pushed)}`);
    const seen = await waitPane(P.alpha, m);
    const line = seen ? lineOf(seen, m) : '';
    j.that(seen, 'the text never reached alpha\'s pane');
    j.that(line.includes(`[chatter] #chat mention from ada: @alpha ${m}`), 'no "#chat mention from ada" attribution');
    const row = readChatter(KEY, "SELECT delivered_at, read_at FROM messages WHERE kind = 'mention' AND to_agent = 'alpha' AND ref_id = ?", `p${r.body?.id}`)[0];
    if (seen) S.pushesSeen.push({ actor: 'ada', target: 'alpha', check: '1a' });
    return j.done(`${said(r)} pushed=${JSON.stringify(r.body?.pushed)} delivery=${r.body?.delivery}; pane: "${clip(line)}"; mention row delivered_at=${row?.delivered_at ?? 'null'} read_at=${row?.read_at ?? 'null'}`);
  });

  await check('1b', 'Queued when the pane is not ready: with alpha reported blocked, pushed ["alpha (queued)"] and nothing in the pane; reported idle, the plugin\'s pane.agent_status_changed hook (_flush) delivers it', async () => {
    const j = judge();
    await setState(P.alpha, 'blocked');
    const m = mark('M1B');
    const r = await send(T.ada, '#chat', `@alpha ${m} sent while alpha is blocked`);
    j.that(r.status === 201, `status ${said(r)}`);
    j.that(sameSet(r.body?.pushed, ['alpha (queued)']), `pushed ${JSON.stringify(r.body?.pushed)}`);
    await sleep(1500);
    const early = paneText(P.alpha).includes(m);
    j.that(!early, 'it reached the pane while alpha was blocked');
    const ref = `p${r.body?.id}`;
    const queued = readChatter(KEY, "SELECT delivered_at FROM messages WHERE kind = 'mention' AND to_agent = 'alpha' AND ref_id = ?", ref)[0];
    j.that(queued && queued.delivered_at === null, 'the mention row is not pending while blocked');
    const t0 = Date.now();
    await setState(P.alpha, 'idle');
    const seen = await waitPane(P.alpha, m, 15_000);
    const ms = Date.now() - t0;
    j.that(seen, 'never delivered after alpha reported idle');
    const after = readChatter(KEY, "SELECT delivered_at, read_at FROM messages WHERE kind = 'mention' AND to_agent = 'alpha' AND ref_id = ?", ref)[0];
    // Herdr records a hook run once it has exited, which can be after its delivery reached the pane.
    const flushes = () => herdrJson(['plugin', 'log', 'list', '--plugin', 'chatter']).result.logs
      .filter((l) => l.event === 'pane.agent_status_changed' && l.started_unix_ms >= t0 - 500 && /flushed \d+/.test(l.stdout || ''));
    const hooks = await until(() => (flushes().length ? flushes() : null), 5000, 'a _flush run that flushed').catch(() => []);
    j.that(hooks.length > 0, 'no _flush hook run reports a flush');
    if (seen) S.pushesSeen.push({ actor: 'ada', target: 'alpha', check: '1b' });
    return j.done(`${said(r)} pushed=${JSON.stringify(r.body?.pushed)}; in the pane while blocked: ${early ? 'yes' : 'no'}; row delivered_at while blocked: ${queued?.delivered_at ?? 'null'}; after "report-agent --state idle": in the pane after ${ms} ms ("${clip(lineOf(seen || '', m), 120)}"), delivered_at=${after?.delivered_at ?? 'null'}, read_at=${after?.read_at ?? 'null'}; hook: pane.agent_status_changed -> "${clip(hooks[0]?.stdout, 40)}"`);
  });

  await check('1c', 'A mention longer than 700 characters: the pane shows the first 700 and production\'s patched notice "[TRUNCATED: showing 700 of N chars; ...]"; read_at stays NULL after the terminal submission (the patch)', async () => {
    const j = judge();
    const keep = mark('KEEP');
    const cut = mark('CUT');
    const fill = (s, n) => s + 'f'.repeat(Math.max(0, n - s.length));
    let body = fill(`@alpha ${mark('M1C')} long message `, 600);
    body = fill(`${body} ${keep} `, 850);
    body = fill(`${body} ${cut} `, 1000);
    const r = await send(T.ada, '#chat', body);
    j.that(r.status === 201 && sameSet(r.body?.pushed, ['alpha']), `${said(r)} pushed ${JSON.stringify(r.body?.pushed)}`);
    const notice = TRUNCATION(body.length);
    const seen = await waitPane(P.alpha, notice);
    j.that(seen, `the pane never showed "${notice}"`);
    const flat = seen || '';
    j.that(flat.includes(keep), 'the text before character 700 is missing');
    j.that(!flat.includes(cut), 'text after character 700 reached the pane');
    const i = flat.indexOf(notice);
    const shown = i < 0 ? '' : flat.slice(Math.max(0, i - 40), i + notice.length + 60);
    const mrow = readChatter(KEY, "SELECT delivered_at, read_at, length(body) AS n FROM messages WHERE kind = 'mention' AND to_agent = 'alpha' AND ref_id = ?", `p${r.body?.id}`)[0];
    j.that(mrow?.delivered_at, 'the mention row was not marked delivered');
    j.that(mrow && mrow.read_at === null, `read_at is ${mrow?.read_at} (the local patch leaves it NULL)`);
    j.that(mrow?.n === body.length, 'the stored body is not the full text');
    if (seen) S.pushesSeen.push({ actor: 'ada', target: 'alpha', check: '1c' });
    return j.done(`${said(r)}; body ${body.length} chars, stored in full (${mrow?.n}); pane: "...${clip(shown, 240)}"; text past 700 in the pane: ${flat.includes(cut) ? 'yes' : 'no'}; mention row delivered_at=${mrow?.delivered_at ?? 'null'} read_at=${mrow?.read_at ?? 'NULL'}`);
  });
}

async function check2() {
  await check('2', 'A DM from a member to an agent: 201, delivery "delivered"; the pane shows the text attributed to the sender, with a reply hint naming the sender', async () => {
    const j = judge();
    const m = mark('M2');
    const r = await send(T.ada, 'alpha', `${m} a direct message to alpha`);
    j.that(r.status === 201 && r.body?.delivery === 'delivered', `${said(r)} delivery ${r.body?.delivery}`);
    const seen = await waitPane(P.alpha, m);
    const line = seen ? lineOf(seen, m) : '';
    j.that(line.includes(`[chatter] message from ada: ${m} a direct message to alpha`), 'the pane does not show "[chatter] message from ada: <text>"');
    j.that(line.includes('reply: chatter send ada'), 'no reply hint naming ada');
    const dm = rowsWith(m)[0];
    if (seen) S.pushesSeen.push({ actor: 'ada', target: 'alpha', check: '2' });
    return j.done(`${said(r)} delivery=${r.body?.delivery} pushed=${JSON.stringify(r.body?.pushed)}; pane: "${clip(line)}"; row ${dm?.from_agent}->${dm?.to_agent} kind=${dm?.kind} delivered_at=${dm?.delivered_at ?? 'null'} read_at=${dm?.read_at ?? 'NULL'}`);
  });
}

async function check3() {
  await check('3', 'The admin\'s @everyone reaches every live dummy agent of the repo and no other pane: pushes = live dummy agents of the repo; plain (not an agent) and outsider (an agent of another repo) get nothing', async () => {
    const j = judge();
    const live = agentList().filter((a) => a.name && isUnder(a.cwd, REPO)).map((a) => a.name).sort();
    const before = snapshot();
    const m = mark('M3');
    const r = await send(T[ADMIN], '#chat', `@everyone ${m} all hands`);
    j.that(r.status === 201, `status ${said(r)}`);
    const pushed = r.body?.pushed || [];
    j.that(sameSet(pushed, live) && pushed.length === 2, `pushed ${JSON.stringify(pushed)} for live ${JSON.stringify(live)}`);
    const got = [];
    for (const n of ['alpha', 'coder']) {
      const seen = await waitPane(P[n], m);
      if (seen) { got.push(n); S.pushesSeen.push({ actor: ADMIN, target: n, check: '3' }); }
      j.that(seen && lineOf(seen, m).includes(`[chatter] #chat mention from ${ADMIN}: @everyone ${m}`), `${n} did not get it as a mention from ${ADMIN}`);
    }
    await sleep(1000);
    const after = snapshot();
    const others = ['plain', 'outsider'].filter((n) => before[n] !== after[n] || after[n].includes(m));
    j.that(others.length === 0, `${others.join(', ')} changed`);
    return j.done(`${said(r)} pushed=${JSON.stringify(pushed)} (${pushed.length}) for live dummy agents of the repo ${JSON.stringify(live)} (${live.length}); panes with the text: ${got.join(', ')}; plain and outsider unchanged: ${others.length === 0 ? 'yes' : `no (${others.join(', ')})`}; 4 panes in all`);
  });
}

async function check4() {
  await check('4', 'A restricted member (can_address_agents off): a mention and a DM of an agent answer 403 agents_not_allowed; nothing in any pane, nothing written, nothing audited as a push', async () => {
    const j = judge();
    const before = snapshot();
    const mark0 = await maxAuditId();
    const m = mark('M4');
    const r1 = await send(T.rex, '#chat', `@alpha ${m} from a restricted member`);
    const r2 = await send(T.rex, 'alpha', `${m} a DM from a restricted member`);
    j.that(r1.status === 403 && r1.body?.error?.code === 'agents_not_allowed', `mention: ${said(r1)}`);
    j.that(r2.status === 403 && r2.body?.error?.code === 'agents_not_allowed', `DM: ${said(r2)}`);
    await sleep(1500);
    const changed = changedPanes(before, snapshot());
    j.that(changed.length === 0, `panes changed: ${changed.join(', ')}`);
    const written = rowsWith(m).length;
    j.that(written === 0, `${written} rows written`);
    const audited = (await auditAll()).filter((e) => e.id > mark0 && e.actor === 'rex');
    j.that(audited.length === 0, `${audited.length} audit entries by rex`);
    S.audit4 = { from: mark0, to: await maxAuditId() };
    return j.done(`mention ${said(r1)}, DM ${said(r2)}; panes changed: ${changed.length ? changed.join(', ') : 'none'}; rows written: ${written}; audit entries by rex since: ${audited.length}`);
  });
}

async function check5() {
  await check('5', 'A non-admin\'s @everyone and @everyoneX answer 403 everyone_admin_only (ada, who may address agents, and rex); rex\'s @codX (only a case-sensitive prefix of "coder" as Chatter reads it) answers 403 agents_not_allowed; nothing in any pane', async () => {
    const j = judge();
    const before = snapshot();
    const m = mark('M5');
    const tries = [
      ['ada', '@everyone', await send(T.ada, '#chat', `@everyone ${m} from a member`), 'everyone_admin_only'],
      ['ada', '@everyoneX', await send(T.ada, '#chat', `@everyoneX ${m} from a member`), 'everyone_admin_only'],
      ['rex', '@everyoneX', await send(T.rex, '#chat', `@everyoneX ${m} from a restricted member`), 'everyone_admin_only'],
      ['rex', '@codX', await send(T.rex, '#chat', `@codX ${m} from a restricted member`), 'agents_not_allowed'],
    ];
    for (const [who, what, r, code] of tries) j.that(r.status === 403 && r.body?.error?.code === code, `${who} ${what}: ${said(r)}`);
    await sleep(1500);
    const changed = changedPanes(before, snapshot());
    j.that(changed.length === 0, `panes changed: ${changed.join(', ')}`);
    const written = rowsWith(m).length;
    j.that(written === 0, `${written} rows written`);
    return j.done(`${tries.map(([who, what, r]) => `${who} ${what}: ${said(r)}`).join('; ')}; panes changed: ${changed.length ? changed.join(', ') : 'none'}; rows written: ${written}`);
  });
}

async function check6() {
  const isBye = (ev) => ev.event === 'bye';
  const isHello = (ev) => ev.event === 'hello';

  await check('6a', 'Revocation ends a live stream with bye revoked, and the token is refused afterwards (401)', async () => {
    const j = judge();
    const s = await openStream(T.grace);
    j.that(s.status === 200 && await s.waitFor(isHello), `stream ${s.status}`);
    const del = await api(B.base, T[ADMIN], 'DELETE', '/v1/members/grace');
    const bye = await s.waitFor(isBye, 3000);
    j.that(del.status === 200, `DELETE ${said(del)}`);
    j.that(bye?.data?.reason === 'revoked', `bye ${JSON.stringify(bye?.data)}`);
    const me = await api(B.base, T.grace, 'GET', '/v1/me');
    j.that(me.status === 401, `after: ${said(me)}`);
    return j.done(`stream ${s.status}, hello; DELETE /v1/members/grace ${said(del)}; bye ${JSON.stringify(bye?.data)}; GET /v1/me with the token ${said(me)}`);
  });

  await check('6b', 'Rotation through the HTTP route ends the old stream with bye token_rotated; the old token answers 401, the new one 200', async () => {
    const j = judge();
    const s = await openStream(T.thom);
    j.that(s.status === 200 && await s.waitFor(isHello), `stream ${s.status}`);
    const old = T.thom;
    const rot = await api(B.base, T[ADMIN], 'POST', '/v1/members/thom/token');
    if (rot.body?.token) { S.secrets.add(rot.body.token); T.thom = rot.body.token; }
    const bye = await s.waitFor(isBye, 3000);
    j.that(rot.status === 201 && rot.body?.token, `rotate ${said(rot)}`);
    j.that(bye?.data?.reason === 'token_rotated', `bye ${JSON.stringify(bye?.data)}`);
    const a = await api(B.base, old, 'GET', '/v1/me');
    const b = await api(B.base, T.thom, 'GET', '/v1/me');
    j.that(a.status === 401 && b.status === 200, `old ${said(a)}, new ${said(b)}`);
    return j.done(`POST /v1/members/thom/token ${said(rot)} (token captured, not printed); bye ${JSON.stringify(bye?.data)}; old token ${said(a)}, new token ${said(b)}`);
  });

  await check('6c', 'Rotation through the CLI (`chatter-bridge token rotate thom`, a separate process on the same state directory) ends the open stream with bye token_rotated within about 2 s', async () => {
    const j = judge();
    const s = await openStream(T.thom);
    j.that(s.status === 200 && await s.waitFor(isHello), `stream ${s.status}`);
    const old = T.thom;
    const t0 = Date.now();
    T.thom = tokenFrom(bridgeCli(['token', 'rotate', 'thom']), 'token rotate thom');
    const bye = await s.waitFor(isBye, 6000);
    const ms = Date.now() - t0;
    j.that(bye?.data?.reason === 'token_rotated', `bye ${JSON.stringify(bye?.data)}`);
    j.that(ms < 4000, `took ${ms} ms`);
    const a = await api(B.base, old, 'GET', '/v1/me');
    j.that(a.status === 401, `old token ${said(a)}`);
    return j.done(`CLI rotate exit 0 (token captured, not printed); bye ${JSON.stringify(bye?.data)} after ${ms} ms; old token ${said(a)}`);
  });
}

async function check9() {
  await check('9', 'A broken Chatter command (a second bridge on the same state, CHATTER_CMD pointing at a missing script): /healthz and /v1/repos answer 502 with the fixed message, to a member and to the admin; the detail is in the bridge\'s log; no path in any answer', async () => {
    const j = judge();
    const missing = path.join(ISO, 'missing', 'chatter.js');
    const broken = await startBridge('bridge-broken', Object.freeze({ ...BRIDGE_ENV, CHATTER_CMD: JSON.stringify([process.execPath, '--no-warnings', missing]) }));
    const answers = [
      ['/healthz', await api(broken.base, null, 'GET', '/healthz')],
      ['/v1/repos as ada', await api(broken.base, T.ada, 'GET', '/v1/repos')],
      ['/v1/repos as admin', await api(broken.base, T[ADMIN], 'GET', '/v1/repos')],
    ];
    const leaks = [ISO, missing, realHome(), 'Cannot find module', '    at ', 'node:internal'];
    for (const [what, r] of answers) {
      j.that(r.status === 502 && JSON.stringify(r.body) === JSON.stringify(FIXED_REPOS_FAILED), `${what}: ${r.status} ${clip(r.text, 100)}`);
      j.that(!leaks.some((l) => r.text.includes(l)), `${what} carries a path or Node's message`);
    }
    await sleep(300);
    // What Chatter printed spans several lines (node's loader error and a stack) after the bridge's one prefix.
    const log = fs.readFileSync(broken.log, 'utf8');
    const at = log.indexOf('chatter data failed');
    const block = at < 0 ? '' : log.slice(at, at + 3000);
    const lines = block.split('\n');
    j.that(block.includes(missing) && block.includes('Cannot find module'), 'the log lacks the detail');
    try { process.kill(broken.pid, 'SIGTERM'); } catch { /* already gone */ }
    return j.done(`${answers.map(([w, r]) => `${w}: ${r.status} ${r.text}`).join('; ')}; the log has "${clip(lines[0], 80)}" followed by "${clip(lines.find((l) => l.includes('Cannot find module')), 140)}"`);
  });
}

async function check7() {
  // A pane that only Herdr knows: a live, named agent of the repo that never ran chatter, so it is not in the
  // agents table the bridge reads. A member named "zed" has a handle that is the start of its name.
  const hidden = 'zed-helper';
  let facts;
  try {
    P.hidden = herdrJson(['pane', 'split', P.coder, '--direction', 'down', '--cwd', REPO, '--no-focus']).result.pane.pane_id;
    await shellReady(P.hidden);
    await makeDummy(P.hidden, hidden, { register: false });
    const inTable = readChatter(KEY, 'SELECT name FROM agents WHERE name = ?', hidden).length;
    const dir = await api(B.base, T.ada, 'GET', '/v1/directory');
    const a = agentOf(P.hidden);
    facts = `${hidden} (${P.hidden}): live in Herdr (name=${a?.name}, agent=${a?.agent}, ${a?.agent_status}, cwd in the repo: ${isUnder(a?.cwd, REPO) ? 'yes' : 'no'}), in the agents table: ${inTable ? 'yes' : 'no'}, in /v1/directory: ${dir.body?.agents?.includes(hidden) ? 'yes' : 'no'}`;
    if (a?.name !== hidden || inTable) throw new Error(`the Herdr-only agent is not as intended: ${facts}`);
  } catch (e) {
    if (e instanceof Abort) throw e;
    row('7a', 'DMs to a prefix of an agent only Herdr knows', '', 'blocked', e.message);
    row('7b', 'Mentions of an agent only Herdr knows', '', 'blocked', e.message);
    return;
  }
  const reached = (m) => paneText(P.hidden).includes(m);

  await check('7a', 'DMs to a prefix of an agent only Herdr knows (zed-helper), as a restricted member (rex) and a permitted one (ada): a bare prefix ("zed-h") is refused 404; a DM to the member "zed" must reach zed only, never the agent (fail closed)', async () => {
    const j = judge();
    const out = [facts];
    const cases = [
      ['rex', 'zed-h', T.rex], ['ada', 'zed-h', T.ada], ['rex', 'zed', T.rex], ['ada', 'zed', T.ada],
    ];
    for (const [who, to, token] of cases) {
      const m = mark(`M7A-${who}-${to}`);
      const r = await send(token, to, `${m} a DM from ${who} to ${to}`);
      await sleep(800);
      const inPane = reached(m);
      const stored = rowsWith(m).filter((x) => x.kind === 'chat');
      const where = stored.map((x) => `to_agent=${x.to_agent} delivered_at=${x.delivered_at ? 'set' : 'null'}`).join(', ') || 'no row';
      out.push(`${who} -> "${to}": ${said(r)} id=${r.body?.id ?? null} delivery=${r.body?.delivery ?? null} mentioned_members=${JSON.stringify(r.body?.mentioned_members ?? null)}; stored ${where}; in ${hidden}'s pane: ${inPane ? `YES ("${clip(lineOf(paneText(P.hidden), m), 90)}")` : 'no'}`);
      if (inPane) S.pushesSeen.push({ actor: who, target: hidden, check: '7a', dm: true });
      if (to === 'zed-h') j.that(r.status === 404 && !inPane, `${who} -> zed-h: ${said(r)}, in pane: ${inPane}`);
      if (to === 'zed') {
        j.that(!inPane, `BOUNDARY BREAK: ${who}'s DM addressed to member "zed" was typed into ${hidden}'s terminal`);
        j.that(stored.every((x) => x.to_agent === 'zed'), `BOUNDARY BREAK: ${who}'s DM to "zed" was stored for ${stored.map((x) => x.to_agent).join(', ')}`);
      }
    }
    return j.done(out.join(' || '));
  });

  await check('7b', 'Mentions of that agent in #chat by a restricted member (rex): a bare prefix (@zed-h), a member\'s handle that is its prefix (@zed), its exact name (@zed-helper); and @zed by a permitted member (ada). A restricted member must reach no agent (fail closed)', async () => {
    const j = judge();
    const out = [];
    const cases = [['rex', '@zed-h', T.rex], ['rex', '@zed', T.rex], ['rex', `@${hidden}`, T.rex], ['ada', '@zed', T.ada]];
    for (const [who, mention, token] of cases) {
      const m = mark(`M7B-${who}-${mention.slice(1)}`);
      const r = await send(token, '#chat', `${mention} ${m} a mention from ${who}`);
      await sleep(800);
      const inPane = reached(m);
      out.push(`${who} "${mention}": ${said(r)} pushed=${JSON.stringify(r.body?.pushed ?? null)} mentioned_members=${JSON.stringify(r.body?.mentioned_members ?? null)} warnings=${JSON.stringify(r.body?.warnings ?? null)}; in ${hidden}'s pane: ${inPane ? 'YES' : 'no'}`);
      if (inPane) S.pushesSeen.push({ actor: who, target: hidden, check: '7b' });
      if (who === 'rex') j.that(!inPane, `BOUNDARY BREAK: restricted member rex reached ${hidden} with "${mention}"`);
    }
    return j.done(out.join(' || '));
  });
}

async function check8() {
  await check('8', 'The audit log (GET /v1/audit as the admin) holds every push into an agent terminal, the @everyone and the registry changes, with the right actors; nothing by rex in check 4\'s window', async () => {
    const j = judge();
    const entries = await auditAll();
    const has = (actor, action, target) => entries.filter((e) => e.actor === actor && e.action === action && (target === undefined || e.target === target));
    const need = [
      ['cli', 'init', ADMIN], ['cli', 'token_rotate', ADMIN],
      [ADMIN, 'member_add', 'ada'], [ADMIN, 'member_add', 'rex'], [ADMIN, 'member_add', 'grace'], [ADMIN, 'member_add', 'thom'], [ADMIN, 'member_add', 'zed'],
      [ADMIN, 'member_revoke', 'grace'], [ADMIN, 'token_rotate', 'thom'], ['cli', 'token_rotate', 'thom'],
      ['ada', 'dm_agent', 'alpha'],
    ];
    const missing = need.filter(([a, act, t]) => has(a, act, t).length === 0).map((x) => x.join(' '));
    j.that(missing.length === 0, `missing: ${missing.join(', ')}`);
    const every = has(ADMIN, 'everyone');
    j.that(every.length === 1 && sameSet(every[0].detail?.pushed, ['alpha', 'coder']), `everyone entries ${JSON.stringify(every.map((e) => e.detail))}`);
    // Every push the panes showed, by sender and agent, against the entries that record a push into a terminal.
    const tally = new Map();
    for (const p of S.pushesSeen) tally.set(`${p.actor}>${p.target}`, (tally.get(`${p.actor}>${p.target}`) || 0) + 1);
    const unaudited = [];
    for (const [k, n] of tally) {
      const [actor, target] = k.split('>');
      const logged = entries.filter((e) => e.actor === actor && e.target === target && (e.action === 'push_agent' || e.action === 'dm_agent')).length;
      if (logged < n) unaudited.push(`${actor}->${target}: ${n} seen in the pane, ${logged} audited`);
    }
    j.that(unaudited.length === 0, `terminal pushes without an audit entry: ${unaudited.join('; ')}`);
    const window4 = S.audit4 ? entries.filter((e) => e.id > S.audit4.from && e.id <= S.audit4.to && e.actor === 'rex').length : null;
    j.that(window4 === 0, `rex has ${window4} entries in check 4's window`);
    const counts = {};
    for (const e of entries) counts[`${e.actor} ${e.action}`] = (counts[`${e.actor} ${e.action}`] || 0) + 1;
    return j.done(`${entries.length} entries: ${Object.entries(counts).map(([k, n]) => `${k} x${n}`).join(', ')}; everyone detail.pushed=${JSON.stringify(every[0]?.detail?.pushed)}; registry entries present: ${need.length - missing.length}/${need.length}; pushes seen in panes vs audited: ${unaudited.length ? unaudited.join('; ') : 'all audited'}`);
  });
}

// ------------------------------------------------------------------ teardown and report
/**
 * Synchronous, so that it also runs from a signal handler: stop the bridges, stop the throwaway server through
 * its own socket, end anything left with HOME=$ISO (by that environment, never by a name pattern), remove $ISO,
 * then check that no herdr process is left and that the real directories did not change.
 */
function teardown() {
  if (S.tornDown) return;
  S.tornDown = true;
  S.gate.shut('teardown has started');
  for (const s of S.streams) { try { s.close(); } catch { /* gone */ } }
  for (const b of S.bridges) { if (alive(b.pid)) { try { process.kill(b.pid, 'SIGTERM'); } catch { /* gone */ } } }
  if (!waitSync(() => S.bridges.every((b) => !alive(b.pid)), 5000)) {
    for (const b of S.bridges) { if (alive(b.pid)) { try { process.kill(b.pid, 'SIGKILL'); } catch { /* gone */ } } }
  }
  const bridgesLeft = S.bridges.filter((b) => alive(b.pid)).length;
  // What was sent, read before $ISO goes: an aborted run must show none.
  let sent = 'nothing to count';
  try {
    const posts = S.bridges.reduce((n, b) => n + (fs.existsSync(b.log)
      ? fs.readFileSync(b.log, 'utf8').split('\n').filter((l) => / POST \/v1\/repos\/[^/]+\/messages /.test(l)).length : 0), 0);
    const msgs = KEY && DatabaseSync ? readChatter(KEY, 'SELECT COUNT(*) AS n FROM messages')[0].n : 0;
    if (S.createdIso) sent = `message POSTs in the bridge logs: ${posts}, rows in the repo's messages table: ${msgs}`;
  } catch (e) { sent = `could not count what was sent: ${e.message}`; }
  let stopNote = 'not started';
  let leftovers = [];
  if (S.createdIso) {
    if (ENV && HERDR_BIN) {
      const r = spawnSync(HERDR_BIN, ['server', 'stop'], { env: ENV, cwd: '/', encoding: 'utf8', timeout: 15_000 });
      stopNote = `herdr server stop exit ${r.status}`;
    }
    const gone = () => { try { return herdrOfIso().length === 0; } catch { return false; } };
    if (!waitSync(gone, 10_000)) {
      for (const pid of herdrOfIso()) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
      stopNote += '; server signalled by pid';
      waitSync(gone, 5000);
    }
    if (!waitSync(() => pidsWithHome(ISO).length === 0, 5000)) {
      leftovers = pidsWithHome(ISO);
      for (const pid of leftovers) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
      if (!waitSync(() => pidsWithHome(ISO).length === 0, 3000)) {
        for (const pid of pidsWithHome(ISO)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      }
    }
    try { fs.rmSync(ISO, { recursive: true, force: true }); } catch { /* reported below */ }
  }
  const tdExp = 'Teardown: bridges stopped, the throwaway server stopped through its socket, nothing left with HOME=$ISO, $ISO removed; no herdr process left (by command name); the real Herdr directories unchanged';
  const count = herdrCount();
  const left = pidsWithHome(ISO).length;
  const isoGone = !fs.existsSync(ISO);
  const hash = S.startHash ? dirsHash(dirs) : null;
  const obs = `${sent}; bridges left: ${bridgesLeft}; ${stopNote}; processes that had to be signalled: ${leftovers.length}; HOME=$ISO left: ${left}; $ISO ${isoGone ? (S.createdIso ? 'removed' : 'never created') : 'still there'}; herdr processes (ps -eo comm | grep -cx herdr): ${count}; real dirs: ${hash ? `${hash.entries} entries, sha256 ${hash.hash.slice(0, 16)} (start ${S.startHash.slice(0, 16)})` : 'not hashed at the start'}`;
  const problems = [];
  if (bridgesLeft) problems.push('a bridge is still running');
  if (S.createdIso && (left || !isoGone)) problems.push('throwaway processes or files remain');
  if (S.startHerdr === 0 && count !== 0) problems.push(`${count} herdr process(es) remain`);
  if (hash && hash.hash !== S.startHash) problems.push('the real Herdr directories changed');
  if (S.startHerdr !== 0 && S.startHerdr !== null) row('T', tdExp, obs, 'blocked', 'herdr processes were already running at the start, so "none left" cannot be judged');
  else row('T', tdExp, obs, problems.length ? 'fail' : 'pass', problems.join('; '));
}

function printTable() {
  if (S.printed) return;
  S.printed = true;
  const cell = (s) => redact(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' / ');
  const lines = [];
  lines.push(`real-herdr smoke, run ${RUN}, ${new Date().toISOString()}: ${S.facts.join(', ') || 'no Herdr started'}, node ${process.version}, $ISO=${ISO}`);
  lines.push('');
  lines.push('| id | expected | observed | verdict |');
  lines.push('|---|---|---|---|');
  for (const r of S.rows) lines.push(`| ${cell(r.id)} | ${cell(r.expected)} | ${cell(r.observed)} | ${cell(r.verdict === 'pass' ? 'pass' : `${r.verdict}: ${r.reason}`)} |`);
  const bad = S.rows.filter((r) => r.verdict !== 'pass');
  lines.push('');
  lines.push(bad.length ? `NOT PASSED: ${bad.map((r) => `${r.id} ${r.verdict}`).join(', ')}` : 'ALL PASSED');
  process.stdout.write(`${lines.join('\n')}\n`);
}

function finish(code) {
  teardown();
  printTable();
  const ok = S.rows.length > 0 && S.rows.every((r) => r.verdict === 'pass');
  process.exit(code ?? (ok ? 0 : 1));
}

async function main() {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      row('X', 'The run completes', '', 'blocked', `interrupted by ${sig}`);
      finish(130);
    });
  }
  process.on('uncaughtException', (e) => {
    row('X', 'The run completes', '', 'blocked', `uncaught: ${e.message}`);
    finish(1);
  });
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
    await preconditions();
    await setupHerdr();
    await setupPanes();
    await setupBridge();
    await sendGate();
    await setupMembers();
    await check1();
    await check2();
    await check3();
    await check4();
    await check5();
    await check6();
    await check9();
    await check7();
    await check8();
  } catch (e) {
    if (!(e instanceof Abort)) row('X', 'The run completes', '', 'blocked', e.message);
  } finally {
    finish();
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
