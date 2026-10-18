// One repo kept in step with the bridge: its newest page, then a stream from the highest id that
// page held, every message merged into a bounded cache by id. An epoch change throws the cache away
// and starts again. The store runs one of these per repo it follows and shows the selected one.
import type { Api } from '../api/client';
import type { Clock } from '../api/clock';
import { connectStream, type StreamHandle, type StreamStatus, type StreamTiming } from '../api/stream';
import { CHANNEL, type Me, type Message, type MessagesPage } from '../api/types';
import { CACHE_LIMIT, merge, newest } from './cache';
import { belongsTo, conversationOf, conversationOfPair } from './conversations';
import { classify, keepTrying, retryDelay } from './failure';
import type { Conversation, ConversationId, ErrorInfo, OlderResult } from './types';

/** The bridge's largest page (bridge/src/messages.js), for catching up after a send. */
const MAX_PAGE = 500;

/**
 * How far one press of "Load older messages" in a DM may look for a message of that DM before it gives up and
 * says so (V5 finding 5): this many pages or this many messages, whichever comes first. The bridge pages over
 * every conversation the member may see, so a DM further back than a page needs several pages, and a bound
 * keeps a DM with nothing older from reading the whole history in one go. fake.ts takes both numbers from here, so the
 * two stores cannot disagree on them; conformance.test.ts runs the same cases on both.
 */
export const OLDER_MAX_PAGES = 10;
export const OLDER_MAX_MESSAGES = 1_000;

/** The press found, or has nothing to say: the common answer, so the same frozen object everywhere. */
export const NOT_LOOKED_BACK: OlderResult = Object.freeze({ lookedBack: null });

/**
 * Where the repo stands, for the Connection status: loading or reloading its newest page; its
 * stream connecting (never yet open in this epoch); open; down after having been open, retrying.
 */
export type Phase = 'loading' | 'connecting' | 'open' | 'down';

/** What a repo needs from the store. Every callback is about this session only. */
export interface SyncHost {
  readonly api: Api;
  readonly clock: Clock;
  readonly random: () => number;
  readonly streamTiming: Partial<StreamTiming> | undefined;
  readonly pageSize: number;
  /** The session's: aborted on sign-out, revocation and dispose. */
  readonly signal: AbortSignal;
  readonly schedule: (callback: () => void, ms: number) => () => void;
  readonly report: (error: unknown) => void;
  /** Something the snapshot shows changed. */
  changed(): void;
  /** The newest page arrived, the first time or after an epoch change. */
  loaded(repo: RepoSync): void;
  /** A message the store had not seen came through the stream. */
  arrived(repo: RepoSync, message: Message): void;
  /** The bridge stopped accepting the member's credentials; `error` is its answer. */
  unauthorized(error: ErrorInfo | null): void;
  revoked(): void;
  /** The repo list again, after an epoch change. Never rejects. */
  refetchRepos(repo: RepoSync): Promise<void>;
}

interface Waiter {
  readonly match: (message: Message) => boolean;
  readonly resolve: (arrived: boolean) => void;
  readonly cancel: () => void;
}

const errorInfo = (error: { readonly code: string; readonly message: string } | null): ErrorInfo | null =>
  error === null ? null : { code: error.code, message: error.message };

export class RepoSync {
  readonly key: string;
  /** The member's read pointer here; only ever moves forward. */
  readPointer: number;
  /** Ascending ids, each once, at most `cap` of the newest. */
  messages: readonly Message[] = [];
  hasMore = false;
  /** The newest page of the current epoch has arrived. */
  loaded = false;
  phase: Phase = 'loading';
  /**
   * Every DM conversation seen in this epoch. Kept even when the cache lets its messages go, so a
   * trim never takes a conversation, or the selected one, out from under the member.
   */
  readonly known = new Map<ConversationId, Conversation>();
  private epoch: string | null = null;
  private cap = CACHE_LIMIT;
  private everOpened = false;
  // The stream's own position: the last id it delivered or the hello's max_id. Not the cache's top,
  // which a send's catch-up can move past rows the stream has yet to deliver.
  private cursor = 0;
  private stream: StreamHandle | null = null;
  private retry: (() => void) | null = null;
  private failures = 0;
  // Bumped on stop and on every epoch change: an answer to an earlier run is dropped.
  private run = 0;
  private stopped = false;
  private older: Promise<OlderResult> | null = null;
  private listing: Promise<void> | null = null;
  private readonly waiters = new Set<Waiter>();

