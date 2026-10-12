// How the Board view refreshes: the Refresh board button, the 15-second timer that runs through the
// injected clock, and what happens when the document is hidden, the repository changes or the view
// goes away. What the view shows is in BoardView.test.tsx.
import { screen } from '@testing-library/dom';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '../../../test/render';
import { ManualClock } from '../../api/clock';
import { setupUser } from '../shell/test-utils';
import { BoardView } from './BoardView';
import { REFRESH_INTERVAL_MS } from './board-loader';
import {
  advance,
  instantApi,
  makeBoard,
  makeTask,
  manualApi,
  recordedBoard,
  rerender,
  restoreVisibility,
  setVisibility,
  settle,
  type BoardApi,
} from './board-test-utils';

afterEach(restoreVisibility);

const REPO = 'repo-c522d9cf';

function view(api: BoardApi, clock: ManualClock, repoKey: string | null = REPO) {
  return (
    <main>
      <BoardView api={api} repoKey={repoKey} clock={clock} timeZone="UTC" />
    </main>
  );
}

const refreshButton = (): HTMLElement => screen.getByRole('button', { name: 'Refresh board' });

/** The off-screen status that says "Board refreshed". */
const refreshedStatus = (): HTMLElement => {
  const status = screen.getAllByRole('status').find((candidate) => candidate.classList.contains('visually-hidden'));
  if (!status) throw new Error('no off-screen status');
  return status;
};

describe('Refresh board: the button', () => {
  it('asks the bridge again for the same repository and shows what comes back', async () => {
    let answer = makeBoard({ tasks: [makeTask({ id: 'TASK-1', title: 'First title' })] });
    const { api, board } = instantApi(() => answer);
    const user = setupUser();
    render(view(api, new ManualClock()));
    await settle();
    expect(screen.getByText('First title')).toBeTruthy();

    answer = makeBoard({ tasks: [makeTask({ id: 'TASK-1', title: 'Second title' })] });
    await user.click(refreshButton());
    await settle();
    expect(board).toHaveBeenCalledTimes(2);
    expect(board.mock.calls.map(([repo]) => repo)).toEqual([REPO, REPO]);
    expect(screen.getByText('Second title')).toBeTruthy();
    expect(screen.queryByText('First title')).toBeNull();
  });

  it('keeps its name and stays usable while a request is out, so the focused button does not flicker for a screen reader', async () => {
    const { api, calls } = manualApi();
    const user = setupUser();
    render(view(api, new ManualClock()));
    calls[0]?.resolve(recordedBoard());
    await settle();
    await user.click(refreshButton());
    expect(calls).toHaveLength(2);
    const button = refreshButton();
    expect(button.textContent).toBe('Refresh board');
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(button.hasAttribute('aria-disabled')).toBe(false);
  });

  it('says "Board refreshed" in a polite status when the answer is back, and again for each press', async () => {
    const { api } = instantApi(() => recordedBoard());
    const user = setupUser();
    render(view(api, new ManualClock()));
    await settle();
    // Nothing yet: loading the page is not a refresh someone asked for.
    expect(refreshedStatus().textContent).toBe('');

    await user.click(refreshButton());
    await settle();
    const first = refreshedStatus().firstElementChild;
    expect(refreshedStatus().textContent).toBe('Board refreshed');

    await user.click(refreshButton());
    await settle();
    // The text is the same, so it is a new element: that is what makes a screen reader say it again.
    expect(refreshedStatus().textContent).toBe('Board refreshed');
    expect(refreshedStatus().firstElementChild).not.toBe(first);
  });

  it('does not announce a refresh that nobody asked for', async () => {
    const { api, board } = instantApi(() => recordedBoard());
    const clock = new ManualClock();
    render(view(api, clock));
    await settle();
    await advance(clock, REFRESH_INTERVAL_MS);
    expect(board).toHaveBeenCalledTimes(2);
    expect(refreshedStatus().textContent).toBe('');
  });

  it('joins a request that is already out instead of sending a second, and still answers the press', async () => {
    const { api, calls } = manualApi();
    const clock = new ManualClock();
    const user = setupUser();
    render(view(api, clock));
    calls[0]?.resolve(recordedBoard());
    await settle();
    await advance(clock, REFRESH_INTERVAL_MS);
    // The timer's request is out; now the button is pressed twice.
    expect(calls).toHaveLength(2);
    await user.click(refreshButton());
    await user.click(refreshButton());
    expect(calls).toHaveLength(2);
    calls[1]?.resolve(recordedBoard());
    await settle();
    expect(refreshedStatus().textContent).toBe('Board refreshed');
  });

  it('shows a failure again as a new element when Refresh was pressed and it failed again, but not for background retries', async () => {
    const { api, calls } = manualApi();
    const clock = new ManualClock();
    const user = setupUser();
    render(view(api, clock));
    calls[0]?.reject(new Error('could not reach the bridge'));
    await settle();
    const first = screen.getByRole('alert');

    // A background retry that fails the same way leaves the alert as it is, so it is not read out again.
    await advance(clock, REFRESH_INTERVAL_MS);
    calls[1]?.reject(new Error('could not reach the bridge'));
    await settle();
    expect(screen.getByRole('alert')).toBe(first);

    // Someone pressed Refresh and it failed again: they are waiting for an answer, so they get one.
    await user.click(refreshButton());
    calls[2]?.reject(new Error('could not reach the bridge'));
    await settle();
    const again = screen.getByRole('alert');
    expect(again).not.toBe(first);
    expect(again.textContent).toBe(first.textContent);
  });

  it('does the same for the warning that sits above an old board', async () => {
    const { api, calls } = manualApi();
    const clock = new ManualClock();
    const user = setupUser();
    render(view(api, clock));
    calls[0]?.resolve(recordedBoard());
    await settle();
    await advance(clock, REFRESH_INTERVAL_MS);
    calls[1]?.reject(new Error('down'));
    await settle();
    const warning = (): HTMLElement | undefined => screen.getAllByRole('status').find((status) => status.textContent?.includes('Could not refresh'));
    const first = warning();
    expect(first).toBeTruthy();

    await user.click(refreshButton());
    calls[2]?.reject(new Error('down'));
    await settle();
    expect(warning()).toBeTruthy();
    expect(warning()).not.toBe(first);
  });

  it('keeps keyboard focus on the button through a refresh', async () => {
    const { api } = instantApi(() => recordedBoard());
    const user = setupUser();
    render(view(api, new ManualClock()));
    await settle();
    await user.tab();
    expect(document.activeElement).toBe(refreshButton());
    await user.keyboard('{Enter}');
    await settle();
    expect(document.activeElement).toBe(refreshButton());
  });

  it('works from the keyboard: Enter and Space both refresh', async () => {
    const { api, board } = instantApi(() => recordedBoard());
    const user = setupUser();
    render(view(api, new ManualClock()));
    await settle();
    await user.tab();
    await user.keyboard('{Enter}');
    await settle();
    expect(board).toHaveBeenCalledTimes(2);
    await user.keyboard(' ');
    await settle();
    expect(board).toHaveBeenCalledTimes(3);
  });
});

