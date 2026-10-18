// Checks every bridge answer at the boundary. Each parser takes `unknown` (parsed JSON) and returns
// a fresh object with exactly the typed fields, or throws a ProtocolError naming the first field
// that does not match, e.g. `messages[3].created_at`. Unknown extra fields are dropped, so nothing
// the types do not describe reaches the views.
import { ProtocolError } from './errors';
import {
  DELIVERIES,
  MEMBER_KINDS,
  MEMBER_ROLES,
  MEMBER_STATUSES,
  type AddMemberResult,
  type AgentTask,
  type AuditEntry,
  type AuditResponse,
  type Board,
  type BoardAgent,
  type BoardHandoff,
  type BoardNote,
  type BoardTask,
  type Bye,
  type ConversationPair,
  type ConversationsResponse,
  type Directory,
  type DirectoryMember,
  type ErrorBody,
  type Health,
  type Hello,
  type Me,
  type Member,
  type MemberResult,
  type MembersResponse,
  type Message,
  type MessagesPage,
  type ReadResult,
  type Repo,
  type ReposResponse,
  type SendResult,
  type TokenResult,
} from './types';

type Fields = Readonly<Record<string, unknown>>;
type Item<T> = (value: unknown, path: string) => T;

// The bridge's own form, and the zoneless UTC form Chatter's CLI prints (only board agents use it).
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const CHATTER_UTC = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const ROOT = 'body';

const at = (path: string, key: string): string => (path ? `${path}.${key}` : key);

function fields(value: unknown, path: string): Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProtocolError(path || ROOT, 'is not an object');
  }
  // Checked just above: a non-null, non-array object.
  return value as Fields;
}

function string(o: Fields, key: string, path: string): string {
  const v = o[key];
  if (typeof v !== 'string') throw new ProtocolError(at(path, key), 'is not a string');
  return v;
}

function nullableString(o: Fields, key: string, path: string): string | null {
  return o[key] === null ? null : string(o, key, path);
}

/** For objects that come from Chatter's CLI rather than the bridge: a missing field counts as null. */
function optionalString(o: Fields, key: string, path: string): string | null {
  return o[key] === undefined ? null : nullableString(o, key, path);
}

function bool(o: Fields, key: string, path: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') throw new ProtocolError(at(path, key), 'is not a boolean');
  return v;
}

/** Ids, counts and cursors: never negative, never fractional. */
function count(o: Fields, key: string, path: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
    throw new ProtocolError(at(path, key), 'is not a non-negative integer');
  }
  return v;
}

function nullableCount(o: Fields, key: string, path: string): number | null {
  return o[key] === null ? null : count(o, key, path);
}

function oneOf<T extends string>(o: Fields, key: string, path: string, allowed: readonly T[]): T {
  const v = o[key];
  const found = allowed.find((option) => option === v);
  if (found === undefined) throw new ProtocolError(at(path, key), `is not one of ${allowed.join(', ')}`);
  return found;
}

function timestamp(o: Fields, key: string, path: string): string {
  const v = string(o, key, path);
  if (!ISO_UTC.test(v)) throw new ProtocolError(at(path, key), 'is not an ISO 8601 UTC timestamp');
  return v;
}

function nullableTimestamp(o: Fields, key: string, path: string): string | null {
  return o[key] === null ? null : timestamp(o, key, path);
}

/** Chatter's own JSON prints UTC without a zone; reading that as local time would shift it. */
function chatterTimestamp(o: Fields, key: string, path: string): string | null {
  const v = optionalString(o, key, path);
  if (v === null || ISO_UTC.test(v)) return v;
  if (CHATTER_UTC.test(v)) return `${v.replace(' ', 'T')}Z`;
  throw new ProtocolError(at(path, key), 'is not a UTC timestamp');
}

function list<T>(o: Fields, key: string, path: string, item: Item<T>): T[] {
  const v = o[key];
  const where = at(path, key);
  if (!Array.isArray(v)) throw new ProtocolError(where, 'is not an array');
  // The array is JSON, so its elements are unknown until each one is checked.
  return (v as readonly unknown[]).map((element, index) => item(element, `${where}[${index}]`));
}

const text: Item<string> = (value, path) => {
  if (typeof value !== 'string') throw new ProtocolError(path, 'is not a string');
  return value;
};

function record(o: Fields, key: string, path: string): Readonly<Record<string, unknown>> | null {
  return o[key] === null ? null : fields(o[key], at(path, key));
}

// ----------------------------------------------------------------------------- session and lists

