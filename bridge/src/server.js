import http from 'node:http';
import { credentialOf, makeAuthenticator, revokedCredentials } from './auth.js';
import { canSee, boardTables, findWritten, maxMessageId, queryMessages, rowsAfter, shape } from './messages.js';
import { DEFAULT_LIMITS, RateLimiter, checkWrite } from './policy.js';
import { apiArea, createStatic } from './static.js';
import { HttpError } from './util.js';

export const VERSION = '0.1.0';
const MAX_JSON = 64 * 1024;
/** The reasons a stream's `bye` event gives. */
const BYE = { epoch: 'epoch', error: 'error', revoked: 'revoked', tokenRotated: 'token_rotated', client: 'client' };
// For a non-admin, whatever made `chatter agents` fail: Chatter's stderr and a failed run's error can name
// host paths (the node binary, a member's config directory), which are admin only, as in /v1/repos.
const AGENTS_ERROR_FOR_MEMBERS = 'Chatter could not list agents';
// What a sender is told when Chatter does not write: its stderr can name host paths, so it goes to the log.
const SEND_FAILED = "Chatter could not send the message; an admin can find the reason in the bridge's log";
// The warnings Chatter 0.19.0 writes for a post (`postToChat`), as whole lines. A sender is shown a warning
// only in one of these forms; any other stderr line could carry a host path, so it goes to the log instead.
const KNOWN_WARNINGS = [
  /^mention @[a-z0-9_-]+ matches no agent in this repo — not pushed$/,
  /^@everyone is reserved for the human — post saved, nobody was pushed$/,
];

/** What a member who is not, or no longer, an admin is told, at the door and wherever it is checked again. */
const adminOnly = () => new HttpError(403, 'admin_only', 'admin only');

/** A member route's body must be a JSON object: `null`, a string, a number or an array is refused, never a 500. */
function mustBeObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'bad_request', 'body must be a JSON object');
}

const intParam = (v, name) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, 'bad_request', `${name} must be a non-negative integer`);
  return n;
};

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_JSON) throw new HttpError(413, 'body_too_large', 'request body is too large');
    chunks.push(c);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'bad_json', 'body is not valid JSON'); }
}

/**
 * Whether a stream may carry anything, judged from the registry as it is now, which the API or the CLI in
 * another process may have changed: its member is still active and, for a stream opened with a bearer
 * token (`credential`, the token's SHA-256), that token is still one of the member's live tokens. A
 * tailnet-identity stream has no token (`credential` null), so only its member's status counts.
 * Returns the current member record, or the reason the stream must end. The record and the credential are
 * read together, from one snapshot of the registry.
 */
function standing(store, handle, credential) {
  const { member, tokenLive } = store.memberAndToken(handle, credential);
  if (!member || member.status !== 'active') return { reason: BYE.revoked };
  if (credential !== null && !tokenLive) return { reason: BYE.tokenRotated };
  return { member };
}

/** One poller per repo, shared by every open stream on it. */
class Watcher {
  constructor(bridge, repo) {
    this.bridge = bridge;
    this.repo = repo;
    this.subs = new Set();
    this.lastId = 0;
    this.epoch = null;
    this.timer = null;
    this.ticks = 0;
  }

  add(sub) {
    if (!this.timer) this.start();
    this.subs.add(sub);
  }

  remove(sub) {
    this.subs.delete(sub);
    if (!this.subs.size) this.stop();
  }

