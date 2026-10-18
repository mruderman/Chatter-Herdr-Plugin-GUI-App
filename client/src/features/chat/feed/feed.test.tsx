import { getDefaultNormalizer, screen, within } from '@testing-library/dom';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '../../../../test/render';
import { ManualClock } from '../../../api/clock';
import { createFakeStore, type FakeStore } from '../../../state/fake';
import type { OlderResult, StoreSnapshot } from '../../../state/types';
import { setupUser } from '../../shell/test-utils';
import { Feed } from './feed';
import { Live, clockAfterRecordings, installFakeLayout, scrollLogTo, type FakeLayout } from './test-harness';

// Names, roles and strings are written out as docs/ui-contract.md has them, not read from the
// component's constants, so a changed constant cannot quietly change the contract.

function renderFeed(store: FakeStore, timeZone = 'UTC'): HTMLElement {
  render(<Live store={store} view={(snapshot) => <Feed snapshot={snapshot} store={store} timeZone={timeZone} />} />);
  return screen.getByRole('log', { name: 'Messages' });
}

const exactText = { normalizer: getDefaultNormalizer({ trim: false, collapseWhitespace: false }) };

/** The article holding a body, found by the body's exact text. */
function articleWith(log: HTMLElement, body: string): HTMLElement {
  const article = within(log).getByText(body, exactText).closest('article');
  if (!article) throw new Error(`no article holds "${body}"`);
  return article;
}

const articleNames = (log: HTMLElement): Array<string | null> => within(log).getAllByRole('article').map((article) => article.getAttribute('aria-label'));

/** Whether a message shows its own visible sender and time header. */
function showsHeader(article: HTMLElement, sender: string): boolean {
  const name = within(article).queryByText(sender, { exact: true });
  return name !== null && !name.closest('.visually-hidden');
}

function receiveAll(store: FakeStore, messages: ReadonlyArray<{ from: string; body: string; afterMs: number; to?: string }>): void {
  for (const { from, body, afterMs, to } of messages) {
    act(() => {
      store.clock.advance(afterMs);
      store.receive({ from, body, to });
    });
  }
}