describe('the 15-second refresh', () => {
  it('refreshes every 15 seconds while the document is visible, and not before', async () => {
    const { api, board } = instantApi(() => recordedBoard());
    const clock = new ManualClock();
    render(view(api, clock));
    await settle();
    expect(board).toHaveBeenCalledTimes(1);

    await advance(clock, REFRESH_INTERVAL_MS - 1);
    expect(board).toHaveBeenCalledTimes(1);
    await advance(clock, 1);
    expect(board).toHaveBeenCalledTimes(2);
    await advance(clock, REFRESH_INTERVAL_MS - 1);
    expect(board).toHaveBeenCalledTimes(2);
    await advance(clock, 1);
    expect(board).toHaveBeenCalledTimes(3);
  });

  it('is 15 seconds', () => {
    expect(REFRESH_INTERVAL_MS).toBe(15_000);
  });

  it('shows what a refresh brought without anyone pressing anything', async () => {
    let answer = makeBoard({ tasks: [makeTask({ title: 'Before' })] });
    const { api } = instantApi(() => answer);
    const clock = new ManualClock();
    render(view(api, clock));
    await settle();
    answer = makeBoard({ tasks: [makeTask({ title: 'After' })] });
    await advance(clock, REFRESH_INTERVAL_MS);
    expect(screen.getByText('After')).toBeTruthy();
    expect(screen.queryByText('Before')).toBeNull();
  });

  it('counts the interval from the answer, so a slow request is never doubled', async () => {
    const { api, calls } = manualApi();
    const clock = new ManualClock();
    render(view(api, clock));
    await settle();
    expect(calls).toHaveLength(1);
    // Nothing is scheduled while a request is out, however long it takes.
    expect(clock.scheduled).toBe(0);
    await advance(clock, 4 * REFRESH_INTERVAL_MS);
    expect(calls).toHaveLength(1);

    calls[0]?.resolve(recordedBoard());
    await settle();
    expect(clock.delays).toEqual([REFRESH_INTERVAL_MS]);
    await advance(clock, REFRESH_INTERVAL_MS);
    expect(calls).toHaveLength(2);
  });

  it('goes on after a failed refresh', async () => {
    const { api, calls } = manualApi();
    const clock = new ManualClock();
    render(view(api, clock));
    calls[0]?.reject(new Error('could not reach the bridge'));
    await settle();
    await advance(clock, REFRESH_INTERVAL_MS);
    expect(calls).toHaveLength(2);
    calls[1]?.resolve(recordedBoard());
    await settle();
    expect(screen.getByRole('table', { name: 'Tasks' })).toBeTruthy();
  });
});

