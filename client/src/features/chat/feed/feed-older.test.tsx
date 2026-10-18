// V5 finding 5, in the feed. One press of "Load older messages" in a direct message conversation keeps looking
// (state/repo-sync.ts) until a message of it was added, the history ends, or the bound is reached. While it looks
// the button says so, and when it gives up the feed says how far it looked and leaves the button where it is.
// The words are written out as the finding fixes them, not read from the component's constants.
import { screen, within } from '@testing-library/dom';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '../../../../test/render';
import { createFakeStore, type FakeStore } from '../../../state/fake';
import type { OlderResult } from '../../../state/types';
import { setupUser } from '../../shell/test-utils';
import { Feed } from './feed';
import { Live, clockAfterRecordings, installFakeLayout, type FakeLayout } from './test-harness';

const LOOKED_BACK_10 = 'Looked back 10 messages and found none of this conversation. Press Load older messages to look further.';
const LOADING = 'Loading older messages...';
const BUTTON = { name: 'Load older messages' } as const;

function renderFeed(store: FakeStore): HTMLElement {
  render(<Live store={store} view={(snapshot) => <Feed snapshot={snapshot} store={store} timeZone="UTC" />} />);
  return screen.getByRole('log', { name: 'Messages' });
}

function openDm(store: FakeStore, label: string): void {
  const conversation = store.getSnapshot().conversations.find((c) => c.label === label);
  if (!conversation) throw new Error(`no conversation "${label}"`);
  act(() => store.selectConversation(conversation.id));
}

/** The line beside the button that says what a press is doing or did; outside the log, so the log's content does not move. */
function olderStatus(): HTMLElement {
  const status = document.querySelector<HTMLElement>('.feed__older-status');
  if (!status) throw new Error('no older-messages status line');
  return status;
}

const bodies = (log: HTMLElement): Array<string | null | undefined> =>
  within(log).queryAllByRole('article').map((article) => article.querySelector('.message__body')?.textContent);

let layout: FakeLayout | null = null;
afterEach(() => {
  layout?.uninstall();
  layout = null;
  vi.restoreAllMocks();
});

