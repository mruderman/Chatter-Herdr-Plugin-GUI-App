// @vitest-environment node
// connectStream against a scripted bridge: each connection is a ReadableStream the test writes the
// recorded SSE bytes into, time is a ManualClock and jitter is a fixed number, so every reconnect,
// delay and silence is exact.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { body, recordedError, streamBytes } from '../../test/fixtures/recorded';
import type { Api } from './client';
import { ManualClock } from './clock';
import { ApiError, NetworkError, ProtocolError } from './errors';
import { parseHello, parseMessagesPage } from './guards';
import { connectStream, DEFAULT_STREAM_TIMING, SERVER_PING_INTERVAL_MS, type StreamOptions, type StreamStatus } from './stream';
import type { Message } from './types';

const KEY = parseMessagesPage(body('messages-flan')).repo;
const EPOCH = parseMessagesPage(body('messages-flan')).epoch;
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const abortError = (): DOMException => new DOMException('The operation was aborted.', 'AbortError');

/** One response body the fake bridge is writing. */
class Wire {
  readonly body: ReadableStream<Uint8Array>;
  cancelled = false;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private done = false;

  constructor(readonly lastEventId: number | null, readonly signal: AbortSignal) {
    this.body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
      cancel: () => {
        this.cancelled = true;
      },
    });
    signal.addEventListener('abort', () => this.fail(abortError()));
  }

  send(data: string | Uint8Array): void {
    if (!this.done) this.controller?.enqueue(typeof data === 'string' ? encode(data) : data);
  }

  end(): void {
    if (this.done) return;
    this.done = true;
    this.controller?.close();
  }

  fail(error: unknown): void {
    if (this.done) return;
    this.done = true;
    this.controller?.error(error);
  }
}

class FakeBridge {
  readonly wires: Wire[] = [];
  readonly requests: Array<{ readonly lastEventId: number | null; readonly signal: AbortSignal }> = [];
  private readonly refusals: unknown[] = [];
  private hangs = 0;

  readonly api: Pick<Api, 'openStream'> = {
    openStream: (_repo, { lastEventId, signal }) => {
      this.requests.push({ lastEventId, signal });
      if (this.refusals.length) return Promise.reject(this.refusals.shift());
      if (this.hangs > 0) {
        this.hangs -= 1;
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(abortError())));
      }
      const wire = new Wire(lastEventId, signal);
      this.wires.push(wire);
      return Promise.resolve(wire.body);
    },
  };

  refuse(...errors: unknown[]): void {
    this.refusals.push(...errors);
  }

  hangNext(): void {
    this.hangs += 1;
  }

  get wire(): Wire {
    const wire = this.wires.at(-1);
    if (!wire) throw new Error('no connection yet');
    return wire;
  }
}

