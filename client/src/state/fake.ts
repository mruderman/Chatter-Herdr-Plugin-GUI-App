// A deterministic stand-in for the store (types.ts), seeded from the recordings in
// client/test/fixtures, for view tests. It never touches the network. It refuses writes the way
// the bridge does (bridge/src/policy.js, checkWrite: same order, same codes, the recorded
// messages and the bridge's own words for the prefix rules), so a view test shows exactly the refusal
// text a member would see. Its rules also serve the scripted bridge in fake-api.ts, and
// bridge-parity.test.ts checks them against a real bridge. Not part of the app.
import { ManualClock } from '../api/clock';
import { ERROR_CODES } from '../api/errors';
import { parseDirectory, parseMe, parseMessagesPage, parseRepos } from '../api/guards';
import { CHANNEL, type Directory, type Me, type Message, type SendResult } from '../api/types';
import { body, recordedError } from '../../test/fixtures/recorded';
import { NOT_LOOKED_BACK, OLDER_MAX_MESSAGES, OLDER_MAX_PAGES } from './repo-sync';
import { REVOKED_SEND } from './revoked-send';
import { announcementOf, makeNotice } from './send-notice';
import type {
  Announcement,
  Connection,
  Conversation,
  ConversationId,
  ErrorInfo,
  IncomingMessage,
  OlderResult,
  RepoChoice,
  SendDraft,
  SendNotice,
  Session,
  Store,
  StoreSnapshot,
} from './types';

/** Whose view of the recordings the fake starts from, and the recorded exchanges that hold it. */
export const FAKE_MEMBERS = {
  /** The admin, human: sees every DM, may use @everyone. */
  flan: { me: 'me-admin', repos: 'repos-admin', messages: 'messages-flan' },
  /** A computational member with DMs to two members and to an agent. */
  thom: { me: 'me-computational', repos: 'repos-member', messages: 'messages-thom' },
  /** A human member whose read pointer is at message 5. */
  mira: { me: 'me-human', repos: 'repos-after-read', messages: 'messages-mira' },
  /** A computational member who may not address agents, and has no DMs. */
  kieran: { me: 'me-restricted', repos: 'repos-member', messages: 'messages-kieran' },
} as const;
export type FakeMember = keyof typeof FAKE_MEMBERS;

/** The second recorded repo; every member sees the same single #chat post in it. */
const SECOND_REPO_MESSAGES = 'messages-site';

/** The one token the fake accepts. A throwaway that opens nothing anywhere. */
export const FAKE_TOKEN = 'fake-member-token';

// UI contract section 3, and bridge/src/policy.js DEFAULT_LIMITS.maxBody.
const ANNOUNCE_EVERY_MS = 3_000;
const ANNOUNCE_CHARS = 140;
const MAX_BODY = 8_000;
const KIND_POST = 'post';
const KIND_DM = 'chat';
const EVERYONE = 'everyone';
// policy.js says this; no recording has it, because no client can send a NUL through JSON by accident.
const NUL_MESSAGE = 'message contains a NUL byte';
// bridge/src/auth.js:55 sends this with 403 not_registered, on the tailnet-identity path only, which
// the recorder does not use, so no recording has it. The text was confirmed by running that authenticator.
const NOT_REGISTERED_MESSAGE = 'your Tailscale login is not registered as a member';

export interface FakeStoreOptions {
  readonly as?: FakeMember;
  /**
   * Where the session starts. Signed in (the default) loads the member's recorded data at once.
   * 'signed-out' is a first load that got a plain 401, so there is no error to explain;
   * 'not-registered' is one that got the bridge's 403 not_registered, which carries its error
   * (UI contract section 1). Every start except signed in has nothing loaded.
   */
  readonly session?: Session['status'] | 'not-registered';
  /** Messages per page, newest first; older pages come with loadOlder(). Default: everything at once. */
  readonly pageSize?: number;
  /** The read pointer of every repo. Default: the recorded one (0, except mira's 5). */
  readonly lastReadId?: number;
  readonly clock?: ManualClock;
}

/** A message for receive(): only who, to whom and what are required. */
export interface ArrivingMessage {
  readonly from: string;
  /** Default "#chat". */
  readonly to?: string;
  readonly body: string;
  /** Default: the selected repo. */
  readonly repo?: string;
  readonly kind?: string;
  readonly ref_id?: string | null;
}

