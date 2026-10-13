// The safety interlocks of the real-Herdr smoke (docs/runbooks/real-herdr-smoke.md). An admin `@everyone` types
// into every live agent's terminal, so nothing may be sent until these have shown that the only Herdr in play is
// the throwaway one. Every function here only reads, or refuses; none of them starts, stops or talks to a Herdr.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/** A refused precondition: the harness sends nothing more, tears down and exits non-zero. */
export class Abort extends Error {}

/** The account's home from the password database: `$HOME` can be pointed elsewhere, this cannot. */
export const realHome = () => os.userInfo().homedir;
/** The socket the real (default-session) Herdr listens on. */
export const realSocket = (home = realHome()) => path.join(home, '.config', 'herdr', 'herdr.sock');
/** What a real Herdr writes: its config, sockets and logs, and its state (plugin state included). */
export const realDirs = (home = realHome()) => [path.join(home, '.config', 'herdr'), path.join(home, '.local', 'state', 'herdr')];

export const isUnder = (p, root) => typeof p === 'string' && (p === root || p.startsWith(root + path.sep));

/**
 * `find DIRS -printf '%p %T@ %s\n' | sort | sha256sum`, the measure taken by hand before the run, so the two can be
 * compared. Names, mtimes and sizes only; no file is opened. Run without a shell, so no alias or function of the
 * caller's shell stands in for `find`.
 */
export function dirsHash(dirs) {
  const found = spawnSync('find', [...dirs, '-printf', '%p %T@ %s\n'], { encoding: 'utf8', maxBuffer: 256 << 20 });
  if (found.error) throw new Abort(`could not run find over the real Herdr directories: ${found.error.code}`);
  const sorted = spawnSync('sort', [], { input: found.stdout, encoding: 'utf8', maxBuffer: 256 << 20 });
  if (sorted.status !== 0) throw new Abort('sort failed while hashing the real Herdr directories');
  const entries = sorted.stdout ? sorted.stdout.split('\n').length - 1 : 0;
  return { hash: crypto.createHash('sha256').update(sorted.stdout).digest('hex'), entries };
}

/**
 * Whether anything accepts a connection on a Unix socket path: 'accepts', 'refused' (a stale file, or not a
 * socket), 'absent', 'timeout' or 'error:<code>'. Only 'absent' and 'refused' count as nobody listening.
 */
export function socketState(p, ms = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ path: p });
    let settled = false;
    const done = (state) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      s.destroy();
      resolve(state);
    };
    const timer = setTimeout(() => done('timeout'), ms);
    s.once('connect', () => done('accepts'));
    s.once('error', (e) => done(e.code === 'ENOENT' ? 'absent' : e.code === 'ECONNREFUSED' ? 'refused' : `error:${e.code}`));
  });
}

export const NOBODY_LISTENING = new Set(['absent', 'refused']);

/**
 * The precondition run at the start and again just before the first send: nothing accepts a connection on any
 * guarded socket, and the real directories are as they were at the start. Throws Abort; returns the evidence.
 */
export async function preflight({ sockets, dirs, startHash }) {
  const problems = [];
  const states = [];
  for (const s of sockets) {
    const st = await socketState(s);
    states.push(`${s}: ${st}`);
    if (!NOBODY_LISTENING.has(st)) problems.push(`${s} ${st === 'accepts' ? 'accepts a connection' : `could not be judged (${st})`}`);
  }
  const now = dirsHash(dirs);
  if (now.hash !== startHash) problems.push(`the real Herdr directories changed since the start (${startHash.slice(0, 16)} became ${now.hash.slice(0, 16)})`);
  if (problems.length) throw new Abort(`precondition failed: ${problems.join('; ')}`);
  return { states, hash: now.hash, entries: now.entries };
}

