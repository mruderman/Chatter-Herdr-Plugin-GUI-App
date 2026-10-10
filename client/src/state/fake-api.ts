// A scripted bridge for the real store's tests, answering through the same `Api` interface that
// createApi implements (src/api/client.ts). Its database is the recordings in client/test/fixtures,
// and it keeps the bridge's rules: who sees what (bridge/src/messages.js canSee), paging
// (queryMessages), refusals in checkWrite's order with the recorded texts (bridge/src/policy.js), a
// read pointer that only moves forward (store.js setRead), and the stream's replay after
// Last-Event-ID, then hello, then live rows (server.js openStream). Tests drive what a real bridge
// does on its own: someone else writes, the member is revoked, the token rotates, the repo is
// purged, the network drops. Not part of the app.
import type { Api, RequestOptions } from '../api/client';
import { ManualClock, type Clock } from '../api/clock';
import { ApiError, ERROR_CODES, NetworkError } from '../api/errors';
import { parseDirectory, parseMe, parseMessagesPage, parseRepos } from '../api/guards';
import { BYE_REASONS } from '../api/stream';
import {
  CHANNEL,
  type Directory,
  type Me,
  type Message,
  type MessagesPage,
  type MessagesQuery,
  type Repo,
  type SendRequest,
  type SendResult,
} from '../api/types';
import { body, recordedError } from '../../test/fixtures/recorded';
import { FAKE_MEMBERS, type FakeMember } from './fake';

export const BRIDGE_ROUTES = {
  me: 'me',
  directory: 'directory',
  repos: 'repos',
  messages: 'messages',
  send: 'send',
  read: 'read',
  stream: 'stream',
} as const;
export type BridgeRoute = (typeof BRIDGE_ROUTES)[keyof typeof BRIDGE_ROUTES];

/** One request the store made, as the bridge saw it. Tokens are never kept, only whether one came. */
export interface BridgeRequest {
  readonly route: BridgeRoute;
  readonly repo: string | null;
  readonly withToken: boolean;
  readonly query?: MessagesQuery;
  readonly lastEventId?: number | null;
  readonly upToId?: number;
  readonly draft?: SendRequest;
}

/** A row someone writes through Chatter, as the CLI would: no policy, any sender. */
export interface Written {
  readonly from: string;
  /** Default "#chat". */
  readonly to?: string;
  readonly body: string;
  /** Default: the first recorded repo. */
  readonly repo?: string;
  readonly kind?: string;
  readonly ref_id?: string | null;
}

export interface ExtraRepo {
  readonly key: string;
  readonly label: string;
  readonly orphan?: boolean;
  readonly rows?: readonly Message[];
}

export interface FakeBridgeOptions {
  /** Message times come from it, so a row equals the one the fake store would make at the same moment. */
  readonly clock?: Clock;
  /** Who the tailnet identity header names when no token is sent; 'not-registered' answers 403. Default: nobody, so 401. */
  readonly identity?: FakeMember | 'not-registered' | null;
  /** Every member's read pointer in every repo. Default: the recorded ones (0, except mira's 5). */
  readonly lastReadId?: number;
}

const MAIN_PAGE = parseMessagesPage(body('messages-flan'));
const SITE_PAGE = parseMessagesPage(body('messages-site'));
/** The first recorded repo, where every member has history. */
export const MAIN_REPO = MAIN_PAGE.repo;
/** The second recorded repo: one #chat post. */
export const SITE_REPO = SITE_PAGE.repo;

// bridge/src/messages.js queryMessages and bridge/src/policy.js DEFAULT_LIMITS.
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_BODY = 8_000;
const KIND_POST = 'post';
const KIND_DM = 'chat';
const KIND_MENTION = 'mention';
const ROLE_ADMIN = 'admin';
const EVERYONE = 'everyone';
const NUL_MESSAGE = 'message contains a NUL byte';
const NOT_REGISTERED_MESSAGE = 'your Tailscale login is not registered as a member';
const NETWORK_MESSAGE = 'could not reach the bridge';
const RETRY_FIELD = 'retry: 2000\n\n';
// Throwaway credentials that open nothing anywhere; the bridge's real ones start with `cb_`.
const TOKEN_PREFIX = 'test-token-';
const encoder = new TextEncoder();

interface Table {
  epoch: string;
  readonly rows: Message[];
  /** The highest id in the table, visible to a member or not (it counts Chatter's mention copies too). */
  maxId: number;
}

interface Subscriber {
  readonly member: Me;
  readonly repo: string;
  /** Rows up to here were sent or are invisible to this member. */
  lastSent: number;
  readonly controller: ReadableStreamDefaultController<Uint8Array>;
  open: boolean;
}