  start() {
    const { host } = this.bridge;
    this.lastId = maxMessageId(host.openRO(this.repo));
    this.epoch = host.epoch(this.repo);
    this.timer = setInterval(() => this.tick(), this.bridge.pollMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.bridge.watchers.delete(this.repo.key);
  }

  poke() { if (this.timer) this.tick(); }

  /** Ends the streams that may no longer carry anything; every other stream sees its member's current role. */
  refresh() {
    for (const s of [...this.subs]) {
      const { member, reason } = standing(this.bridge.store, s.member.handle, s.credential);
      if (reason) s.close(reason);
      else s.member = member;
    }
  }

  tick() {
    const { host } = this.bridge;
    this.ticks += 1;
    try {
      if (host.epoch(this.repo) !== this.epoch) {
        for (const s of [...this.subs]) s.close(BYE.epoch);
        return;
      }
      const rows = rowsAfter(host.openRO(this.repo), this.lastId, 500);
      // Before any row goes out, so a demotion, a revocation or a rotation made since the last tick decides
      // who sees it; idle streams are refreshed every fourth tick so that they still end in time.
      if (rows.length || this.ticks % 4 === 0) this.refresh();
      for (const row of rows) {
        this.lastId = row.id;
        for (const s of this.subs) s.deliver(row);
      }
      if (this.ticks % 30 === 0) for (const s of this.subs) s.ping();
    } catch (e) {
      for (const s of [...this.subs]) s.close(BYE.error);
      this.bridge.log(`watcher ${this.repo.key}: ${e.message}`);
    }
  }
}

/**
 * @param {object} o
 * @param {import('./store.js').Store} o.store
 * @param {import('./chatter.js').ChatterHost} o.host
 */
export function createBridge({ store, host, trustTailscale = false, whois, limits = DEFAULT_LIMITS, origins = [], pollMs = 500, staticDir = null, log = () => {} }) {
  const statics = staticDir ? createStatic(staticDir) : null;
  const identify = makeAuthenticator({ store, trustTailscale, whois });
  const limiter = new RateLimiter(limits.postsPerMinute);
  const bridge = { store, host, log, pollMs, watchers: new Map() };
  const streams = new Map(); // handle -> Set<sub>
  const agentCache = new Map(); // repo key -> { at, agents }

  const activeHandles = () => new Set(store.listMembers().filter((m) => m.status === 'active').map((m) => m.handle));

  const watcherFor = (repo) => {
    let w = bridge.watchers.get(repo.key);
    if (!w) { w = new Watcher(bridge, repo); bridge.watchers.set(repo.key, w); }
    return w;
  };

  const closeStreamsFor = (handle, reason) => {
    for (const s of [...(streams.get(handle) || [])]) s.close(reason);
  };

  /**
   * The member a request acts as, for every decision made after an await. The door read the registry before
   * that await, and the API or the CLI in another process may have revoked, demoted or rotated since. `now()`
   * reads it again with the request's credential, by the rule a stream follows (`standing`), and answers as
   * the door does: 401 if the member is no longer active or the bearer token is no longer theirs. `admin()`
   * adds 403 for a member who is no longer an admin. Both only read and never await, so either can be the
   * first statement of a registry transaction.
   */
  const actingAs = (handle, credential) => ({
    handle,
    credential,
    now() {
      const { member } = standing(store, handle, credential);
      if (!member) throw revokedCredentials();
      return member;
    },
    admin() {
      const member = this.now();
      if (member.role !== 'admin') throw adminOnly();
      return member;
    },
  });

  const send = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(text);
  };

  // ------------------------------------------------------------- handlers
  async function listRepos(actor) {
    const repos = await host.repos();
    const member = actor.now();
    return repos.map((r) => ({
      key: r.key, label: r.label, repo_root: member.role === 'admin' ? r.repo_root : null, orphan: r.orphan,
      messages: r.messages, last_activity: r.last_activity, epoch: host.epoch(r),
      last_read_id: store.getRead(member.handle, r.key),
    }));
  }

  async function getMessages(actor, key, q) {
    const repo = await host.repo(key);
    const page = queryMessages(host.openRO(repo), actor.now(), {
      afterId: intParam(q.get('after_id'), 'after_id'),
      beforeId: intParam(q.get('before_id'), 'before_id'),
      limit: q.get('limit') ?? 100,
    });
    return { repo: repo.key, epoch: host.epoch(repo), ...page };
  }

