// The live message stream of one repo, over fetch (D13: EventSource cannot send `Authorization`).
// It resumes with `Last-Event-ID`, reconnects with exponential backoff and full jitter, notices a
// connection that has gone silent, and stops for good on revocation, on an epoch change and on
// refusals that retrying cannot fix. What the bridge sends (bridge/src/server.js, openStream):
//   retry: 2000                      once, first
//   id: N / event: message / data    replayed rows after Last-Event-ID, then live ones
//   event: hello / data {epoch, max_id}   after the replay; it has no id
//   : ping                           every 30 polls
//   event: bye / data {reason}       then the bridge ends the response
import type { Api } from './client';
import { systemClock, type Clock } from './clock';
import { ApiError, NetworkError, ProtocolError } from './errors';
import { parseBye, parseHello, parseMessage } from './guards';
import { SseParser, type SseEvent } from './sse';
import type { Message } from './types';

export const STREAM_EVENTS = { hello: 'hello', message: 'message', bye: 'bye' } as const;

/** Every `bye` reason the bridge sends (bridge/src/server.js). Only two of them end this stream. */
export const BYE_REASONS = {
  revoked: 'revoked',
  epoch: 'epoch',
  tokenRotated: 'token_rotated',
  error: 'error',
  shutdown: 'shutdown',
  client: 'client',
} as const;

// Read from bridge/src/server.js, not guessed: Watcher.tick runs every `pollMs`, which is 500 ms
// unless createBridge is given another value (bin/chatter-bridge.js never does), and it pings
// every subscriber when `ticks % 30 === 0`.
const SERVER_POLL_MS = 500;
const SERVER_PING_EVERY_TICKS = 30;
export const SERVER_PING_INTERVAL_MS = SERVER_POLL_MS * SERVER_PING_EVERY_TICKS;

export interface StreamTiming {
  /** First backoff ceiling; doubles per consecutive failure. */
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Silence (not one byte, not even a ping) after which the connection is presumed dead. */
  readonly deadAfterMs: number;
}

export const DEFAULT_STREAM_TIMING: StreamTiming = {
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  deadAfterMs: 3 * SERVER_PING_INTERVAL_MS,
};

export type ReconnectCause = 'network' | 'server' | 'ended' | 'dead' | 'bye';

/** Why a stream stopped for good. `resync`: the repo's epoch changed; reload it, then open a new stream. */
export type CloseReason = 'aborted' | 'resync' | 'unauthorized' | 'failed';

export type StreamStatus =
  | { readonly state: 'connecting' }
  | { readonly state: 'open'; readonly epoch: string; readonly maxId: number }
  | {
    readonly state: 'reconnecting';
    /** Consecutive failures since the last `hello`, starting at 1. */
    readonly attempt: number;
    readonly delayMs: number;
    readonly cause: ReconnectCause;
    /** Set when cause is `bye`. */
    readonly byeReason: string | null;
    readonly error: Error | null;
  }
  | { readonly state: 'closed'; readonly reason: CloseReason; readonly error: ApiError | ProtocolError | null }
  | { readonly state: 'revoked' };

export type StreamState = StreamStatus['state'];

export interface StreamOptions {
  readonly api: Pick<Api, 'openStream'>;
  readonly repo: string;
  /**
   * Resume after this id. Pass the id of the newest message the page returned (0 for an empty page),
   * not the page's `max_id`: the bridge reads that in a separate statement, so a row written between
   * the two would be skipped. Null starts from "now" and adopts the hello's `max_id`, which is safe
   * because the stream has by then replayed everything up to it.
   */
  readonly lastEventId?: number | null;
  /** The epoch `lastEventId` belongs to. A hello with another epoch closes the stream with `resync`. */
  readonly epoch?: string | null;
  /** Each message once, in id order, never one from another epoch. Replayed ones arrive with the hello. */
  readonly onMessage: (message: Message) => void;
  readonly onStatus: (status: StreamStatus) => void;
  readonly clock?: Clock;
  /** Returns a number in [0, 1), like Math.random. */
  readonly random?: () => number;
  readonly timing?: Partial<StreamTiming>;
}

