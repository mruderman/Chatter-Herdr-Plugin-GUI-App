import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

export class ChatterHost {
  /**
   * @param {object} o
   * @param {string[]} o.cmd              argv prefix that runs the Chatter CLI
   * @param {string} o.memberConfigRoot   per-member Chatter config dirs live here
   * @param {string|null} [o.adminConfigDir]  Chatter config dir of the human admin (default: Chatter's own)
   * @param {string|null} [o.stateDir]    HERDR_PLUGIN_STATE_DIR passthrough
   */
  constructor({ cmd, memberConfigRoot, adminConfigDir = null, stateDir = null, timeoutMs = 15_000, env = process.env }) {
    if (!cmd?.length) throw new Error('ChatterHost needs a command');
    this.cmd = cmd;
    this.memberConfigRoot = memberConfigRoot;
    this.adminConfigDir = adminConfigDir;
    this.stateDir = stateDir;
    this.timeoutMs = timeoutMs;
    this.env = env;
    this._repos = null;
    this._reposAt = 0;
    this._reposInflight = null;
    this._dbs = new Map();
    this._locks = new Map();
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
    const env = { ...this.env };
    for (const k of Object.keys(env)) if (/^HERDR_PANE/.test(k)) delete env[k];
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
      if (r.code !== 0) throw new HttpError(502, 'chatter_error', `chatter data failed: ${r.stderr.trim() || r.code}`);
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