  constructor(private readonly host: SyncHost, private readonly member: Me, key: string, readPointer: number) {
    this.key = key;
    this.readPointer = readPointer;
  }

  start(): void {
    this.loadNewest();
  }

  /** Stops every request, timer and stream; what is held stays readable. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.run += 1;
    this.halt();
    for (const waiter of this.waiters) {
      waiter.cancel();
      waiter.resolve(false);
    }
    this.waiters.clear();
  }

  /**
   * Replaces the stream by one opened now, from the same cursor and epoch: the credential the api holds changed
   * (the member's own token was rotated), and the stream is bound to the old one, which the bridge has ended.
   * Not a new `run`, so a page, an older page or a list that is on its way still arrives. A repo with no stream
   * has nothing to replace: one still loading opens its stream with whatever the api holds when its page is
   * here, and one waiting to try again does the same when its timer fires.
   */
  restartStream(): void {
    if (this.stopped || this.stream === null) return;
    // Closing reports `closed` with reason `aborted`, which onStatus ignores after it forgets the handle.
    this.stream.close();
    this.openStream();
    this.host.changed();
  }

  /**
   * The next older page. For `wanted`, a DM (any id but the channel's), the pages after it too, one at a time,
   * until a page adds a message of it, the repo has no older page left, or OLDER_MAX_PAGES / OLDER_MAX_MESSAGES
   * have been loaded: the bridge pages over everything the member may see, so the first page may hold none of the
   * conversation on screen (V5 finding 5). Without `wanted`, or for the channel, it is the one page it always was.
   * Overlapping calls share one chain, the one the first of them started: it looks for that call's conversation, and
   * the feed, which holds its button down for the whole chain, never asks for another meanwhile. A failure ends the
   * chain without a word and leaves `hasMore` as the last page left it, for another try; so does a stop, a sign-out,
   * or a new epoch, and nothing is asked once the repo is stopped. The answer says how far it looked only when it
   * gave up at its bound.
   */
  loadOlder(wanted: ConversationId | null = null): Promise<OlderResult> {
    if (this.stopped || !this.hasMore) return Promise.resolve(NOT_LOOKED_BACK);
    if (this.older) return this.older;
    const run = this.run;
    const seeking = wanted !== null && wanted !== CHANNEL ? wanted : null;
    this.older = (async (): Promise<OlderResult> => {
      let pages = 0;
      let loaded = 0;
      try {
        for (;;) {
          // Before every request, not only the first: a listener told of the last page may have ended the session.
          if (run !== this.run) return NOT_LOOKED_BACK;
          const lowest = this.messages[0]?.id;
          const query = lowest === undefined ? { limit: this.host.pageSize } : { beforeId: lowest, limit: this.host.pageSize };
          const page = await this.host.api.messages(this.key, query, { signal: this.host.signal });
          // A page from another epoch belongs to no one: the stream's resync reloads the repo.
          if (run !== this.run || page.epoch !== this.epoch) return NOT_LOOKED_BACK;
          const added = this.absorb(page.messages, true);
          this.hasMore = page.has_more;
          this.host.changed();
          pages += 1;
          loaded += page.messages.length;
          // A message found on the last page the bound allows still counts as found, so the bound is read after it.
          if (seeking === null || !this.hasMore || added.some((message) => belongsTo(message, seeking))) return NOT_LOOKED_BACK;
          if (pages >= OLDER_MAX_PAGES || loaded >= OLDER_MAX_MESSAGES) return Object.freeze({ lookedBack: loaded });
        }
      } catch (failure) {
        const read = classify(failure, this.host.signal);
        if (read.kind === 'bug') this.host.report(read.error);
        return NOT_LOOKED_BACK;
      } finally {
        if (run === this.run) this.older = null;
      }
    })();
    return this.older;
  }

