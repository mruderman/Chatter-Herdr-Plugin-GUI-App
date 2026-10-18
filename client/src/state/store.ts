// The real store: the contract in types.ts, kept over the bridge API (src/api). It asks /v1/me on
// start, follows up to 8 repos at once (repo-sync.ts) and shows the selected one, and it words and
// orders everything the contract fixes as the fake store does (conversations.ts, announce.ts),
// because the views are tested against the fake. The member's token lives in this closure and
// nowhere else: not in a snapshot, storage, a URL, a log or an error. When the admin rotates their own
// token the closure takes the new one over (followRotation) and the session goes on.
import { createApi, type Api } from '../api/client';
import { systemClock, type Clock } from '../api/clock';
import { ApiError } from '../api/errors';
import type { StreamTiming } from '../api/stream';
import { CHANNEL, type Directory, type Me, type Message, type Repo, type SendResult } from '../api/types';
import { Announcer } from './announce';
import { belongsTo, CHANNEL_CONVERSATION, conversationOf, dmId, ordered } from './conversations';
import { classify, keepTrying, retryDelay, UNAUTHORIZED } from './failure';
import { RepoSync, type SyncHost } from './repo-sync';
import { REVOKED_SEND } from './revoked-send';
import { announcementOf, makeNotice } from './send-notice';
import type {
  Connection,
  ConversationId,
  ErrorInfo,
  IncomingMessage,
  SendDraft,
  SendNotice,
  Session,
  Store,
  StoreSnapshot,
} from './types';

export interface StoreOptions {
  /**
   * Builds the API client around the store's token holder: `getToken` reads the token from the
   * store's closure on every request. Default: createApi on the page's own origin.
   */
  readonly api?: (getToken: () => string | null) => Api;
  /** Every timer of the store and of its streams goes through it. Default: the system clock. */
  readonly clock?: Clock;
  /** In [0, 1), like Math.random: the streams' reconnect jitter. */
  readonly random?: () => number;
  /** The streams' reconnect and silence timing (src/api/stream.ts); the defaults suit the bridge. */
  readonly streamTiming?: Partial<StreamTiming>;
  /** Messages per page, for the newest page and for older ones. Default 100. */
  readonly pageSize?: number;
  /** Where an error thrown by a listener, or a bug, goes. Default: the browser's reportError. */
  readonly reportError?: (error: unknown) => void;
}

const PAGE_SIZE = 100;
/** Repos followed whether selected or not; one outside them is followed while it is selected. */
const BACKGROUND_REPOS = 8;
/** How long a sent message may take to come back through the stream before the store fetches it. */
const SEND_WAIT_MS = 1_000;
const DIRECTORY_EVERY_MS = 5 * 60_000;
const UNKNOWN_HANDLE_EVERY_MS = 60_000;
/**
 * How often a read acknowledgement that failed in transit is said again, after retryDelay: 1, 2, 4, 8,
 * 16, 30, 30 and 30 seconds, two minutes in all. That outlasts a dropped connection or a restarting
 * bridge, which is what a transient failure is, and a bridge that stays away longer is the connection
 * badge's business: the next trigger the feed has (a new message, another visit) acknowledges again.
 */
const READ_RETRIES = 8;

/** A read acknowledgement that failed in transit and waits to be said again. */
interface ReadRetry {
  readonly sync: RepoSync;
  /** The id of the failed call, never the newest message by now: the retry must not read what arrived since. */
  readonly id: number;
  retries: number;
  cancel: () => void;
}

