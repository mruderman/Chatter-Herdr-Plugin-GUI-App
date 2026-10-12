// The running app as main.tsx puts it together (T10 brief, "Wiring" and "Registry"), over the fake
// store: the shell's props come from the snapshot, the registry's views are the real ones, the Board
// uses the services' Api and clock, and Settings gets the notifier's controls. Names and texts are
// written out as docs/ui-contract.md has them.
import { screen, within } from '@testing-library/dom';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { body } from '../../test/fixtures/recorded';
import { render } from '../../test/render';
import { createApi, type Api } from '../api/client';
import { ManualClock } from '../api/clock';
import { parseBoard } from '../api/guards';
import { createNotifier } from '../features/notify';
import { createThemeManager } from '../features/shell';
import { expectNoAxeViolations, setupUser } from '../features/shell/test-utils';
import { createFakeStore, FAKE_TOKEN, type FakeStore, type FakeStoreOptions } from '../state/fake';
import { AppRoot } from './root';
import type { Services } from './services';

const REPO = 'repo-c522d9cf';
const OTHER_REPO = 'site-24538864';
const BOARD_EVERY_MS = 15_000; // the Board's refresh interval (plan T6)
// After the recorded messages (2026-10-10T14:06:56Z), so a message that arrives now is the newest.
const AFTER_RECORDINGS = Date.UTC(2026, 9, 10, 15, 0, 0);

/** Lets promises settle and Preact render what they caused. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function advance(clock: ManualClock, ms: number): Promise<void> {
  act(() => clock.advance(ms));
  await settle();
}

const made: Services[] = [];
afterEach(() => {
  for (const services of made.splice(0)) services.dispose();
  vi.restoreAllMocks();
});

/** Services over the fake store, as createServices makes them over the real one; only the board route answers. */
function setup(options: FakeStoreOptions = {}) {
  const clock = new ManualClock(AFTER_RECORDINGS);
  const store: FakeStore = createFakeStore({ clock, ...options });
  const board = vi.fn<Api['board']>(async () => parseBoard(body('board')));
  const refuse = async (): Promise<Response> => {
    throw new Error('this test has no network');
  };
  const api: Api = { ...createApi({ getToken: () => null, fetch: refuse }), board };
  const notifier = createNotifier({ store, clock, notificationApi: null, storage: null });
  const services: Services = {
    store,
    api,
    notifier,
    clock,
    dispose() {
      notifier.dispose();
      store.dispose();
    },
  };
  made.push(services);
  const themeManager = createThemeManager({ root: document.documentElement, getStorage: () => null });
  render(<AppRoot services={services} themeManager={themeManager} />);
  return { store, board, clock, user: setupUser() };
}

const heading = (): string | null => screen.getByRole('heading', { level: 1 }).textContent;
const nav = () => within(screen.getByRole('navigation', { name: 'Primary' }));

describe('the session, from the store into the shell', () => {
  it('shows the sign-in form after a plain 401, and the Chat view once the store accepts the token', async () => {
    const { store, user } = setup({ session: 'signed-out' });
    expect(heading()).toBe('Sign in');
    expect(screen.queryByRole('alert')).toBeNull();
    await user.type(screen.getByLabelText('Access token'), `${FAKE_TOKEN}{Enter}`);
    await settle();
    expect(store.getSnapshot().session.status).toBe('signed-in');
    expect(heading()).toBe('Chat');
    expect(screen.getByRole('status', { name: 'Connection' }).textContent).toBe('Online');
    expect(screen.getByText('Thom (thom)')).toBeTruthy();
  });

  it('shows the bridge\'s refusal of a bad token as the sign-in alert', async () => {
    const { user } = setup({ session: 'signed-out' });
    await user.type(screen.getByLabelText('Access token'), 'not-the-token{Enter}');
    await settle();
    expect(screen.getByRole('alert').textContent).toMatch(/^Sign-in failed: \S/);
    expect(heading()).toBe('Sign in');
  });

  it('shows a first-load 403 not_registered with its message, and the form', () => {
    setup({ session: 'not-registered' });
    expect(screen.getByRole('alert').textContent).toBe('Sign-in failed: your Tailscale login is not registered as a member');
    expect(screen.getByLabelText('Access token')).toBeTruthy();
  });

  it('switches the store\'s repository from the header\'s select', async () => {
    const { store, user } = setup();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Repository' }), 'site');
    expect(store.getSnapshot().selectedRepo).toBe(OTHER_REPO);
    expect(within(screen.getByRole('log', { name: 'Messages' })).getByText('site repo kickoff')).toBeTruthy();
  });

  it('does not list Admin for a member', () => {
    setup({ as: 'thom' });
    expect(nav().getAllByRole('button').map((button) => button.textContent)).toEqual(['Chat', 'Board', 'Members']);
  });
});

