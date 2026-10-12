// The real store: the contract in types.ts, kept over the bridge API (src/api). It asks /v1/me on
// start, follows up to 8 repos at once (repo-sync.ts) and shows the selected one, and it words and
// orders everything the contract fixes as the fake store does (conversations.ts, announce.ts),
// because the views are tested against the fake. The member's token lives in this closure and
// nowhere else: not in a snapshot, storage, a URL, a log or an error.
import { createApi, type Api } from '../api/client';
import { systemClock, type Clock } from '../api/clock';
import type { StreamTiming } from '../api/stream';
import { CHANNEL, type Directory, type Me, type Message, type Repo, type SendResult } from '../api/types';
import { Announcer } from './announce';
import { belongsTo, CHANNEL_CONVERSATION, conversationOf, ordered } from './conversations';
import { classify, keepTrying, retryDelay, UNAUTHORIZED } from './failure';
import { RepoSync, type SyncHost } from './repo-sync';
import type {
  Connection,
  ConversationId,
  ErrorInfo,
  IncomingMessage,
  SendDraft,
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
  /** The bridge revoked the member: everything stays readable and nothing is asked any more. */
  revoked = false;
  /** Bumped on every change of repo or conversation, so a late send failure is not shown in another one. */
  selection = 0;
  /** The directory request in flight, and the one waiting behind it (see refreshDirectory). A request's failure is caught inside, so neither rejects. */
  runningRefresh: Promise<void> | null = null;
  queuedRefresh: Promise<void> | null = null;
  readonly unknownAt = new Map<string, number>();
  private readonly timers = new Set<() => void>();

  constructor(readonly me: Me, private readonly clock: Clock) {}

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
  const api = (options.api ?? ((getToken) => createApi({ getToken })))(() => token);

  const listeners = new Set<(snapshot: StoreSnapshot) => void>();
  const incomingListeners = new Set<(incoming: IncomingMessage) => void>();
  let session: Session = Object.freeze({ status: 'unknown' });
  let live: Live | null = null;
  // Bumped whenever the session changes hands, so an answer to an older /v1/me is dropped.
  let attempt = 0;
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
    token = null;
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
    current.selection += 1;
    announcer.drop();
    ensureSync(current, repo);
    // A repo outside the background set is followed only while it is selected.
    if (previous !== null && previous !== repo.key && !current.background.has(previous)) {
      current.repos.get(previous)?.stop();
      current.repos.delete(previous);
    }
    fixMarker(current);
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
    token = trimmed === '' ? null : trimmed;
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
      token = null;
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
    const repo = current ? selectedSync(current) : null;
    if (disposed || !current || current.revoked || !repo) return false;
    const selection = current.selection;
    if (current.sendError !== null) {
      current.sendError = null;
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
    try {
      const result = await api.markRead(repo.key, newest.id, { signal: current.abort.signal });
      if (live === current) repo.readPointer = Math.max(repo.readPointer, result.last_read_id);
    } catch (failure) {
      const read = classify(failure, current.abort.signal);
      if (read.kind === 'bug') report(read.error);
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
      current.selection += 1;
      fixMarker(current);
      publish();
    },

    send,

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
