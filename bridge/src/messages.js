import { chatterTime, mentionsOf } from './util.js';

const CHANNEL = '#chat';

/**
 * Who may see a message row. Mirrors Chatter's own feed: channel posts plus
 * direct traffic, never the per-recipient "mention" copies. The admin (the
 * human window in Chatter) sees all direct traffic; members see only their own.
 */
export function canSee(member, row) {
  if (row.to_agent === CHANNEL) return true;
  if (row.kind === 'mention') return false;
  if (member.role === 'admin') return true;
  return row.to_agent === member.handle || row.from_agent === member.handle;
}

export function shape(row) {
  const { handles, everyone } = mentionsOf(row.body || '');
  return {
    id: row.id,
    from: row.from_agent,
    to: row.to_agent,
    body: row.body,
    kind: row.kind,
    ref_id: row.ref_id ?? null,
    created_at: chatterTime(row.created_at),
    mentions: handles,
    everyone,
  };
}

function visibility(member) {
  if (member.role === 'admin') return { sql: "(to_agent = '#chat' OR kind != 'mention')", params: [] };
  return {
    sql: "(to_agent = '#chat' OR (kind != 'mention' AND (to_agent = ? OR from_agent = ?)))",
    params: [member.handle, member.handle],
  };
}

/**
 * One page of messages visible to `member`, oldest first.
 *  - afterId: rows with id > afterId, ascending (sync forward)
 *  - beforeId: rows with id < beforeId, the newest `limit` of them (page back)
 *  - neither: the newest `limit` rows
 * Ids rise monotonically but are NOT contiguous for a member, because other
 * people's DMs are invisible to them.
 */
export function queryMessages(db, member, { afterId = null, beforeId = null, limit = 100 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const v = visibility(member);
  let rows;
  let hasMore = false;
  if (afterId !== null) {
    rows = db.prepare(`SELECT * FROM messages WHERE ${v.sql} AND id > ? ORDER BY id ASC LIMIT ?`)
      .all(...v.params, afterId, lim + 1);
    hasMore = rows.length > lim;
    rows = rows.slice(0, lim);
  } else {
    const cond = beforeId !== null ? `${v.sql} AND id < ?` : v.sql;
    const params = beforeId !== null ? [...v.params, beforeId] : v.params;
    rows = db.prepare(`SELECT * FROM messages WHERE ${cond} ORDER BY id DESC LIMIT ?`).all(...params, lim + 1);
    hasMore = rows.length > lim;
    rows = rows.slice(0, lim).reverse();
  }
  const maxId = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM messages').get().m;
  return { messages: rows.map(shape), has_more: hasMore, max_id: maxId };
}

/**
 * The direct-message pairs visible to `member`, newest first: for each unordered pair of participants, the
 * id and time of its newest visible message. The same visibility as `queryMessages`, so a member learns
 * nothing they could not find by paging back (V5 finding 9: a DM older than the newest page has no entry
 * in a list built from loaded messages). No text: only who and when.
 */
export function listConversations(db, member) {
  const v = visibility(member);
  // Scalar min() and max() over the two columns name the pair whichever way it was written.
  const rows = db.prepare(
    `SELECT c.a, c.b, c.last_id, m.created_at FROM (
       SELECT min(from_agent, to_agent) AS a, max(from_agent, to_agent) AS b, max(id) AS last_id
       FROM messages WHERE to_agent != ? AND ${v.sql} GROUP BY a, b
     ) AS c JOIN messages AS m ON m.id = c.last_id ORDER BY c.last_id DESC`,
  ).all(CHANNEL, ...v.params);
  return rows.map((r) => ({ a: r.a, b: r.b, last_id: r.last_id, last_at: chatterTime(r.created_at) }));
}

export function maxMessageId(db) {
  return db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM messages').get().m;
}

export function rowsAfter(db, afterId, limit) {
  return db.prepare('SELECT * FROM messages WHERE id > ? ORDER BY id ASC LIMIT ?').all(afterId, limit);
}

/** Find the row a CLI write just created (the CLI prints the id only for posts). */
export function findWritten(db, { afterId, from, to, kind, body }) {
  return db.prepare(
    'SELECT id FROM messages WHERE id > ? AND from_agent = ? AND to_agent = ? AND kind = ? AND body = ? ORDER BY id ASC LIMIT 1',
  ).get(afterId, from, to, kind, body)?.id ?? null;
}

const iso = (s) => chatterTime(s);

/** Tasks, notes, open questions and handoffs. Agents come from the CLI (live state). */
export function boardTables(db) {
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC, id LIMIT 200').all().map((t) => ({
    id: t.id, title: t.title, status: t.status, assignee: t.assignee ?? null, created_by: t.created_by ?? null,
    created_at: iso(t.created_at), updated_at: iso(t.updated_at),
  }));
  const noteRow = (n) => ({
    id: n.id, author: n.author, type: n.type, text: n.text, task_id: n.task_id ?? null, created_at: iso(n.created_at),
  });
  const notes = db.prepare("SELECT * FROM notes WHERE status = 'active' AND type != 'question' ORDER BY id DESC LIMIT 200")
    .all().map(noteRow);
  const questions = db.prepare("SELECT * FROM notes WHERE status = 'active' AND type = 'question' ORDER BY id DESC LIMIT 100")
    .all().map(noteRow);
  const handoffs = db.prepare('SELECT * FROM handoffs ORDER BY id DESC LIMIT 100').all().map((h) => ({
    id: h.id, task_id: h.task_id ?? null, from: h.from_agent, to: h.to_agent ?? null, summary: h.summary,
    branch: h.branch ?? null, status: h.status, created_at: iso(h.created_at),
  }));
  return { tasks, notes, questions, handoffs };
}