/** /proc/<pid>/environ as an object. */
export function parseEnviron(buf) {
  const env = {};
  for (const kv of String(buf).split('\0')) {
    if (!kv) continue;
    const i = kv.indexOf('=');
    if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return env;
}

export const readEnviron = (pid) => parseEnviron(fs.readFileSync(`/proc/${pid}/environ`, 'latin1'));

// The only Herdr variables a process outside a pane may carry: the socket of the throwaway server and the binary.
const HERDR_ALLOWED = new Set(['HERDR_SOCKET_PATH', 'HERDR_BIN_PATH']);
const XDG_HOMES = ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME'];

/**
 * What is wrong with the environment of the bridge (or any child outside a pane) for a run under `iso`. Names
 * the variables only, never their values: an environment can hold secrets.
 */
export function envProblems(env, iso, { requireBridge = true } = {}) {
  const problems = [];
  if (env.HOME !== iso) problems.push('HOME is not the throwaway home');
  if (!isUnder(env.HERDR_SOCKET_PATH, iso)) problems.push('HERDR_SOCKET_PATH is not under the throwaway home');
  for (const k of Object.keys(env)) {
    if (k.startsWith('HERDR_') && !HERDR_ALLOWED.has(k)) problems.push(`${k} is set`);
  }
  for (const k of XDG_HOMES) if (k in env && !isUnder(env[k], iso)) problems.push(`${k} points outside the throwaway home`);
  if (requireBridge) {
    for (const k of ['CHATTER_STATE_DIR', 'CHATTER_BRIDGE_STATE_DIR', 'CHATTER_ADMIN_CONFIG_DIR']) {
      if (!isUnder(env[k], iso)) problems.push(`${k} is not under the throwaway home`);
    }
  }
  return problems;
}

/**
 * The environment of every child: an allowlist of the caller's variables plus the throwaway home and socket.
 * Nothing Herdr-specific is inherited: a caller inside a real Herdr pane carries HERDR_SOCKET_PATH and
 * HERDR_SESSION, which Herdr's CLI prefers over the home-derived default socket.
 */
export function childEnv(base, iso, extra = {}) {
  const keep = ['PATH', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_COLLATE', 'TERM', 'USER', 'LOGNAME', 'SHELL', 'TZ'];
  const env = {};
  for (const k of keep) if (base[k] !== undefined) env[k] = base[k];
  env.HOME = iso;
  env.HERDR_SOCKET_PATH = path.join(iso, '.config', 'herdr', 'herdr.sock');
  return Object.freeze({ ...env, ...extra });
}

/** `ps -eo comm | grep -cx herdr`: by command name, so a shell line that mentions herdr is not counted. */
export const countHerdr = (psComm) => psComm.split('\n').filter((l) => l.trim() === 'herdr').length;

export function herdrPids() {
  const r = spawnSync('ps', ['-eo', 'pid=,comm='], { encoding: 'utf8' });
  if (r.status !== 0) throw new Abort('ps failed');
  return r.stdout.split('\n').map((l) => l.trim().split(/\s+/)).filter(([, comm]) => comm === 'herdr').map(([pid]) => Number(pid));
}

export function herdrCount() {
  const r = spawnSync('ps', ['-eo', 'comm='], { encoding: 'utf8' });
  if (r.status !== 0) throw new Abort('ps failed');
  return countHerdr(r.stdout);
}

/** Every process of this account whose HOME is exactly `home` (the panes, the server, the bridge, their children). */
export function pidsWithHome(home) {
  const out = [];
  for (const p of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(p)) continue;
    let env;
    try { env = fs.readFileSync(`/proc/${p}/environ`, 'latin1'); } catch { continue; }
    if (env.split('\0').includes(`HOME=${home}`)) out.push(Number(p));
  }
  return out;
}

/**
 * The one gate in front of every write: a POST to the bridge, or anything that can type into a pane through
 * Chatter. Closed until the pre-send interlocks pass; any later failure closes it again.
 */
export class SendGate {
  constructor() {
    this.open = false;
    this.reason = 'the pre-send interlocks have not run';
  }

  pass() { this.open = true; }

  shut(reason) {
    this.open = false;
    this.reason = reason;
  }

  assertOpen(what) {
    if (!this.open) throw new Abort(`refused to ${what}: ${this.reason}`);
  }
}
