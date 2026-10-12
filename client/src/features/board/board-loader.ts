// Fetches one repository's board and keeps it fresh. Plain TypeScript with no Preact, so the timing
// rules can be read, and tested, apart from the rendering:
//   - one request at a time: Refresh while a request is in flight joins it;
//   - a one-shot timer, armed again after each answer, never while a request is out;
//   - no automatic request while the document is hidden, the first load included;
//   - when the document becomes visible again the board is fetched at once if it is a full
//     interval old, and left alone if it is fresher.
// All timing goes through the injected Clock.
import type { Api } from '../../api/client';
import type { Clock } from '../../api/clock';
import type { Board } from '../../api/types';
import { BOARD_TEXT } from './board-text';

/** How often a visible board refreshes itself (the plan's T6 brief). */
export const REFRESH_INTERVAL_MS = 15_000;

// The browser's own names: the event the document fires when its tab is shown or hidden, and the one
// state of `document.visibilityState` in which the page is on screen (the others are "hidden" and,
// before a page is shown for the first time, "prerender").
const VISIBILITY_EVENT = 'visibilitychange';
const VISIBLE: DocumentVisibilityState = 'visible';

export type BoardState =
  /** Nothing to show yet: the first request for this repository is out, or waiting for the page to be visible. */
  | { readonly phase: 'loading' }
  /** The first request failed and there is nothing older to show. */
  | { readonly phase: 'failed'; readonly message: string }
  /**
   * `board` is the newest answer received, `loadedAt` when it arrived (clock time). `refreshError` is
   * set when a later request failed: the old board stays on screen and says so.
   */
  | { readonly phase: 'ready'; readonly board: Board; readonly loadedAt: number; readonly refreshError: string | null };

export const LOADING: BoardState = { phase: 'loading' };

export interface BoardLoaderOptions {
  /** Only the board route is used, so a test can hand in just that. */
  readonly api: Pick<Api, 'board'>;
  readonly repoKey: string;
  readonly clock: Clock;
  /**
   * Called with each new state. `requested` is true when someone pressed Refresh for the request
   * that produced it, so the caller can answer them; background refreshes pass false.
   */
  readonly onState: (state: BoardState, requested: boolean) => void;
}

export interface BoardLoader {
  /** The Refresh button: starts a request now, or joins the one in flight. Works whether or not the page is visible. */
  refresh(): void;
  /** Cancels the timer and any request in flight and stops listening. Nothing runs afterwards. */
  dispose(): void;
}

export function createBoardLoader({ api, repoKey, clock, onState }: BoardLoaderOptions): BoardLoader {
  let state: BoardState = LOADING;
  let inFlight: AbortController | null = null;
  // Someone pressed Refresh for the request in flight.
  let requested = false;
  let cancelTimer: (() => void) | null = null;
  // When the last request ended, success or failure; null before the first one.
  let finishedAt: number | null = null;
  let disposed = false;

  const isVisible = (): boolean => document.visibilityState === VISIBLE;
  const isDue = (): boolean => finishedAt === null || clock.now() - finishedAt >= REFRESH_INTERVAL_MS;

  function arm(): void {
    cancelTimer?.();
    cancelTimer = clock.schedule(() => {
      cancelTimer = null;
      automatic();
    }, REFRESH_INTERVAL_MS);
  }

  // The first load and every tick of the timer. While the page is hidden nothing is requested and the
  // timer is armed again, so the check repeats; becoming visible does not wait for it (below).
  function automatic(): void {
    if (isVisible()) start(false);
    else arm();
  }

  function start(byHand: boolean): void {
    if (disposed) return;
    if (inFlight) {
      requested ||= byHand;
      return;
    }
    cancelTimer?.();
    cancelTimer = null;
    const controller = new AbortController();
    inFlight = controller;
    requested = byHand;
    // `async` turns an `api.board` that throws instead of rejecting into a rejection, too.
    void (async () => api.board(repoKey, { signal: controller.signal }))().then(
      (board) => finish(controller, { phase: 'ready', board, loadedAt: clock.now(), refreshError: null }),
      (failure: unknown) => finish(controller, failedState(failure)),
    );
  }

  function failedState(failure: unknown): BoardState {
    const message = failure instanceof Error && failure.message !== '' ? failure.message : BOARD_TEXT.unexpectedFailure;
    return state.phase === 'ready' ? { ...state, refreshError: message } : { phase: 'failed', message };
  }

  function finish(controller: AbortController, next: BoardState): void {
    // Disposed, or not the request this loader is waiting for: the answer is of no interest.
    if (disposed || inFlight !== controller) return;
    inFlight = null;
    finishedAt = clock.now();
    state = next;
    const byHand = requested;
    requested = false;
    // Armed before the listener runs, so a listener that throws cannot stop the refreshing.
    arm();
    onState(next, byHand);
  }

  function onVisibilityChange(): void {
    if (disposed || inFlight || !isVisible() || !isDue()) return;
    start(false);
  }

  document.addEventListener(VISIBILITY_EVENT, onVisibilityChange);
  automatic();

  return {
    refresh: () => start(true),
    dispose() {
      disposed = true;
      document.removeEventListener(VISIBILITY_EVENT, onVisibilityChange);
      cancelTimer?.();
      cancelTimer = null;
      inFlight?.abort();
      inFlight = null;
    },
  };
}
