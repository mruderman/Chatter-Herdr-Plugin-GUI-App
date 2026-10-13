// Request and response types for every bridge route (docs/SPEC.md section 5), taken from the
// recordings in client/test/fixtures/api.json. Where the recordings and the SPEC prose differ, the
// recordings win. Every timestamp here is ISO 8601 UTC ending in `Z`, guards.ts makes sure of it.
// Ids only rise, but a member's view of them has gaps (other people's DMs, Chatter's mention
// copies), so nothing may be inferred from a gap.

export const MEMBER_KINDS = ['human', 'computational'] as const;
export type MemberKind = (typeof MEMBER_KINDS)[number];

export const MEMBER_ROLES = ['admin', 'member'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const MEMBER_STATUSES = ['active', 'revoked'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

/** Delivery of a DM to a Herdr agent; null for anything else. */
export const DELIVERIES = ['delivered', 'queued'] as const;
export type Delivery = (typeof DELIVERIES)[number];

/** Where a message to the group chat goes; every other `to` is a member handle or an agent name. */
export const CHANNEL = '#chat';

/** GET /healthz (no credentials). */
export interface Health {
  readonly ok: boolean;
  readonly version: string;
  readonly repos: number;
}

/** GET /v1/me */
export interface Me {
  readonly handle: string;
  readonly display_name: string;
  readonly kind: MemberKind;
  readonly role: MemberRole;
  readonly can_address_agents: boolean;
}

export interface DirectoryMember {
  readonly handle: string;
  readonly display_name: string;
  readonly kind: MemberKind;
}

/** GET /v1/directory: active members only, and agent names sorted. */
export interface Directory {
  readonly members: readonly DirectoryMember[];
  readonly agents: readonly string[];
}

export interface Repo {
  readonly key: string;
  readonly label: string;
  /** A host path, sent to the admin only; null for everyone else. */
  readonly repo_root: string | null;
  readonly orphan: boolean;
  /** Rows in Chatter's table, including ones this member cannot see. */
  readonly messages: number;
  readonly last_activity: string | null;
  readonly epoch: string;
  readonly last_read_id: number;
}

/** GET /v1/repos */
export interface ReposResponse {
  readonly repos: readonly Repo[];
}

/**
 * One chat message. `to` is CHANNEL or a handle or agent name. `kind` is Chatter's: `post` in
 * #chat, `chat` for a DM, and `system`, `handoff` or `purpose` for DMs Chatter writes itself.
 * `ref_id` is Chatter's reference (`TASK-1`, `h1`, `q2`). `mentions` never contains `everyone`;
 * that is `everyone: true`.
 */
export interface Message {
  readonly id: number;
  readonly from: string;
  readonly to: string;
  readonly body: string;
  readonly kind: string;
  readonly ref_id: string | null;
  readonly created_at: string;
  readonly mentions: readonly string[];
  readonly everyone: boolean;
}

/**
 * GET /v1/repos/{key}/messages. Oldest first, at most 500. `max_id` is the largest id in the
 * whole table, visible to this member or not. It is read in a separate statement from the messages, so
 * a row written between the two can be counted in `max_id` and missing from `messages`: resume a stream
 * after the highest message id returned, never after `max_id`.
 */
export interface MessagesPage {
  readonly repo: string;
  readonly epoch: string;
  readonly messages: readonly Message[];
  readonly has_more: boolean;
  readonly max_id: number;
}

/** With neither cursor, the newest page. `afterId` walks forward, `beforeId` walks back. */
export interface MessagesQuery {
  readonly afterId?: number;
  readonly beforeId?: number;
  readonly limit?: number;
}

/** POST /v1/repos/{key}/messages */
export interface SendRequest {
  readonly to: string;
  readonly body: string;
}

/**
 * 201 answer to a send. `id` is null only if the bridge could not find the row it just wrote.
 * `pushed` names agents whose panes got the text, with " (queued)" appended when no pane was live.
 * `mentioned_members` is the members mentioned in a #chat post, or the recipient of a DM.
 */
export interface SendResult {
  readonly id: number | null;
  readonly pushed: readonly string[];
  readonly warnings: readonly string[];
  readonly mentioned_members: readonly string[];
  readonly delivery: Delivery | null;
}

/** POST /v1/repos/{key}/read: the pointer only moves forward and is capped at the newest id. */
export interface ReadResult {
  readonly last_read_id: number;
}

export interface AgentTask {
  readonly id: string;
  readonly title: string;
}

/**
 * A Herdr agent as Chatter's `agents --all --json` reports it. The bridge passes Chatter's object
 * through for an admin and, for anyone else, only the keys without a host path (`MEMBER_AGENT_KEYS`
 * in bridge/src/server.js). The guard keeps only these fields either way, so `cwd` and `repo_root`
 * never reach a view, and turns Chatter's zoneless UTC times into ISO.
 */
export interface BoardAgent {
  readonly name: string;
  readonly kind: string | null;
  readonly role: string | null;
  readonly status: string | null;
  readonly branch: string | null;
  readonly task: AgentTask | null;
  readonly registered_at: string | null;
  readonly last_seen_at: string | null;
  readonly departed_at: string | null;
}

export interface BoardTask {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly assignee: string | null;
  readonly created_by: string | null;
  readonly created_at: string | null;
  readonly updated_at: string | null;
}

/** A note or an open question (a note whose type is `question`). */
export interface BoardNote {
  readonly id: number;
  readonly author: string;
  readonly type: string;
  readonly text: string;
  readonly task_id: string | null;
  readonly created_at: string | null;
}

export interface BoardHandoff {
  readonly id: number;
  readonly task_id: string | null;
  readonly from: string;
  readonly to: string | null;
  readonly summary: string;
  readonly branch: string | null;
  readonly status: string;
  readonly created_at: string | null;
}

/** GET /v1/repos/{key}/board. `agents_error` is set, and `agents` empty, when Chatter failed. */
export interface Board {
  readonly repo: string;
  readonly epoch: string;
  readonly agents: readonly BoardAgent[];
  readonly agents_error: string | null;
  readonly tasks: readonly BoardTask[];
  readonly notes: readonly BoardNote[];
  readonly questions: readonly BoardNote[];
  readonly handoffs: readonly BoardHandoff[];
}

/** A registry entry, as the admin sees it. */
export interface Member {
  readonly handle: string;
  readonly display_name: string;
  readonly kind: MemberKind;
  readonly role: MemberRole;
  readonly can_address_agents: boolean;
  readonly tailscale_login: string | null;
  readonly status: MemberStatus;
  readonly created_at: string;
  readonly last_seen_at: string | null;
}

/** GET /v1/members (admin) */
export interface MembersResponse {
  readonly members: readonly Member[];
}

/** POST /v1/members (admin). Computational members always get a token; humans only with `issue_token`. */
export interface AddMemberRequest {
  readonly handle: string;
  readonly kind: MemberKind;
  readonly display_name?: string;
  readonly role?: MemberRole;
  readonly can_address_agents?: boolean;
  readonly tailscale_login?: string | null;
  readonly issue_token?: boolean;
}

/** 201 answer to an add. The token is shown once and never again; keep it out of storage and logs. */
export interface AddMemberResult {
  readonly member: Member;
  readonly token: string | null;
}

/** PATCH /v1/members/{handle} (admin): only the fields present change. */
export interface UpdateMemberRequest {
  readonly display_name?: string;
  readonly kind?: MemberKind;
  readonly role?: MemberRole;
  readonly can_address_agents?: boolean;
  readonly tailscale_login?: string | null;
}

/** Answer to PATCH and to DELETE (revoke) on /v1/members/{handle}. */
export interface MemberResult {
  readonly member: Member;
}

/** 201 answer to POST /v1/members/{handle}/token (rotate). Shown once, like AddMemberResult. */
export interface TokenResult {
  readonly token: string;
}

/**
 * An audit entry. Actions seen: `member_add`, `member_update`, `member_revoke`, `token_rotate`,
 * `push_agent`, `dm_agent`, `everyone`. `detail` is a JSON object or null.
 */
export interface AuditEntry {
  readonly id: number;
  readonly at: string;
  readonly actor: string;
  readonly action: string;
  readonly target: string | null;
  readonly repo: string | null;
  readonly message_id: number | null;
  readonly detail: Readonly<Record<string, unknown>> | null;
}

/** GET /v1/audit (admin): newest first. */
export interface AuditResponse {
  readonly entries: readonly AuditEntry[];
}

export interface AuditQuery {
  readonly limit?: number;
  readonly beforeId?: number;
}

/** The `hello` event: sent once the replay (if any) is out; carries no SSE id. */
export interface Hello {
  readonly epoch: string;
  readonly max_id: number;
}

/** The `bye` event: the bridge closes the stream right after it. */
export interface Bye {
  readonly reason: string;
}

/** Every non-2xx answer from the bridge. */
export interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}