/** Lets every pending promise and stream read run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function start(bridge: FakeBridge, options: Partial<StreamOptions> = {}) {
  const clock = new ManualClock();
  const messages: Message[] = [];
  const statuses: StreamStatus[] = [];
  const handle = connectStream({
    api: bridge.api,
    repo: KEY,
    clock,
    random: () => 0.5,
    onMessage: (message) => messages.push(message),
    onStatus: (status) => statuses.push(status),
    ...options,
  });
  const states = (): string[] => statuses.map((status) => status.state);
  const last = (): StreamStatus | undefined => statuses.at(-1);
  return { clock, messages, statuses, handle, states, last };
}

const hello = (epoch: string, maxId: number): string => `event: hello\ndata: ${JSON.stringify({ epoch, max_id: maxId })}\n\n`;
const messageEvent = (message: Message): string => `id: ${message.id}\nevent: message\ndata: ${JSON.stringify(message)}\n\n`;
const recordedMessage = (id: number): Message => {
  const found = parseMessagesPage(body('messages-flan')).messages.find((m) => m.id === id);
  if (!found) throw new Error(`no recorded message ${id}`);
  return found;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('connectStream: the recorded streams', () => {
  it('delivers each message of the live stream once, in order, and resumes after the last one', async () => {
    const bridge = new FakeBridge();
    const s = start(bridge);
    await settle();
    expect(bridge.requests[0]?.lastEventId).toBeNull();
    bridge.wire.send(streamBytes('live'));
    bridge.wire.end();
    await settle();
    const ids = parseMessagesPage(body('messages-mira')).messages.map((m) => m.id).filter((id) => id > 1);
    expect(s.messages.map((m) => m.id)).toEqual(ids);
    expect(s.statuses).toEqual([
      { state: 'connecting' },
      { state: 'open', epoch: EPOCH, maxId: 1 },
      { state: 'reconnecting', attempt: 1, delayMs: 500, cause: 'bye', byeReason: 'token_rotated', error: null },
    ]);
    s.clock.advance(500);
    await settle();
    expect(bridge.requests[1]?.lastEventId).toBe(ids.at(-1));
  });

  it('holds a resumed replay back until the hello, then delivers it and resumes after max_id', async () => {
    const bridge = new FakeBridge();
    const s = start(bridge, { lastEventId: 2, epoch: EPOCH });
    await settle();
    expect(bridge.requests[0]?.lastEventId).toBe(2);
    const resume = text(streamBytes('resume'));
    const helloAt = resume.indexOf('event: hello');
    bridge.wire.send(resume.slice(0, helloAt));
    await settle();
    expect(s.messages).toEqual([]);
    bridge.wire.send(resume.slice(helloAt));
    await settle();
    expect(s.messages.map((m) => m.id)).toEqual(parseMessagesPage(body('messages-mira')).messages.map((m) => m.id).filter((id) => id > 2));
    const recordedHello = parseHello(JSON.parse(resume.slice(helloAt).split('data: ')[1] ?? ''));
    expect(s.last()).toEqual({ state: 'open', epoch: EPOCH, maxId: recordedHello.max_id });
    bridge.wire.fail(new TypeError('network connection lost'));
    await settle();
    expect(s.last()).toMatchObject({ state: 'reconnecting', cause: 'network' });
    s.clock.advance(1_000);
    await settle();
    // 15 and 16 are flan's DMs to codex: invisible to mira, and already behind the hello's max_id.
    expect(bridge.requests[1]?.lastEventId).toBe(recordedHello.max_id);
  });

  it('stops for good on bye revoked', async () => {
    const bridge = new FakeBridge();
    const s = start(bridge);
    await settle();
    bridge.wire.send(streamBytes('revoked'));
    bridge.wire.end();
    await settle();
    expect(s.states()).toEqual(['connecting', 'open', 'revoked']);
    s.clock.advance(10 * 60_000);
    await settle();
    expect(bridge.requests).toHaveLength(1);
    expect(s.clock.scheduled).toBe(0);
  });

  it('closes with resync on bye epoch, and does not reconnect', async () => {
    const bridge = new FakeBridge();
    const s = start(bridge);
    await settle();
    bridge.wire.send(streamBytes('epoch'));
    bridge.wire.end();
    await settle();
    expect(s.last()).toEqual({ state: 'closed', reason: 'resync', error: null });
    s.clock.advance(10 * 60_000);
    await settle();
    expect(bridge.requests).toHaveLength(1);
  });
});

describe('connectStream: cursor and epoch', () => {
  it('without a cursor, resumes from the hello\'s max_id', async () => {
    const bridge = new FakeBridge();
    const s = start(bridge);
    await settle();
    bridge.wire.send(`retry: 2000\n\n${hello('e1', 7)}`);
    bridge.wire.end();
    await settle();
    expect(s.last()).toMatchObject({ state: 'reconnecting', cause: 'ended' });
    s.clock.advance(500);
    await settle();
    expect(bridge.requests[1]?.lastEventId).toBe(7);
  });

  it('closes with resync when the hello\'s epoch is not the cursor\'s, and delivers none of the replay', async () => {
    const bridge = new FakeBridge();
    const s = start(bridge, { lastEventId: 2, epoch: 'an-older-epoch' });
    await settle();
    bridge.wire.send(streamBytes('resume'));
    await settle();
    expect(s.messages).toEqual([]);
    expect(s.last()).toEqual({ state: 'closed', reason: 'resync', error: null });
    expect(bridge.wire.signal.aborted).toBe(true);
  });

  it('remembers the epoch of its first hello and resyncs when a reconnect finds another', async () => {
    const bridge = new FakeBridge();
    const s = start(bridge);
    await settle();
    bridge.wire.send(hello('e1', 3));
    bridge.wire.end();
    await settle();
    s.clock.advance(500);
    await settle();
    bridge.wire.send(hello('e2', 1));
    await settle();
    expect(s.states()).toEqual(['connecting', 'open', 'reconnecting', 'closed']);
    expect(s.last()).toMatchObject({ reason: 'resync' });
  });

  it('never delivers a message twice or one at or behind its cursor', async () => {
    const bridge = new FakeBridge();
    const s = start(bridge);
    await settle();
    bridge.wire.send(hello(EPOCH, 5));
    bridge.wire.send(messageEvent(recordedMessage(3)));
    bridge.wire.send(messageEvent(recordedMessage(7)));
    bridge.wire.send(messageEvent(recordedMessage(7)));
    await settle();
    expect(s.messages.map((m) => m.id)).toEqual([7]);
  });
});

describe('connectStream: backoff', () => {
  async function failEveryTime(random: () => number, rounds: number): Promise<number[]> {
    const bridge = new FakeBridge();
    bridge.refuse(...Array.from({ length: rounds }, () => new NetworkError('could not reach the bridge')));
    const s = start(bridge, { random });
    const delays: number[] = [];
    for (let round = 0; round < rounds; round += 1) {
      await settle();
      const status = s.last();
      if (status?.state !== 'reconnecting') throw new Error(`expected reconnecting, got ${status?.state}`);
      expect(status.attempt).toBe(round + 1);
      expect(s.clock.delays).toEqual([status.delayMs]);
      delays.push(status.delayMs);
      s.clock.advance(status.delayMs);
    }
    return delays;
  }

  it('doubles the ceiling from 1 s up to the 30 s cap and waits a random part of it', async () => {
    expect(await failEveryTime(() => 0.5, 8)).toEqual([500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000]);
  });

  it('uses the whole range of the jitter, from nothing to just under the ceiling', async () => {
    expect(await failEveryTime(() => 0, 3)).toEqual([0, 0, 0]);
    expect(await failEveryTime(() => 0.9999, 7)).toEqual([999, 1_999, 3_999, 7_999, 15_998, 29_997, 29_997]);
  });

  it('starts again from 1 s after a hello', async () => {
    const bridge = new FakeBridge();
    bridge.refuse(new NetworkError('down'), new NetworkError('down'), new NetworkError('down'));
    const s = start(bridge);
    for (const delay of [500, 1_000, 2_000]) {
      await settle();
      expect(s.last()).toMatchObject({ state: 'reconnecting', delayMs: delay });
      s.clock.advance(delay);
    }
    await settle();
    bridge.wire.send(hello(EPOCH, 9));
    bridge.wire.end();
    await settle();
    expect(s.last()).toMatchObject({ state: 'reconnecting', attempt: 1, delayMs: 500 });
  });
});

describe('connectStream: a silent connection', () => {
  it('waits three server ping intervals, read from the bridge source', () => {
    expect(SERVER_PING_INTERVAL_MS).toBe(15_000);
    expect(DEFAULT_STREAM_TIMING.deadAfterMs).toBe(45_000);
  });

  it('reconnects when not even a ping arrives in time, and a ping resets the wait', async () => {
    const bridge = new FakeBridge();
    const s = start(bridge);
    await settle();
    bridge.wire.send(hello(EPOCH, 3));
    await settle();
    s.clock.advance(44_999);
    await settle();
    expect(s.last()?.state).toBe('open');
    bridge.wire.send(': ping\n\n');
    await settle();
    s.clock.advance(44_999);
    await settle();
    expect(s.last()?.state).toBe('open');
    s.clock.advance(1);
    await settle();
    expect(s.last()).toMatchObject({ state: 'reconnecting', cause: 'dead' });
    expect(bridge.requests[0]?.signal.aborted).toBe(true);
    s.clock.advance(500);
    await settle();
    expect(bridge.requests[1]?.lastEventId).toBe(3);
  });

  it('gives up on a connection attempt that never answers', async () => {
    const bridge = new FakeBridge();
    bridge.hangNext();
    const s = start(bridge);
    await settle();
    s.clock.advance(45_000);
    await settle();
    expect(s.last()).toMatchObject({ state: 'reconnecting', cause: 'dead' });
    expect(bridge.requests[0]?.signal.aborted).toBe(true);
  });
});

describe('connectStream: refusals', () => {
  it.each(['stream-unauthenticated'])('ends as unauthorized on the recorded %s, without retrying', async (name) => {
    const bridge = new FakeBridge();
    const { status, code, message } = recordedError(name);
    bridge.refuse(new ApiError(status, code, message));
    const s = start(bridge);
    await settle();
    expect(s.last()).toMatchObject({ state: 'closed', reason: 'unauthorized', error: { status: 401, code } });
    expect(s.clock.scheduled).toBe(0);
  });

  it('ends as unauthorized on a 403 too', async () => {
    const bridge = new FakeBridge();
    bridge.refuse(new ApiError(403, 'not_registered', 'your Tailscale login is not registered as a member'));
    const s = start(bridge);
    await settle();
    expect(s.last()).toMatchObject({ state: 'closed', reason: 'unauthorized' });
  });

  it('ends as failed on the recorded no_such_repo, without retrying', async () => {
    const bridge = new FakeBridge();
    const { status, code, message } = recordedError('stream-no-such-repo');
    bridge.refuse(new ApiError(status, code, message));
    const s = start(bridge);
    await settle();
    expect(s.last()).toMatchObject({ state: 'closed', reason: 'failed', error: { status: 404, code: 'no_such_repo' } });
    expect(s.clock.scheduled).toBe(0);
  });

  it('retries a server error', async () => {
    const bridge = new FakeBridge();
    bridge.refuse(new ApiError(503, 'schema_mismatch', 'Chatter database layout changed'));
    const s = start(bridge);
    await settle();
    expect(s.last()).toMatchObject({ state: 'reconnecting', cause: 'server' });
  });

  it('fails on an event it cannot read, naming the field', async () => {
    const bridge = new FakeBridge();
    const s = start(bridge);
    await settle();
    bridge.wire.send(hello(EPOCH, 3));
    bridge.wire.send(`id: 4\nevent: message\ndata: ${JSON.stringify({ ...recordedMessage(4), id: 'four' })}\n\n`);
    await settle();
    const status = s.last();
    expect(status).toMatchObject({ state: 'closed', reason: 'failed' });
    expect(status?.state === 'closed' ? status.error : null).toBeInstanceOf(ProtocolError);
    expect(status?.state === 'closed' ? status.error : null).toMatchObject({ field: 'message.id' });
    expect(bridge.wire.signal.aborted).toBe(true);
  });
});

describe('connectStream: closing', () => {
  it('reports connecting only after it has returned its handle', async () => {
    const bridge = new FakeBridge();
    const s = start(bridge);
    expect(s.statuses).toEqual([]);
    await settle();
    expect(s.states()).toEqual(['connecting']);
  });

  it('close() on an open stream aborts it, reports aborted once, and nothing follows', async () => {
    const bridge = new FakeBridge();
    const s = start(bridge);
    await settle();
    bridge.wire.send(hello(EPOCH, 3));
    await settle();
    s.handle.close();
    s.handle.close();
    expect(s.last()).toEqual({ state: 'closed', reason: 'aborted', error: null });
    expect(bridge.wire.signal.aborted).toBe(true);
    bridge.wire.send(messageEvent(recordedMessage(4)));
    s.clock.advance(10 * 60_000);
    await settle();
    expect(s.messages).toEqual([]);
    expect(s.states()).toEqual(['connecting', 'open', 'closed']);
    expect(bridge.requests).toHaveLength(1);
  });

  it('close() while waiting to reconnect cancels the reconnect', async () => {
    const bridge = new FakeBridge();
    bridge.refuse(new NetworkError('down'));
    const s = start(bridge);
    await settle();
    expect(s.clock.scheduled).toBe(1);
    s.handle.close();
    expect(s.clock.scheduled).toBe(0);
    s.clock.advance(60_000);
    await settle();
    expect(bridge.requests).toHaveLength(1);
  });

  it('close() before it starts means no request at all', async () => {
    const bridge = new FakeBridge();
    const s = start(bridge);
    s.handle.close();
    await settle();
    expect(bridge.requests).toHaveLength(0);
    expect(s.states()).toEqual(['closed']);
  });

  it('close() from inside onMessage stops delivery at once', async () => {
    const bridge = new FakeBridge();
    const seen: number[] = [];
    let close = (): void => undefined;
    const s = start(bridge, {
      onMessage: (message) => {
        seen.push(message.id);
        close();
      },
    });
    close = () => s.handle.close();
    await settle();
    bridge.wire.send(hello(EPOCH, 3) + messageEvent(recordedMessage(4)) + messageEvent(recordedMessage(5)));
    await settle();
    expect(seen).toEqual([4]);
  });

  it('a callback that throws is reported on its own and does not break the stream', async () => {
    const thrown: unknown[] = [];
    const original = globalThis.queueMicrotask;
    vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((callback) => original(() => {
      try {
        callback();
      } catch (error) {
        thrown.push(error);
      }
    }));
    const bridge = new FakeBridge();
    let first = true;
    const seen: number[] = [];
    const s = start(bridge, {
      onMessage: (message) => {
        seen.push(message.id);
        if (first) {
          first = false;
          throw new Error('a view bug');
        }
      },
    });
    await settle();
    bridge.wire.send(hello(EPOCH, 3) + messageEvent(recordedMessage(4)) + messageEvent(recordedMessage(5)));
    await settle();
    expect(seen).toEqual([4, 5]);
    expect(thrown).toHaveLength(1);
    expect(s.last()?.state).toBe('open');
    expect(bridge.requests).toHaveLength(1);
  });
});