interface RepoEntry {
  readonly key: string;
  readonly label: string;
  readonly orphan: boolean;
}

const abortError = (): DOMException => new DOMException('The operation was aborted.', 'AbortError');

/** The recorded exchanges of a member who can sign in, or undefined for anyone else. */
function recordedNames(handle: string): (typeof FAKE_MEMBERS)[FakeMember] | undefined {
  return Object.entries(FAKE_MEMBERS).find(([name]) => name === handle)?.[1];
}

function refusal(name: string): ApiError {
  const { status, code, message } = recordedError(name);
  return new ApiError(status, code, message);
}

/** bridge/src/util.js mentionsOf. */
function mentionsOf(text: string): { handles: string[]; everyone: boolean } {
  const handles = new Set<string>();
  let everyone = false;
  for (const match of text.matchAll(/@([a-z0-9_-]+)/gi)) {
    const name = (match[1] ?? '').toLowerCase();
    if (name === EVERYONE) everyone = true;
    else handles.add(name);
  }
  return { handles: [...handles], everyone };
}

/** bridge/src/messages.js canSee. */
function canSee(member: Me, row: Message): boolean {
  if (row.to === CHANNEL) return true;
  if (row.kind === KIND_MENTION) return false;
  if (member.role === ROLE_ADMIN) return true;
  return row.to === member.handle || row.from === member.handle;
}

function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const sse = {
  message: (row: Message): string => `id: ${row.id}\nevent: message\ndata: ${JSON.stringify(row)}\n\n`,
  hello: (epoch: string, maxId: number): string => `event: hello\ndata: ${JSON.stringify({ epoch, max_id: maxId })}\n\n`,
  bye: (reason: string): string => `event: bye\ndata: ${JSON.stringify({ reason })}\n\n`,
};

export class FakeBridge {
  /** Every request in order, refused or not. */
  readonly requests: BridgeRequest[] = [];
  /** When true, a send answers `id: null`, as the bridge does when it cannot find the row it wrote. */
  sendIdNull = false;
  identity: FakeMember | 'not-registered' | null;
  private readonly clock: Clock;
  private readonly lastReadId: number | undefined;
  private readonly tables = new Map<string, Table>();
  private readonly repoList: RepoEntry[] = [];
  private readonly tokens = new Map<string, string>();
  private readonly pointers = new Map<string, number>();
  private readonly revoked = new Set<string>();
  private readonly subscribers = new Set<Subscriber>();
  private readonly failures = new Map<BridgeRoute, unknown[]>();
  private readonly holding = new Set<BridgeRoute>();
  private readonly waiting = new Map<BridgeRoute, Array<() => void>>();
  private served: Directory = parseDirectory(body('directory'));
  private down = false;
  private deliveryHeld = false;
  private rotations = 0;
  private purges = 0;

  constructor(options: FakeBridgeOptions = {}) {
    this.clock = options.clock ?? new ManualClock();
    this.identity = options.identity ?? null;
    this.lastReadId = options.lastReadId;
    for (const page of [MAIN_PAGE, SITE_PAGE]) {
      this.tables.set(page.repo, { epoch: page.epoch, rows: [...page.messages], maxId: page.max_id });
    }
    for (const repo of parseRepos(body('repos-member')).repos) this.repoList.push({ key: repo.key, label: repo.label, orphan: repo.orphan });
    for (const handle of Object.keys(FAKE_MEMBERS)) this.tokens.set(`${TOKEN_PREFIX}${handle}`, handle);
  }

