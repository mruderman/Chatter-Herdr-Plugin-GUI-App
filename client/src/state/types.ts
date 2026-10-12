// The store contract: what the views read and the actions they take, and nothing more. T5
// implements it over src/api; fake.ts imitates it from the recorded fixtures so views can be built
// and tested first. Frozen at gate G1. Text that docs/ui-contract.md fixes (conversation labels,
// announcements) is produced by the store, so the views and the E2E specs see one spelling.
//
// Board, member administration and audit are not here: those views read the API directly
// (src/api, `Api`) with the selected repo key from this store.
import type { Directory, Me, Message } from '../api/types';

export { CHANNEL } from '../api/types';

/** A refusal as the views show it: the bridge's own code and message, or the client's for network and protocol failures. */
export interface ErrorInfo {
  readonly code: string;
  readonly message: string;
}

export type Session =
  /** Asking /v1/me, or the bridge could not be reached to ask. */
  | { readonly status: 'unknown' }
  /**
   * /v1/me refused the member, or they signed out. A 401 is the case the sign-in view is for
   * (D14). A 403 means a tailnet login that is not registered; its error has the bridge's code
   * `not_registered`. `error` says why the last attempt failed, shown as "Sign-in failed: " plus
   * its message; it is null when there is nothing to explain (no credentials sent yet, or a
   * deliberate sign-out).
   */
  | { readonly status: 'signed-out'; readonly error: ErrorInfo | null }
  | { readonly status: 'signed-in'; readonly me: Me };

/**
 * The header's Connection status (UI contract section 2): online "Online", syncing "Syncing",
 * offline "Offline", revoked "Access revoked". Syncing while the selected repo loads or reloads or
 * its stream connects; online once both are done; offline while the stream is down and retrying;
 * revoked when the bridge revoked the member, after which nothing reconnects. Only meaningful
 * while signed in.
 */
export type Connection = 'online' | 'syncing' | 'offline' | 'revoked';

/** One option of the Repository select. */
export interface RepoChoice {
  readonly key: string;
  readonly label: string;
}

/** Opaque and stable for the session. Both directions of a DM share one id. */
export type ConversationId = string;

/**
 * A button in the Conversations navigation; `label` is its accessible name, exactly:
 *   channel   "#chat"
 *   direct    "DM with {peer}": a DM the member sends or receives; peer is a member or an agent
 *   observed  "DM {from} to {to}": the admin's view of a DM between two others. One conversation
 *             covers both directions, so `from` and `to` are the pair's two handles in
 *             alphabetical order (plain string comparison, as `[a, b].sort()` does, never a locale
 *             order) and imply no direction: the first handle did not necessarily write first.
 * A DM conversation appears when a message of it is loaded or arrives, or the member sends one.
 */
export type Conversation =
  | { readonly kind: 'channel'; readonly id: ConversationId; readonly label: string }
  | { readonly kind: 'direct'; readonly id: ConversationId; readonly label: string; readonly peer: string }
  | { readonly kind: 'observed'; readonly id: ConversationId; readonly label: string; readonly from: string; readonly to: string };

/** Text for the polite live region "Announcements". `seq` grows with each one, so a repeated text is still announced. */
export interface Announcement {
  readonly text: string;
  readonly seq: number;
}

/** A message from someone else that arrived through the stream, for desktop notifications. */
export interface IncomingMessage {
  readonly repo: string;
  readonly message: Message;
}

/** Everything a view reads. A new object whenever anything in it changes; never mutated. */
export interface StoreSnapshot {
  readonly session: Session;
  readonly connection: Connection;
  /** Active members and agent names, for the To select, @-completion and the Members view; null until loaded. */
  readonly directory: Directory | null;
  readonly repos: readonly RepoChoice[];
  readonly selectedRepo: string | null;
  /** "#chat" first, then the member's DMs by peer, then (admin only) others' DMs by their two handles. Empty when no repo is selected. */
  readonly conversations: readonly Conversation[];
  /** "#chat" when a repo is selected; null when none is. */
  readonly selectedConversation: ConversationId | null;
  /** The selected conversation's loaded messages: ascending id, each once, the member's own included once the bridge accepted them. */
  readonly messages: readonly Message[];
  /**
   * Older messages may exist: "Load older messages" shows. The bridge pages over all of the
   * member's messages in the repo, not per conversation, so a page may add nothing to this one.
   */
  readonly hasMore: boolean;
  /**
   * The id of the message the "New messages" separator goes before: the first message of the
   * conversation past the repo's read pointer when the conversation was opened (or when its
   * messages first loaded, if they were not loaded yet). Null when none was unread then. Neither
   * later messages nor markRead move it; selecting a conversation or repo recomputes it.
   */
  readonly newMarkerBeforeId: number | null;
  /** Why the last send failed, shown as "Not sent: " plus its message; null after a success, a new send, or another conversation or repo. */
  readonly sendError: ErrorInfo | null;
  /**
   * Throttled per UI contract section 3, at most once per 3 seconds; never about the member's own
   * messages. Null until the first one. One message reads "{sender}: {first 140 characters}". A
   * burst reads "{n} new messages in {conversation}" (the conversation's label) when all of it is
   * in one conversation, and "{n} new messages in {k} conversations" when it spans several, k
   * being the number of distinct conversations and n the number of messages.
   */
  readonly announcement: Announcement | null;
}

export interface SendDraft {
  /** "#chat", or the handle of a member or the name of an agent for a DM. */
  readonly to: string;
  readonly body: string;
}

export interface Store {
  getSnapshot(): StoreSnapshot;
  /** Calls `listener` with each new snapshot. Returns the unsubscribe function. */
  subscribe(listener: (snapshot: StoreSnapshot) => void): () => void;
  /**
   * Calls `listener` once per message that arrives through the stream and that the store had not
   * seen (live, or replayed after a reconnect), in any repo the store streams. Never for loaded
   * pages, never for the member's own messages.
   */
  onIncoming(listener: (incoming: IncomingMessage) => void): () => void;

  /** Holds the token in memory only and asks /v1/me with it. True once signed in; false with the session's error set. */
  signIn(token: string): Promise<boolean>;
  /** Forgets the token and everything loaded for the member; the session becomes signed-out with no error. */
  signOut(): void;
  /** Selects a repo from `repos` (another key is ignored): "#chat" opens, its newest page loads and its stream starts. */
  selectRepo(key: string): void;
  /** Opens a conversation from `conversations` (another id is ignored) and fixes its new marker. */
  selectConversation(id: ConversationId): void;
  /**
   * Sends to the selected repo. True once the bridge accepted it: the message then shows in its
   * conversation, which appears if it is a new DM. False when it was refused or the bridge could
   * not be reached, with `sendError` set; also false, with no request, when nothing is selected.
   */
  send(draft: SendDraft): Promise<boolean>;
  /** Loads the next older page of the selected repo. Does nothing when `hasMore` is false; overlapping calls share one request. */
  loadOlder(): Promise<void>;
  /** Moves the selected repo's read pointer forward to the newest message of the selected conversation. Never backward. */
  markRead(): Promise<void>;
  /**
   * Fetches the directory again, so a member added, changed or revoked elsewhere (the admin panel)
   * shows in the To select and @-completion. The promise resolves after a request that started after
   * the call: a call may share a request that is queued behind the one running, never the running one,
   * which may have been answered before the change the caller has just made. A failure keeps the old
   * directory, and the promise still resolves. Does nothing when signed out.
   */
  refreshDirectory(): Promise<void>;
  /** Stops streams and timers. The store is not used afterwards. */
  dispose(): void;
}
