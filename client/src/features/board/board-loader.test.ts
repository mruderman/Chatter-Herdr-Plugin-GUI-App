// The loader on its own, with no rendering: one request at a time, a timer armed after each answer,
// nothing automatic while the document is hidden, and nothing at all after dispose. BoardView's tests
// check the same rules through the page; these pin the edges that are hard to see there.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManualClock } from '../../api/clock';
import type { Board } from '../../api/types';
import { createBoardLoader, REFRESH_INTERVAL_MS, type BoardState } from './board-loader';
import { makeBoard, makeTask, manualApi, recordedBoard, restoreVisibility, settle, setVisibility, type BoardApi } from './board-test-utils';

afterEach(restoreVisibility);

type Emitted = { state: BoardState; requested: boolean };

function start(api: BoardApi, clock = new ManualClock()) {
  const emitted: Emitted[] = [];
  const loader = createBoardLoader({ api, repoKey: 'repo-1', clock, onState: (state, requested) => emitted.push({ state, requested }) });
  return { loader, clock, emitted };
}

const ready = (board: Board, loadedAt: number, refreshError: string | null = null): BoardState => ({ phase: 'ready', board, loadedAt, refreshError });

describe('board loader: requests', () => {
  it('asks for the repository it was made for, with a signal, as soon as it is made', () => {
    const { api, calls } = manualApi();
    start(api);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.repo).toBe('repo-1');
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('reports the answer with the clock time it arrived', async () => {
    const { api, calls } = manualApi();
    const board = recordedBoard();
    const { emitted, clock } = start(api);
    clock.advance(1_234);
    calls[0]?.resolve(board);
    await settle();
    expect(emitted).toEqual([{ state: ready(board, clock.now()), requested: false }]);
  });

  it('turns a failure into text: an Error\'s message, or a plain one for anything else', async () => {
    const { api, calls } = manualApi();
    const { emitted, clock } = start(api);
    calls[0]?.reject(new Error('could not reach the bridge'));
    await settle();
    clock.advance(REFRESH_INTERVAL_MS);
    calls[1]?.reject(42);
    await settle();
    expect(emitted.map((entry) => entry.state)).toEqual([
      { phase: 'failed', message: 'could not reach the bridge' },
      { phase: 'failed', message: 'unexpected error' },
    ]);
  });

  it('treats an api that throws instead of rejecting as a failure', async () => {
    const api: BoardApi = {
      board: () => {
        throw new Error('thrown, not rejected');
      },
    };
    const { emitted } = start(api);
    await settle();
    expect(emitted.map((entry) => entry.state)).toEqual([{ phase: 'failed', message: 'thrown, not rejected' }]);
  });

  it('keeps the last board when a later request fails, and replaces it when one succeeds', async () => {
    const { api, calls } = manualApi();
    const first = makeBoard({ tasks: [makeTask({ title: 'first' })] });
    const second = makeBoard({ tasks: [makeTask({ title: 'second' })] });
    const { emitted, clock } = start(api);
    calls[0]?.resolve(first);
    await settle();
    const loadedAt = clock.now();
    clock.advance(REFRESH_INTERVAL_MS);
    calls[1]?.reject(new Error('down'));
    await settle();
    clock.advance(REFRESH_INTERVAL_MS);
    calls[2]?.resolve(second);
    await settle();
    expect(emitted.map((entry) => entry.state)).toEqual([
      ready(first, loadedAt),
      ready(first, loadedAt, 'down'),
      ready(second, loadedAt + 2 * REFRESH_INTERVAL_MS),
    ]);
  });

  it('never has two requests out at once, however often refresh() is called', async () => {
    const { api, calls } = manualApi();
    const { loader } = start(api);
    loader.refresh();
    loader.refresh();
    loader.refresh();
    expect(calls).toHaveLength(1);
  });

  it('says a request was asked for only when refresh() asked for it, also when it joined one in flight', async () => {
    const { api, calls } = manualApi();
    const { loader, emitted, clock } = start(api);
    calls[0]?.resolve(recordedBoard());
    await settle();
    clock.advance(REFRESH_INTERVAL_MS);
    calls[1]?.resolve(recordedBoard());
    await settle();
    // A background request that someone then pressed Refresh during.
    clock.advance(REFRESH_INTERVAL_MS);
    expect(calls).toHaveLength(3);
    loader.refresh();
    calls[2]?.resolve(recordedBoard());
    await settle();
    // And one the button started itself.
    loader.refresh();
    expect(calls).toHaveLength(4);
    calls[3]?.resolve(recordedBoard());
    await settle();
    expect(emitted.map((entry) => entry.requested)).toEqual([false, false, true, true]);
  });
});

describe('board loader: the timer', () => {
  it('is armed after the answer and not while a request is out', async () => {
    const { api, calls } = manualApi();
    const { clock } = start(api);
    expect(clock.scheduled).toBe(0);
    calls[0]?.resolve(recordedBoard());
    await settle();
    expect(clock.delays).toEqual([REFRESH_INTERVAL_MS]);
    clock.advance(REFRESH_INTERVAL_MS);
    expect(calls).toHaveLength(2);
    expect(clock.scheduled).toBe(0);
  });

  it('is armed after a failure as well', async () => {
    const { api, calls } = manualApi();
    const { clock } = start(api);
    calls[0]?.reject(new Error('down'));
    await settle();
    expect(clock.delays).toEqual([REFRESH_INTERVAL_MS]);
  });

  it('is restarted by Refresh, so the next tick is a full interval after that answer', async () => {
    const { api, calls } = manualApi();
    const { loader, clock } = start(api);
    calls[0]?.resolve(recordedBoard());
    await settle();
    clock.advance(10_000);
    loader.refresh();
    expect(clock.scheduled).toBe(0);
    calls[1]?.resolve(recordedBoard());
    await settle();
    expect(clock.delays).toEqual([REFRESH_INTERVAL_MS]);
  });
});

describe('board loader: the document being hidden', () => {
  it('does not request while hidden, keeps checking, and requests when visible again after an interval', async () => {
    const { api, calls } = manualApi();
    const { clock } = start(api);
    calls[0]?.resolve(recordedBoard());
    await settle();
    setVisibility('hidden');
    clock.advance(5 * REFRESH_INTERVAL_MS);
    expect(calls).toHaveLength(1);
    expect(clock.scheduled).toBe(1);
    setVisibility('visible');
    expect(calls).toHaveLength(2);
  });

  it('does not request on becoming visible when the last answer is younger than an interval', async () => {
    const { api, calls } = manualApi();
    const { clock } = start(api);
    calls[0]?.resolve(recordedBoard());
    await settle();
    clock.advance(REFRESH_INTERVAL_MS - 1);
    // The tick has not come yet; hiding and showing the page must not bring it forward.
    expect(calls).toHaveLength(1);
    setVisibility('hidden');
    setVisibility('visible');
    expect(calls).toHaveLength(1);
  });

  it('does not make its first request while hidden, but does the moment the document is visible', () => {
    setVisibility('hidden');
    const { api, calls } = manualApi();
    const { clock } = start(api);
    clock.advance(3 * REFRESH_INTERVAL_MS);
    expect(calls).toHaveLength(0);
    setVisibility('visible');
    expect(calls).toHaveLength(1);
  });

  it('counts "prerender" and other states that are not "visible" as hidden', () => {
    setVisibility('prerender' as DocumentVisibilityState);
    const { api, calls } = manualApi();
    start(api);
    expect(calls).toHaveLength(0);
  });

  it('still lets Refresh through while hidden: that was someone\'s own request', () => {
    setVisibility('hidden');
    const { api, calls } = manualApi();
    const { loader } = start(api);
    loader.refresh();
    expect(calls).toHaveLength(1);
  });
});

describe('board loader: dispose', () => {
  it('aborts the request in flight, cancels the timer and stops listening for visibility', async () => {
    const { api, calls } = manualApi();
    const { loader, clock } = start(api);
    calls[0]?.resolve(recordedBoard());
    await settle();
    clock.advance(REFRESH_INTERVAL_MS);
    expect(calls).toHaveLength(2);
    loader.dispose();
    expect(calls[1]?.signal?.aborted).toBe(true);
    expect(clock.scheduled).toBe(0);
    setVisibility('hidden');
    setVisibility('visible');
    clock.advance(10 * REFRESH_INTERVAL_MS);
    expect(calls).toHaveLength(2);
  });

  it('cancels a timer that was armed, too', async () => {
    const { api, calls } = manualApi();
    const { loader, clock } = start(api);
    calls[0]?.resolve(recordedBoard());
    await settle();
    expect(clock.scheduled).toBe(1);
    loader.dispose();
    expect(clock.scheduled).toBe(0);
  });

  it('reports nothing after it, not even an answer that was already on its way', async () => {
    const { api, calls } = manualApi({ honorAbort: false });
    const { loader, emitted, clock } = start(api);
    loader.dispose();
    calls[0]?.resolve(recordedBoard());
    await settle();
    expect(emitted).toEqual([]);
    expect(clock.scheduled).toBe(0);
  });

  it('ignores refresh() afterwards', () => {
    const { api, calls } = manualApi();
    const { loader } = start(api);
    loader.dispose();
    loader.refresh();
    expect(calls).toHaveLength(1);
  });

  it('can be called twice', () => {
    const { api } = manualApi();
    const { loader } = start(api);
    loader.dispose();
    expect(() => loader.dispose()).not.toThrow();
  });
});

describe('board loader: it uses the clock it was given and no timer of its own', () => {
  it('never calls setTimeout or setInterval', async () => {
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    const interval = vi.spyOn(globalThis, 'setInterval');
    try {
      const { api, calls } = manualApi();
      const { clock, loader } = start(api);
      calls[0]?.resolve(recordedBoard());
      // Not `settle()`: it uses setTimeout itself. A few microtask turns are enough for the answer to be handled.
      for (let turn = 0; turn < 10 && clock.scheduled === 0; turn += 1) await Promise.resolve();
      // The timer path was really exercised, through the clock.
      expect(clock.scheduled).toBe(1);
      clock.advance(REFRESH_INTERVAL_MS);
      expect(calls).toHaveLength(2);
      loader.dispose();
      expect(timeout).not.toHaveBeenCalled();
      expect(interval).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
      interval.mockRestore();
    }
  });
});