  /** The `api` option of createStore: an Api that sends whatever token the store holds. */
  readonly api = (getToken: () => string | null): Api => {
    const unscripted = (route: string) => async (): Promise<never> => {
      throw new Error(`fake bridge: ${route} is not scripted`);
    };
    const enter = async (route: BridgeRoute, signal: AbortSignal | undefined, request: Omit<BridgeRequest, 'route' | 'withToken'>): Promise<Me> => {
      const token = getToken()?.trim() ?? '';
      this.requests.push({ route, withToken: token !== '', ...request });
      await this.gate(route, signal);
      return this.authenticate(token);
    };
    const signalOf = (options?: RequestOptions): AbortSignal | undefined => options?.signal;
    return {
      health: unscripted('health'),
      board: unscripted('board'),
      members: unscripted('members'),
      addMember: unscripted('addMember'),
      updateMember: unscripted('updateMember'),
      revokeMember: unscripted('revokeMember'),
      rotateToken: unscripted('rotateToken'),
      audit: unscripted('audit'),
      me: async (options) => enter(BRIDGE_ROUTES.me, signalOf(options), { repo: null }),
      directory: async (options) => {
        await enter(BRIDGE_ROUTES.directory, signalOf(options), { repo: null });
        return parseDirectory(this.served);
      },
      repos: async (options) => {
        const member = await enter(BRIDGE_ROUTES.repos, signalOf(options), { repo: null });
        return { repos: this.repoList.map((entry) => this.repoFor(member, entry)) };
      },
      messages: async (repo, query = {}, options) => {
        const member = await enter(BRIDGE_ROUTES.messages, signalOf(options), { repo, query });
        return this.page(member, repo, query);
      },
      send: async (repo, draft, options) => {
        const member = await enter(BRIDGE_ROUTES.send, signalOf(options), { repo, draft: { to: draft.to, body: draft.body } });
        return this.accept(member, repo, draft);
      },
      markRead: async (repo, upToId, options) => {
        const member = await enter(BRIDGE_ROUTES.read, signalOf(options), { repo, upToId });
        const table = this.table(repo);
        const key = this.pointerKey(member.handle, repo);
        this.pointers.set(key, Math.max(this.pointer(member.handle, repo), Math.min(upToId, table.maxId)));
        return { last_read_id: this.pointer(member.handle, repo) };
      },
      openStream: async (repo, { lastEventId, signal }) => {
        const member = await enter(BRIDGE_ROUTES.stream, signal, { repo, lastEventId });
        return this.stream(member, repo, lastEventId, signal);
      },
    };
  };

  /** The token that signs `handle` in now. A throwaway string that opens nothing anywhere. */
  tokenOf(handle: string): string {
    for (const [token, owner] of this.tokens) if (owner === handle) return token;
    throw new Error(`fake bridge: no token for "${handle}"`);
  }

  /** Someone writes a row through Chatter; open streams that may see it get it at once, unless delivery is held. */
  write(written: Written): Message {
    const repo = written.repo ?? MAIN_REPO;
    const table = this.table(repo);
    const to = written.to ?? CHANNEL;
    const { handles, everyone } = mentionsOf(written.body);
    const message: Message = {
      id: table.maxId + 1,
      from: written.from,
      to,
      body: written.body,
      kind: written.kind ?? (to === CHANNEL ? KIND_POST : KIND_DM),
      ref_id: written.ref_id ?? null,
      created_at: isoSeconds(this.clock.now()),
      mentions: handles,
      everyone,
    };
    table.rows.push(message);
    table.maxId = message.id;
    this.flush(repo);
    return message;
  }

  /** A row the member may not see, such as Chatter's mention copy: it only moves max_id. */
  writeInvisible(repo = MAIN_REPO): number {
    const table = this.table(repo);
    table.maxId += 1;
    return table.maxId;
  }

  addRepo(extra: ExtraRepo): void {
    const rows = [...(extra.rows ?? [])];
    this.tables.set(extra.key, { epoch: `epoch-${extra.key}`, rows, maxId: Math.max(0, ...rows.map((row) => row.id)) });
    this.repoList.push({ key: extra.key, label: extra.label, orphan: extra.orphan ?? false });
  }

  setDirectory(directory: Directory): void {
    // A copy through the guard: whatever the store does with it must not reach the caller's object.
    this.served = parseDirectory(directory);
  }

  /** The repo's database is deleted and recreated: a new epoch, no rows, and every stream on it gets `bye epoch`. */
  purge(repo = MAIN_REPO): void {
    const table = this.table(repo);
    this.purges += 1;
    table.epoch = `${table.epoch}-purged-${this.purges}`;
    table.rows.length = 0;
    table.maxId = 0;
    for (const sub of [...this.subscribers]) if (sub.repo === repo) this.end(sub, BYE_REASONS.epoch);
  }

  /** The admin revokes the member: its streams get `bye revoked` and its credentials stop working. */
  revoke(handle: string): void {
    this.revoked.add(handle);
    for (const sub of [...this.subscribers]) if (sub.member.handle === handle) this.end(sub, BYE_REASONS.revoked);
  }

  /** The admin rotates the member's token: its streams get `bye token_rotated` and the old token stops working. */
  rotate(handle: string): string {
    const old = this.tokenOf(handle);
    this.tokens.delete(old);
    this.rotations += 1;
    const fresh = `${TOKEN_PREFIX}${handle}-rotated-${this.rotations}`;
    this.tokens.set(fresh, handle);
    for (const sub of [...this.subscribers]) if (sub.member.handle === handle) this.end(sub, BYE_REASONS.tokenRotated);
    return fresh;
  }

