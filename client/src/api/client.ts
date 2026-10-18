// The typed client for every bridge route. One method per route; each sends credentials only
// when the caller has a token, checks the answer with guards.ts, and fails with ApiError,
// NetworkError or ProtocolError (errors.ts). A caller's own abort is passed through untouched.
import { ApiError, CLIENT_ERROR_CODES, NetworkError, ProtocolError } from './errors';
import {
  parseAddMemberResult,
  parseAudit,
  parseBoard,
  parseConversations,
  parseDirectory,
  parseErrorBody,
  parseHealth,
  parseMe,
  parseMemberResult,
  parseMembers,
  parseMessagesPage,
  parseReadResult,
  parseRepos,
  parseSendResult,
  parseTokenResult,
} from './guards';
import { QUERY, ROUTES } from './routes';
import type {
  AddMemberRequest,
  AddMemberResult,
  AuditQuery,
  AuditResponse,
  Board,
  ConversationsResponse,
  Directory,
  Health,
  Me,
  MemberResult,
  MembersResponse,
  MessagesPage,
  MessagesQuery,
  ReadResult,
  ReposResponse,
  SendRequest,
  SendResult,
  TokenResult,
  UpdateMemberRequest,
} from './types';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ApiOptions {
  /** Prepended to every path. Empty (the default) means the page's own origin, as in production. */
  readonly baseUrl?: string;
  /**
   * The member's token, or null. Read on every request and never kept: the caller owns it and
   * holds it in memory only. With null, no `Authorization` is sent and the tailnet identity
   * header, added by `tailscale serve`, identifies the member.
   */
  readonly getToken: () => string | null;
  readonly fetch?: FetchLike;
}

export interface RequestOptions {
  readonly signal?: AbortSignal;
}

export interface StreamRequest {
  /** Resume after this message id (sent as `Last-Event-ID`); null for "from now". */
  readonly lastEventId: number | null;
  readonly signal: AbortSignal;
}

export interface Api {
  health(options?: RequestOptions): Promise<Health>;
  me(options?: RequestOptions): Promise<Me>;
  directory(options?: RequestOptions): Promise<Directory>;
  repos(options?: RequestOptions): Promise<ReposResponse>;
  messages(repo: string, query?: MessagesQuery, options?: RequestOptions): Promise<MessagesPage>;
  /** The direct-message pairs the caller may see, however old (types.ts, ConversationsResponse). */
  conversations(repo: string, options?: RequestOptions): Promise<ConversationsResponse>;
  send(repo: string, message: SendRequest, options?: RequestOptions): Promise<SendResult>;
  board(repo: string, options?: RequestOptions): Promise<Board>;
  markRead(repo: string, upToId: number, options?: RequestOptions): Promise<ReadResult>;
  members(options?: RequestOptions): Promise<MembersResponse>;
  addMember(member: AddMemberRequest, options?: RequestOptions): Promise<AddMemberResult>;
  updateMember(handle: string, patch: UpdateMemberRequest, options?: RequestOptions): Promise<MemberResult>;
  revokeMember(handle: string, options?: RequestOptions): Promise<MemberResult>;
  rotateToken(handle: string, options?: RequestOptions): Promise<TokenResult>;
  audit(query?: AuditQuery, options?: RequestOptions): Promise<AuditResponse>;
  /** Opens the SSE stream and returns its body once the bridge has accepted it. stream.ts reads it. */
  openStream(repo: string, request: StreamRequest): Promise<ReadableStream<Uint8Array>>;
}

const JSON_TYPE = 'application/json';
const EVENT_STREAM = 'text/event-stream';
const HEADERS = {
  accept: 'Accept',
  authorization: 'Authorization',
  contentType: 'Content-Type',
  lastEventId: 'Last-Event-ID',
} as const;
const METHODS = { get: 'GET', post: 'POST', patch: 'PATCH', delete: 'DELETE' } as const;
// What the bridge's `Bearer\s+(\S+)` can carry. Anything else is refused here, before a header is
// built from it: Node's Headers quotes the whole invalid value in its TypeError (checked with a
// dummy value containing NUL), which would put the token in an error message.
const SENDABLE_TOKEN = /^[\x21-\x7e]+$/;
// The status the bridge itself gives a token it cannot use.
const UNAUTHORIZED = 401;