describe('the 15-second refresh and the document being hidden', () => {
  it('makes no request while the document is hidden, however many intervals pass', async () => {
    const { api, board } = instantApi(() => recordedBoard());
    const clock = new ManualClock();
    render(view(api, clock));
    await settle();
    expect(board).toHaveBeenCalledTimes(1);

    setVisibility('hidden');
    await advance(clock, 10 * REFRESH_INTERVAL_MS);
    expect(board).toHaveBeenCalledTimes(1);
    // The timer keeps ticking, only the request is skipped: the check repeats.
    expect(clock.scheduled).toBe(1);
  });

  it('asks again at once when the document becomes visible after at least one interval', async () => {
    const { api, board } = instantApi(() => recordedBoard());
    const clock = new ManualClock();
    render(view(api, clock));
    await settle();
    setVisibility('hidden');
    await advance(clock, 3 * REFRESH_INTERVAL_MS);
    expect(board).toHaveBeenCalledTimes(1);

    setVisibility('visible');
    await settle();
    expect(board).toHaveBeenCalledTimes(2);
    // And from then on every 15 seconds again.
    await advance(clock, REFRESH_INTERVAL_MS);
    expect(board).toHaveBeenCalledTimes(3);
  });

  it('leaves the board alone when the document comes back sooner than an interval after the last answer', async () => {
    const { api, board } = instantApi(() => recordedBoard());
    const clock = new ManualClock();
    render(view(api, clock));
    await settle();
    await advance(clock, 4_000);
    setVisibility('hidden');
    await advance(clock, 4_000);
    setVisibility('visible');
    await settle();
    expect(board).toHaveBeenCalledTimes(1);
    // The regular tick still comes, 15 seconds after the answer.
    await advance(clock, REFRESH_INTERVAL_MS - 8_000);
    expect(board).toHaveBeenCalledTimes(2);
  });

  it('does not start while the document is hidden at the start, and starts when it becomes visible', async () => {
    setVisibility('hidden');
    const { api, board } = instantApi(() => recordedBoard());
    const clock = new ManualClock();
    render(view(api, clock));
    await settle();
    await advance(clock, 4 * REFRESH_INTERVAL_MS);
    expect(board).not.toHaveBeenCalled();
    expect(screen.getByText('Loading the board')).toBeTruthy();

    setVisibility('visible');
    await settle();
    expect(board).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('table', { name: 'Tasks' })).toBeTruthy();
  });

  it('does not stack a second request when the document becomes visible while one is out', async () => {
    const { api, calls } = manualApi();
    const clock = new ManualClock();
    render(view(api, clock));
    await settle();
    expect(calls).toHaveLength(1);
    setVisibility('hidden');
    setVisibility('visible');
    await settle();
    expect(calls).toHaveLength(1);
  });
});