/** Reports without interrupting the caller; rethrown on its own microtask where reportError is missing, as stream.ts does. */
function reportLater(error: unknown): void {
  if (typeof globalThis.reportError === 'function') {
    globalThis.reportError(error);
    return;
  }
  queueMicrotask(() => {
    throw error;
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function sameList<T>(a: readonly T[], b: readonly T[], same: (x: T, y: T) => boolean): boolean {
  return a.length === b.length && a.every((x, i) => {
    const y = b[i];
    return y !== undefined && same(x, y);
  });
}

/** Snapshots are rebuilt often; an equal one is not published, so a view only renders on a real change. */
function sameSnapshot(a: StoreSnapshot, b: StoreSnapshot): boolean {
  return a.session === b.session
    && a.connection === b.connection
    && a.directory === b.directory
    && sameList(a.repos, b.repos, (x, y) => x.key === y.key && x.label === y.label)
    && a.selectedRepo === b.selectedRepo
    && sameList(a.conversations, b.conversations, (x, y) => x.id === y.id && x.label === y.label)
    && a.selectedConversation === b.selectedConversation
    && sameList(a.messages, b.messages, (x, y) => x === y)
    && a.hasMore === b.hasMore
    && a.newMarkerBeforeId === b.newMarkerBeforeId
    && a.sendError === b.sendError
    && a.sendNotice === b.sendNotice
    && a.announcement === b.announcement;
}

function sameDirectory(a: Directory | null, b: Directory): boolean {
  return a !== null && JSON.stringify(a) === JSON.stringify(b);
}

/** Everything that exists only while one member is signed in, thrown away whole on sign-out. */
class Live {
  readonly abort = new AbortController();
  readonly repos = new Map<string, RepoSync>();
  directory: Directory | null = null;
  /** The bridge's repo list, null until it first arrives. */
  repoList: readonly Repo[] | null = null;
  background = new Set<string>();
  selectedRepo: string | null = null;
  selectedConversation: ConversationId | null = null;
  marker: number | null = null;
  sendError: ErrorInfo | null = null;
  /** What the bridge said about the last accepted send, with the conversation its message went to: opening another takes it away. */
  sendNotice: { readonly notice: SendNotice; readonly conversation: ConversationId } | null = null;
  /** The bridge revoked the member: everything stays readable and nothing is asked any more. */
  revoked = false;
  /** Bumped on every change of repo or conversation, so a late send failure is not shown in another one. */
  selection = 0;
  /** The directory request in flight, and the one waiting behind it (see refreshDirectory). A request's failure is caught inside, so neither rejects. */
  runningRefresh: Promise<void> | null = null;
  queuedRefresh: Promise<void> | null = null;
  readonly unknownAt = new Map<string, number>();
  /** One per repo, because the read pointer is: a failure in another repo must not take its place. */
  readonly readRetries = new Map<string, ReadRetry>();
  private readonly replacements = new Map<string, number>();
  private readonly timers = new Set<() => void>();

  constructor(readonly me: Me, private readonly clock: Clock) {}

  /** How often the repo's database was replaced, so a request can tell that it was while the request was out. */
  replacedCount(key: string): number {
    return this.replacements.get(key) ?? 0;
  }

  noteReplaced(key: string): void {
    this.replacements.set(key, this.replacedCount(key) + 1);
  }

  schedule(callback: () => void, ms: number): () => void {
    const cancel = this.clock.schedule(() => {
      this.timers.delete(cancel);
      callback();
    }, ms);
    this.timers.add(cancel);
    return () => {
      this.timers.delete(cancel);
      cancel();
    };
  }

  /** Stops every request, timer and stream; what is loaded stays readable. */
  halt(): void {
    this.abort.abort();
    for (const cancel of this.timers) cancel();
    this.timers.clear();
    // The timers are gone; an acknowledgement still in flight finds its entry missing and schedules nothing.
    this.readRetries.clear();
    for (const repo of this.repos.values()) repo.stop();
  }
}

export function createStore(options: StoreOptions = {}): Store {
  const clock = options.clock ?? systemClock;
  const random = options.random ?? Math.random;
  const pageSize = options.pageSize ?? PAGE_SIZE;
  const report = options.reportError ?? reportLater;
  // The member's token. Only getToken below reads it, on every request.
  let token: string | null = null;
  // Bumped whenever the token changes hands (sign-in, sign-out, a rotation followed), like `attempt` below for
  // the session: a request remembers the one it was sent under, so that a refusal can be told to be about a
  // credential that has been replaced since (steady, below).
  let credential = 0;
  // The rotations of the member's own token that are on their way: the bridge has already ended the old token
  // when it answers, and the answer is what carries the new one (followRotation).
  const rotating = new Set<Promise<void>>();
  const raw = (options.api ?? ((getToken) => createApi({ getToken })))(() => token);
  const api = steady(raw);

  const listeners = new Set<(snapshot: StoreSnapshot) => void>();
  const incomingListeners = new Set<(incoming: IncomingMessage) => void>();
  let session: Session = Object.freeze({ status: 'unknown' });
  let live: Live | null = null;
  // Bumped whenever the session changes hands, so an answer to an older /v1/me is dropped.
  let attempt = 0;
  // The sequence number of the last send notice, so that a notice of the same text is still a new one.
  let noticeSeq = 0;
  let asking: AbortController | null = null;
  let askAgain: (() => void) | null = null;
  let disposed = false;
  const announcer = new Announcer(clock, () => publish());
  let snapshot: StoreSnapshot = deepFreeze(build());

  function safely(call: () => void): void {
    try {
      call();
    } catch (error) {
      report(error);
    }
  }

  // ------------------------------------------------------------------------------------- snapshot

  function selectedSync(current: Live): RepoSync | null {
    return current.selectedRepo === null ? null : current.repos.get(current.selectedRepo) ?? null;
  }

  function connectionOf(current: Live, repo: RepoSync | null): Connection {
    if (current.revoked) return 'revoked';
    if (current.repoList === null) return 'syncing';
    if (repo === null) return 'online';
    switch (repo.phase) {
      case 'open':
        return 'online';
      case 'down':
        return 'offline';
      case 'loading':
      case 'connecting':
        return 'syncing';
    }
  }

  function build(): StoreSnapshot {
    const current = live;
    if (!current) {
      return {
        session,
        // Only meaningful while signed in; the fake says online here too.
        connection: 'online',
        directory: null,
        repos: [],
        selectedRepo: null,
        conversations: [],
        selectedConversation: null,
        messages: [],
        hasMore: false,
        newMarkerBeforeId: null,
        sendError: null,
        sendNotice: null,
        announcement: announcer.current,
      };
    }
    const repo = selectedSync(current);
    const id = current.selectedRepo === null ? null : current.selectedConversation;
    return {
      session,
      connection: connectionOf(current, repo),
      directory: current.directory,
      repos: (current.repoList ?? []).map(({ key, label }) => ({ key, label })),
      selectedRepo: current.selectedRepo,
      conversations: current.selectedRepo === null ? [] : repo ? ordered(repo.known.values()) : [CHANNEL_CONVERSATION],
      selectedConversation: id,
      messages: repo && id !== null ? repo.messages.filter((message) => belongsTo(message, id)) : [],
      hasMore: repo?.hasMore ?? false,
      newMarkerBeforeId: current.marker,
      sendError: current.sendError,
      sendNotice: current.sendNotice?.notice ?? null,
      announcement: announcer.current,
    };
  }

  function publish(): void {
    if (disposed) return;
    const next = build();
    if (sameSnapshot(next, snapshot)) return;
    snapshot = deepFreeze(next);
    for (const listener of [...listeners]) safely(() => listener(snapshot));
  }

  // -------------------------------------------------------------------------------------- session

  function setToken(next: string | null): void {
    token = next;
    credential += 1;
  }

  /**
   * Asks again, once the credential is the new one, a request that the bridge refused with 401 for a credential
   * that was replaced after the request was sent: the refusal is about the old token and says nothing about the
   * one held now. Where it matters is the repo list, a newest page and a stream, whose refusal ends the session.
   * While the member's own token is being rotated, a 401 for the current token waits for the rotation's answer
   * first, since the bridge ends the old token before it answers and a reconnect can be refused in between.
   * A 401 for the credential held when it arrives, with no rotation to wait for, passes on as it always did.
   */
  async function again<T>(call: () => Promise<T>): Promise<T> {
    for (;;) {
      // The credential the call is sent under: createApi reads the token synchronously when it is called.
      const made = credential;
      try {
        return await call();
      } catch (failure) {
        if (!(failure instanceof ApiError) || failure.status !== UNAUTHORIZED || token === null) throw failure;
        if (made === credential && rotating.size > 0) await Promise.all([...rotating]);
        if (made === credential || token === null) throw failure;
      }
    }
  }

  /** The Api the session's own requests go through. Sign-in (`me`) and `send` are left alone: each answers for itself. */
  function steady(inner: Api): Api {
    return {
      ...inner,
      directory: (o) => again(() => inner.directory(o)),
      repos: (o) => again(() => inner.repos(o)),
      messages: (repo, query, o) => again(() => inner.messages(repo, query, o)),
      conversations: (repo, o) => again(() => inner.conversations(repo, o)),
      markRead: (repo, upToId, o) => again(() => inner.markRead(repo, upToId, o)),
      openStream: (repo, request) => again(() => inner.openStream(repo, request)),
    };
  }

  function setSignedOut(error: ErrorInfo | null): void {
    // The same object when nothing changed, so no snapshot is published for it.
    if (session.status === 'signed-out' && session.error === null && error === null) return;
    session = Object.freeze({ status: 'signed-out', error: error === null ? null : Object.freeze({ code: error.code, message: error.message }) });
  }

  /** Drops any /v1/me in flight or waiting to be asked again. */
  function stopAsking(): void {
    attempt += 1;
    asking?.abort();
    asking = null;
    askAgain?.();
    askAgain = null;
  }

  function endLive(): void {
    const current = live;
    if (!current) return;
    live = null;
    current.halt();
  }

  function endSession(error: ErrorInfo | null): void {
    endLive();
    setToken(null);
    announcer.reset();
    setSignedOut(error);
    publish();
  }

  /** The question asked on start, without a token: the tailnet identity may answer it. */
  function ask(failures: number): void {
    const id = attempt;
    const controller = new AbortController();
    asking = controller;
    void (async () => {
      try {
        const me = await api.me({ signal: controller.signal });
        if (id !== attempt || disposed) return;
        asking = null;
        begin(me);
      } catch (failure) {
        if (id !== attempt || disposed) return;
        asking = null;
        const read = classify(failure, controller.signal);
        switch (read.kind) {
          case 'aborted':
            return;
          case 'bug':
            report(read.error);
            return;
          case 'transient':
            // The bridge could not be reached: the session stays unknown and is asked again.
            askAgain = clock.schedule(() => {
              askAgain = null;
              if (id === attempt && !disposed) ask(failures + 1);
            }, retryDelay(failures));
            return;
          case 'auth':
            // A first-load 401 has nothing to explain, nothing was tried (D14); a 403 not_registered does (UI contract section 1).
            setSignedOut(read.status === UNAUTHORIZED ? null : read.error);
            publish();
            return;
          case 'refused':
            setSignedOut(read.error);
            publish();
            return;
        }
      }
    })();
  }

  function hostFor(current: Live): SyncHost {
    const mine = (): boolean => live === current && !disposed;
    return {
      api,
      clock,
      random,
      streamTiming: options.streamTiming,
      pageSize,
      report,
      signal: current.abort.signal,
      schedule: (callback, ms) => current.schedule(callback, ms),
      changed: () => {
        if (mine()) publish();
      },
      loaded: (repo) => {
        if (!mine() || repo.key !== current.selectedRepo) return;
        // After an epoch change a selected DM may have gone with the old database.
        const id = current.selectedConversation;
        if (id !== null && id !== CHANNEL && !repo.known.has(id)) {
          current.selectedConversation = CHANNEL;
          current.selection += 1;
          keepNoticeFor(current, CHANNEL);
        }
        fixMarker(current);
      },
      arrived: (repo, message) => {
        if (mine()) arrived(current, repo, message);
      },
      unauthorized: (error) => {
        if (mine()) endSession(error);
      },
      revoked: () => {
        if (mine()) revoke(current);
      },
      refetchRepos: (repo) => refetchRepos(current, repo),
    };
  }

  function begin(me: Me): void {
    const current = new Live(deepFreeze({ ...me }), clock);
    live = current;
    session = Object.freeze({ status: 'signed-in', me: current.me });
    const following = (): boolean => live === current && !current.revoked && !disposed;
    keepTrying<Directory>({
      request: (signal) => api.directory({ signal }),
      signal: current.abort.signal,
      current: following,
      schedule: (callback, ms) => current.schedule(callback, ms),
      report,
      // The repo list and the streams decide about dead credentials.
      onAuth: () => undefined,
      onValue: (directory) => {
        current.directory = deepFreeze(directory);
        publish();
      },
    });
    keepTrying<readonly Repo[]>({
      request: async (signal) => (await api.repos({ signal })).repos,
      signal: current.abort.signal,
      current: following,
      schedule: (callback, ms) => current.schedule(callback, ms),
      report,
      // No stream runs yet to notice a dead credential, so the list ends the session itself.
      onAuth: (error) => endSession(error),
      onValue: (repos) => {
        follow(current, repos);
        publish();
      },
    });
    refreshEvery(current);
    publish();
  }

  function refreshEvery(current: Live): void {
    current.schedule(() => {
      void refreshDirectory();
      refreshEvery(current);
    }, DIRECTORY_EVERY_MS);
  }

  // ---------------------------------------------------------------------------------------- repos

  function follow(current: Live, repos: readonly Repo[]): void {
    current.repoList = repos;
    current.background = new Set(repos.filter((repo) => !repo.orphan).slice(0, BACKGROUND_REPOS).map((repo) => repo.key));
    for (const repo of repos) if (current.background.has(repo.key)) ensureSync(current, repo);
    const first = repos[0];
    if (first) select(current, first);
  }

  function ensureSync(current: Live, repo: Repo): void {
    if (current.repos.has(repo.key) || current.revoked) return;
    const sync = new RepoSync(hostFor(current), current.me, repo.key, repo.last_read_id);
    current.repos.set(repo.key, sync);
    sync.start();
  }

  function select(current: Live, repo: Repo): void {
    const previous = current.selectedRepo;
    current.selectedRepo = repo.key;
    current.selectedConversation = CHANNEL;
    current.sendError = null;
    current.sendNotice = null;
    current.selection += 1;
    announcer.drop();
    ensureSync(current, repo);
    // A DM older than the newest page has no message to make a button of: the bridge's list of pairs does (V5
    // finding 9). Asked each time a repo is selected, and again by the repo itself after an epoch change. A
    // stopped repo (revoked, signed out) asks nothing.
    void current.repos.get(repo.key)?.loadConversations();
    // A repo outside the background set is followed only while it is selected.
    if (previous !== null && previous !== repo.key && !current.background.has(previous)) {
      current.repos.get(previous)?.stop();
      current.repos.delete(previous);
    }
    fixMarker(current);
  }

  /** The notice about a send belongs to the conversation its message went to: showing another one takes it away. */
  function keepNoticeFor(current: Live, id: ConversationId | null): void {
    if (current.sendNotice !== null && current.sendNotice.conversation !== id) current.sendNotice = null;
  }

  /** The first message of the selected conversation past the read pointer, fixed until the next selection. */
  function fixMarker(current: Live): void {
    const repo = selectedSync(current);
    const id = current.selectedConversation;
    current.marker = repo && repo.loaded && id !== null
      ? repo.messages.find((message) => belongsTo(message, id) && message.id > repo.readPointer)?.id ?? null
      : null;
  }

  async function refetchRepos(current: Live, sync: RepoSync): Promise<void> {
    // Called when the repo's database was replaced: an id from the old one, said again, would be clamped
    // to the new database's highest and mark all of it read. Before the await, so no timer can fire first.
    current.noteReplaced(sync.key);
    const unsaid = current.readRetries.get(sync.key);
    if (unsaid) dropRetry(current, unsaid);
    try {
      const { repos } = await api.repos({ signal: current.abort.signal });
      if (live !== current || current.revoked) return;
      current.repoList = repos;
      const entry = repos.find((repo) => repo.key === sync.key);
      if (entry) sync.readPointer = Math.max(sync.readPointer, entry.last_read_id);
      publish();
    } catch (failure) {
      // The reload goes ahead without it: the new page carries the epoch.
      const read = classify(failure, current.abort.signal);
      if (read.kind === 'bug') report(read.error);
    }
  }

  function arrived(current: Live, repo: RepoSync, message: Message): void {
    const own = message.from === current.me.handle;
    if (!own && repo.key === current.selectedRepo) announcer.add(message, conversationOf(message, current.me).label);
    publish();
    if (own) return;
    const incoming: IncomingMessage = Object.freeze({ repo: repo.key, message });
    for (const listener of [...incomingListeners]) safely(() => listener(incoming));
    if (live === current) noticeHandle(current, message.from);
  }

  /** A sender the directory does not know is probably a member added since: look again, once a minute per handle. */
  function noticeHandle(current: Live, handle: string): void {
    const directory = current.directory;
    if (!directory || directory.agents.includes(handle) || directory.members.some((member) => member.handle === handle)) return;
    const now = clock.now();
    const last = current.unknownAt.get(handle);
    if (last !== undefined && now - last < UNKNOWN_HANDLE_EVERY_MS) return;
    current.unknownAt.set(handle, now);
    void refreshDirectory();
  }

  function revoke(current: Live): void {
    if (current.revoked) return;
    current.revoked = true;
    current.halt();
    announcer.drop();
    publish();
  }

  // A call resolves after a request that started after the call. The admin panel calls this once its
  // change is made, and a request that was already out may have been answered before the change, so a
  // caller shares a request that is queued and has not started, never one that is running. At most one
  // request waits, behind the one running. With nothing running it still starts a microtask later, so
  // the calls of one synchronous turn share it, and a failure of the request ahead does not stop it.
  function refreshDirectory(): Promise<void> {
    const current = live;
    if (disposed || !current || current.revoked) return Promise.resolve();
    if (current.queuedRefresh) return current.queuedRefresh;
    const queued: Promise<void> = (current.runningRefresh ?? Promise.resolve()).then(async () => {
      // One synchronous step from the queue to the request: a caller that arrives after it must find the
      // request running and not queued, and one that arrives before it must find it queued.
      current.queuedRefresh = null;
      if (live !== current || disposed || current.revoked) return;
      current.runningRefresh = queued;
      try {
        const directory = await api.directory({ signal: current.abort.signal });
        if (live !== current || disposed || current.revoked) return;
        if (!sameDirectory(current.directory, directory)) {
          current.directory = deepFreeze(directory);
          publish();
        }
      } catch (failure) {
        // A failure keeps the old directory (the contract); dead credentials are the streams' to report.
        const read = classify(failure, current.abort.signal);
        if (read.kind === 'bug') report(read.error);
      } finally {
        if (current.runningRefresh === queued) current.runningRefresh = null;
      }
    });
    current.queuedRefresh = queued;
    return queued;
  }

  // -------------------------------------------------------------------------------------- actions

  async function signIn(given: string): Promise<boolean> {
    if (disposed) return false;
    stopAsking();
    const id = attempt;
    endLive();
    announcer.reset();
    const trimmed = given.trim();
    setToken(trimmed === '' ? null : trimmed);
    // Signed out, with the last error cleared, while the bridge is asked: the sign-in form stays up.
    setSignedOut(null);
    publish();
    const controller = new AbortController();
    asking = controller;
    try {
      const me = await api.me({ signal: controller.signal });
      if (id !== attempt || disposed) return false;
      asking = null;
      begin(me);
      return true;
    } catch (failure) {
      if (id !== attempt || disposed) return false;
      asking = null;
      setToken(null);
      const read = classify(failure, controller.signal);
      if (read.kind === 'aborted') return false;
      if (read.kind === 'bug') report(read.error);
      setSignedOut(read.kind === 'bug' ? null : read.error);
      publish();
      return false;
    }
  }

  async function send(draft: SendDraft): Promise<boolean> {
    const current = live;
    if (disposed || !current) return false;
    if (current.revoked) {
      // Nothing is asked of the bridge and nothing is lost: the member is told, in the words of the Connection
      // status, and the draft stays with the view. What is loaded stays readable (V5 finding 3).
      current.sendNotice = null;
      current.sendError = REVOKED_SEND;
      publish();
      return false;
    }
    const repo = selectedSync(current);
    if (!repo) return false;
    const selection = current.selection;
    // A new send replaces whatever the last one left: its refusal, and the notice about it.
    if (current.sendError !== null || current.sendNotice !== null) {
      current.sendError = null;
      current.sendNotice = null;
      publish();
    }
    const baseline = repo.messages.at(-1)?.id ?? 0;
    let result: SendResult;
    try {
      result = await api.send(repo.key, { to: draft.to, body: draft.body }, { signal: current.abort.signal });
    } catch (failure) {
      if (live !== current || disposed) return false;
      const read = classify(failure, current.abort.signal);
      if (read.kind === 'aborted') return false;
      if (read.kind === 'bug') {
        report(read.error);
        return false;
      }
      // Shown only where it was sent from; the draft stays the view's to keep.
      if (current.selection === selection) {
        current.sendError = read.error;
        publish();
      }
      return false;
    }
    if (live !== current || disposed || current.revoked) return true;
    // What the bridge reported about the send goes up at once, not after the message has come back through
    // the stream, and only where it was sent from, as a refusal does: a notice in another conversation
    // would be about a message that is not there.
    if (current.selection === selection) {
      const notice = makeNotice(draft, result, noticeSeq + 1);
      if (notice) {
        noticeSeq += 1;
        current.sendNotice = { notice, conversation: draft.to === CHANNEL ? CHANNEL : dmId(current.me.handle, draft.to) };
        announcer.say(announcementOf(notice));
        publish();
      }
    }
    // The answer's id may be null (the bridge could not find its own row), so it is a hint, not a promise.
    const id = result.id;
    const me = current.me.handle;
    const text = draft.body.trim();
    const match = id !== null
      ? (message: Message) => message.id === id
      : (message: Message) => message.id > baseline && message.from === me && message.to === draft.to && message.body === text;
    const arrivedInTime = await repo.waitFor(match, SEND_WAIT_MS);
    if (!arrivedInTime && live === current && !disposed && !current.revoked) await repo.catchUp(me);
    return true;
  }

  async function markRead(): Promise<void> {
    const current = live;
    const repo = current ? selectedSync(current) : null;
    const id = current?.selectedConversation ?? null;
    if (disposed || !current || current.revoked || !repo || id === null) return;
    const newest = repo.messages.findLast((message) => belongsTo(message, id));
    // The pointer only moves forward, so there is nothing to say when it is already past.
    if (!newest || newest.id <= repo.readPointer) return;
    const replaced = current.replacedCount(repo.key);
    const failedInTransit = await acknowledge(current, repo, newest.id);
    // Not when the database was replaced while the request was out: its id means nothing in the new one.
    if (failedInTransit && current.replacedCount(repo.key) === replaced) retryRead(current, repo, newest.id);
  }

  /** Says once that `id` was read. True when it failed in transit, which another try may get past. */
  async function acknowledge(current: Live, repo: RepoSync, id: number): Promise<boolean> {
    try {
      const result = await api.markRead(repo.key, id, { signal: current.abort.signal });
      if (live === current) repo.readPointer = Math.max(repo.readPointer, result.last_read_id);
      return false;
    } catch (failure) {
      const read = classify(failure, current.abort.signal);
      if (read.kind === 'bug') report(read.error);
      // A refusal comes back the same, and dead credentials are the streams' to report.
      return read.kind === 'transient';
    }
  }

  // The feed marks an id as acknowledged before the answer is in and asks again only for a newer one, so
  // a failure nobody retries leaves the bridge's pointer behind (and a reload shows read messages as new).
  function retryRead(current: Live, sync: RepoSync, id: number): void {
    if (live !== current || disposed || current.revoked) return;
    const pending = current.readRetries.get(sync.key);
    // Both were read, and the larger id says so for the smaller one too: the pointer is one per repo.
    if (pending && pending.id >= id) return;
    pending?.cancel();
    const entry: ReadRetry = { sync, id, retries: 0, cancel: () => undefined };
    current.readRetries.set(sync.key, entry);
    waitToResend(current, entry);
  }

  function waitToResend(current: Live, entry: ReadRetry): void {
    entry.cancel = current.schedule(() => {
      void resend(current, entry);
    }, retryDelay(entry.retries));
  }

  async function resend(current: Live, entry: ReadRetry): Promise<void> {
    const { sync, id } = entry;
    // The repo may have been left (a ninth one is followed only while selected) or the pointer moved on.
    if (live !== current || disposed || current.revoked || current.repos.get(sync.key) !== sync || sync.readPointer >= id) {
      dropRetry(current, entry);
      return;
    }
    entry.retries += 1;
    const again = await acknowledge(current, sync, id);
    // A newer failure took its place meanwhile, or the session ended and cleared it.
    if (current.readRetries.get(sync.key) !== entry) return;
    if (again && entry.retries < READ_RETRIES) waitToResend(current, entry);
    else dropRetry(current, entry);
  }

  function dropRetry(current: Live, entry: ReadRetry): void {
    if (current.readRetries.get(entry.sync.key) !== entry) return;
    entry.cancel();
    current.readRetries.delete(entry.sync.key);
  }

  /**
   * The new token takes the place of the old one in this closure, and the streams, which the bridge ended with
   * the old token, reopen on it from their cursors. Nothing else is touched: it is the same session, so no
   * page is reloaded and nothing the member sees moves. Called in the continuation of the call that carried the
   * answer, before anything else can run with the old token; what was already sent with it is `again`'s.
   */
  function takeOver(current: Live, fresh: string): void {
    setToken(fresh);
    for (const repo of current.repos.values()) repo.restartStream();
  }

  async function followRotation<T extends { readonly token: string }>(handle: string, rotate: () => Promise<T>): Promise<T> {
    const current = live;
    // Only the member's own token ends this session when it is rotated, and only when the session holds one: a
    // session through the tailnet identity has no token, and its streams just reconnect after the bye.
    if (disposed || !current || current.revoked || token === null || handle !== current.me.handle) return rotate();
    let done: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      done = resolve;
    });
    rotating.add(waiting);
    try {
      const answered = await rotate();
      if (live === current && !disposed && !current.revoked && token !== null) takeOver(current, answered.token);
      return answered;
    } finally {
      rotating.delete(waiting);
      done();
    }
  }

  ask(0);

  return {
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

    signIn,

    signOut() {
      if (disposed) return;
      stopAsking();
      endSession(null);
    },

    selectRepo(key) {
      const current = live;
      if (disposed || !current || key === current.selectedRepo) return;
      const repo = current.repoList?.find((entry) => entry.key === key);
      if (!repo) return;
      select(current, repo);
      publish();
    },

    selectConversation(id) {
      const current = live;
      if (disposed || !current || current.selectedRepo === null || id === current.selectedConversation) return;
      if (id !== CHANNEL && !(selectedSync(current)?.known.has(id) ?? false)) return;
      current.selectedConversation = id;
      current.sendError = null;
      // The composer opens the DM that a first message to someone created: that notice is about it, and stays.
      keepNoticeFor(current, id);
      current.selection += 1;
      fixMarker(current);
      publish();
    },

    send,

    dismissSendNotice() {
      const current = live;
      if (disposed || !current || current.sendNotice === null) return;
      current.sendNotice = null;
      publish();
    },

    followRotation,

    loadOlder() {
      const current = live;
      const repo = current ? selectedSync(current) : null;
      if (disposed || !current || current.revoked || !repo) return Promise.resolve();
      return repo.loadOlder();
    },

    markRead,
    refreshDirectory,

    dispose() {
      if (disposed) return;
      disposed = true;
      stopAsking();
      endLive();
      announcer.drop();
      listeners.clear();
      incomingListeners.clear();
    },
  };
}