export interface StreamHandle {
  /** Stops the stream and any pending reconnect; reports `closed` with reason `aborted`. */
  close(): void;
}

type Outcome =
  | { readonly kind: 'aborted' }
  | { readonly kind: 'revoked' }
  | { readonly kind: 'resync' }
  | { readonly kind: 'unauthorized'; readonly error: ApiError }
  | { readonly kind: 'failed'; readonly error: ApiError | ProtocolError }
  | { readonly kind: 'retry'; readonly cause: ReconnectCause; readonly byeReason: string | null; readonly error: Error | null };

const UNAUTHORIZED = new Set([401, 403]);
// Everything else below 500 is a refusal that the same request will get again.
const RETRYABLE_REFUSALS = new Set([408, 429]);

function classify(failure: unknown): Outcome {
  if (failure instanceof ApiError) {
    if (UNAUTHORIZED.has(failure.status)) return { kind: 'unauthorized', error: failure };
    if (failure.status >= 500 || RETRYABLE_REFUSALS.has(failure.status)) {
      return { kind: 'retry', cause: 'server', byeReason: null, error: failure };
    }
    return { kind: 'failed', error: failure };
  }
  if (failure instanceof ProtocolError) return { kind: 'failed', error: failure };
  const error = failure instanceof NetworkError ? failure : new NetworkError('the event stream broke', { cause: failure });
  return { kind: 'retry', cause: 'network', byeReason: null, error };
}

function json(data: string, field: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    throw new ProtocolError(field, 'is not JSON');
  }
}