describe('repository changes and the view going away', () => {
  it('drops the old repository\'s board at once and loads the new one\'s', async () => {
    const { api, calls } = manualApi();
    const clock = new ManualClock();
    const container = render(view(api, clock, 'repo-a'));
    calls[0]?.resolve(makeBoard({ tasks: [makeTask({ title: 'Task of A' })] }));
    await settle();
    expect(screen.getByText('Task of A')).toBeTruthy();

    rerender(container, view(api, clock, 'repo-b'));
    // Before the new answer: no trace of repository A under repository B's name.
    expect(screen.queryByText('Task of A')).toBeNull();
    expect(screen.getByText('Loading the board')).toBeTruthy();
    expect(calls.map((call) => call.repo)).toEqual(['repo-a', 'repo-b']);

    calls[1]?.resolve(makeBoard({ tasks: [makeTask({ title: 'Task of B' })] }));
    await settle();
    expect(screen.getByText('Task of B')).toBeTruthy();
  });

  it('stops the old repository\'s request and its timer', async () => {
    const { api, calls } = manualApi();
    const clock = new ManualClock();
    const container = render(view(api, clock, 'repo-a'));
    await settle();
    expect(calls[0]?.signal?.aborted).toBe(false);
    rerender(container, view(api, clock, 'repo-b'));
    expect(calls[0]?.signal?.aborted).toBe(true);
    // Only the new repository's request is out, so nothing is scheduled.
    expect(clock.scheduled).toBe(0);
  });

  it('never shows a late answer for the repository it left, even from a route that ignores the abort', async () => {
    const { api, calls } = manualApi({ honorAbort: false });
    const clock = new ManualClock();
    const container = render(view(api, clock, 'repo-a'));
    await settle();
    rerender(container, view(api, clock, 'repo-b'));
    calls[0]?.resolve(makeBoard({ tasks: [makeTask({ title: 'Late task of A' })] }));
    await settle();
    expect(screen.queryByText('Late task of A')).toBeNull();
    expect(screen.getByText('Loading the board')).toBeTruthy();
    // And no timer was started for the answer that was thrown away.
    expect(clock.scheduled).toBe(0);
  });

  it('does not restart, or fetch twice, when its parent passes a new api or clock object on every render', async () => {
    const first = instantApi(() => recordedBoard());
    const second = instantApi(() => recordedBoard());
    const clock = new ManualClock();
    const container = render(view(first.api, clock));
    await settle();
    expect(first.board).toHaveBeenCalledTimes(1);

    rerender(container, view({ board: (repo, options) => second.api.board(repo, options) }, clock));
    rerender(container, view({ board: (repo, options) => second.api.board(repo, options) }, clock));
    await settle();
    expect(first.board).toHaveBeenCalledTimes(1);
    expect(second.board).not.toHaveBeenCalled();

    // The next request goes to the api the parent passed last.
    await advance(clock, REFRESH_INTERVAL_MS);
    expect(first.board).toHaveBeenCalledTimes(1);
    expect(second.board).toHaveBeenCalledTimes(1);
  });

  it('shows the no-repository text and stops everything when the repository becomes null', async () => {
    const { api, calls } = manualApi();
    const clock = new ManualClock();
    const container = render(view(api, clock, 'repo-a'));
    await settle();
    rerender(container, view(api, clock, null));
    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(screen.getByText('No repository is selected, so there is no board to show.')).toBeTruthy();
    await advance(clock, 4 * REFRESH_INTERVAL_MS);
    expect(calls).toHaveLength(1);
    expect(clock.scheduled).toBe(0);
  });

  it('cancels the timer and stops listening for visibility when it is removed', async () => {
    const { api, board } = instantApi(() => recordedBoard());
    const clock = new ManualClock();
    render(view(api, clock));
    await settle();
    expect(clock.scheduled).toBe(1);

    cleanup();
    expect(clock.scheduled).toBe(0);
    setVisibility('hidden');
    setVisibility('visible');
    await advance(clock, 4 * REFRESH_INTERVAL_MS);
    expect(board).toHaveBeenCalledTimes(1);
  });

  it('aborts the request in flight when it is removed, and a late answer changes nothing', async () => {
    const { api, calls } = manualApi({ honorAbort: false });
    const clock = new ManualClock();
    const container = render(view(api, clock));
    await settle();
    cleanup();
    expect(calls[0]?.signal?.aborted).toBe(true);
    calls[0]?.resolve(recordedBoard());
    await settle();
    expect(container.isConnected).toBe(false);
    expect(clock.scheduled).toBe(0);
  });

  it('keeps the section headings when only the data changes', async () => {
    let answer = makeBoard();
    const { api } = instantApi(() => answer);
    const clock = new ManualClock();
    render(view(api, clock));
    await settle();
    const headings = screen.getAllByRole('heading', { level: 2 });
    answer = makeBoard({ tasks: [makeTask()] });
    await advance(clock, REFRESH_INTERVAL_MS);
    expect(screen.getByRole('table', { name: 'Tasks' })).toBeTruthy();
    // The same elements, updated in place (compared by identity: toEqual would call two equal nodes equal):
    // focus and the scroll position of a table are not lost to a refresh.
    const after = screen.getAllByRole('heading', { level: 2 });
    expect(after).toHaveLength(headings.length);
    after.forEach((heading, index) => expect(heading).toBe(headings[index]));
  });
});