function nonNegativeInteger(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${what} must be a non-negative integer`);
  return value;
}

function withQuery(path: string, entries: ReadonlyArray<readonly [string, number | undefined]>): string {
  const params = new URLSearchParams();
  for (const [name, value] of entries) if (value !== undefined) params.set(name, String(nonNegativeInteger(value, name)));
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export function createApi(options: ApiOptions): Api {
  const baseUrl = options.baseUrl ?? '';
  const fetchImpl: FetchLike = options.fetch ?? ((url, init) => globalThis.fetch(url, init));

  function headersFor(accept: string): Headers {
    const headers = new Headers({ [HEADERS.accept]: accept });
    const token = options.getToken()?.trim();
    if (token) {
      if (!SENDABLE_TOKEN.test(token)) {
        throw new ApiError(UNAUTHORIZED, CLIENT_ERROR_CODES.unusableToken, 'the token contains spaces or control characters');
      }
      headers.set(HEADERS.authorization, `Bearer ${token}`);
    }
    return headers;
  }

  async function exchange(path: string, init: RequestInit): Promise<Response> {
    try {
      return await fetchImpl(`${baseUrl}${path}`, init);
    } catch (failure) {
      if (init.signal?.aborted) throw failure;
      throw new NetworkError('could not reach the bridge', { cause: failure });
    }
  }

  async function readText(response: Response, signal: AbortSignal | null | undefined): Promise<string> {
    try {
      return await response.text();
    } catch (failure) {
      if (signal?.aborted) throw failure;
      throw new NetworkError('the connection to the bridge broke during an answer', { cause: failure });
    }
  }

  function refusal(status: number, text: string): ApiError {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const body = parseErrorBody(parsed);
    return body
      ? new ApiError(status, body.error.code, body.error.message)
      : new ApiError(status, CLIENT_ERROR_CODES.unexpectedStatus, `the bridge answered HTTP ${status}`);
  }

  async function call<T>(method: string, path: string, parse: (value: unknown) => T, body: unknown, signal?: AbortSignal): Promise<T> {
    const headers = headersFor(JSON_TYPE);
    const init: RequestInit = { method, headers };
    if (signal) init.signal = signal;
    if (body !== undefined) {
      headers.set(HEADERS.contentType, JSON_TYPE);
      init.body = JSON.stringify(body);
    }
    const response = await exchange(path, init);
    const text = await readText(response, signal);
    if (!response.ok) throw refusal(response.status, text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ProtocolError('body', 'is not JSON');
    }
    return parse(parsed);
  }

  const get = <T>(path: string, parse: (value: unknown) => T, o?: RequestOptions): Promise<T> => call(METHODS.get, path, parse, undefined, o?.signal);

  // Every method is async, so a bad argument rejects like any other failure instead of throwing.
  return {
    health: async (o) => get(ROUTES.health, parseHealth, o),
    me: async (o) => get(ROUTES.me, parseMe, o),
    directory: async (o) => get(ROUTES.directory, parseDirectory, o),
    repos: async (o) => get(ROUTES.repos, parseRepos, o),
    messages: async (repo, query = {}, o) => get(
      withQuery(ROUTES.messages(repo), [[QUERY.afterId, query.afterId], [QUERY.beforeId, query.beforeId], [QUERY.limit, query.limit]]),
      parseMessagesPage,
      o,
    ),
    conversations: async (repo, o) => get(ROUTES.conversations(repo), parseConversations, o),
    send: async (repo, message, o) => call(METHODS.post, ROUTES.messages(repo), parseSendResult, { to: message.to, body: message.body }, o?.signal),
    board: async (repo, o) => get(ROUTES.board(repo), parseBoard, o),
    markRead: async (repo, upToId, o) => call(METHODS.post, ROUTES.read(repo), parseReadResult, { up_to_id: nonNegativeInteger(upToId, 'up_to_id') }, o?.signal),
    members: async (o) => get(ROUTES.members, parseMembers, o),
    addMember: async (member, o) => call(METHODS.post, ROUTES.members, parseAddMemberResult, member, o?.signal),
    updateMember: async (handle, patch, o) => call(METHODS.patch, ROUTES.member(handle), parseMemberResult, patch, o?.signal),
    revokeMember: async (handle, o) => call(METHODS.delete, ROUTES.member(handle), parseMemberResult, undefined, o?.signal),
    rotateToken: async (handle, o) => call(METHODS.post, ROUTES.memberToken(handle), parseTokenResult, undefined, o?.signal),
    audit: async (query = {}, o) => get(withQuery(ROUTES.audit, [[QUERY.limit, query.limit], [QUERY.beforeId, query.beforeId]]), parseAudit, o),

    async openStream(repo, { lastEventId, signal }) {
      const headers = headersFor(EVENT_STREAM);
      if (lastEventId !== null) headers.set(HEADERS.lastEventId, String(nonNegativeInteger(lastEventId, 'lastEventId')));
      const response = await exchange(ROUTES.stream(repo), { method: METHODS.get, headers, signal });
      if (!response.ok) throw refusal(response.status, await readText(response, signal));
      const type = response.headers.get(HEADERS.contentType) ?? '';
      if (!type.toLowerCase().startsWith(EVENT_STREAM) || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw new ProtocolError('content-type', `is "${type}", not ${EVENT_STREAM} with a body`);
      }
      return response.body;
    },
  };
}