  /** The network drops: open streams break, and every request fails until restore(). */
  cut(): void {
    this.down = true;
    for (const sub of [...this.subscribers]) {
      this.subscribers.delete(sub);
      sub.open = false;
      sub.controller.error(new TypeError('network connection lost'));
    }
  }

  restore(): void {
    this.down = false;
  }

  /** The next calls to `route` fail with these errors, one each. */
  failNext(route: BridgeRoute, ...errors: unknown[]): void {
    this.failures.set(route, [...(this.failures.get(route) ?? []), ...errors]);
  }

  /** Calls to `route` wait until release(route). */
  hold(route: BridgeRoute): void {
    this.holding.add(route);
  }

  release(route: BridgeRoute): void {
    this.holding.delete(route);
    for (const resume of this.waiting.get(route)?.splice(0) ?? []) resume();
  }

  /** New rows stay out of open streams until releaseDelivery(), as when the stream lags. */
  holdDelivery(): void {
    this.deliveryHeld = true;
  }

  releaseDelivery(): void {
    this.deliveryHeld = false;
    for (const key of this.tables.keys()) this.flush(key);
  }

  readPointer(handle: string, repo = MAIN_REPO): number {
    return this.pointer(handle, repo);
  }

  /** Streams open right now, on one repo or on all. */
  openStreams(repo?: string): number {
    return [...this.subscribers].filter((sub) => sub.open && (repo === undefined || sub.repo === repo)).length;
  }

  count(route: BridgeRoute, repo?: string): number {
    return this.requests.filter((r) => r.route === route && (repo === undefined || r.repo === repo)).length;
  }

  rows(repo = MAIN_REPO): readonly Message[] {
    return this.table(repo).rows;
  }

  // ------------------------------------------------------------------------------------------ inside