  /**
   * Asks the bridge which DM pairs the member may see (GET /conversations) and adds each to `known`, so that a
   * DM older than the newest page has a button (V5 finding 9). An entry is the same conversation a message of
   * its pair gives (conversationOfPair), so nothing is listed twice and a pair already known is left alone.
   * Overlapping calls share one request. Never rejects and never says it failed: the list then stays what the
   * loaded messages give, and nothing asks again by itself. A 401 is treated as `loadOlder` and `catchUp` treat
   * it: the member's streams and newest page decide about dead credentials, this optional read does not.
   */
  loadConversations(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.listing) return this.listing;
    const run = this.run;
    this.listing = (async () => {
      try {
        const { conversations } = await this.host.api.conversations(this.key, { signal: this.host.signal });
        // The answer carries no epoch, so a replaced database is told by the run: an answer from before it is another's.
        if (run !== this.run) return;
        let added = false;
        for (const pair of conversations) {
          const conversation = conversationOfPair(pair.a, pair.b, this.member);
          if (this.known.has(conversation.id)) continue;
          this.known.set(conversation.id, Object.freeze(conversation));
          added = true;
        }
        if (added) this.host.changed();
      } catch (failure) {
        const read = classify(failure, this.host.signal);
        if (read.kind === 'bug') this.host.report(read.error);
      } finally {
        if (run === this.run) this.listing = null;
      }
    })();
    return this.listing;
  }

  /** Resolves true once a message matching `match` is held, false after `ms` or when the repo stops. */
  waitFor(match: (message: Message) => boolean, ms: number): Promise<boolean> {
    if (this.messages.some(match)) return Promise.resolve(true);
    if (this.stopped) return Promise.resolve(false);
    return new Promise((resolve) => {
      const waiter: Waiter = {
        match,
        resolve,
        cancel: this.host.schedule(() => {
          this.waiters.delete(waiter);
          resolve(false);
        }, ms),
      };
      this.waiters.add(waiter);
    });
  }

  /**
   * The page after the highest id held, once, keeping only the member's own messages: the stream
   * still brings everyone else's, so they are announced and passed on as arrivals. Never rejects.
   */
  async catchUp(own: string): Promise<void> {
    if (this.stopped) return;
    const run = this.run;
    try {
      const page = await this.host.api.messages(this.key, { afterId: this.messages.at(-1)?.id ?? 0, limit: MAX_PAGE }, { signal: this.host.signal });
      if (run !== this.run || page.epoch !== this.epoch) return;
      if (this.absorb(page.messages.filter((message) => message.from === own)).length > 0) this.host.changed();
    } catch (failure) {
      const read = classify(failure, this.host.signal);
      if (read.kind === 'bug') this.host.report(read.error);
    }
  }

  // ------------------------------------------------------------------------------------------ inside

  private loadNewest(): void {
    const run = this.run;
    this.phase = 'loading';
    keepTrying<MessagesPage>({
      request: (signal) => this.host.api.messages(this.key, { limit: this.host.pageSize }, { signal }),
      signal: this.host.signal,
      current: () => run === this.run,
      schedule: (callback, ms) => {
        this.retry = this.host.schedule(callback, ms);
        return this.retry;
      },
      report: this.host.report,
      onAuth: (error) => this.host.unauthorized(error),
      onValue: (page) => {
        this.retry = null;
        this.epoch = page.epoch;
        this.absorb(page.messages);
        this.hasMore = page.has_more;
        this.loaded = true;
        // The stream starts after the newest id the page held, never after max_id: max_id is read in
        // a statement of its own, so a row written in between would be skipped. An empty page starts at 0.
        this.cursor = this.messages.at(-1)?.id ?? 0;
        this.host.loaded(this);
        this.openStream();
        this.host.changed();
      },
    });
  }

  private openStream(): void {
    const run = this.run;
    this.phase = this.everOpened ? 'down' : 'connecting';
    this.stream = connectStream({
      api: this.host.api,
      repo: this.key,
      lastEventId: this.cursor,
      epoch: this.epoch,
      clock: this.host.clock,
      random: this.host.random,
      timing: this.host.streamTiming,
      onMessage: (message) => {
        if (run === this.run) this.fromStream(message);
      },
      onStatus: (status) => {
        if (run === this.run) this.onStatus(status);
      },
    });
  }

  private fromStream(message: Message): void {
    this.cursor = Math.max(this.cursor, message.id);
    if (this.absorb([message]).length > 0) this.host.arrived(this, message);
  }

  private onStatus(status: StreamStatus): void {
    switch (status.state) {
      case 'connecting':
        return;
      case 'open':
        this.phase = 'open';
        this.everOpened = true;
        this.failures = 0;
        this.cursor = Math.max(this.cursor, status.maxId);
        this.host.changed();
        return;
      case 'reconnecting':
        this.phase = this.everOpened ? 'down' : 'connecting';
        this.host.changed();
        return;
      case 'revoked':
        this.stream = null;
        this.host.revoked();
        return;
      case 'closed':
        this.stream = null;
        switch (status.reason) {
          case 'aborted':
            return;
          case 'resync':
            this.resync();
            return;
          case 'unauthorized':
            this.host.unauthorized(errorInfo(status.error));
            return;
          case 'failed': {
            // A refusal the stream will not retry by itself, such as a repo that went away: try again later.
            this.phase = this.everOpened ? 'down' : 'connecting';
            const run = this.run;
            this.retry = this.host.schedule(() => {
              this.retry = null;
              if (run === this.run) this.openStream();
            }, retryDelay(this.failures));
            this.failures += 1;
            this.host.changed();
            return;
          }
        }
    }
  }

  /** The repo's database was replaced: everything held is from a database that no longer exists. */
  private resync(): void {
    this.run += 1;
    this.halt();
    this.messages = [];
    this.known.clear();
    this.hasMore = false;
    this.loaded = false;
    this.epoch = null;
    this.cap = CACHE_LIMIT;
    this.cursor = 0;
    this.everOpened = false;
    this.failures = 0;
    this.phase = 'loading';
    this.host.changed();
    // The pairs of the old database went with it; the new one's are asked for beside its newest page.
    void this.loadConversations();
    const run = this.run;
    void this.host.refetchRepos(this)
      .then(() => {
        if (run === this.run) this.loadNewest();
      })
      .catch(this.host.report);
  }

  private halt(): void {
    this.stream?.close();
    this.stream = null;
    this.retry?.();
    this.retry = null;
    this.older = null;
    this.listing = null;
  }

  /**
   * Merges by id and keeps the newest `cap`; returns what was new. Pages the member asked for
   * (`asked`) raise the cap instead of being dropped again at once; a trim means older ones exist.
   */
  private absorb(incoming: readonly Message[], asked = false): readonly Message[] {
    const { messages, added } = merge(this.messages, incoming);
    if (added.length === 0) return added;
    if (asked) this.cap = Math.max(this.cap, messages.length);
    const kept = newest(messages, this.cap);
    this.messages = kept.messages;
    if (kept.trimmed) this.hasMore = true;
    for (const message of added) {
      if (message.to === CHANNEL) continue;
      const conversation = conversationOf(message, this.member);
      if (!this.known.has(conversation.id)) this.known.set(conversation.id, Object.freeze(conversation));
    }
    for (const waiter of [...this.waiters]) {
      if (added.some(waiter.match)) {
        this.waiters.delete(waiter);
        waiter.cancel();
        waiter.resolve(true);
      }
    }
    return added;
  }
}
