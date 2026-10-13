import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LIVE_STATUS } from './policy.js';
import { HttpError } from './util.js';

// The README calls Chatter's SQLite layout an internal detail, so the bridge
// pins the columns it reads and refuses a repo whose schema has drifted.
const EXPECTED_COLUMNS = {
  messages: ['id', 'from_agent', 'to_agent', 'body', 'kind', 'ref_id', 'created_at', 'delivered_at', 'read_at'],
  agents: ['name', 'pane_id', 'repo_root', 'branch', 'kind', 'role', 'registered_at', 'last_seen_at', 'departed_at'],
  notes: ['id', 'author', 'type', 'text', 'task_id', 'status', 'created_at'],
  tasks: ['id', 'title', 'status', 'assignee', 'created_by', 'created_at', 'updated_at'],
  handoffs: ['id', 'task_id', 'from_agent', 'to_agent', 'summary', 'branch', 'status', 'created_at'],
};

const KEY_RE = /^[A-Za-z0-9._-]+$/;
// What every caller of the repo listing is told when Chatter fails, /healthz's unauthenticated one included.
const REPOS_FAILED = 'Chatter could not list the repositories';
// Herdr's answer when no server runs on the socket it was pointed at (seen on 0.9.1): no live agents.
const HERDR_NO_SERVER = 'server_not_running';
const OUTPUT_CAP = 1_000_000;
const LOG_CLIP = 2000;

const isRecord = (v) => typeof v === 'object' && v !== null;
const clip = (s) => (s.length > LOG_CLIP ? `${s.slice(0, LOG_CLIP)}...` : s);

/**
 * What `herdr agent list` answered, read as Chatter reads it (`herdr()` and `agentList` in its herdr.ts): the
 * answer is stdout, or stderr when stdout is empty; the agents are `result.agents`; an entry counts only if
 * it is an object with a string `pane_id`, and its name is `name` when that is a non-empty string (Chatter's
 * `resolveRecipient` adds `a.name` only when it is truthy). No working-directory filter: every live name of
 * the session is returned, where Chatter keeps those whose cwd is in the repo (`teamAgents`).
 * Stricter than Chatter on failure: Chatter takes any failed or unexpected answer as "no live agents"; here
 * only Herdr's "no server is running" is, and anything else is `unknown`, with the reason for the log.
 */
export function readAgentList(code, stdout, stderr) {
  const raw = stdout.trim() || stderr.trim();
  let json = null;
  try { json = JSON.parse(raw); } catch { /* not JSON: judged below */ }
  if (isRecord(json) && isRecord(json.error) && json.error.code === HERDR_NO_SERVER) return { names: [], status: LIVE_STATUS.ok };
  if (code !== 0) return { names: [], status: LIVE_STATUS.unknown, why: `exited ${code}: ${clip(raw)}` };
  if (!isRecord(json) || !isRecord(json.result) || !Array.isArray(json.result.agents)) {
    return { names: [], status: LIVE_STATUS.unknown, why: `answered something other than an agent list: ${clip(raw)}` };
  }
  const names = json.result.agents
    .filter((a) => isRecord(a) && typeof a.pane_id === 'string' && typeof a.name === 'string' && a.name)
    .map((a) => a.name);
  return { names: [...new Set(names)], status: LIVE_STATUS.ok };
}

export class ChatterHost {
  /**
   * @param {object} o
   * @param {string[]} o.cmd              argv prefix that runs the Chatter CLI
   * @param {string} o.memberConfigRoot   per-member Chatter config dirs live here
   * @param {string|null} [o.adminConfigDir]  Chatter config dir of the human admin (default: Chatter's own)
   * @param {string|null} [o.stateDir]    HERDR_PLUGIN_STATE_DIR passthrough
   * @param {(line: string) => void} [o.log]  the operator's log, for what Chatter printed when it failed
   * @param {number} [o.herdrTimeoutMs]   how long `herdr agent list` may take before the answer is unknown
   * @param {number} [o.liveTtlMs]        how long an answer of `herdr agent list` is kept
   */
  constructor({ cmd, memberConfigRoot, adminConfigDir = null, stateDir = null, timeoutMs = 15_000, herdrTimeoutMs = 5000, liveTtlMs = 2000, env = process.env, log = () => {} }) {
    if (!cmd?.length) throw new Error('ChatterHost needs a command');
    this.cmd = cmd;
    this.memberConfigRoot = memberConfigRoot;
    this.adminConfigDir = adminConfigDir;
    this.stateDir = stateDir;
    this.timeoutMs = timeoutMs;
    this.herdrTimeoutMs = herdrTimeoutMs;
    this.liveTtlMs = liveTtlMs;
    this.env = env;
    this.log = log;
    this._repos = null;
    this._reposAt = 0;
    this._reposInflight = null;
    this._live = null;
    this._liveAt = 0;
    this._liveInflight = null;
    this._dbs = new Map();
    this._locks = new Map();
  }