  async function postMessage(actor, key, body) {
    const repo = await host.repo(key);
    if (repo.orphan || !repo.repo_root) throw new HttpError(409, 'repo_unwritable', 'repo no longer exists on this host');
    // Synchronous, and given the agent names and the live agents already loaded, so that a caller can decide
    // and act in one run. It reads the registry and the roster as they are now: the sender still active, with
    // the credential the request came with, and their role and flags as they are.
    const decideWith = ([agentNames, liveAgents]) => {
      const current = actor.now();
      const members = activeHandles();
      const decision = checkWrite({
        member: current, to: body.to, body: body.body, agentNames, repoAgents: host.rosterNames(repo), liveAgents, memberHandles: members, limits,
      });
      return { decision, members };
    };
    // Who counts as an agent: the agents tables, and the live agents Herdr reports, which Chatter also counts.
    const loadAgents = () => Promise.all([host.agentNames(), host.liveAgents()]);
    // Refused here, a send answers at once and costs no rate-limit token.
    decideWith(await loadAgents());
    // Taken before the lock, so that one member cannot queue unlimited sends behind it. A send admitted here
    // keeps its slot even if it is refused when it is decided again inside the lock.
    limiter.take(actor.handle);

    const result = await host.withLock(repo.key, async () => {
      // The send may have waited here behind others while the admin revoked its sender or changed what they
      // may do, its token was rotated, or an agent joined: decide again, and write only what that decision
      // allows. The one await comes first. From the decision to the spawn nothing awaits, so nothing else in
      // this process runs between them: `host.run` spawns the child before it returns (`ChatterHost.run` is
      // not async, and makes the member's config directory synchronously before it spawns).
      const { decision, members } = decideWith(await loadAgents());
      const db = host.openRO(repo);
      const before = maxMessageId(db);
      // `--queue` always follows the body, so a body that is literally "--queue" survives (see cmdSend).
      const args = decision.mode === 'post' ? ['post', decision.body] : ['send', decision.to, decision.body, '--queue'];
      const r = await host.run({ handle: actor.handle, cwd: repo.repo_root, args });
      if (r.code !== 0) {
        // Chatter's stderr can name host paths or end in a stack, and a sender is not the operator.
        log(`chatter ${args[0]} as ${actor.handle} in ${repo.key} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`);
        throw new HttpError(422, 'chatter_refused', SEND_FAILED);
      }
      const to = decision.mode === 'post' ? '#chat' : decision.to;
      const id = findWritten(db, { afterId: before, from: actor.handle, to, kind: decision.mode === 'post' ? 'post' : 'chat', body: decision.body });
      return { id, stdout: r.stdout, stderr: r.stderr, decision, members };
    });
    const { decision, members } = result;

    const pushed = (/pushed to (.+)$/m.exec(result.stdout)?.[1] || '').split(', ').filter(Boolean);
    const warnings = result.stderr.split('\n').filter((l) => l.startsWith('warning: ')).map((l) => l.slice(9))
      .filter((w) => {
        if (!KNOWN_WARNINGS.some((known) => known.test(w))) {
          log(`chatter warning for ${actor.handle} in ${repo.key}, held back: ${w}`);
          return false;
        }
        const m = /^mention @([a-z0-9_-]+) matches no agent/.exec(w);
        return !(m && members.has(m[1]));
      });
    const delivery = decision.mode === 'dm' && decision.toAgent ? (result.stdout.startsWith('delivered') ? 'delivered' : 'queued') : null;

    for (const p of pushed) store.audit({ actor: actor.handle, action: 'push_agent', target: p.replace(/ \(queued\)$/, ''), repo: repo.key, message_id: result.id });
    if (decision.mode === 'dm' && decision.toAgent) {
      store.audit({ actor: actor.handle, action: 'dm_agent', target: decision.to, repo: repo.key, message_id: result.id, detail: { delivery } });
    }
    if (decision.everyone) store.audit({ actor: actor.handle, action: 'everyone', repo: repo.key, message_id: result.id, detail: { pushed } });

    bridge.watchers.get(repo.key)?.poke();
    return { id: result.id, pushed, warnings, mentioned_members: decision.memberTargets, delivery };
  }

