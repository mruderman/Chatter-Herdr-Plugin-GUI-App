import { screen, within } from '@testing-library/dom';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '../../../../test/render';
import { ManualClock } from '../../../api/clock';
import { createFakeStore, type FakeStore } from '../../../state/fake';
import '../../shell/test-utils';
import { Feed } from './feed';
import { Live, clockAfterRecordings, installFakeLayout, scrollLogTo, type FakeLayout } from './test-harness';

// Plan T8a, "Reading position", against a fake layout: the log shows 200 px and every heading,
// separator and message in it is 40 px tall (test-harness.tsx). Timers are Vitest's fakes, so the
// 500 ms debounce of markRead is stepped through exactly.

let layout: FakeLayout;
let visibility: DocumentVisibilityState = 'visible';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  layout = installFakeLayout();
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(document, 'visibilityState');
  layout.uninstall();
  vi.useRealTimers();
});

function open(store: FakeStore): HTMLElement {
  render(<Live store={store} view={(snapshot) => <Feed snapshot={snapshot} store={store} timeZone="UTC" />} />);
  return screen.getByRole('log', { name: 'Messages' });
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function receive(store: FakeStore, count = 1): void {
  for (let index = 0; index < count; index += 1) {
    act(() => {
      store.receive({ from: 'mira', body: `arrival ${index}` });
    });
  }
}

function setVisibility(state: DocumentVisibilityState): void {
  visibility = state;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

function select(store: FakeStore, label: string): void {
  const conversation = store.getSnapshot().conversations.find((candidate) => candidate.label === label);
  if (!conversation) throw new Error(`no conversation "${label}"`);
  act(() => store.selectConversation(conversation.id));
}

const REPO = 'repo-c522d9cf';

describe('where a conversation opens', () => {
  it('at the bottom when nothing in it is unread', () => {
    // thom's #chat: a day heading and nine messages, 400 px in a 200 px view.
    const log = open(createFakeStore({ as: 'thom', lastReadId: 100 }));
    expect(log.scrollTop).toBe(200);
    expect(log.scrollTop).toBe(layout.maxScroll(log));
  });

  it('with the "New messages" separator at the top of the view', () => {
    const log = open(createFakeStore({ as: 'mira' }));
    const marker = within(log).getByRole('separator', { name: 'New messages' });
    expect(layout.offsetInView(log, marker)).toBe(0);
    expect(log.scrollTop).toBeLessThan(layout.maxScroll(log));
  });

  it('with the day heading above the separator in view when the first unread message starts a new day', () => {
    // Everything recorded is read (pointer 14); seven messages arrive the next day, then #chat is opened again.
    const store = createFakeStore({ as: 'thom', lastReadId: 14, clock: new ManualClock(Date.UTC(2026, 9, 11, 9, 0, 0)) });
    open(store);
    receive(store, 7);
    select(store, 'DM with mira');
    select(store, '#chat');
    const log = screen.getByRole('log', { name: 'Messages' });
    const day = within(log).getByRole('heading', { level: 3, name: 'Sunday, October 11, 2026' });
    expect(layout.offsetInView(log, day)).toBe(0);
    expect(layout.offsetInView(log, within(log).getByRole('separator', { name: 'New messages' }))).toBe(layout.row);
  });

  it('afresh each time a conversation is opened', () => {
    const store = createFakeStore({ as: 'thom', lastReadId: 100 });
    const log = open(store);
    scrollLogTo(log, 0);
    select(store, 'DM with mira');
    select(store, '#chat');
    expect(log.scrollTop).toBe(layout.maxScroll(log));
  });
});

describe('new messages', () => {
  it('keep a reader who was at the bottom at the bottom', () => {
    const store = createFakeStore({ as: 'thom', lastReadId: 100, clock: clockAfterRecordings() });
    const log = open(store);
    receive(store, 2);
    expect(log.scrollTop).toBe(280);
    expect(log.scrollTop).toBe(layout.maxScroll(log));
  });

  it('leave a reader who scrolled up exactly where they were', () => {
    const store = createFakeStore({ as: 'thom', lastReadId: 100, clock: clockAfterRecordings() });
    const log = open(store);
    scrollLogTo(log, 40);
    receive(store, 3);
    expect(log.scrollTop).toBe(40);
  });

  it('leave a reader placed at the marker there', () => {
    const store = createFakeStore({ as: 'mira', clock: clockAfterRecordings() });
    const log = open(store);
    const placed = log.scrollTop;
    receive(store, 3);
    expect(log.scrollTop).toBe(placed);
    expect(layout.offsetInView(log, within(log).getByRole('separator', { name: 'New messages' }))).toBe(0);
  });
});

describe('markRead: debounced 500 ms, only while the page is shown and the newest message is in view', () => {
  it('is called once, 500 ms after a conversation opens with its newest message in view', () => {
    // Only the newest message (14) is unread, so the marker and the bottom are both in view.
    const store = createFakeStore({ as: 'thom', lastReadId: 13 });
    const markRead = vi.spyOn(store, 'markRead');
    const log = open(store);
    expect(within(log).getByRole('separator', { name: 'New messages' })).toBeTruthy();
    advance(499);
    expect(markRead).not.toHaveBeenCalled();
    advance(1);
    expect(markRead).toHaveBeenCalledTimes(1);
    expect(store.readPointer(REPO)).toBe(14);
  });

  it('is not called while the page is hidden, and is called once it is shown again', () => {
    visibility = 'hidden';
    const store = createFakeStore({ as: 'thom', lastReadId: 100 });
    const markRead = vi.spyOn(store, 'markRead');
    open(store);
    advance(1_000);
    expect(markRead).not.toHaveBeenCalled();
    setVisibility('visible');
    advance(500);
    expect(markRead).toHaveBeenCalledTimes(1);
  });

  it('is not called while the newest message is out of view, and is called once the reader scrolls down to it', () => {
    const store = createFakeStore({ as: 'mira' });
    const markRead = vi.spyOn(store, 'markRead');
    const log = open(store);
    advance(1_000);
    expect(markRead).not.toHaveBeenCalled();
    scrollLogTo(log, layout.maxScroll(log));
    advance(500);
    expect(markRead).toHaveBeenCalledTimes(1);
  });

  it('is called for new messages that arrive while the reader is at the bottom of a shown page', () => {
    const store = createFakeStore({ as: 'thom', lastReadId: 100, clock: clockAfterRecordings() });
    const markRead = vi.spyOn(store, 'markRead');
    open(store);
    advance(500);
    expect(markRead).toHaveBeenCalledTimes(1);
    receive(store);
    advance(500);
    expect(markRead).toHaveBeenCalledTimes(2);
  });

  it('is not called for new messages that arrive while the page is hidden', () => {
    const store = createFakeStore({ as: 'thom', lastReadId: 100, clock: clockAfterRecordings() });
    const markRead = vi.spyOn(store, 'markRead');
    open(store);
    advance(500);
    setVisibility('hidden');
    receive(store, 2);
    advance(2_000);
    expect(markRead).toHaveBeenCalledTimes(1);
  });

  it('is not called for new messages that arrive while the reader has scrolled up', () => {
    const store = createFakeStore({ as: 'thom', lastReadId: 100, clock: clockAfterRecordings() });
    const markRead = vi.spyOn(store, 'markRead');
    const log = open(store);
    advance(500);
    scrollLogTo(log, 0);
    receive(store, 2);
    advance(2_000);
    expect(markRead).toHaveBeenCalledTimes(1);
  });

  it('waits for a burst to end: one call, 500 ms after the last arrival', () => {
    const store = createFakeStore({ as: 'thom', lastReadId: 100, clock: clockAfterRecordings() });
    const markRead = vi.spyOn(store, 'markRead');
    open(store);
    advance(500);
    receive(store);
    advance(300);
    receive(store);
    advance(300);
    expect(markRead).toHaveBeenCalledTimes(1);
    advance(200);
    expect(markRead).toHaveBeenCalledTimes(2);
  });

  it('drops a waiting call when the page is hidden before it is due', () => {
    const store = createFakeStore({ as: 'thom', lastReadId: 100 });
    const markRead = vi.spyOn(store, 'markRead');
    open(store);
    advance(200);
    setVisibility('hidden');
    advance(1_000);
    expect(markRead).not.toHaveBeenCalled();
  });

  it('drops a waiting call when the reader scrolls away before it is due', () => {
    const store = createFakeStore({ as: 'thom', lastReadId: 100 });
    const markRead = vi.spyOn(store, 'markRead');
    const log = open(store);
    advance(200);
    scrollLogTo(log, 0);
    advance(1_000);
    expect(markRead).not.toHaveBeenCalled();
  });

  it('sends nothing more when nothing new has arrived since the last call', () => {
    const store = createFakeStore({ as: 'thom', lastReadId: 100 });
    const markRead = vi.spyOn(store, 'markRead');
    const log = open(store);
    advance(500);
    scrollLogTo(log, 0);
    scrollLogTo(log, layout.maxScroll(log));
    setVisibility('visible');
    advance(2_000);
    expect(markRead).toHaveBeenCalledTimes(1);
  });

  it('is never called once the feed has gone', () => {
    const store = createFakeStore({ as: 'thom', lastReadId: 100 });
    const markRead = vi.spyOn(store, 'markRead');
    open(store);
    advance(200);
    cleanup();
    advance(2_000);
    expect(markRead).not.toHaveBeenCalled();
  });
});

// G2 round 4, finding 2. The log is a box inside a page that scrolls, so the log being scrolled to its own
// end says nothing about the browser window: at 200% text on a phone the page can be scrolled until the
// log is entirely above the window. The fake layout puts the log 100 to 300 px down a 768 px window.
describe('markRead: only while the log\'s bottom edge is inside the browser window', () => {
  /** The page scrolled until the whole log is above the window (its bottom at -100). */
  const scrollLogOutOfWindow = (): void => layout.scrollPageTo(layout.top + layout.viewport + 100);

  it('sends nothing for a message that arrives while the log is entirely above the window', () => {
    const store = createFakeStore({ as: 'thom', lastReadId: 100, clock: clockAfterRecordings() });
    const markRead = vi.spyOn(store, 'markRead');
    open(store);
    advance(500);
    expect(markRead).toHaveBeenCalledTimes(1);
    scrollLogOutOfWindow();
    receive(store);
    advance(2_000);
    expect(markRead).toHaveBeenCalledTimes(1);
  });

  it('sends one acknowledgement with the newest id, after the debounce, when a window scroll brings the log back', () => {
    // Everything recorded is read (pointer 14), so the pointer shows which message an acknowledgement reached.
    const store = createFakeStore({ as: 'thom', lastReadId: 14, clock: clockAfterRecordings() });
    const markRead = vi.spyOn(store, 'markRead');
    const log = open(store);
    advance(500);
    scrollLogOutOfWindow();
    receive(store);
    advance(2_000);
    expect(markRead).toHaveBeenCalledTimes(1);
    expect(store.readPointer(REPO)).toBe(14);
    expect(log.scrollTop).toBe(layout.maxScroll(log));
    layout.scrollPageTo(0);
    advance(499);
    expect(markRead).toHaveBeenCalledTimes(1);
    advance(1);
    expect(markRead).toHaveBeenCalledTimes(2);
    const newest = store.getSnapshot().messages.at(-1)?.id;
    expect(newest).toBeGreaterThan(14);
    expect(store.readPointer(REPO)).toBe(newest);
    advance(5_000);
    expect(markRead).toHaveBeenCalledTimes(2);
  });

  it('sends nothing for a conversation that opens with the log below the window, until the page is scrolled to it', () => {
    layout.resizeWindow(250);
    const store = createFakeStore({ as: 'thom', lastReadId: 100 });
    const markRead = vi.spyOn(store, 'markRead');
    open(store);
    advance(2_000);
    expect(markRead).not.toHaveBeenCalled();
    layout.scrollPageTo(100);
    advance(500);
    expect(markRead).toHaveBeenCalledTimes(1);
  });

  it('sends for a log whose top is above the window while its bottom is inside', () => {
    layout.scrollPageTo(150);
    expect(layout.top - layout.pageScroll).toBeLessThan(0);
    const store = createFakeStore({ as: 'thom', lastReadId: 100 });
    const markRead = vi.spyOn(store, 'markRead');
    open(store);
    advance(500);
    expect(markRead).toHaveBeenCalledTimes(1);
  });

  // The log's bottom edge sits at `bottom` in the window (768 px tall); the log is 200 px high.
  it.each([
    { where: 'exactly at the lower edge', bottom: 768, acknowledged: true },
    { where: 'one px below the lower edge', bottom: 769, acknowledged: false },
    { where: 'one px inside the upper edge', bottom: 1, acknowledged: true },
    { where: 'exactly at the upper edge', bottom: 0, acknowledged: false },
  ])('with the bottom edge $where, acknowledging is $acknowledged', ({ bottom, acknowledged }) => {
    layout.scrollPageTo(layout.top + layout.viewport - bottom);
    const store = createFakeStore({ as: 'thom', lastReadId: 100 });
    const markRead = vi.spyOn(store, 'markRead');
    open(store);
    advance(2_000);
    expect(markRead).toHaveBeenCalledTimes(acknowledged ? 1 : 0);
  });

  it('sends when a window resize brings the bottom inside the window', () => {
    layout.resizeWindow(250);
    const store = createFakeStore({ as: 'thom', lastReadId: 100 });
    const markRead = vi.spyOn(store, 'markRead');
    open(store);
    advance(1_000);
    expect(markRead).not.toHaveBeenCalled();
    layout.resizeWindow(400);
    advance(499);
    expect(markRead).not.toHaveBeenCalled();
    advance(1);
    expect(markRead).toHaveBeenCalledTimes(1);
  });

  it('drops a waiting call when the log leaves the window before it is due', () => {
    const store = createFakeStore({ as: 'thom', lastReadId: 100 });
    const markRead = vi.spyOn(store, 'markRead');
    open(store);
    advance(200);
    scrollLogOutOfWindow();
    advance(1_000);
    expect(markRead).not.toHaveBeenCalled();
  });

  it('listens to the window\'s scroll and resize passively, and stops when the feed has gone', () => {
    // Behaviour cannot tell a listener that stays behind from one that was removed: once the feed has gone
    // the log is gone too and the handler returns early. So the calls themselves are what is checked.
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');
    try {
      open(createFakeStore({ as: 'thom', lastReadId: 100 }));
      const listenersFor = (spy: typeof added, type: string): unknown[] => spy.mock.calls.filter(([name]) => name === type).map(([, listener]) => listener);
      for (const type of ['scroll', 'resize']) {
        expect(listenersFor(added, type), type).toHaveLength(1);
        expect(added.mock.calls.find(([name]) => name === type)?.[2], type).toEqual(expect.objectContaining({ passive: true }));
        expect(listenersFor(removed, type), type).toHaveLength(0);
      }
      cleanup();
      for (const type of ['scroll', 'resize']) expect(listenersFor(removed, type), type).toEqual(listenersFor(added, type));
    } finally {
      added.mockRestore();
      removed.mockRestore();
    }
  });
});