export function connectStream(options: StreamOptions): StreamHandle {
  const clock = options.clock ?? systemClock;
  const random = options.random ?? Math.random;
  const timing: StreamTiming = { ...DEFAULT_STREAM_TIMING, ...options.timing };
  // The bridge sends each message's id as its SSE id, so this is the last event id seen.
  let cursor: number | null = options.lastEventId ?? null;
  let epoch: string | null = options.epoch ?? null;
  let failures = 0;
  let finished = false;
  let cancelRetry: (() => void) | null = null;
  let stopCurrent: (() => void) | null = null;

  // A throwing callback is the caller's bug. Rethrown on its own, it cannot pass for a broken
  // connection here and set off a reconnect loop.
  function guarded(callback: () => void): void {
    try {
      callback();
    } catch (failure) {
      queueMicrotask(() => {
        throw failure;
      });
    }
  }

  function emit(status: StreamStatus): void {
    if (!finished) guarded(() => options.onStatus(status));
  }

  function finish(status: StreamStatus): void {
    if (finished) return;
    finished = true;
    cancelRetry?.();
    cancelRetry = null;
    stopCurrent?.();
    guarded(() => options.onStatus(status));
  }

  function deliver(message: Message): void {
    if (finished || (cursor !== null && message.id <= cursor)) return;
    cursor = message.id;
    guarded(() => options.onMessage(message));
  }

  async function attempt(): Promise<void> {
    // A status callback may have closed the handle just before this call, and close() can only stop an
    // attempt that is already running: this one has not set `stopCurrent` yet.
    if (finished) return;
    const controller = new AbortController();
    // A holder, not `let`s: closures set these, and narrowing would not see them do so.
    const run: { outcome: Outcome | null; cancelSilence: (() => void) | null } = { outcome: null, cancelSilence: null };
    const pending: Message[] = [];
    let helloSeen = false;

    const settle = (outcome: Outcome): void => {
      if (run.outcome) return;
      run.outcome = outcome;
      controller.abort();
    };
    const armSilence = (): void => {
      run.cancelSilence?.();
      run.cancelSilence = clock.schedule(() => settle({ kind: 'retry', cause: 'dead', byeReason: null, error: null }), timing.deadAfterMs);
    };
    stopCurrent = () => settle({ kind: 'aborted' });

    const handle = (event: SseEvent): Outcome | null => {
      switch (event.type) {
        case STREAM_EVENTS.message: {
          const message = parseMessage(json(event.data, 'message'), 'message');
          // Held back until the hello: only the hello says which epoch the replay came from.
          if (helloSeen) deliver(message);
          else pending.push(message);
          return null;
        }
        case STREAM_EVENTS.hello: {
          const hello = parseHello(json(event.data, 'hello'));
          if (epoch !== null && hello.epoch !== epoch) return { kind: 'resync' };
          epoch = hello.epoch;
          helloSeen = true;
          failures = 0;
          for (const message of pending.splice(0)) deliver(message);
          // Every row up to max_id was replayed or is invisible to this member, so resuming from
          // here loses nothing, even if this connection started without a cursor.
          cursor = Math.max(cursor ?? 0, hello.max_id);
          emit({ state: 'open', epoch: hello.epoch, maxId: hello.max_id });
          return null;
        }
        case STREAM_EVENTS.bye: {
          const { reason } = parseBye(json(event.data, 'bye'));
          if (reason === BYE_REASONS.revoked) return { kind: 'revoked' };
          if (reason === BYE_REASONS.epoch) return { kind: 'resync' };
          // token_rotated, shutdown, error: try again. A dead token then gets a 401, which ends
          // the stream; a member signed in through the tailnet simply reconnects.
          return { kind: 'retry', cause: 'bye', byeReason: reason, error: null };
        }
        default:
          return null;
      }
    };

    armSilence();
    try {
      const body = await options.api.openStream(options.repo, { lastEventId: cursor, signal: controller.signal });
      if (run.outcome) {
        await body.cancel().catch(() => undefined);
      } else {
        armSilence();
        const reader = body.getReader();
        // The bridge's `retry: 2000` is EventSource's fixed delay; reconnects follow the backoff above instead.
        const parser = new SseParser({
          onEvent(event) {
            if (run.outcome || finished) {
              parser.stop();
              return;
            }
            let outcome: Outcome | null;
            try {
              outcome = handle(event);
            } catch (failure) {
              outcome = classify(failure);
            }
            if (outcome) {
              settle(outcome);
              parser.stop();
            }
          },
        });
        try {
          while (!run.outcome) {
            const { done, value } = await reader.read();
            if (done) {
              parser.end();
              settle({ kind: 'retry', cause: 'ended', byeReason: null, error: null });
              break;
            }
            armSilence();
            parser.push(value);
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
      }
    } catch (failure) {
      settle(classify(failure));
    } finally {
      run.cancelSilence?.();
      stopCurrent = null;
    }
    conclude(run.outcome ?? { kind: 'aborted' });
  }

  function conclude(outcome: Outcome): void {
    if (finished) return;
    switch (outcome.kind) {
      case 'aborted':
        return;
      case 'revoked':
        finish({ state: 'revoked' });
        return;
      case 'resync':
        finish({ state: 'closed', reason: 'resync', error: null });
        return;
      case 'unauthorized':
      case 'failed':
        finish({ state: 'closed', reason: outcome.kind, error: outcome.error });
        return;
      case 'retry': {
        const ceiling = Math.min(timing.maxDelayMs, timing.baseDelayMs * 2 ** failures);
        const delayMs = Math.floor(random() * ceiling);
        failures += 1;
        emit({ state: 'reconnecting', attempt: failures, delayMs, cause: outcome.cause, byeReason: outcome.byeReason, error: outcome.error });
        // The store closes a stream from this very callback when a subscriber signs out or disposes it
        // while handling the Offline publication; finish() has then run and found no retry to cancel.
        if (finished) return;
        cancelRetry = clock.schedule(() => {
          cancelRetry = null;
          void attempt();
        }, delayMs);
        return;
      }
    }
  }

  // Started on a microtask so the caller has its handle before the first callback runs.
  queueMicrotask(() => {
    if (finished) return;
    emit({ state: 'connecting' });
    // Same as after `reconnecting`: the callback may have closed the handle.
    if (finished) return;
    void attempt();
  });

  return {
    close: () => finish({ state: 'closed', reason: 'aborted', error: null }),
  };
}