  private async gate(route: BridgeRoute, signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) throw abortError();
    if (this.holding.has(route)) {
      await new Promise<void>((resolve, reject) => {
        const list = this.waiting.get(route) ?? [];
        list.push(resolve);
        this.waiting.set(route, list);
        signal?.addEventListener('abort', () => reject(abortError()), { once: true });
      });
    }
    if (signal?.aborted) throw abortError();
    if (this.down) throw new NetworkError(NETWORK_MESSAGE);
    const queued = this.failures.get(route);
    if (queued && queued.length > 0) throw queued.shift();
  }

  private authenticate(token: string): Me {
    if (token) {
      const handle = this.tokens.get(token);
      if (handle === undefined || this.revoked.has(handle)) throw refusal('me-bad-token');
      return this.meOf(handle);
    }
    if (this.identity === 'not-registered') throw new ApiError(403, ERROR_CODES.notRegistered, NOT_REGISTERED_MESSAGE);
    if (this.identity !== null) {
      if (this.revoked.has(this.identity)) throw new ApiError(403, ERROR_CODES.notRegistered, NOT_REGISTERED_MESSAGE);
      return this.meOf(this.identity);
    }
    throw refusal('me-unauthenticated');
  }

  private meOf(handle: string): Me {
    const names = recordedNames(handle);
    if (!names) throw new Error(`fake bridge: "${handle}" cannot sign in`);
    return parseMe(body(names.me));
  }

  private table(repo: string): Table {
    const table = this.tables.get(repo);
    if (!table) throw new ApiError(404, ERROR_CODES.noSuchRepo, `no repo "${repo}"`);
    return table;
  }

  private pointerKey(handle: string, repo: string): string {
    return `${handle}\n${repo}`;
  }

  private pointer(handle: string, repo: string): number {
    const set = this.pointers.get(this.pointerKey(handle, repo));
    if (set !== undefined) return set;
    if (this.lastReadId !== undefined) return this.lastReadId;
    const names = recordedNames(handle);
    if (!names) return 0;
    return parseRepos(body(names.repos)).repos.find((r) => r.key === repo)?.last_read_id ?? 0;
  }

  private repoFor(member: Me, entry: RepoEntry): Repo {
    const table = this.table(entry.key);
    return {
      key: entry.key,
      label: entry.label,
      repo_root: member.role === ROLE_ADMIN ? `<scratch>/${entry.label}` : null,
      orphan: entry.orphan,
      messages: table.rows.length,
      last_activity: table.rows.at(-1)?.created_at ?? null,
      epoch: table.epoch,
      last_read_id: this.pointer(member.handle, entry.key),
    };
  }

  /** bridge/src/messages.js queryMessages. */
  private page(member: Me, repo: string, query: MessagesQuery): MessagesPage {
    const table = this.table(repo);
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const visible = table.rows.filter((row) => canSee(member, row));
    let rows: Message[];
    let hasMore: boolean;
    if (query.afterId !== undefined) {
      const after = query.afterId;
      const newer = visible.filter((row) => row.id > after);
      hasMore = newer.length > limit;
      rows = newer.slice(0, limit);
    } else {
      const before = query.beforeId;
      const older = before === undefined ? visible : visible.filter((row) => row.id < before);
      hasMore = older.length > limit;
      rows = older.slice(-limit);
    }
    return { repo, epoch: table.epoch, messages: rows.map((row) => ({ ...row, mentions: [...row.mentions] })), has_more: hasMore, max_id: table.maxId };
  }

  /** bridge/src/policy.js checkWrite, in its order, then the write. */
  private accept(member: Me, repo: string, draft: SendRequest): SendResult {
    this.table(repo);
    if (!draft.to) throw refusal('post-missing-to');
    const text = draft.body.trim();
    if (!text) throw refusal('post-empty');
    if (text.includes('\0')) throw new ApiError(400, ERROR_CODES.invalidBody, NUL_MESSAGE);
    if (text.length > MAX_BODY) throw refusal('post-too-long');
    const admin = member.role === ROLE_ADMIN;
    const { handles, everyone } = mentionsOf(text);
    const agents = new Set(this.served.agents);
    const members = new Set(this.served.members.map((m) => m.handle));
    let mentioned: string[];
    let delivery: SendResult['delivery'] = null;
    if (draft.to === CHANNEL) {
      if (everyone && !admin) throw refusal('post-everyone-member');
      if (!admin && !member.can_address_agents && handles.some((h) => agents.has(h))) throw refusal('post-agents-not-allowed');
      mentioned = handles.filter((h) => members.has(h) && h !== member.handle);
    } else {
      if (draft.to === member.handle) throw refusal('post-self-dm');
      const toAgent = agents.has(draft.to);
      if (!toAgent && !members.has(draft.to)) {
        throw new ApiError(404, ERROR_CODES.unknownRecipient, `no agent or member named "${draft.to}"`);
      }
      if (toAgent && !admin && !member.can_address_agents) throw refusal('post-dm-agent-not-allowed');
      mentioned = members.has(draft.to) ? [draft.to] : [];
      if (toAgent) delivery = 'queued';
    }
    const written = this.write({ from: member.handle, to: draft.to, body: text, repo });
    return { id: this.sendIdNull ? null : written.id, pushed: [], warnings: [], mentioned_members: mentioned, delivery };
  }

  private stream(member: Me, repo: string, lastEventId: number | null, signal: AbortSignal): ReadableStream<Uint8Array> {
    const table = this.table(repo);
    let sub: Subscriber | null = null;
    const wire = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const opened: Subscriber = { member, repo, lastSent: lastEventId ?? table.maxId, controller, open: true };
        sub = opened;
        this.send(opened, RETRY_FIELD);
        // Replay up to the current max, then hello, as server.js openStream does.
        if (lastEventId !== null) {
          for (const row of table.rows) {
            if (row.id > lastEventId && canSee(member, row)) this.send(opened, sse.message(row));
          }
        }
        this.send(opened, sse.hello(table.epoch, table.maxId));
        opened.lastSent = Math.max(opened.lastSent, table.maxId);
        this.subscribers.add(opened);
      },
      cancel: () => {
        if (sub) {
          sub.open = false;
          this.subscribers.delete(sub);
        }
      },
    });
    signal.addEventListener('abort', () => {
      if (sub?.open) {
        sub.open = false;
        this.subscribers.delete(sub);
        sub.controller.error(abortError());
      }
    }, { once: true });
    return wire;
  }

  private send(sub: Subscriber, text: string): void {
    if (sub.open) sub.controller.enqueue(encoder.encode(text));
  }

  private flush(repo: string): void {
    if (this.deliveryHeld) return;
    const table = this.table(repo);
    for (const sub of this.subscribers) {
      if (sub.repo !== repo || !sub.open) continue;
      for (const row of table.rows) {
        if (row.id <= sub.lastSent) continue;
        if (canSee(sub.member, row)) this.send(sub, sse.message(row));
        sub.lastSent = row.id;
      }
    }
  }

  private end(sub: Subscriber, reason: string): void {
    this.send(sub, sse.bye(reason));
    sub.open = false;
    this.subscribers.delete(sub);
    sub.controller.close();
  }
}