describe('the registry\'s real views', () => {
  it('Chat: the conversations, the feed, and the composer in ChatView\'s slot', () => {
    setup();
    const main = within(screen.getByRole('main'));
    expect(main.getByRole('navigation', { name: 'Conversations' })).toBeTruthy();
    const log = main.getByRole('log', { name: 'Messages' });
    const composer = main.getByRole('form', { name: 'Message composer' });
    expect(log.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(composer).getByLabelText('Message').id).toBe('chat-message-box');
  });

  it('Chat: a new snapshot updates the feed in place instead of remounting it', () => {
    const { store } = setup();
    const log = screen.getByRole('log', { name: 'Messages' });
    act(() => {
      store.receive({ from: 'grace', body: 'fresh from the stream' });
    });
    expect(screen.getByRole('log', { name: 'Messages' })).toBe(log);
    expect(within(log).getByText('fresh from the stream')).toBeTruthy();
  });

  it('Chat: sends through the store from the composer', async () => {
    const { store, user } = setup();
    await user.type(screen.getByLabelText('Message'), 'hello from the wired app{Enter}');
    expect(store.sent).toEqual([{ to: '#chat', body: 'hello from the wired app' }]);
    expect(within(screen.getByRole('log', { name: 'Messages' })).getByText('hello from the wired app')).toBeTruthy();
  });

  it('Members: the directory the store holds', async () => {
    const { user } = setup();
    await user.click(nav().getByRole('button', { name: 'Members' }));
    expect(heading()).toBe('Members');
    const members = within(screen.getByRole('list', { name: 'Members' }));
    expect(members.getAllByRole('listitem')).toHaveLength(7);
    expect(within(screen.getByRole('list', { name: 'Agents' })).getByText('codex')).toBeTruthy();
  });

  it('Admin: still the placeholder until the admin panel is wired in (T10b)', async () => {
    const { user } = setup({ as: 'flan' });
    await user.click(nav().getByRole('button', { name: 'Admin' }));
    expect(heading()).toBe('Admin');
  });

  it('Board: asks for the selected repository through the services\' Api and refreshes on their clock', async () => {
    const { board, clock, user } = setup();
    await user.click(nav().getByRole('button', { name: 'Board' }));
    await settle();
    expect(heading()).toBe('Board');
    expect(board.mock.calls.map(([repo]) => repo)).toEqual([REPO]);
    expect(screen.getByRole('heading', { level: 2, name: 'Agents' })).toBeTruthy();
    await advance(clock, BOARD_EVERY_MS);
    expect(board).toHaveBeenCalledTimes(2);
  });

  it('Board: asks for nothing more once the bridge has revoked the member', async () => {
    const { store, board, clock, user } = setup();
    await user.click(nav().getByRole('button', { name: 'Board' }));
    await settle();
    await advance(clock, BOARD_EVERY_MS);
    expect(board).toHaveBeenCalledTimes(2);

    act(() => store.setConnection('revoked'));
    await advance(clock, 10 * BOARD_EVERY_MS);
    expect(board).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status', { name: 'Connection' }).textContent).toBe('Access revoked');
    expect(screen.getByText('No repository is selected, so there is no board to show.')).toBeTruthy();
  });

  it.each([
    ['Chat', null],
    ['Board', 'Board'],
    ['Members', 'Members'],
  ])('%s, wired: axe finds no violation in its structure', async (_name, button) => {
    const { user } = setup();
    if (button) await user.click(nav().getByRole('button', { name: button }));
    await settle();
    await expectNoAxeViolations();
  });
});

describe('Settings, with the notifier connected', () => {
  it('shows the notification controls the notifier supplies', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Settings' }));
    expect(dialog.getByRole('button', { name: 'Enable desktop notifications' })).toBeTruthy();
    expect(dialog.getByText('This browser does not support desktop notifications.')).toBeTruthy();
    expect((dialog.getByRole('checkbox', { name: 'Notify me about mentions and direct messages' }) as HTMLInputElement).checked).toBe(true);
  });
});
