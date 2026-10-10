// @vitest-environment node
// The SSE parser against the raw bytes the real bridge sent (client/test/fixtures/sse), cut at
// every possible place, and against the parts of the format the bridge does not use yet.
import { describe, expect, it } from 'vitest';
import { body, streamBytes } from '../../test/fixtures/recorded';
import { parseMessagesPage } from './guards';
import { SseParser, type SseEvent } from './sse';

interface Parsed {
  events: SseEvent[];
  retries: number[];
}

function parse(chunks: Iterable<Uint8Array>, end = true): Parsed {
  const parsed: Parsed = { events: [], retries: [] };
  const parser = new SseParser({
    onEvent: (event) => parsed.events.push(event),
    onRetry: (ms) => parsed.retries.push(ms),
  });
  for (const chunk of chunks) parser.push(chunk);
  if (end) parser.end();
  return parsed;
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const whole = (text: string): Parsed => parse([bytes(text)]);

/** Cuts `data` at the given offsets. */
function cut(data: Uint8Array, at: readonly number[]): Uint8Array[] {
  const edges = [0, ...at, data.length];
  return edges.slice(1).map((edge, i) => data.subarray(edges[i] ?? 0, edge));
}

/** A deterministic sequence in [0, 1), so random cuts are the same on every run. */
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

const live = streamBytes('live');
const expected = whole(new TextDecoder().decode(live));

describe('SseParser on the recorded live stream', () => {
  it('reads retry, hello, every message mira may see, and the bye', () => {
    expect(expected.retries).toEqual([2000]);
    expect(expected.events.map((e) => e.type)).toEqual(['hello', ...Array(10).fill('message'), 'bye']);
    const hello = expected.events[0];
    expect(hello?.lastEventId).toBe('');
    // Mira joined at max_id 1; she sees every later message except thom's DM to grace, thom's DM
    // to codex, Chatter's mention copy and flan's DMs to codex.
    const seen = parseMessagesPage(body('messages-mira')).messages.map((m) => m.id).filter((id) => id > 1);
    const ids = expected.events.filter((e) => e.type === 'message').map((e) => Number(e.lastEventId));
    expect(ids).toEqual(seen);
    expect(expected.events.filter((e) => e.type === 'message').map((e) => (JSON.parse(e.data) as { id: number }).id)).toEqual(seen);
    const bye = expected.events.at(-1);
    expect(JSON.parse(bye?.data ?? '')).toEqual({ reason: 'token_rotated' });
    // A bye has no id of its own: it carries the last one the stream set.
    expect(bye?.lastEventId).toBe(String(seen.at(-1)));
  });

  it('keeps multi-byte text intact', () => {
    const unicode = expected.events.map((e) => JSON.parse(e.data) as { body?: string }).find((d) => d.body?.startsWith('ü'));
    expect(unicode?.body).toBe('ünïcödé — 𝄞 multi-byte check');
  });

  it('gives the same events whichever single place the bytes are cut, including inside a character', () => {
    for (let at = 1; at < live.length; at += 1) {
      expect(parse(cut(live, [at]))).toEqual(expected);
    }
  });

  it('gives the same events one byte at a time', () => {
    expect(parse(cut(live, Array.from({ length: live.length - 1 }, (_, i) => i + 1)))).toEqual(expected);
  });

  it('gives the same events for many random cuttings', () => {
    const random = lcg(20261010);
    for (let round = 0; round < 200; round += 1) {
      const at = Array.from({ length: 1 + Math.floor(random() * 12) }, () => 1 + Math.floor(random() * (live.length - 1)));
      expect(parse(cut(live, [...new Set(at)].sort((a, b) => a - b)))).toEqual(expected);
    }
  });

  it('gives the same events with CRLF or lone CR line ends, cut anywhere', () => {
    const text = new TextDecoder().decode(live);
    for (const ending of ['\r\n', '\r']) {
      const converted = bytes(text.replaceAll('\n', ending));
      expect(parse([converted])).toEqual(expected);
      for (let at = 1; at < converted.length; at += 7) expect(parse(cut(converted, [at]))).toEqual(expected);
    }
  });

  it('splits a CRLF across chunks into one line end, not two', () => {
    const parsed = parse([bytes('data: a\r'), bytes('\ndata: b\r'), bytes('\n\r'), bytes('\n')]);
    expect(parsed.events).toEqual([{ type: 'message', data: 'a\nb', lastEventId: '' }]);
  });
});

describe('SseParser on the other recordings', () => {
  it('replays before the hello when resuming', () => {
    const types = whole(new TextDecoder().decode(streamBytes('resume'))).events.map((e) => e.type);
    expect(types.at(-1)).toBe('hello');
    expect(types.slice(0, -1).every((type) => type === 'message')).toBe(true);
  });

  it.each([['revoked', 'revoked'], ['epoch', 'epoch']] as const)('reads the %s bye', (name, reason) => {
    const events = whole(new TextDecoder().decode(streamBytes(name))).events;
    expect(events.map((e) => e.type)).toEqual(['hello', 'bye']);
    expect(JSON.parse(events[1]?.data ?? '')).toEqual({ reason });
  });
});

describe('SseParser on the rest of the format', () => {
  it('joins several data lines with LF and keeps an empty data line', () => {
    expect(whole('data: one\ndata: two\n\n').events[0]?.data).toBe('one\ntwo');
    expect(whole('data\n\n').events[0]?.data).toBe('');
    expect(whole('data:\ndata:\n\n').events[0]?.data).toBe('\n');
  });

  it('strips exactly one space after the colon', () => {
    expect(whole('data:x\n\n').events[0]?.data).toBe('x');
    expect(whole('data:  x\n\n').events[0]?.data).toBe(' x');
  });

  it('ignores comments, even a block of nothing but comments', () => {
    expect(whole(': ping\n\n').events).toEqual([]);
    expect(whole(': a\ndata: x\n: b\n\n').events[0]?.data).toBe('x');
  });

  it('does not dispatch an event without data, and forgets its type', () => {
    expect(whole('event: hello\n\ndata: x\n\n').events).toEqual([{ type: 'message', data: 'x', lastEventId: '' }]);
  });

  it('keeps the last id across events, resets it with an empty id, and ignores an id with NUL', () => {
    const events = whole('id: 7\ndata: a\n\ndata: b\n\nid: 8\u0000\ndata: c\n\nid\ndata: d\n\n').events;
    expect(events.map((e) => e.lastEventId)).toEqual(['7', '7', '7', '']);
  });

  it('reports a valid retry only', () => {
    expect(whole('retry: 1500\n\nretry: 2s\n\nretry: -1\n\n').retries).toEqual([1500]);
  });

  it('ignores fields it does not know', () => {
    expect(whole('foo: bar\ndata: x\n\n').events).toEqual([{ type: 'message', data: 'x', lastEventId: '' }]);
  });

  it('strips a leading byte-order mark, and only the first', () => {
    const parsed = parse([new Uint8Array([0xef, 0xbb, 0xbf]), bytes('data: x\n\n')]);
    expect(parsed.events[0]?.data).toBe('x');
  });

  it('drops an event that the stream ends before completing', () => {
    expect(whole('data: complete\n\ndata: cut off').events.map((e) => e.data)).toEqual(['complete']);
    expect(whole('data: no blank line\n').events).toEqual([]);
  });

  it('delivers nothing after stop(), even later in the same chunk', () => {
    const seen: string[] = [];
    const parser = new SseParser({
      onEvent(event) {
        seen.push(event.data);
        parser.stop();
      },
    });
    parser.push(bytes('data: first\n\ndata: second\n\n'));
    parser.push(bytes('data: third\n\n'));
    expect(seen).toEqual(['first']);
  });
});