  // The agent-row keys of Chatter 0.19.0 (`cmdAgents`) that are not host paths. An allowlist, not a
  // denylist of cwd and repo_root: a column a later Chatter adds fails closed until someone judges it safe.
  const MEMBER_AGENT_KEYS = new Set([
    'name', 'pane_id', 'workspace_id', 'branch', 'kind', 'role',
    'registered_at', 'last_seen_at', 'departed_at', 'status', 'task',
  ]);

  async function getBoard(actor, key) {
    const repo = await host.repo(key);
    let agents = [];
    let agents_error = null;
    const hit = agentCache.get(repo.key);
    if (hit && Date.now() - hit.at < 2000) agents = hit.agents;
    else if (repo.repo_root && !repo.orphan) {
      try {
        const r = await host.run({ handle: actor.handle, cwd: repo.repo_root, args: ['agents', '--all', '--json'] });
        if (r.code === 0) { agents = JSON.parse(r.stdout || '[]'); agentCache.set(repo.key, { at: Date.now(), agents }); }
        else agents_error = (r.stderr || '').trim().split('\n').pop() || `exit ${r.code}`;
      } catch (e) { agents_error = e.message; }
    }
    // After the last await: the member as they are now decides whether anything is answered, and the role
    // what the agent rows and the error may show.
    const member = actor.now();
    const out = boardTables(host.openRO(repo));
    if (agents_error !== null && member.role !== 'admin') agents_error = AGENTS_ERROR_FOR_MEMBERS;
    // Host paths are admin only, as in /v1/repos. The cache is shared across roles and `agents` may be the
    // cached array itself, so build new rows instead of deleting from them.
    if (member.role !== 'admin') agents = agents.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => MEMBER_AGENT_KEYS.has(k))));
    return { repo: repo.key, epoch: host.epoch(repo), agents, agents_error, ...out };
  }

  async function openStream(actor, key, req, res, q) {
    const repo = await host.repo(key);
    // The door checked the credential before that await, and the resume below replays a batch at once:
    // judge it again now, as the watcher does before every batch.
    const member = actor.now();
    const db = host.openRO(repo);
    const watcher = watcherFor(repo);
    const last = req.headers['last-event-id'] ?? q.get('after_id');
    const afterId = intParam(last, 'Last-Event-ID');

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    if (!watcher.timer) watcher.start();
    const sub = {
      member,
      // The SHA-256 of the bearer token this stream was opened with, or null for the tailnet identity: the
      // watcher ends the stream once it is no longer a live token of the member, whichever process rotated it.
      credential: actor.credential,
      lastSent: afterId ?? watcher.lastId,
      deliver(row) {
        if (row.id <= this.lastSent || !canSee(this.member, row)) return;
        this.lastSent = row.id;
        res.write(`id: ${row.id}\nevent: message\ndata: ${JSON.stringify(shape(row))}\n\n`);
      },
      ping() { res.write(': ping\n\n'); },
      close(reason) {
        if (this.closed) return;
        this.closed = true;
        try { res.write(`event: bye\ndata: ${JSON.stringify({ reason })}\n\n`); res.end(); } catch { /* socket already gone */ }
        watcher.remove(this);
        const set = streams.get(actor.handle);
        set?.delete(this);
        if (set && !set.size) streams.delete(actor.handle);
      },
    };
    res.write('retry: 2000\n\n');
    watcher.add(sub);
    // Resume: replay up to the watcher's cursor; newer rows arrive through ticks.
    // Everything here is synchronous, so no tick can slip in between.
    if (afterId !== null) {
      let cursor = afterId;
      for (;;) {
        const rows = db.prepare('SELECT * FROM messages WHERE id > ? AND id <= ? ORDER BY id ASC LIMIT 500').all(cursor, watcher.lastId);
        if (!rows.length) break;
        // Each page is judged as the watcher judges a batch, just before it goes out: the CLI in another
        // process may have revoked, demoted or rotated while the pages before it were written.
        const { member: current, reason } = standing(store, actor.handle, actor.credential);
        if (reason) { sub.close(reason); return; }
        sub.member = current;
        for (const row of rows) sub.deliver(row);
        cursor = rows[rows.length - 1].id;
      }
    }
    res.write(`event: hello\ndata: ${JSON.stringify({ epoch: host.epoch(repo), max_id: watcher.lastId })}\n\n`);
    if (!streams.has(actor.handle)) streams.set(actor.handle, new Set());
    streams.get(actor.handle).add(sub);
    req.on('close', () => sub.close(BYE.client));
  }

  // ---------------------------------------------------------- admin routes
  async function addMember(actor, body) {
    const agentNames = await host.agentNames();
    // One transaction with its audit entry, so a 500 means no member and no token exist. The config
    // directory is made after the store has checked the handle; one left behind by a rollback is harmless.
    // The body is judged only once the acting admin is authorised: one who is no longer gets 401 or 403 for it.
    return store.transaction(() => {
      actor.admin();
      mustBeObject(body);
      const { kind } = body;
      if (agentNames.has(body.handle)) {
        throw new HttpError(409, 'handle_is_agent', `"${body.handle}" is already a Herdr agent name`);
      }
      // Absent means true (the store's default); anything present but not a boolean the store refuses.
      const m = store.addMember({
        handle: body.handle, display_name: body.display_name, kind, role: body.role || 'member',
        can_address_agents: body.can_address_agents, tailscale_login: body.tailscale_login || null,
      });
      host.ensureMemberConfig(m.handle);
      const token = kind === 'computational' || body.issue_token ? store.issueToken(m.handle) : null;
      store.audit({ actor: actor.handle, action: 'member_add', target: m.handle, detail: { kind: m.kind, role: m.role, can_address_agents: m.can_address_agents } });
      return { member: m, token };
    });
  }

  async function route(req, res, url) {
    const area = apiArea(url.pathname);
    // The app shell is served without credentials (D15); every path the API claims stays with the API.
    // This runs before `seg`, whose decoding throws, so a bad encoding outside the API is a 400, not a 500.
    if (statics && area === null && (req.method === 'GET' || req.method === 'HEAD')) {
      return statics.serve(req, res, url.pathname);
    }
    const seg = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const method = req.method;
    if (method === 'GET' && url.pathname === '/healthz') {
      return send(res, 200, { ok: true, version: VERSION, repos: (await host.repos()).length });
    }
    if (area !== 'v1') throw new HttpError(404, 'not_found', 'no such route');
    // The member as the door found them. Only what follows with no await may use this record; every decision
    // made after an await asks `actor` instead.
    const member = await identify(req);
    const actor = actingAs(member.handle, credentialOf(req));
    const admin = () => { if (member.role !== 'admin') throw adminOnly(); };

    if (method === 'GET' && seg[1] === 'me' && seg.length === 2) {
      const { handle, display_name, kind, role, can_address_agents } = member;
      return send(res, 200, { handle, display_name, kind, role, can_address_agents });
    }
    if (method === 'GET' && seg[1] === 'directory' && seg.length === 2) {
      const agents = [...(await host.agentNames())].sort();
      actor.now();
      const members = store.listMembers().filter((m) => m.status === 'active')
        .map((m) => ({ handle: m.handle, display_name: m.display_name, kind: m.kind }));
      return send(res, 200, { members, agents });
    }
    if (seg[1] === 'repos') {
      if (seg.length === 2 && method === 'GET') return send(res, 200, { repos: await listRepos(actor) });
      const key = seg[2];
      if (seg[3] === 'messages' && seg.length === 4) {
        if (method === 'GET') return send(res, 200, await getMessages(actor, key, url.searchParams));
        if (method === 'POST') return send(res, 201, await postMessage(actor, key, await readJson(req)));
      }
      if (seg[3] === 'stream' && method === 'GET' && seg.length === 4) return openStream(actor, key, req, res, url.searchParams);
      if (seg[3] === 'board' && method === 'GET' && seg.length === 4) return send(res, 200, await getBoard(actor, key));
      if (seg[3] === 'read' && method === 'POST' && seg.length === 4) {
        const repo = await host.repo(key);
        const body = await readJson(req);
        const id = intParam(body.up_to_id, 'up_to_id');
        if (id === null) throw new HttpError(400, 'bad_request', 'up_to_id is required');
        actor.now();
        const max = maxMessageId(host.openRO(repo));
        return send(res, 200, { last_read_id: store.setRead(actor.handle, repo.key, Math.min(id, max)) });
      }
    }
    if (seg[1] === 'members') {
      // The door's record turns a member away before a body is read; each change is authorised again below.
      admin();
      if (seg.length === 2 && method === 'GET') return send(res, 200, { members: store.listMembers() });
      if (seg.length === 2 && method === 'POST') return send(res, 201, await addMember(actor, await readJson(req)));
      const handle = seg[2];
      // Each change below is authorised by the first statement of its transaction, after every await, so a
      // revocation, demotion or rotation made meanwhile by any process decides it. The change and its audit
      // entry are that one transaction, and open streams close only after the commit: a 500 then means
      // nothing happened.
      if (seg.length === 3 && method === 'PATCH') {
        const body = await readJson(req);
        const m = store.transaction(() => {
          actor.admin();
          mustBeObject(body);
          const patch = {};
          for (const k of ['display_name', 'kind', 'role', 'can_address_agents', 'tailscale_login']) if (k in body) patch[k] = body[k];
          const updated = store.updateMember(handle, patch);
          // What was stored, after the store's normalising, not what was sent.
          store.audit({ actor: actor.handle, action: 'member_update', target: handle, detail: Object.fromEntries(Object.keys(patch).map((k) => [k, updated[k]])) });
          return updated;
        });
        return send(res, 200, { member: m });
      }
      if (seg.length === 3 && method === 'DELETE') {
        const m = store.transaction(() => {
          actor.admin();
          const revoked = store.revokeMember(handle);
          store.audit({ actor: actor.handle, action: 'member_revoke', target: handle });
          return revoked;
        });
        closeStreamsFor(handle, BYE.revoked);
        return send(res, 200, { member: m });
      }
      if (seg.length === 4 && seg[3] === 'token' && method === 'POST') {
        const token = store.transaction(() => {
          actor.admin();
          const issued = store.issueToken(handle);
          store.audit({ actor: actor.handle, action: 'token_rotate', target: handle });
          return issued;
        });
        closeStreamsFor(handle, BYE.tokenRotated);
        return send(res, 201, { token });
      }
    }
    if (seg[1] === 'audit' && seg.length === 2 && method === 'GET') {
      admin();
      return send(res, 200, { entries: store.listAudit({ limit: url.searchParams.get('limit') ?? 100, beforeId: intParam(url.searchParams.get('before_id'), 'before_id') }) });
    }
    throw new HttpError(404, 'not_found', 'no such route');
  }

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const origin = req.headers.origin;
    if (origin && origins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Last-Event-ID');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    try {
      await route(req, res, new URL(req.url, 'http://bridge.local'));
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (!(e instanceof HttpError)) log(`500 ${req.method} ${req.url}: ${e.stack || e}`);
      if (res.headersSent) { try { res.end(); } catch { /* ignore */ } } else {
        send(res, status, { error: { code: e instanceof HttpError ? e.code : 'internal', message: e instanceof HttpError ? e.message : 'internal error' } });
      }
    }
    log(`${req.method} ${req.url.split('?')[0]} ${res.statusCode} ${Date.now() - started}ms`);
  });

  return {
    server,
    bridge,
    listen: (port, hostName = '127.0.0.1') => new Promise((resolve) => {
      server.listen(port, hostName, () => resolve(server.address()));
    }),
    close: () => new Promise((resolve) => {
      for (const set of streams.values()) for (const s of [...set]) s.close('shutdown');
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}