describe('the Messages log (ui-contract sections 3 and 8)', () => {
  it('is a focusable log named "Messages", not live itself, with the id the skip link targets', () => {
    const log = renderFeed(createFakeStore({ as: 'thom' }));
    expect(log.id).toBe('chat-messages');
    expect(log.getAttribute('tabindex')).toBe('0');
    expect(log.getAttribute('aria-live')).toBe('off');
  });

  it('shows the conversation oldest first, one article per message named "{sender} at {HH:MM}"', () => {
    const log = renderFeed(createFakeStore({ as: 'thom', lastReadId: 100 }));
    expect(articleNames(log)).toEqual([
      'flan at 14:06',
      'thom at 14:06',
      'mira at 14:06',
      'flan at 14:06',
      'grace at 14:06',
      'thom at 14:06',
      'flan at 14:06',
      'grace at 14:06',
      'mira at 14:06',
    ]);
    const bodies = within(log)
      .getAllByRole('article')
      .map((article) => article.querySelector('.message__body')?.textContent);
    expect(bodies.slice(0, 3)).toEqual(['setup message', 'hello from thom', 'morning all, @thom can you check the deploy notes?']);
  });

  it('names each article with the local time of the time zone in use', () => {
    const log = renderFeed(createFakeStore({ as: 'thom', lastReadId: 100 }), 'America/New_York');
    expect(articleNames(log)[0]).toBe('flan at 10:06');
  });

  it('puts a <time datetime> with the message time in every article', () => {
    const store = createFakeStore({ as: 'thom', lastReadId: 100 });
    const log = renderFeed(store);
    const created = store.getSnapshot().messages.map((message) => message.created_at);
    const times = within(log)
      .getAllByRole('article')
      .map((article) => article.querySelector('time')?.getAttribute('datetime'));
    expect(times).toEqual(created);
  });

  it.each<[string, Partial<StoreSnapshot>, string]>([
    ['an empty conversation', {}, 'No messages in this conversation yet.'],
    ['an empty conversation with older pages left', { hasMore: true }, 'No recent messages in this conversation.'],
    ['a conversation still loading', { connection: 'syncing' }, 'Loading messages.'],
    ['no open conversation', { selectedConversation: null }, 'No conversation is open.'],
  ])('says so in text: %s', (_state, overrides, text) => {
    const store = createFakeStore({ as: 'thom' });
    render(<Feed snapshot={{ ...store.getSnapshot(), messages: [], newMarkerBeforeId: null, ...overrides }} store={store} />);
    expect(screen.getByRole('log', { name: 'Messages' }).textContent).toBe(text);
  });

  // V5 finding 9: a conversation the bridge lists whose messages are all older than the newest page. The feed has
  // nothing to show, and "No recent messages" does not tell the reader what to do about it.
  describe('a direct message conversation none of whose messages is loaded', () => {
    const OLDER_HINT = 'Its messages are older than the ones loaded. Press Load older messages to bring them in.';
    const openDm = (store: FakeStore, label: string): void => {
      const conversation = store.getSnapshot().conversations.find((c) => c.label === label);
      if (!conversation) throw new Error(`no conversation "${label}"`);
      act(() => store.selectConversation(conversation.id));
    };

    it.each([
      ['a member\'s own DM', 'thom', 'DM with mira'],
      ['an admin\'s observed pair', 'flan', 'DM mira to thom'],
    ] as const)('tells the reader to press "Load older messages", in the feed\'s own status line: %s', (_what, as, label) => {
      const store = createFakeStore({ as, pageSize: 2 });
      const log = renderFeed(store);
      openDm(store, label);
      expect(within(log).queryAllByRole('article')).toEqual([]);
      expect(log.textContent).toBe(OLDER_HINT);
      const status = log.querySelector('.feed__status');
      expect(status?.textContent).toBe(OLDER_HINT);
      expect(status?.tagName).toBe('P');
    });

    it('goes when the messages are paged in', async () => {
      const store = createFakeStore({ as: 'thom', pageSize: 5 });
      const log = renderFeed(store);
      openDm(store, 'DM with mira');
      expect(log.textContent).toBe(OLDER_HINT);
      while (store.getSnapshot().hasMore && store.getSnapshot().messages.length === 0) await act(async () => { await store.loadOlder(); });
      expect(log.textContent).not.toContain('older than the ones loaded');
      expect(within(log).getAllByRole('article').length).toBeGreaterThan(0);
    });

    it('is not said when nothing older exists: the conversation is simply empty', () => {
      const store = createFakeStore({ as: 'thom', pageSize: 2 });
      openDm(store, 'DM with mira');
      render(<Feed snapshot={{ ...store.getSnapshot(), hasMore: false }} store={store} />);
      expect(screen.getByRole('log', { name: 'Messages' }).textContent).toBe('No messages in this conversation yet.');
    });

    it('is not said while the repo loads, and #chat keeps its own words', () => {
      const store = createFakeStore({ as: 'thom', pageSize: 2 });
      openDm(store, 'DM with mira');
      render(<Feed snapshot={{ ...store.getSnapshot(), connection: 'syncing' }} store={store} />);
      expect(screen.getByRole('log', { name: 'Messages' }).textContent).toBe('Loading messages.');
    });

    it('does not replace the words of an empty #chat with older pages left', () => {
      const store = createFakeStore({ as: 'thom' });
      render(<Feed snapshot={{ ...store.getSnapshot(), messages: [], newMarkerBeforeId: null, hasMore: true }} store={store} />);
      expect(screen.getByRole('log', { name: 'Messages' }).textContent).toBe('No recent messages in this conversation.');
    });
  });
});

