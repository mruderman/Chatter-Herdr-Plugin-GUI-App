import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HANDLE_RE, HttpError, newToken, nowIso, sha256 } from './util.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS members (
  handle TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('human','computational')),
  role TEXT NOT NULL CHECK (role IN ('admin','member')),
  can_address_agents INTEGER NOT NULL DEFAULT 1,
  tailscale_login TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,
  handle TEXT NOT NULL REFERENCES members(handle),
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  repo TEXT,
  message_id INTEGER,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS reads (
  handle TEXT NOT NULL,
  repo TEXT NOT NULL,
  last_read_id INTEGER NOT NULL,
  PRIMARY KEY (handle, repo)
);
`;

const toMember = (r) => (r ? ({
  handle: r.handle,
  display_name: r.display_name,
  kind: r.kind,
  role: r.role,
  can_address_agents: !!r.can_address_agents,
  tailscale_login: r.tailscale_login ?? null,
  status: r.status,
  created_at: r.created_at,
  last_seen_at: r.last_seen_at ?? null,
}) : null);

export class Store {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
    this.db.exec(SCHEMA);
    this._lastTouch = new Map();
  }

  close() { this.db.close(); }

  // ------------------------------------------------------------- members
  addMember({ handle, display_name, kind, role = 'member', can_address_agents = true, tailscale_login = null }) {
    if (!HANDLE_RE.test(handle || '')) {
      throw new HttpError(400, 'bad_handle', 'handle must be 1-32 chars of a-z, 0-9, _ or -, starting with a letter or digit');
    }
    if (handle === 'everyone') throw new HttpError(400, 'bad_handle', '"everyone" is reserved');
    if (!['human', 'computational'].includes(kind)) throw new HttpError(400, 'bad_kind', 'kind must be human or computational');
    if (!['admin', 'member'].includes(role)) throw new HttpError(400, 'bad_role', 'role must be admin or member');
    if (this.getMember(handle)) throw new HttpError(409, 'handle_taken', `member "${handle}" already exists`);
    if (tailscale_login && this.memberByLogin(tailscale_login)) {
      throw new HttpError(409, 'login_taken', 'that Tailscale login is already mapped to a member');
    }
    this.db.prepare(
      'INSERT INTO members (handle, display_name, kind, role, can_address_agents, tailscale_login, created_at) VALUES (?,?,?,?,?,?,?)',
    ).run(handle, display_name || handle, kind, role, can_address_agents ? 1 : 0, tailscale_login, nowIso());
    return this.getMember(handle);
  }

  getMember(handle) {
    return toMember(this.db.prepare('SELECT * FROM members WHERE handle = ?').get(handle));
  }

  listMembers() {
    return this.db.prepare('SELECT * FROM members ORDER BY created_at, handle').all().map(toMember);
  }

  memberByLogin(login) {
    return toMember(this.db.prepare("SELECT * FROM members WHERE tailscale_login = ? AND status = 'active'").get(login));
  }

  countAdmins() {
    return this.db.prepare("SELECT COUNT(*) AS n FROM members WHERE role = 'admin' AND status = 'active'").get().n;
  }

  updateMember(handle, patch) {
    const m = this.getMember(handle);
    if (!m) throw new HttpError(404, 'no_such_member', `no member "${handle}"`);
    const next = { ...m, ...patch };
    if (patch.role && patch.role !== m.role && m.role === 'admin' && this.countAdmins() <= 1) {
      throw new HttpError(409, 'last_admin', 'cannot demote the last admin');
    }
    this.db.prepare(
      'UPDATE members SET display_name = ?, kind = ?, role = ?, can_address_agents = ?, tailscale_login = ? WHERE handle = ?',
    ).run(next.display_name, next.kind, next.role, next.can_address_agents ? 1 : 0, next.tailscale_login, handle);
    return this.getMember(handle);
  }

  revokeMember(handle) {
    const m = this.getMember(handle);
    if (!m) throw new HttpError(404, 'no_such_member', `no member "${handle}"`);
    if (m.role === 'admin' && m.status === 'active' && this.countAdmins() <= 1) {
      throw new HttpError(409, 'last_admin', 'cannot revoke the last admin');
    }
    const at = nowIso();
    this.db.prepare("UPDATE members SET status = 'revoked' WHERE handle = ?").run(handle);
    this.db.prepare('UPDATE tokens SET revoked_at = ? WHERE handle = ? AND revoked_at IS NULL').run(at, handle);
    return this.getMember(handle);
  }

  touch(handle) {
    const now = Date.now();
    if (now - (this._lastTouch.get(handle) || 0) < 30_000) return;
    this._lastTouch.set(handle, now);
    this.db.prepare('UPDATE members SET last_seen_at = ? WHERE handle = ?').run(nowIso(), handle);
  }

  // -------------------------------------------------------------- tokens
  // The token is returned once; only its SHA-256 is stored.
  issueToken(handle) {
    const m = this.getMember(handle);
    if (!m || m.status !== 'active') throw new HttpError(404, 'no_such_member', `no active member "${handle}"`);
    const at = nowIso();
    this.db.prepare('UPDATE tokens SET revoked_at = ? WHERE handle = ? AND revoked_at IS NULL').run(at, handle);
    const token = newToken();
    this.db.prepare('INSERT INTO tokens (token_hash, handle, created_at) VALUES (?,?,?)').run(sha256(token), handle, at);
    return token;
  }

  memberByToken(token) {
    const row = this.db.prepare(
      `SELECT m.* FROM tokens t JOIN members m ON m.handle = t.handle
       WHERE t.token_hash = ? AND t.revoked_at IS NULL AND m.status = 'active'`,
    ).get(sha256(token));
    return toMember(row);
  }

  // --------------------------------------------------------------- audit
  audit({ actor, action, target = null, repo = null, message_id = null, detail = null }) {
    this.db.prepare(
      'INSERT INTO audit (at, actor, action, target, repo, message_id, detail) VALUES (?,?,?,?,?,?,?)',
    ).run(nowIso(), actor, action, target, repo, message_id, detail ? JSON.stringify(detail) : null);
  }

  listAudit({ limit = 100, beforeId = null } = {}) {
    const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
    const rows = beforeId
      ? this.db.prepare('SELECT * FROM audit WHERE id < ? ORDER BY id DESC LIMIT ?').all(beforeId, lim)
      : this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(lim);
    return rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
  }

  // --------------------------------------------------------------- reads
  getRead(handle, repo) {
    return this.db.prepare('SELECT last_read_id FROM reads WHERE handle = ? AND repo = ?').get(handle, repo)?.last_read_id ?? 0;
  }

  // Monotonic: a pointer only moves forward.
  setRead(handle, repo, id) {
    this.db.prepare(
      `INSERT INTO reads (handle, repo, last_read_id) VALUES (?,?,?)
       ON CONFLICT(handle, repo) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`,
    ).run(handle, repo, id);
    return this.getRead(handle, repo);
  }
}