  /**
   * The environment of every program the host runs, Chatter and Herdr alike, so that the bridge's own
   * `herdr agent list` reaches the socket the Chatter it runs reaches. Never a pane's: the bridge is no agent.
   */
  baseEnv() {
    const env = { ...this.env };
    for (const k of Object.keys(env)) if (/^HERDR_PANE/.test(k)) delete env[k];
    return env;
  }

  // ----------------------------------------------------------- identities
  ensureMemberConfig(handle) {
    const dir = path.join(this.memberConfigRoot, handle);
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'name');
    if (!fs.existsSync(f) || fs.readFileSync(f, 'utf8').trim() !== handle) fs.writeFileSync(f, `${handle}\n`);
    return dir;
  }

  adminHandle() {
    const dir = this.adminConfigDir || process.env.HERDR_PLUGIN_CONFIG_DIR
      || path.join(os.homedir(), '.config', 'herdr', 'plugins', 'config', 'chatter');
    try {
      const n = fs.readFileSync(path.join(dir, 'name'), 'utf8').trim();
      return n || null;
    } catch { return null; }
  }

  // ------------------------------------------------------------------ CLI
  /** Run the Chatter CLI as a member. argv array, never a shell. */
  run({ handle, admin = false, cwd, args }) {
    const env = this.baseEnv();
    if (admin) {
      if (this.adminConfigDir) env.HERDR_PLUGIN_CONFIG_DIR = this.adminConfigDir;
      else delete env.HERDR_PLUGIN_CONFIG_DIR;
    } else {
      env.HERDR_PLUGIN_CONFIG_DIR = this.ensureMemberConfig(handle);
    }
    if (this.stateDir) env.HERDR_PLUGIN_STATE_DIR = this.stateDir;
    return new Promise((resolve, reject) => {
      const child = spawn(this.cmd[0], [...this.cmd.slice(1), ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const cap = (s, d) => (s.length > 1_000_000 ? s : s + d);
      child.stdout.on('data', (d) => { stdout = cap(stdout, d); });
      child.stderr.on('data', (d) => { stderr = cap(stderr, d); });
      const timer = setTimeout(() => child.kill('SIGKILL'), this.timeoutMs);
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
  }

  /** Serialize writes per repo so concurrent posts do not interleave. */
  withLock(key, fn) {
    const prev = this._locks.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this._locks.set(key, next);
    next.finally(() => { if (this._locks.get(key) === next) this._locks.delete(key); }).catch(() => {});
    return next;
  }

  // ---------------------------------------------------------------- repos
  async repos({ fresh = false } = {}) {
    if (!fresh && this._repos && Date.now() - this._reposAt < 3000) return this._repos;
    if (this._reposInflight) return this._reposInflight;
    this._reposInflight = (async () => {
      const r = await this.run({ admin: true, cwd: os.homedir(), args: ['data', '--json'] });
      if (r.code !== 0) {
        // Chatter's stderr can name host paths (the node binary, its script, a stack): it is the operator's.
        this.log(`chatter data failed (exit ${r.code}): ${r.stderr.trim()}`);
        throw new HttpError(502, 'chatter_error', REPOS_FAILED);
      }
      const rows = JSON.parse(r.stdout || '[]');
      this._repos = rows.map((x) => ({
        key: x.key,
        dir: x.dir,
        repo_root: x.repo_root || null,
        orphan: !!x.orphan,
        label: x.repo_root ? path.basename(x.repo_root) : x.key.replace(/-[0-9a-f]{8}$/, ''),
        messages: x.messages,
        last_activity: x.last_activity ? `${x.last_activity.replace(' ', 'T')}Z` : null,
      }));
      this._reposAt = Date.now();
      return this._repos;
    })().finally(() => { this._reposInflight = null; });
    return this._reposInflight;
  }

  async repo(key) {
    if (!KEY_RE.test(key || '')) throw new HttpError(400, 'bad_repo', 'invalid repo key');
    let found = (await this.repos()).find((r) => r.key === key);
    if (!found) found = (await this.repos({ fresh: true })).find((r) => r.key === key);
    if (!found) throw new HttpError(404, 'no_such_repo', `no repo "${key}"`);
    return found;
  }

  dbFile(repo) { return path.join(repo.dir, 'chatter.db'); }

  /** Identity of the database file: changes if the universe is deleted and recreated. */
  epoch(repo) {
    try {
      const st = fs.statSync(this.dbFile(repo));
      return `${st.ino}-${Math.floor(st.birthtimeMs)}`;
    } catch { return 'missing'; }
  }

  /** Read-only handle, reopened if the file was replaced. Throws on schema drift. */
  openRO(repo) {
    const file = this.dbFile(repo);
    const epoch = this.epoch(repo);
    const cached = this._dbs.get(repo.key);
    if (cached && cached.epoch === epoch) return cached.db;
    if (cached) { try { cached.db.close(); } catch { /* already closed */ } }
    if (epoch === 'missing') throw new HttpError(404, 'no_such_repo', 'repo database is gone');
    const db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 3000;');
    const problems = checkSchema(db);
    if (problems.length) {
      db.close();
      throw new HttpError(503, 'schema_mismatch', `Chatter database layout changed: ${problems.join('; ')}`);
    }
    this._dbs.set(repo.key, { db, epoch });
    return db;
  }

  /** Every name the repos know as a Herdr agent (live or departed). */
  async agentNames() {
    const names = new Set();
    for (const repo of await this.repos()) {
      if (repo.orphan) continue;
      try {
        for (const r of this.openRO(repo).prepare('SELECT name FROM agents').all()) names.add(r.name);
      } catch { /* a drifted repo contributes no names; reads of it already fail loudly */ }
    }
    return names;
  }

  /**
   * The registered, non-departed agent names of one repo: the roster Chatter's `resolveRecipient` matches a
   * recipient or a mention against, by exact name and then by unique case-insensitive prefix.
   */
  rosterNames(repo) {
    return this.openRO(repo).prepare('SELECT name FROM agents WHERE departed_at IS NULL').all().map((r) => r.name);
  }

  /**
   * The names of the live agents Herdr reports for the whole session, which Chatter's `resolveRecipient`
   * also counts (for the agents whose cwd is in the repo) though the agents table may not hold them. Run as
   * Chatter's `sessionAgents` runs it: `herdr agent list`, the binary `HERDR_BIN_PATH` or `herdr`, with the
   * environment the host gives Chatter. Kept `liveTtlMs`; callers meanwhile share one run. Never rejects:
   * `status` is `ok`, or `unknown` when Herdr's answer could not be read, whose detail goes to the log only.
   * @returns {Promise<{ names: string[], status: string }>}
   */
  async liveAgents() {
    if (this._live && Date.now() - this._liveAt < this.liveTtlMs) return this._live;
    if (!this._liveInflight) {
      this._liveInflight = this._listLive().then((live) => {
        this._live = live;
        this._liveAt = Date.now();
        return live;
      }).finally(() => { this._liveInflight = null; });
    }
    return this._liveInflight;
  }

  _listLive() {
    const bin = this.env.HERDR_BIN_PATH || 'herdr';
    return new Promise((resolve) => {
      let settled = false;
      const done = ({ names, status, why }) => {
        if (settled) return;
        settled = true;
        if (status !== LIVE_STATUS.ok) this.log(`herdr agent list ${why}`);
        resolve(Object.freeze({ names: Object.freeze(names), status }));
      };
      let child;
      try {
        // A working directory that always exists, so that ENOENT can only mean the binary is missing.
        child = spawn(bin, ['agent', 'list'], { cwd: '/', env: this.baseEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        done({ names: [], status: LIVE_STATUS.unknown, why: `could not be run: ${e.message}` });
        return;
      }
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const cap = (s, d) => (s.length > OUTPUT_CAP ? s : s + d);
      child.stdout.on('data', (d) => { stdout = cap(stdout, d); });
      child.stderr.on('data', (d) => { stderr = cap(stderr, d); });
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, this.herdrTimeoutMs);
      child.on('error', (e) => {
        clearTimeout(timer);
        // No Herdr installed: no live agents, as Chatter's `herdr()` finds none when it cannot start herdr.
        if (e.code === 'ENOENT') done({ names: [], status: LIVE_STATUS.ok });
        else done({ names: [], status: LIVE_STATUS.unknown, why: `could not be run: ${e.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) done({ names: [], status: LIVE_STATUS.unknown, why: `gave no answer within ${this.herdrTimeoutMs} ms` });
        else done(readAgentList(code, stdout, stderr));
      });
    });
  }

  close() {
    for (const { db } of this._dbs.values()) { try { db.close(); } catch { /* ignore */ } }
    this._dbs.clear();
  }
}

export function checkSchema(db) {
  const problems = [];
  for (const [table, cols] of Object.entries(EXPECTED_COLUMNS)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    if (!have.size) { problems.push(`table ${table} missing`); continue; }
    const missing = cols.filter((c) => !have.has(c));
    if (missing.length) problems.push(`${table} lacks ${missing.join(', ')}`);
  }
  return problems;
}