describe('groups: one header for consecutive messages from one sender within 5 minutes', () => {
  it('shares the header at exactly 5 minutes and starts a new one past it', () => {
    const store = createFakeStore({ as: 'thom', lastReadId: 100, clock: clockAfterRecordings() });
    const log = renderFeed(store);
    // Message times are whole seconds (the bridge writes them so), so "past 5 minutes" is 5:01.
    receiveAll(store, [
      { from: 'mira', body: 'first', afterMs: 0 },
      { from: 'mira', body: 'five minutes on', afterMs: 300_000 },
      { from: 'mira', body: 'five minutes and a second on', afterMs: 301_000 },
    ]);
    const [first, second, third] = ['first', 'five minutes on', 'five minutes and a second on'].map((body) => articleWith(log, body)) as [HTMLElement, HTMLElement, HTMLElement];
    expect(showsHeader(first, 'mira')).toBe(true);
    expect(showsHeader(second, 'mira')).toBe(false);
    expect(showsHeader(third, 'mira')).toBe(true);
    // The article's name carries sender and time for every message, header or not.
    expect([first, second, third].map((article) => article.getAttribute('aria-label'))).toEqual(['mira at 15:00', 'mira at 15:05', 'mira at 15:10']);
    // The grouped message keeps its own <time>, hidden from view because the header above shows the time.
    const hiddenTime = second.querySelector('time');
    expect(hiddenTime?.getAttribute('datetime')).toBe('2026-10-10T15:05:00Z');
    expect(hiddenTime?.classList.contains('visually-hidden')).toBe(true);
  });

  it('starts a new header when another member writes in between', () => {
    const store = createFakeStore({ as: 'thom', lastReadId: 100, clock: clockAfterRecordings() });
    const log = renderFeed(store);
    receiveAll(store, [
      { from: 'mira', body: 'one', afterMs: 0 },
      { from: 'grace', body: 'two', afterMs: 1_000 },
      { from: 'mira', body: 'three', afterMs: 1_000 },
    ]);
    expect(showsHeader(articleWith(log, 'three'), 'mira')).toBe(true);
  });
});

describe('day headings: h3 with the local date, one per local day', () => {
  // 03:59 and 04:01 UTC on 11 October: 23:59 on the 10th and 00:01 on the 11th in New York (EDT).
  function acrossNewYorkMidnight(timeZone: string): HTMLElement {
    const store = createFakeStore({ as: 'thom', lastReadId: 100, clock: new ManualClock(Date.UTC(2026, 9, 11, 3, 59, 0)) });
    const log = renderFeed(store, timeZone);
    receiveAll(store, [
      { from: 'mira', body: 'before midnight', afterMs: 0 },
      { from: 'mira', body: 'after midnight', afterMs: 120_000 },
    ]);
    return log;
  }

  const headings = (log: HTMLElement): Array<string | null> => within(log).getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);

  it('splits at local midnight in New York', () => {
    const log = acrossNewYorkMidnight('America/New_York');
    expect(headings(log)).toEqual(['Saturday, October 10, 2026', 'Sunday, October 11, 2026']);
    const lastDay = within(log).getAllByRole('heading', { level: 3 })[1];
    expect(lastDay?.nextElementSibling).toBe(articleWith(log, 'after midnight'));
    expect(lastDay?.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-11');
    // Across a day heading the same sender gets a new header, two minutes apart or not.
    expect(showsHeader(articleWith(log, 'after midnight'), 'mira')).toBe(true);
  });

  it('splits at local midnight in UTC, which falls elsewhere', () => {
    const log = acrossNewYorkMidnight('UTC');
    expect(headings(log)).toEqual(['Saturday, October 10, 2026', 'Sunday, October 11, 2026']);
    const lastDay = within(log).getAllByRole('heading', { level: 3 })[1];
    expect(lastDay?.nextElementSibling).toBe(articleWith(log, 'before midnight'));
    expect(showsHeader(articleWith(log, 'after midnight'), 'mira')).toBe(false);
  });
});