/** The contract plus controls a view test drives. */
export interface FakeStore extends Store {
  /** Advance it to release throttled announcements. */
  readonly clock: ManualClock;
  /** Drafts the fake accepted, oldest first. */
  readonly sent: readonly SendDraft[];
  /** A message from someone else arriving through the stream: shown, announced, passed to onIncoming. */
  receive(message: ArrivingMessage): Message;
  setConnection(connection: Connection): void;
  readPointer(repo: string): number;
  /**
   * Changes the directory the bridge answers with from now on, as the admin panel does when it adds,
   * edits or revokes a member. The store keeps showing its old one until refreshDirectory() runs; a
   * member who signs in later is shown this one. The directory goes through the guard, so a test
   * cannot stage a shape the bridge never sends, and the caller's object is never frozen.
   */
  setDirectory(directory: Directory): void;
}

interface RepoState {
  readonly choice: RepoChoice;
  /** Everything this member may see, ascending id. */
  readonly messages: Message[];
  /** How many of the newest are loaded. */
  loaded: number;
  readPointer: number;
  /** The highest id the table holds, visible or not: the next message gets maxId + 1. */
  maxId: number;
}

interface Pending {
  readonly message: Message;
  readonly label: string;
}

const CHANNEL_CONVERSATION: Conversation = { kind: 'channel', id: CHANNEL, label: CHANNEL };

/**
 * The bridge's mentionsOf (bridge/src/util.js), so that the mentions of a message match a real one,
 * in the same order. Every mention is read twice and both readings are kept: first as Chatter's
 * postToChat reads it (`/@([a-z0-9_-]+)/g`, case-sensitive, so a capital letter ends the token and
 * "@codX" is "@cod"), then whole, case-insensitive and lower-cased. `everyone` is set when either
 * reading gives exactly "everyone". The scripted bridge (fake-api.ts) uses this function too: there
 * is one copy of the bridge's rules here, and bridge-parity.test.ts compares it with the real one.
 */
export function mentionsOf(text: string): { handles: string[]; everyone: boolean } {
  const handles = new Set<string>();
  let everyone = false;
  const take = (token: string): void => {
    if (token === EVERYONE) everyone = true;
    else handles.add(token);
  };
  for (const match of text.matchAll(/@([a-z0-9_-]+)/g)) take(match[1] ?? '');
  for (const match of text.matchAll(/@([a-z0-9_-]+)/gi)) take((match[1] ?? '').toLowerCase());
  return { handles: [...handles], everyone };
}

/**
 * The two handles of a DM in alphabetical order, whichever way a message went. Plain code-unit
 * comparison, as `[a, b].sort()` does: handles use a-z, 0-9, `_` and `-`, and `localeCompare` ranks
 * the last three differently ('a_b' before 'a-b') with a result that depends on the runtime's ICU.
 */
function pairOf(a: string, b: string): readonly [string, string] {
  return a <= b ? [a, b] : [b, a];
}

function dmId(a: string, b: string): ConversationId {
  return `dm:${JSON.stringify(pairOf(a, b))}`;
}

function belongsTo(message: Message, id: ConversationId): boolean {
  return id === CHANNEL ? message.to === CHANNEL : message.to !== CHANNEL && dmId(message.from, message.to) === id;
}