export function parseHealth(value: unknown): Health {
  const o = fields(value, '');
  return { ok: bool(o, 'ok', ''), version: string(o, 'version', ''), repos: count(o, 'repos', '') };
}

export function parseMe(value: unknown): Me {
  const o = fields(value, '');
  return {
    handle: string(o, 'handle', ''),
    display_name: string(o, 'display_name', ''),
    kind: oneOf(o, 'kind', '', MEMBER_KINDS),
    role: oneOf(o, 'role', '', MEMBER_ROLES),
    can_address_agents: bool(o, 'can_address_agents', ''),
  };
}

const directoryMember: Item<DirectoryMember> = (value, path) => {
  const o = fields(value, path);
  return {
    handle: string(o, 'handle', path),
    display_name: string(o, 'display_name', path),
    kind: oneOf(o, 'kind', path, MEMBER_KINDS),
  };
};

export function parseDirectory(value: unknown): Directory {
  const o = fields(value, '');
  return { members: list(o, 'members', '', directoryMember), agents: list(o, 'agents', '', text) };
}

const repo: Item<Repo> = (value, path) => {
  const o = fields(value, path);
  return {
    key: string(o, 'key', path),
    label: string(o, 'label', path),
    repo_root: nullableString(o, 'repo_root', path),
    orphan: bool(o, 'orphan', path),
    messages: count(o, 'messages', path),
    last_activity: nullableTimestamp(o, 'last_activity', path),
    epoch: string(o, 'epoch', path),
    last_read_id: count(o, 'last_read_id', path),
  };
};

export function parseRepos(value: unknown): ReposResponse {
  return { repos: list(fields(value, ''), 'repos', '', repo) };
}

// ------------------------------------------------------------------------------------- messages

/** Exported for the stream, which receives one message per event rather than a page. */
export const parseMessage: Item<Message> = (value, path) => {
  const o = fields(value, path);
  return {
    id: count(o, 'id', path),
    from: string(o, 'from', path),
    to: string(o, 'to', path),
    body: string(o, 'body', path),
    kind: string(o, 'kind', path),
    ref_id: nullableString(o, 'ref_id', path),
    created_at: timestamp(o, 'created_at', path),
    mentions: list(o, 'mentions', path, text),
    everyone: bool(o, 'everyone', path),
  };
};

export function parseMessagesPage(value: unknown): MessagesPage {
  const o = fields(value, '');
  return {
    repo: string(o, 'repo', ''),
    epoch: string(o, 'epoch', ''),
    messages: list(o, 'messages', '', parseMessage),
    has_more: bool(o, 'has_more', ''),
    max_id: count(o, 'max_id', ''),
  };
}

const conversationPair: Item<ConversationPair> = (value, path) => {
  const o = fields(value, path);
  return {
    a: string(o, 'a', path),
    b: string(o, 'b', path),
    last_id: count(o, 'last_id', path),
    last_at: timestamp(o, 'last_at', path),
  };
};

export function parseConversations(value: unknown): ConversationsResponse {
  const o = fields(value, '');
  return { repo: string(o, 'repo', ''), conversations: list(o, 'conversations', '', conversationPair) };
}

export function parseSendResult(value: unknown): SendResult {
  const o = fields(value, '');
  return {
    id: nullableCount(o, 'id', ''),
    pushed: list(o, 'pushed', '', text),
    warnings: list(o, 'warnings', '', text),
    mentioned_members: list(o, 'mentioned_members', '', text),
    delivery: o['delivery'] === null ? null : oneOf(o, 'delivery', '', DELIVERIES),
  };
}

export function parseReadResult(value: unknown): ReadResult {
  return { last_read_id: count(fields(value, ''), 'last_read_id', '') };
}

// ---------------------------------------------------------------------------------------- board

const agentTask = (o: Fields, key: string, path: string): AgentTask | null => {
  if (o[key] === undefined || o[key] === null) return null;
  const where = at(path, key);
  const t = fields(o[key], where);
  return { id: string(t, 'id', where), title: string(t, 'title', where) };
};

const boardAgent: Item<BoardAgent> = (value, path) => {
  const o = fields(value, path);
  return {
    name: string(o, 'name', path),
    kind: optionalString(o, 'kind', path),
    role: optionalString(o, 'role', path),
    status: optionalString(o, 'status', path),
    branch: optionalString(o, 'branch', path),
    task: agentTask(o, 'task', path),
    registered_at: chatterTimestamp(o, 'registered_at', path),
    last_seen_at: chatterTimestamp(o, 'last_seen_at', path),
    departed_at: chatterTimestamp(o, 'departed_at', path),
  };
};