describe('plain text only (SPEC section 7, ui-contract section 7)', () => {
  const XSS_FLAG = '__chatFeedXss';
  afterEach(() => {
    Reflect.deleteProperty(window, XSS_FLAG);
  });

  it('shows markup, script and URLs in a body as literal text and creates no element from them', () => {
    const store = createFakeStore({ as: 'thom', lastReadId: 100, clock: clockAfterRecordings() });
    const log = renderFeed(store);
    const image = `<img src=x onerror="window.${XSS_FLAG} = 1">`;
    const script = `<script>window.${XSS_FLAG} = 2</script>`;
    receiveAll(store, [
      { from: 'grace', body: image, afterMs: 0 },
      { from: 'grace', body: script, afterMs: 0 },
    ]);
    const recorded = '<b>not bold</b> <script>alert(1)</script> https://example.com/x?y=1&z=2';
    for (const body of [image, script, recorded]) {
      const paragraph = articleWith(log, body).querySelector('.message__body');
      expect(paragraph?.textContent).toBe(body);
      expect(paragraph?.childNodes).toHaveLength(1);
      expect(paragraph?.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    }
    expect(log.querySelectorAll('img, script, b, a, iframe, object, embed')).toHaveLength(0);
    expect(Reflect.get(window, XSS_FLAG)).toBeUndefined();
  });

  it('keeps line breaks and indentation in the text', () => {
    const log = renderFeed(createFakeStore({ as: 'thom', lastReadId: 100 }));
    const body = 'line one\nline two\n  indented';
    expect(articleWith(log, body).querySelector('.message__body')?.textContent).toBe(body);
  });
});

// V5 finding 8. A body written in Hebrew or Arabic was laid out left to right, against the left edge, with its
// closing punctuation at the wrong end. `dir="auto"` has the browser read the direction from the body's first
// strong letter. It goes on the body only: the sender and the time keep the page's direction, so the header and
// the mention bar (a logical `border-inline-start` on the article) sit where they always do.
describe('direction of the text (V5 finding 8)', () => {
  const HEBREW = 'שלום עולם! מה שלומך?';
  const ARABIC = 'مرحبا بالعالم! كيف حالك؟';
  const XSS_FLAG = '__chatFeedDirXss';
  afterEach(() => {
    Reflect.deleteProperty(window, XSS_FLAG);
  });

  it('leaves the direction of every message body to its first strong letter', () => {
    const store = createFakeStore({ as: 'thom', lastReadId: 100, clock: clockAfterRecordings() });
    const log = renderFeed(store);
    receiveAll(store, [
      { from: 'grace', body: HEBREW, afterMs: 0 },
      { from: 'grace', body: ARABIC, afterMs: 0 },
      { from: 'thom', body: 'English first, then עברית', afterMs: 0 },
    ]);
    const bodies = [...log.querySelectorAll('.message__body')];
    expect(bodies.length).toBeGreaterThanOrEqual(12);
    for (const body of bodies) expect(body.getAttribute('dir'), body.textContent ?? '').toBe('auto');
    for (const text of [HEBREW, ARABIC]) expect(articleWith(log, text).querySelector('.message__body')?.getAttribute('dir')).toBe('auto');
  });

  it('puts the direction on the body alone: the article, the sender, the time, the labels and the day heading keep the page\'s', () => {
    const store = createFakeStore({ as: 'thom', lastReadId: 100, clock: clockAfterRecordings() });
    const log = renderFeed(store);
    receiveAll(store, [{ from: 'grace', body: HEBREW, afterMs: 0 }]);
    const article = articleWith(log, HEBREW);
    const withDir = [...log.querySelectorAll('[dir]')];
    expect(withDir.length).toBeGreaterThan(0);
    for (const element of withDir) expect(element.classList.contains('message__body'), element.outerHTML).toBe(true);
    expect(article.hasAttribute('dir')).toBe(false);
    expect(log.hasAttribute('dir')).toBe(false);
    expect(within(log).getAllByRole('heading', { level: 3 }).every((heading) => !heading.hasAttribute('dir'))).toBe(true);
  });

  it('keeps each body one plain text node: Hebrew, and markup that would run a script if it were one', () => {
    const store = createFakeStore({ as: 'thom', lastReadId: 100, clock: clockAfterRecordings() });
    const log = renderFeed(store);
    const image = `<img src=x onerror="window.${XSS_FLAG} = 1">`;
    receiveAll(store, [
      { from: 'grace', body: HEBREW, afterMs: 0 },
      { from: 'grace', body: image, afterMs: 0 },
    ]);
    for (const text of [HEBREW, image]) {
      const paragraph = articleWith(log, text).querySelector('.message__body');
      expect(paragraph?.getAttribute('dir')).toBe('auto');
      expect(paragraph?.textContent).toBe(text);
      expect(paragraph?.childNodes).toHaveLength(1);
      expect(paragraph?.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    }
    expect(log.querySelectorAll('img, script, b, a, iframe, object, embed')).toHaveLength(0);
    expect(Reflect.get(window, XSS_FLAG)).toBeUndefined();
  });
});

describe('the "New messages" marker', () => {
  const MARKED = '@everyone standup in five';

  it('goes once, straight before the first message past the read pointer', () => {
    // mira's read pointer is at 5, so in #chat the first unread message is 7, "@everyone standup in five".
    const log = renderFeed(createFakeStore({ as: 'mira' }));
    const markers = within(log).getAllByRole('separator', { name: 'New messages' });
    expect(markers).toHaveLength(1);
    expect(markers[0]?.textContent).toBe('New messages');
    expect(markers[0]?.nextElementSibling).toBe(articleWith(log, MARKED));
  });

  it('stays where it was when later messages arrive', () => {
    const store = createFakeStore({ as: 'mira', clock: clockAfterRecordings() });
    const log = renderFeed(store);
    receiveAll(store, [
      { from: 'thom', body: 'later one', afterMs: 1_000 },
      { from: 'flan', body: 'later two', afterMs: 1_000 },
    ]);
    const markers = within(log).getAllByRole('separator', { name: 'New messages' });
    expect(markers).toHaveLength(1);
    expect(markers[0]?.nextElementSibling).toBe(articleWith(log, MARKED));
  });

  it('is absent when nothing was unread when the conversation opened', () => {
    const log = renderFeed(createFakeStore({ as: 'thom', lastReadId: 100 }));
    expect(within(log).queryByRole('separator')).toBeNull();
  });
});

describe('labels: "Mentions you", "Direct message", "Admin view"', () => {
  const labelsIn = (article: HTMLElement): string[] =>
    ['Mentions you', 'Direct message', 'Admin view'].filter((label) => within(article).queryByText(label, { exact: true }) !== null);

  it('"Mentions you" on a mention of the member and on @everyone, nothing on a mention of someone else', () => {
    const log = renderFeed(createFakeStore({ as: 'thom', lastReadId: 100 }));
    expect(labelsIn(articleWith(log, 'morning all, @thom can you check the deploy notes?'))).toEqual(['Mentions you']);
    expect(labelsIn(articleWith(log, '@everyone standup in five'))).toEqual(['Mentions you']);
    expect(labelsIn(articleWith(log, '@codex can you summarise the open questions?'))).toEqual([]);
    expect(labelsIn(articleWith(log, 'setup message'))).toEqual([]);
  });

  it('marks a mention with a highlight as well as the label', () => {
    const log = renderFeed(createFakeStore({ as: 'thom', lastReadId: 100 }));
    expect(articleWith(log, '@everyone standup in five').classList.contains('message--mentions-you')).toBe(true);
    expect(articleWith(log, 'setup message').classList.contains('message--mentions-you')).toBe(false);
  });

  it('"Direct message" on every message of the member\'s DM', () => {
    const store = createFakeStore({ as: 'thom', lastReadId: 100 });
    const dm = store.getSnapshot().conversations.find((conversation) => conversation.label === 'DM with mira');
    act(() => store.selectConversation(dm?.id ?? ''));
    const log = renderFeed(store);
    const all = within(log).getAllByRole('article');
    expect(all).toHaveLength(2);
    for (const article of all) expect(labelsIn(article)).toEqual(['Direct message']);
  });

  it('"Admin view" on every message of a DM between two others, seen by the admin', () => {
    const store = createFakeStore({ as: 'flan', lastReadId: 100 });
    const observed = store.getSnapshot().conversations.find((conversation) => conversation.label === 'DM mira to thom');
    act(() => store.selectConversation(observed?.id ?? ''));
    const log = renderFeed(store);
    const all = within(log).getAllByRole('article');
    expect(all).toHaveLength(2);
    for (const article of all) expect(labelsIn(article)).toEqual(['Admin view']);
  });
});

describe('"Load older messages"', () => {
  it('shows only while the store has more, and each press loads the next page', async () => {
    const user = setupUser();
    const store = createFakeStore({ as: 'thom', lastReadId: 100, pageSize: 5 });
    const loadOlder = vi.spyOn(store, 'loadOlder');
    const log = renderFeed(store);
    expect(within(log).queryByText('@everyone standup in five', { exact: true })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Load older messages' }));
    expect(loadOlder).toHaveBeenCalledTimes(1);
    expect(within(log).getByText('@everyone standup in five', { exact: true })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Load older messages' }));
    expect(within(log).getByText('setup message', { exact: true })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load older messages' })).toBeNull();
  });

  it('is absent when everything is loaded', () => {
    renderFeed(createFakeStore({ as: 'thom' }));
    expect(screen.queryByRole('button', { name: 'Load older messages' })).toBeNull();
  });

  it('sends one request however often it is pressed while a page loads, and says it is busy', async () => {
    const user = setupUser();
    const store = createFakeStore({ as: 'thom', lastReadId: 100, pageSize: 5 });
    let finish: () => void = () => undefined;
    const loadOlder = vi.spyOn(store, 'loadOlder').mockImplementation(
      () =>
        new Promise<OlderResult>((resolve) => {
          finish = () => resolve({ lookedBack: null });
        }),
    );
    renderFeed(store);
    const button = screen.getByRole('button', { name: 'Load older messages' });
    await user.click(button);
    await user.click(button);
    expect(loadOlder).toHaveBeenCalledTimes(1);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await act(async () => {
      finish();
      // A task boundary, so every promise callback queued by the settled request has run.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(button.hasAttribute('aria-disabled')).toBe(false);
    await user.click(button);
    expect(loadOlder).toHaveBeenCalledTimes(2);
  });

  it('hands focus to the log when the last page arrives and the button goes', async () => {
    const user = setupUser();
    const log = renderFeed(createFakeStore({ as: 'thom', lastReadId: 100, pageSize: 10 }));
    screen.getByRole('button', { name: 'Load older messages' }).focus();
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('button', { name: 'Load older messages' })).toBeNull();
    expect(document.activeElement).toBe(log);
  });

  describe('keeps the reader on the message they were reading (mock scroll metrics)', () => {
    let layout: FakeLayout;
    afterEach(() => layout.uninstall());

    it.each([
      ['at the top of the log', 0],
      ['part way into the first message', 20],
    ])('%s', async (_where, scrollTop) => {
      layout = installFakeLayout();
      const user = setupUser();
      // Five of thom's newest messages are loaded, all in #chat: 9, 11, 12, 13 and 14. The next page adds 7.
      const log = renderFeed(createFakeStore({ as: 'thom', lastReadId: 100, pageSize: 5 }));
      scrollLogTo(log, scrollTop);
      const reading = articleWith(log, '@codex can you summarise the open questions?');
      const before = layout.offsetInView(log, reading);
      await user.click(screen.getByRole('button', { name: 'Load older messages' }));
      expect(within(log).getByText('@everyone standup in five', { exact: true })).toBeTruthy();
      expect(layout.offsetInView(log, articleWith(log, '@codex can you summarise the open questions?'))).toBe(before);
      expect(log.scrollTop).toBe(scrollTop + layout.row);
    });
  });
});
