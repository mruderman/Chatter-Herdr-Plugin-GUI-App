// A deterministic stand-in for the store (types.ts), seeded from the recordings in
// client/test/fixtures, for view tests. It never touches the network. It refuses writes the way
// the bridge does (bridge/src/policy.js, checkWrite: same order, same codes, the recorded
// messages), so a view test shows exactly the refusal text a member would see. Not part of the app.
import { ManualClock } from '../api/clock';
import { ERROR_CODES } from '../api/errors';
import { parseDirectory, parseMe, parseMessagesPage, parseRepos } from '../api/guards';
import { CHANNEL, type Directory, type Me, type Message } from '../api/types';
import { body, recordedError } from '../../test/fixtures/recorded';
import type {
  Announcement,
  Connection,
  Conversation,
  ConversationId,
  ErrorInfo,
  IncomingMessage,
  RepoChoice,
  SendDraft,
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

export interface FakeStoreOptions {
  readonly as?: FakeMember;
  /** Where the session starts. Signed in (the default) loads the member's recorded data at once. */
  readonly session?: Session['status'];
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
  /** The direction an observed DM pair was first seen in, which fixes its label. */
  readonly firstSeen: Map<ConversationId, { readonly from: string; readonly to: string }>;
}

interface Pending {
  readonly message: Message;
  readonly label: string;
}

const CHANNEL_CONVERSATION: Conversation = { kind: 'channel', id: CHANNEL, label: CHANNEL };

/** Same grammar as the bridge's mentionsOf (bridge/src/util.js), so mentions match a real message. */
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

function dmId(a: string, b: string): ConversationId {
  return `dm:${JSON.stringify([a, b].sort())}`;
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

function recorded(name: string): ErrorInfo {
  const { code, message } = recordedError(name);
  return { code, message };
}

/** The bridge's checkWrite, in its order. Null when the bridge would accept the draft. */
function refusal(draft: SendDraft, me: Me, directory: Directory): ErrorInfo | null {
  if (!draft.to) return recorded('post-missing-to');
  const text = draft.body.trim();
  if (!text) return recorded('post-empty');
  if (text.includes('\0')) return { code: ERROR_CODES.invalidBody, message: NUL_MESSAGE };
  if (text.length > MAX_BODY) return recorded('post-too-long');
  const admin = me.role === 'admin';
  const { handles, everyone } = mentionsOf(text);
  const agents = new Set(directory.agents);
  if (draft.to === CHANNEL) {
    if (everyone && !admin) return recorded('post-everyone-member');
    if (!admin && !me.can_address_agents && handles.some((handle) => agents.has(handle))) return recorded('post-agents-not-allowed');
    return null;
  }
  if (draft.to === me.handle) return recorded('post-self-dm');
  const toAgent = agents.has(draft.to);
  if (!toAgent && !directory.members.some((member) => member.handle === draft.to)) {
    return { code: ERROR_CODES.unknownRecipient, message: `no agent or member named "${draft.to}"` };
  }
  if (toAgent && !admin && !me.can_address_agents) return recorded('post-dm-agent-not-allowed');
  return null;
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
  let directory: Directory | null = null;
  let repos = new Map<string, RepoState>();
  let selectedRepo: string | null = null;
  let selectedConversation: ConversationId | null = null;
  let marker: number | null = null;
  let sendError: ErrorInfo | null = null;
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
    for (const message of loadedOf(repo)) {
      if (message.to === CHANNEL) continue;
      const id = dmId(message.from, message.to);
      if (message.from === member.handle || message.to === member.handle) {
        const peer = message.from === member.handle ? message.to : message.from;
        direct.set(id, { kind: 'direct', id, label: `DM with ${peer}`, peer });
      } else {
        let pair = repo.firstSeen.get(id);
        if (!pair) {
          pair = { from: message.from, to: message.to };
          repo.firstSeen.set(id, pair);
        }
        observed.set(id, { kind: 'observed', id, label: `DM ${pair.from} to ${pair.to}`, from: pair.from, to: pair.to });
      }
    }
    const byPeer = [...direct.values()].sort((a, b) => a.peer.localeCompare(b.peer));
    const pairKey = (c: { from: string; to: string }): string => [c.from, c.to].sort().join(' ');
    const byPair = [...observed.values()].sort((a, b) => pairKey(a).localeCompare(pairKey(b)));
    return [CHANNEL_CONVERSATION, ...byPeer, ...byPair];
  }

  function fixMarker(): void {
    const repo = current();
    if (!repo || selectedConversation === null) {
      marker = null;
      return;
    }
    const id = selectedConversation;
    marker = loadedOf(repo).find((message) => belongsTo(message, id) && message.id > repo.readPointer)?.id ?? null;
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
    directory = parseDirectory(body('directory'));
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
        firstSeen: new Map(),
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
      // The fake's own placeholder: the UI contract names one conversation for a burst and is
      // silent on a burst spanning several, so this lists them all until G1 rules.
      text = `${queue.length} new messages in ${[...new Set(queue.map((p) => p.label))].join(', ')}`;
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
  else if (options.session !== 'unknown') load();
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
      session = { status: 'signed-out', error: recorded(given ? 'me-bad-token' : 'me-unauthenticated') };
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
      fixMarker();
      publish();
    },

    send(draft) {
      const repo = current();
      const member = me();
      if (disposed || !repo || !member || !directory) return Promise.resolve(false);
      const refused = refusal(draft, member, directory);
      if (refused) {
        sendError = refused;
        publish();
        return Promise.resolve(false);
      }
      const text = draft.body.trim();
      const { handles, everyone } = mentionsOf(text);
      append(repo, {
        id: repo.maxId + 1,
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
      publish();
      return Promise.resolve(true);
    },

    loadOlder() {
      const repo = current();
      if (disposed || !repo || repo.loaded >= repo.messages.length) return Promise.resolve();
      repo.loaded = Math.min(repo.messages.length, repo.loaded + pageSize);
      publish();
      return Promise.resolve();
    },

    markRead() {
      const repo = current();
      const newest = snapshot.messages.at(-1);
      if (!disposed && repo && newest) repo.readPointer = Math.max(repo.readPointer, newest.id);
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
  };
}