const boardTask: Item<BoardTask> = (value, path) => {
  const o = fields(value, path);
  return {
    id: string(o, 'id', path),
    title: string(o, 'title', path),
    status: string(o, 'status', path),
    assignee: nullableString(o, 'assignee', path),
    created_by: nullableString(o, 'created_by', path),
    created_at: nullableTimestamp(o, 'created_at', path),
    updated_at: nullableTimestamp(o, 'updated_at', path),
  };
};

const boardNote: Item<BoardNote> = (value, path) => {
  const o = fields(value, path);
  return {
    id: count(o, 'id', path),
    author: string(o, 'author', path),
    type: string(o, 'type', path),
    text: string(o, 'text', path),
    task_id: nullableString(o, 'task_id', path),
    created_at: nullableTimestamp(o, 'created_at', path),
  };
};

const boardHandoff: Item<BoardHandoff> = (value, path) => {
  const o = fields(value, path);
  return {
    id: count(o, 'id', path),
    task_id: nullableString(o, 'task_id', path),
    from: string(o, 'from', path),
    to: nullableString(o, 'to', path),
    summary: string(o, 'summary', path),
    branch: nullableString(o, 'branch', path),
    status: string(o, 'status', path),
    created_at: nullableTimestamp(o, 'created_at', path),
  };
};

export function parseBoard(value: unknown): Board {
  const o = fields(value, '');
  return {
    repo: string(o, 'repo', ''),
    epoch: string(o, 'epoch', ''),
    agents: list(o, 'agents', '', boardAgent),
    agents_error: nullableString(o, 'agents_error', ''),
    tasks: list(o, 'tasks', '', boardTask),
    notes: list(o, 'notes', '', boardNote),
    questions: list(o, 'questions', '', boardNote),
    handoffs: list(o, 'handoffs', '', boardHandoff),
  };
}

// ---------------------------------------------------------------------------------------- admin

const member: Item<Member> = (value, path) => {
  const o = fields(value, path);
  return {
    handle: string(o, 'handle', path),
    display_name: string(o, 'display_name', path),
    kind: oneOf(o, 'kind', path, MEMBER_KINDS),
    role: oneOf(o, 'role', path, MEMBER_ROLES),
    can_address_agents: bool(o, 'can_address_agents', path),
    tailscale_login: nullableString(o, 'tailscale_login', path),
    status: oneOf(o, 'status', path, MEMBER_STATUSES),
    created_at: timestamp(o, 'created_at', path),
    last_seen_at: nullableTimestamp(o, 'last_seen_at', path),
  };
};

export function parseMembers(value: unknown): MembersResponse {
  return { members: list(fields(value, ''), 'members', '', member) };
}

export function parseMemberResult(value: unknown): MemberResult {
  return { member: member(fields(value, '')['member'], 'member') };
}

export function parseAddMemberResult(value: unknown): AddMemberResult {
  const o = fields(value, '');
  return { member: member(o['member'], 'member'), token: nullableString(o, 'token', '') };
}

export function parseTokenResult(value: unknown): TokenResult {
  return { token: string(fields(value, ''), 'token', '') };
}

const auditEntry: Item<AuditEntry> = (value, path) => {
  const o = fields(value, path);
  return {
    id: count(o, 'id', path),
    at: timestamp(o, 'at', path),
    actor: string(o, 'actor', path),
    action: string(o, 'action', path),
    target: nullableString(o, 'target', path),
    repo: nullableString(o, 'repo', path),
    message_id: nullableCount(o, 'message_id', path),
    detail: record(o, 'detail', path),
  };
};

export function parseAudit(value: unknown): AuditResponse {
  return { entries: list(fields(value, ''), 'entries', '', auditEntry) };
}

// ------------------------------------------------------------------------------- stream and errors

export function parseHello(value: unknown): Hello {
  const o = fields(value, '');
  return { epoch: string(o, 'epoch', ''), max_id: count(o, 'max_id', '') };
}

export function parseBye(value: unknown): Bye {
  return { reason: string(fields(value, ''), 'reason', '') };
}

/** The bridge's error shape, or null when a non-2xx answer is something else (a proxy's page). */
export function parseErrorBody(value: unknown): ErrorBody | null {
  try {
    const error = fields(fields(value, '')['error'], 'error');
    return { error: { code: string(error, 'code', 'error'), message: string(error, 'message', 'error') } };
  } catch (failure) {
    if (failure instanceof ProtocolError) return null;
    throw failure;
  }
}