/** ISO 8601 UTC to the second, as the bridge writes message times. */
function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** What the bridge answers a refused write with: the HTTP status, its code and its words. */
export interface Refusal {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

function recorded(name: string): Refusal {
  const { status, code, message } = recordedError(name);
  return { status, code, message };
}

// Statuses of the refusals that no recording has: the ones the prefix rules add (bridge/src/policy.js).
const STATUS = { badRequest: 400, forbidden: 403, notFound: 404, conflict: 409 } as const;

// The bridge's words for the refusals the prefix rules add. The handle or the agent names are the only
// parts that vary, so a view test shows the text a member would read.
const ambiguity = {
  mention: (handle: string, names: readonly string[]): string => `@${handle} is the start of the name of the Herdr agent ${names.join(', ')}, and Chatter could deliver it there; you may not address Herdr agents, so nothing was posted`,
  dmToAgentName: (handle: string, names: readonly string[]): string => `"${handle}" is the start of the name of the Herdr agent ${names.join(', ')}, so Chatter could deliver this message to the agent instead; nothing was sent. An admin can rename the member or the agent.`,
  dmToOwnHandle: (handle: string): string => `"${handle}" is the start of your own handle, so Chatter would take it for you; nothing was sent. ${handle} can still message you, or an admin can rename one of you.`,
};

/**
 * The bridge's checkWrite (bridge/src/policy.js), in its order. Null when the bridge would accept the draft.
 *
 * Chatter takes a name it does not know exactly as the one agent whose name it is the start of
 * (case-insensitive), so the bridge counts such a name as that agent. Its roster is the target repo's
 * agents that have not departed; the directory, which is all the fake knows, lists every agent of every
 * repo, departed ones too. The fake therefore takes every agent in the directory to be on the roster, and
 * agrees with the bridge wherever the two lists agree. Where they differ it cannot follow: a departed
 * agent's name makes a handle look like an agent to the fake and not to the bridge, and a name that the
 * directory offers but that is not on the roster, while being the start of a name that is, is refused by
 * the bridge with 409 `"<name>" is not a live agent of this repo.` and accepted or refused as an agent by
 * the fake. The same goes for such a name that is the start of the sender's own handle: the bridge's
 * own-handle refusal covers every DM name that is not exactly on the roster, a member's handle or an
 * agent name only the directory offers, and is checked before the permission; the fake applies that
 * rule to members' handles only. The cases are listed in bridge-parity.test.ts, which keeps that list exact.
 */
export function refuseWrite(draft: SendDraft, me: Me, directory: Directory): Refusal | null {
  if (!draft.to) return recorded('post-missing-to');
  const text = draft.body.trim();
  if (!text) return recorded('post-empty');
  if (text.includes('\0')) return { status: STATUS.badRequest, code: ERROR_CODES.invalidBody, message: NUL_MESSAGE };
  if (text.length > MAX_BODY) return recorded('post-too-long');
  const admin = me.role === 'admin';
  const { handles, everyone } = mentionsOf(text);
  const agents = new Set(directory.agents);
  const agentsBegunBy = (handle: string): string[] => directory.agents.filter((name) => name.toLowerCase().startsWith(handle.toLowerCase()));
  const agentLike = (handle: string): boolean => agents.has(handle) || agentsBegunBy(handle).length > 0;
  if (draft.to === CHANNEL) {
    if (everyone && !admin) return recorded('post-everyone-member');
    const addressed = handles.filter(agentLike);
    if (addressed.length > 0 && !admin && !me.can_address_agents) {
      const byPrefix = addressed.find((handle) => !agents.has(handle));
      if (byPrefix === undefined) return recorded('post-agents-not-allowed');
      return { status: STATUS.forbidden, code: ERROR_CODES.agentsNotAllowed, message: ambiguity.mention(byPrefix, agentsBegunBy(byPrefix)) };
    }
    return null;
  }
  if (draft.to === me.handle) return recorded('post-self-dm');
  const toAgent = agents.has(draft.to);
  if (!toAgent && !directory.members.some((member) => member.handle === draft.to)) {
    return { status: STATUS.notFound, code: ERROR_CODES.unknownRecipient, message: `no agent or member named "${draft.to}"` };
  }
  // The bridge asks next whether an agent's name is on the repo's live roster; here every agent of the
  // directory is, so the question is never put (see above).
  if (toAgent && !admin && !me.can_address_agents) return recorded('post-dm-agent-not-allowed');
  if (!toAgent) {
    // A private message must never reach an agent or come back to its sender, so admins are refused too.
    const begun = agentsBegunBy(draft.to);
    if (begun.length > 0) {
      return { status: STATUS.conflict, code: ERROR_CODES.ambiguousRecipient, message: ambiguity.dmToAgentName(draft.to, begun) };
    }
    if (me.handle.toLowerCase().startsWith(draft.to.toLowerCase())) {
      return { status: STATUS.conflict, code: ERROR_CODES.ambiguousRecipient, message: ambiguity.dmToOwnHandle(draft.to) };
    }
  }
  return null;
}

/** The mentions of a post as Chatter's postToChat reads them: case-sensitive, so a capital letter ends the token. */
const CHATTER_MENTION = /@([a-z0-9_-]+)/g;

/**
 * Chatter's resolveRecipient for a mention (`soft`): an agent's exact name, or the one agent whose name the
 * token is the start of, ignoring case. Chatter also counts the human's name among the candidates, which the
 * fake does not model: for the admin it is their own handle, and a mention that only starts it resolves to
 * the sender and gets no warning (bridge-parity.test.ts, "@f", where the fake warns or pushes instead).
 */
function resolveMention(token: string, agents: readonly string[]): string | null {
  if (agents.includes(token)) return token;
  const lower = token.toLowerCase();
  const begun = agents.filter((name) => name.toLowerCase().startsWith(lower));
  return begun.length === 1 ? (begun[0] ?? null) : null;
}

/**
 * What the bridge answers a send it accepted with, besides the id (bridge/src/server.js `sendMessage`):
 * who was mentioned, the delivery of a DM to an agent, the agents a post pushed to, and Chatter's warnings.
 * The scripted bridge (fake-api.ts) answers with it and the fake store makes its send notice from it, so that
 * there is one copy; bridge-parity.test.ts compares it with a real bridge over real Chatter.
 *
 * The world it models has no live Herdr pane: an agent addressed is never delivered to, so a DM to an agent
 * is `queued` and a post's push to one is `<name> (queued)`. A warning is Chatter's, for each occurrence of
 * a mention that is no agent, read as Chatter reads it (CHATTER_MENTION), minus the ones the bridge drops
 * because the mention is an active member's handle. As in refuseWrite, the directory stands for the roster:
 * it lists departed agents too, so a mention of one is taken for a hit here and is not one there.
 */
export function answerTo(draft: SendDraft, me: Me, directory: Directory): Omit<SendResult, 'id'> {
  const members = new Set(directory.members.map((member) => member.handle));
  if (draft.to !== CHANNEL) {
    return {
      pushed: [],
      warnings: [],
      mentioned_members: members.has(draft.to) ? [draft.to] : [],
      delivery: directory.agents.includes(draft.to) ? 'queued' : null,
    };
  }
  const text = draft.body.trim();
  const warnings: string[] = [];
  const pushedTo = new Set<string>();
  for (const match of text.matchAll(CHATTER_MENTION)) {
    const token = match[1] ?? '';
    if (token === EVERYONE) continue;
    const hit = resolveMention(token, directory.agents);
    if (hit !== null) {
      if (hit !== me.handle) pushedTo.add(hit);
    } else if (!members.has(token)) {
      warnings.push(`mention @${token} matches no agent in this repo — not pushed`);
    }
  }
  return {
    pushed: [...pushedTo].map((name) => `${name} (queued)`),
    warnings,
    mentioned_members: mentionsOf(text).handles.filter((handle) => members.has(handle) && handle !== me.handle),
    delivery: null,
  };
}

export function createFakeStore(options: FakeStoreOptions = {}): FakeStore {
  const as = options.as ?? 'thom';
  const pageSize = options.pageSize ?? Number.POSITIVE_INFINITY;
  const clock = options.clock ?? new ManualClock();
  const listeners = new Set<(snapshot: StoreSnapshot) => void>();
  const incomingListeners = new Set<(incoming: IncomingMessage) => void>();
  const sent: SendDraft[] = [];

  let session: Session = { status: 'unknown' };
  let connection: Connection = 'online';
  // What /v1/directory answers right now, as against `directory`, what the store has fetched. They
  // are one object until setDirectory(), so a refresh that finds nothing new publishes nothing.
  let served = parseDirectory(body('directory'));
  let directory: Directory | null = null;
  let repos = new Map<string, RepoState>();
  let selectedRepo: string | null = null;
  let selectedConversation: ConversationId | null = null;
  let marker: number | null = null;
  let sendError: ErrorInfo | null = null;
  // The notice about the last accepted send and the conversation its message went to, as in store.ts.
  let sendNotice: { readonly notice: SendNotice; readonly conversation: ConversationId } | null = null;
  let noticeSeq = 0;
  let announcement: Announcement | null = null;
  let queue: Pending[] = [];
  let lastAnnouncedAt = Number.NEGATIVE_INFINITY;
  let cancelFlush: (() => void) | null = null;
  let disposed = false;

  const me = (): Me | null => (session.status === 'signed-in' ? session.me : null);
  const current = (): RepoState | null => (selectedRepo === null ? null : repos.get(selectedRepo) ?? null);
  const loadedOf = (repo: RepoState): Message[] => repo.messages.slice(repo.messages.length - repo.loaded);

  function conversationsOf(repo: RepoState, member: Me): Conversation[] {
    const direct = new Map<ConversationId, Extract<Conversation, { kind: 'direct' }>>();
    const observed = new Map<ConversationId, Extract<Conversation, { kind: 'observed' }>>();
    // Every message the member may see, not only the loaded ones: the real store lists the pairs the bridge
    // names (GET /conversations, bridge/src/messages.js listConversations), which are exactly the pairs of the
    // rows this member can see, and a DM older than the newest page is one of them (V5 finding 9). This file
    // keeps its own dmId and pairOf on purpose: conformance.test.ts then checks the real store's wording against them.
    for (const message of repo.messages) {
      if (message.to === CHANNEL) continue;
      const id = dmId(message.from, message.to);
      if (message.from === member.handle || message.to === member.handle) {
        const peer = message.from === member.handle ? message.to : message.from;
        direct.set(id, { kind: 'direct', id, label: `DM with ${peer}`, peer });
      } else {
        const [from, to] = pairOf(message.from, message.to);
        observed.set(id, { kind: 'observed', id, label: `DM ${from} to ${to}`, from, to });
      }
    }
    const byPeer = [...direct.values()].sort((a, b) => a.peer.localeCompare(b.peer));
    const pairKey = (c: { from: string; to: string }): string => `${c.from} ${c.to}`;
    const byPair = [...observed.values()].sort((a, b) => pairKey(a).localeCompare(pairKey(b)));
    return [CHANNEL_CONVERSATION, ...byPeer, ...byPair];
  }

  // Other people's messages only, as in store.ts (fixMarker): the member's own are past the pointer because they just wrote them.
  function fixMarker(): void {
    const repo = current();
    const member = me();
    if (!repo || !member || selectedConversation === null) {
      marker = null;
      return;
    }
    const id = selectedConversation;
    marker = loadedOf(repo).find((message) => belongsTo(message, id) && message.id > repo.readPointer && message.from !== member.handle)?.id ?? null;
  }

  function build(): StoreSnapshot {
    const member = me();
    const repo = current();
    const signedIn = member !== null;
    const conversations = member && repo ? conversationsOf(repo, member) : [];
    const id = selectedConversation;
    return deepFreeze({
      session,
      connection,
      directory: signedIn ? directory : null,
      repos: signedIn ? [...repos.values()].map((r) => r.choice) : [],
      selectedRepo: signedIn ? selectedRepo : null,
      conversations,
      selectedConversation: signedIn && repo ? id : null,
      messages: repo && id !== null ? loadedOf(repo).filter((message) => belongsTo(message, id)) : [],
      hasMore: repo ? repo.loaded < repo.messages.length : false,
      newMarkerBeforeId: marker,
      sendError,
      sendNotice: signedIn ? (sendNotice?.notice ?? null) : null,
      announcement,
    });
  }

  let snapshot = build();

  function publish(): void {
    snapshot = build();
    for (const listener of [...listeners]) listener(snapshot);
  }

  function load(): void {
    const names = FAKE_MEMBERS[as];
    const member = parseMe(body(names.me));
    directory = served;
    const pages = [parseMessagesPage(body(names.messages)), parseMessagesPage(body(SECOND_REPO_MESSAGES))];
    repos = new Map(parseRepos(body(names.repos)).repos.map((repo): [string, RepoState] => {
      const page = pages.find((p) => p.repo === repo.key);
      const messages = page ? [...page.messages] : [];
      return [repo.key, {
        choice: { key: repo.key, label: repo.label },
        messages,
        loaded: Math.min(messages.length, pageSize),
        readPointer: options.lastReadId ?? repo.last_read_id,
        maxId: Math.max(page?.max_id ?? 0, ...messages.map((m) => m.id)),
      }];
    }));
    session = { status: 'signed-in', me: member };
    connection = 'online';
    selectedRepo = repos.keys().next().value ?? null;
    selectedConversation = selectedRepo === null ? null : CHANNEL;
    fixMarker();
  }

  function clear(): void {
    directory = null;
    repos = new Map();
    selectedRepo = null;
    selectedConversation = null;
    marker = null;
    sendError = null;
    sendNotice = null;
    announcement = null;
    queue = [];
    cancelFlush?.();
    cancelFlush = null;
  }

  function flush(): void {
    cancelFlush = null;
    if (disposed || queue.length === 0) return;
    const [only] = queue;
    let text: string;
    if (queue.length === 1 && only) {
      text = `${only.message.from}: ${Array.from(only.message.body).slice(0, ANNOUNCE_CHARS).join('')}`;
    } else {
      // UI contract section 3: a burst in one conversation names it, one across several counts them.
      const labels = new Set(queue.map((pending) => pending.label));
      const where = labels.size > 1 ? `${labels.size} conversations` : (only?.label ?? CHANNEL);
      text = `${queue.length} new messages in ${where}`;
    }
    announcement = { text, seq: (announcement?.seq ?? 0) + 1 };
    lastAnnouncedAt = clock.now();
    queue = [];
  }

  function announce(message: Message, label: string): void {
    queue.push({ message, label });
    const wait = lastAnnouncedAt + ANNOUNCE_EVERY_MS - clock.now();
    if (wait <= 0) {
      cancelFlush?.();
      flush();
    } else if (!cancelFlush) {
      cancelFlush = clock.schedule(() => {
        flush();
        publish();
      }, wait);
    }
  }

  function append(repo: RepoState, message: Message): void {
    repo.messages.push(message);
    repo.maxId = message.id;
    repo.loaded += 1;
  }

  if (options.session === 'signed-out') session = { status: 'signed-out', error: null };
  else if (options.session === 'not-registered') {
    session = { status: 'signed-out', error: { code: ERROR_CODES.notRegistered, message: NOT_REGISTERED_MESSAGE } };
  } else if (options.session !== 'unknown') load();
  snapshot = build();

  return {
    clock,
    sent,
    getSnapshot: () => snapshot,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    onIncoming(listener) {
      incomingListeners.add(listener);
      return () => {
        incomingListeners.delete(listener);
      };
    },

    signIn(token) {
      if (disposed) return Promise.resolve(false);
      const given = token.trim();
      if (given === FAKE_TOKEN) {
        load();
        publish();
        return Promise.resolve(true);
      }
      clear();
      const { code, message } = recorded(given ? 'me-bad-token' : 'me-unauthenticated');
      session = { status: 'signed-out', error: { code, message } };
      publish();
      return Promise.resolve(false);
    },

    signOut() {
      if (disposed) return;
      clear();
      session = { status: 'signed-out', error: null };
      publish();
    },

    selectRepo(key) {
      if (disposed || !me() || key === selectedRepo || !repos.has(key)) return;
      selectedRepo = key;
      selectedConversation = CHANNEL;
      sendError = null;
      sendNotice = null;
      queue = [];
      cancelFlush?.();
      cancelFlush = null;
      fixMarker();
      publish();
    },

    selectConversation(id) {
      const repo = current();
      const member = me();
      if (disposed || !repo || !member || id === selectedConversation) return;
      if (!conversationsOf(repo, member).some((conversation) => conversation.id === id)) return;
      selectedConversation = id;
      sendError = null;
      if (sendNotice !== null && sendNotice.conversation !== id) sendNotice = null;
      fixMarker();
      publish();
    },

    send(draft) {
      const repo = current();
      const member = me();
      if (disposed || !repo || !member || !directory) return Promise.resolve(false);
      // A new send replaces whatever the last one left, whether this one is refused or not.
      sendNotice = null;
      if (connection === 'revoked') {
        sendError = REVOKED_SEND;
        publish();
        return Promise.resolve(false);
      }
      const refused = refuseWrite(draft, member, directory);
      if (refused) {
        sendError = { code: refused.code, message: refused.message };
        publish();
        return Promise.resolve(false);
      }
      const text = draft.body.trim();
      const { handles, everyone } = mentionsOf(text);
      const id = repo.maxId + 1;
      append(repo, {
        id,
        from: member.handle,
        to: draft.to,
        body: text,
        kind: draft.to === CHANNEL ? KIND_POST : KIND_DM,
        ref_id: null,
        created_at: isoSeconds(clock.now()),
        mentions: handles,
        everyone,
      });
      sent.push({ to: draft.to, body: draft.body });
      sendError = null;
      const notice = makeNotice(draft, { id, ...answerTo(draft, member, directory) }, noticeSeq + 1);
      if (notice) {
        noticeSeq += 1;
        sendNotice = { notice, conversation: draft.to === CHANNEL ? CHANNEL : dmId(member.handle, draft.to) };
        // Said at once and counted as the last announcement, as the real store does (announce.ts, say).
        announcement = { text: announcementOf(notice), seq: (announcement?.seq ?? 0) + 1 };
        lastAnnouncedAt = clock.now();
      }
      publish();
      return Promise.resolve(true);
    },

    dismissSendNotice() {
      if (disposed || sendNotice === null) return;
      sendNotice = null;
      publish();
    },

    followRotation: (_handle, rotate) => rotate(),

    // As the real store's press (repo-sync.ts loadOlder, whose bounds this takes): in a DM, page after page until a
    // message of it is added, the history ends, or the bound is reached; #chat is the one page. A message found on the
    // page that reaches the bound counts as found. The recordings are too small to reach the message bound, so only the
    // page bound is run on both stores (conformance.test.ts); the message bound is run on the real one (load-older.test.ts).
    loadOlder() {
      const repo = current();
      if (disposed || !repo || repo.loaded >= repo.messages.length) return Promise.resolve(NOT_LOOKED_BACK);
      const wanted = selectedConversation;
      const seeking = wanted !== null && wanted !== CHANNEL ? wanted : null;
      let pages = 0;
      let loaded = 0;
      let result: OlderResult = NOT_LOOKED_BACK;
      for (;;) {
        const before = repo.loaded;
        repo.loaded = Math.min(repo.messages.length, repo.loaded + pageSize);
        pages += 1;
        loaded += repo.loaded - before;
        const added = repo.messages.slice(repo.messages.length - repo.loaded, repo.messages.length - before);
        if (seeking === null || repo.loaded >= repo.messages.length || added.some((message) => belongsTo(message, seeking))) break;
        if (pages >= OLDER_MAX_PAGES || loaded >= OLDER_MAX_MESSAGES) {
          result = Object.freeze({ lookedBack: loaded });
          break;
        }
      }
      publish();
      return Promise.resolve(result);
    },

    markRead() {
      const repo = current();
      const newest = snapshot.messages.at(-1);
      if (!disposed && repo && newest) repo.readPointer = Math.max(repo.readPointer, newest.id);
      return Promise.resolve();
    },

    refreshDirectory() {
      // The fake's fetch cannot fail, so the contract's "a failure keeps the old directory" is the real store's to keep.
      if (!disposed && me() && directory !== served) {
        directory = served;
        publish();
      }
      return Promise.resolve();
    },

    dispose() {
      disposed = true;
      cancelFlush?.();
      cancelFlush = null;
      listeners.clear();
      incomingListeners.clear();
    },

    receive(arriving) {
      const member = me();
      const repo = arriving.repo === undefined ? current() : repos.get(arriving.repo) ?? null;
      if (disposed || !member || !repo) throw new Error('fake store: receive() needs a signed-in member and a known repo');
      const to = arriving.to ?? CHANNEL;
      const visible = to === CHANNEL || member.role === 'admin' || arriving.from === member.handle || to === member.handle;
      if (!visible) throw new Error('fake store: the bridge would not deliver that message to this member');
      const { handles, everyone } = mentionsOf(arriving.body);
      const message: Message = {
        id: repo.maxId + 1,
        from: arriving.from,
        to,
        body: arriving.body,
        kind: arriving.kind ?? (to === CHANNEL ? KIND_POST : KIND_DM),
        ref_id: arriving.ref_id ?? null,
        created_at: isoSeconds(clock.now()),
        mentions: handles,
        everyone,
      };
      append(repo, message);
      const own = message.from === member.handle;
      if (!own && repo === current()) {
        const conversation = conversationsOf(repo, member).find((c) => belongsTo(message, c.id));
        announce(message, conversation?.label ?? CHANNEL);
      }
      publish();
      if (!own) for (const listener of [...incomingListeners]) listener({ repo: repo.choice.key, message });
      return message;
    },

    setConnection(next) {
      if (disposed || next === connection) return;
      connection = next;
      publish();
    },

    readPointer(key) {
      const repo = repos.get(key);
      if (!repo) throw new Error(`fake store: no repo "${key}"`);
      return repo.readPointer;
    },

    setDirectory(next) {
      // A copy through the guard: build() freezes what it publishes, and that must not reach the caller's object.
      served = parseDirectory(next);
    },
  };
}