describe('one press in a direct message conversation', () => {
  it('shows the DM\'s older messages: the press does not stop at a page of other conversations', async () => {
    const user = setupUser();
    const store = createFakeStore({ as: 'thom', pageSize: 2 });
    const log = renderFeed(store);
    openDm(store, 'DM with mira');
    expect(bodies(log)).toEqual([]);
    await user.click(screen.getByRole('button', BUTTON));
    // Four pages of two stand between the newest page and these two.
    expect(bodies(log)).toEqual(['sure, sending the details privately', 'thanks!']);
  });

  it('does the same for the admin\'s observed pair', async () => {
    const user = setupUser();
    const store = createFakeStore({ as: 'flan', pageSize: 2 });
    const log = renderFeed(store);
    openDm(store, 'DM mira to thom');
    await user.click(screen.getByRole('button', BUTTON));
    expect(bodies(log)).toEqual(['sure, sending the details privately', 'thanks!']);
  });

  it('keeps the reader on the message they were reading while pages are skipped, however many there are', async () => {
    layout = installFakeLayout({ viewport: 80 });
    const user = setupUser();
    const store = createFakeStore({ as: 'thom', lastReadId: 100, pageSize: 2, clock: clockAfterRecordings() });
    const log = renderFeed(store);
    act(() => {
      store.receive({ from: 'mira', to: 'thom', body: 'a new word in an old DM' });
    });
    openDm(store, 'DM with mira');
    const reading = within(log).getByText('a new word in an old DM').closest('article');
    if (!reading) throw new Error('no article');
    const before = layout.offsetInView(log, reading);
    await user.click(screen.getByRole('button', BUTTON));
    expect(bodies(log)).toEqual(['sure, sending the details privately', 'thanks!', 'a new word in an old DM']);
    const after = within(log).getByText('a new word in an old DM').closest('article');
    if (!after) throw new Error('no article');
    expect(layout.offsetInView(log, after)).toBe(before);
  });

  describe('while it looks', () => {
    /** Every press waits until `release()`, so the test decides when it ends. */
    function holdPress(store: FakeStore) {
      let answer: (result: OlderResult) => void = () => undefined;
      const spy = vi.spyOn(store, 'loadOlder').mockImplementation(
        () =>
          new Promise<OlderResult>((resolve) => {
            answer = resolve;
          }),
      );
      return {
        spy,
        async release(): Promise<void> {
          await act(async () => {
            answer({ lookedBack: null });
            // A task boundary, so every promise callback queued by the settled press has run.
            await new Promise((resolve) => setTimeout(resolve, 0));
          });
        },
      };
    }

    it('marks the button busy and tells a screen reader in the status line, with no visible words that could move the log, and cannot be pressed again', async () => {
      const user = setupUser();
      const store = createFakeStore({ as: 'thom', pageSize: 2 });
      renderFeed(store);
      openDm(store, 'DM with mira');
      const { release, spy } = holdPress(store);
      const button = screen.getByRole('button', BUTTON);
      expect(button.hasAttribute('aria-busy')).toBe(false);
      await user.click(button);
      await user.click(button);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(button.getAttribute('aria-busy')).toBe('true');
      expect(button.getAttribute('aria-disabled')).toBe('true');
      expect(button.textContent).toBe('Load older messages');
      // The words are there for a screen reader only: a visible line beside the button would wrap under it on a
      // narrow screen, and the log would move down and back up around the press.
      expect(olderStatus().textContent).toBe(LOADING);
      expect([...olderStatus().children].map((child) => child.className)).toEqual(['visually-hidden']);
      expect(olderStatus().getAttribute('role')).toBe('status');
      await release();
      expect(button.hasAttribute('aria-busy')).toBe(false);
      expect(button.hasAttribute('aria-disabled')).toBe(false);
      expect(olderStatus().textContent).toBe('');
    });

    it('says nothing in the status line for #chat\'s press, which is one page and over at once', async () => {
      const user = setupUser();
      const store = createFakeStore({ as: 'thom', lastReadId: 100, pageSize: 5 });
      renderFeed(store);
      const { release } = holdPress(store);
      const button = screen.getByRole('button', BUTTON);
      await user.click(button);
      expect(button.getAttribute('aria-busy')).toBe('true');
      expect(olderStatus().textContent).toBe('');
      await release();
      expect(button.hasAttribute('aria-busy')).toBe(false);
    });
  });

  describe('when it gives up at its bound', () => {
    // flan pageSize 1: his DM with codex is 15 and 16, found on the first press; the ten pages after that
    // (14 down to 4) hold none of it, and 3, 2 and 1 are the history's end.
    async function pressTwice(): Promise<{ readonly store: FakeStore; readonly log: HTMLElement; readonly user: ReturnType<typeof setupUser> }> {
      const user = setupUser();
      const store = createFakeStore({ as: 'flan', pageSize: 1 });
      const log = renderFeed(store);
      openDm(store, 'DM with codex');
      await user.click(screen.getByRole('button', BUTTON));
      await user.click(screen.getByRole('button', BUTTON));
      return { store, log, user };
    }

    it('says how far it looked, in the feed\'s status style and outside the log, and leaves the button where it is', async () => {
      const { log } = await pressTwice();
      expect(olderStatus().textContent).toBe(LOOKED_BACK_10);
      expect(olderStatus().classList.contains('feed__status')).toBe(true);
      expect(olderStatus().getAttribute('role')).toBe('status');
      expect(log.contains(olderStatus())).toBe(false);
      expect(log.textContent).not.toContain('Looked back');
      // The DM still shows what it had, and the button is there to look further.
      expect(bodies(log)).toHaveLength(2);
      expect(screen.getByRole('button', BUTTON).hasAttribute('aria-disabled')).toBe(false);
    });

    it('goes at the next press, and is not said when that press reaches the end of the history: the button goes', async () => {
      const { user } = await pressTwice();
      await user.click(screen.getByRole('button', BUTTON));
      expect(screen.queryByRole('button', BUTTON)).toBeNull();
      expect(document.querySelector('.feed__older-status')).toBeNull();
      expect(document.body.textContent).not.toContain('Looked back');
    });

    it('goes when another conversation is opened, and does not come back with the first', async () => {
      const { store } = await pressTwice();
      openDm(store, 'DM codex to thom');
      expect(olderStatus().textContent).toBe('');
      openDm(store, 'DM with codex');
      expect(olderStatus().textContent).toBe('');
    });

    it('is not said after a press that found a message of the conversation', async () => {
      const user = setupUser();
      const store = createFakeStore({ as: 'flan', pageSize: 1 });
      renderFeed(store);
      openDm(store, 'DM mira to thom');
      await user.click(screen.getByRole('button', BUTTON));
      expect(olderStatus().textContent).toBe('');
    });
  });
});
