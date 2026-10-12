// The notifier against the fake store and a fake Notification (D17 and the T9 brief). Each describe
// block is one rule; the privacy rules (no message text, no prompt on load, the permission only from
// the Settings button) come first among the ones to read.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clock } from '../../api/clock';
import type { Message } from '../../api/types';
import { createFakeStore, type FakeMember, type FakeStore } from '../../state/fake';
import { CHANNEL, type IncomingMessage, type Store, type StoreSnapshot } from '../../state/types';
import { createFakeNotifications } from './fake-notification';
import { NOTIFICATIONS_STORAGE_KEY, NOTIFY_THROTTLE_MS, createNotifier, type NotifierStorage } from './notifier';

class MemoryStorage implements NotifierStorage {
  readonly data = new Map<string, string>();
  /** Every key written, in order: the preference is the only thing the notifier may store. */
  readonly writes: string[] = [];
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.writes.push(key);
    this.data.set(key, value);
  }
}

class BrokenStorage implements NotifierStorage {
  getItem(): string | null {
    throw new DOMException('storage is blocked', 'SecurityError');
  }
  setItem(): void {
    throw new DOMException('storage is full', 'QuotaExceededError');
  }
}

/** Where the person is: the page shown or hidden, the window focused or not. Default: looking at the app. */
function lookAt({ visible = true, focused = true }: { visible?: boolean; focused?: boolean } = {}): void {
  vi.spyOn(document, 'hasFocus').mockReturnValue(focused);
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (visible ? 'visible' : 'hidden') });
}

/** Lets promise callbacks (a permission prompt's answer) run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  lookAt();
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, 'visibilityState');
  window.localStorage.clear();
});

interface SetupOptions {
  readonly as?: FakeMember;
  readonly permission?: NotificationPermission;
  readonly storage?: NotifierStorage | null;
  /**
   * What the shell has told the notifier about the Chat view (T12). Default true: a person who is
   * looking at a conversation has Chat open, so the tests of "already looking" keep their meaning.
   * False is another view (Board, Members, Admin); null is nothing said yet.
   */
  readonly chatOpen?: boolean | null;
}

function setup(options: SetupOptions = {}) {
  const store = createFakeStore({ as: options.as ?? 'thom' });
  const browser = createFakeNotifications(options.permission ?? 'granted');
  const storage = options.storage === undefined ? new MemoryStorage() : options.storage;
  const notifier = createNotifier({ store, clock: store.clock, notificationApi: browser.api, storage });
  if (options.chatOpen !== null) notifier.setChatOpen(options.chatOpen ?? true);
  return { store, browser, notifier };
}

function repoKey(store: Store, label: string): string {
  const found = store.getSnapshot().repos.find((repo) => repo.label === label);
  if (!found) throw new Error(`no repo "${label}"`);
  return found.key;
}

function select(store: Store, label: string): void {
  const found = store.getSnapshot().conversations.find((conversation) => conversation.label === label);
  if (!found) throw new Error(`no conversation "${label}"`);
  store.selectConversation(found.id);
}

const titles = (shown: readonly { readonly title: string }[]): string[] => shown.map((notification) => notification.title);

/**
 * The fake store with its incoming messages and its snapshot under the test's control, for what the
 * fake cannot produce: a store that passes on a member's own message, a signed-out one, a repo it
 * does not list.
 */
function manualStore(base: FakeStore, snapshot: () => StoreSnapshot = () => base.getSnapshot()) {
  const listeners = new Set<(incoming: IncomingMessage) => void>();
  const store: Store = {
    ...base,
    getSnapshot: snapshot,
    onIncoming(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    store,
    listeners,
    emit(incoming: IncomingMessage): void {
      for (const listener of [...listeners]) listener(incoming);
    },
  };
}

function aMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 1,
    from: 'mira',
    to: CHANNEL,
    body: 'hello',
    kind: 'post',
    ref_id: null,
    created_at: '2026-10-10T12:00:00Z',
    mentions: [],
    everyone: false,
    ...overrides,
  };
}

describe('which messages notify (D17)', () => {
  it('notifies for a #chat message that mentions the member by handle', () => {
    lookAt({ focused: false });
    const { store, browser } = setup();
    store.receive({ from: 'mira', body: 'hello @thom' });
    expect(titles(browser.shown)).toEqual(['mira mentioned you']);
  });

  it('notifies for @everyone in #chat', () => {
    lookAt({ focused: false });
    const { store, browser } = setup();
    store.receive({ from: 'flan', body: '@everyone stand-up in five' });
    expect(titles(browser.shown)).toEqual(['flan mentioned you']);
  });

  it('notifies for a direct message addressed to the member', () => {
    lookAt({ focused: false });
    const { store, browser } = setup();
    store.receive({ from: 'mira', to: 'thom', body: 'in private' });
    expect(titles(browser.shown)).toEqual(['mira sent you a direct message']);
  });

  it('says it is a direct message, not a mention, when a DM to the member also mentions them', () => {
    lookAt({ focused: false });
    const { store, browser } = setup();
    store.receive({ from: 'mira', to: 'thom', body: 'psst @thom' });
    expect(titles(browser.shown)).toEqual(['mira sent you a direct message']);
  });

  it('stays quiet for a #chat message that does not mention the member', () => {
    lookAt({ focused: false });
    const { store, browser } = setup();
    store.receive({ from: 'mira', body: 'good morning everybody' });
    store.receive({ from: 'grace', body: 'weekly notes are up' });
    expect(browser.shown).toEqual([]);
  });

  it('stays quiet for a message that mentions someone else, or a longer handle that starts like the member', () => {
    lookAt({ focused: false });
    const { store, browser } = setup();
    store.receive({ from: 'mira', body: '@grace can you look' });
    store.receive({ from: 'mira', body: '@thomas can you look' });
    expect(browser.shown).toEqual([]);
  });

  it('stays quiet for a DM between two other members that does not mention the admin who can see it', () => {
    lookAt({ focused: false });
    const { store, browser } = setup({ as: 'flan' });
    store.receive({ from: 'mira', to: 'grace', body: 'is that ok?' });
    expect(browser.shown).toEqual([]);
  });

  it('notifies an admin who is mentioned by handle in a DM between two others, which they can see', () => {
    lookAt({ focused: false });
    const { store, browser } = setup({ as: 'flan' });
    store.receive({ from: 'mira', to: 'grace', body: 'ask @flan about it' });
    expect(titles(browser.shown)).toEqual(['mira mentioned you']);
  });

  // `everyone` means a broadcast only in #chat. The bridge sets the flag from the text of any message
  // (bridge/src/messages.js:18) but writes it false for a DM (bridge/src/policy.js:49), and Chatter expands
  // @everyone only when posting to the channel, so in a DM it is plain text. Counting it there would let any
  // member make an admin's notifier fire by typing it into a DM between two others, which the admin is shown.
  it('does not count @everyone typed in a DM between two others, which only an admin is shown', () => {
    lookAt({ focused: false });
    const { store, browser } = setup({ as: 'flan' });
    store.receive({ from: 'mira', to: 'grace', body: '@everyone is that ok?' });
    expect(browser.shown).toEqual([]);
  });

  it('still notifies for @everyone in #chat, and for a DM addressed to the member that contains it, as a direct message', () => {
    lookAt({ focused: false });
    const { store, browser } = setup();
    store.receive({ from: 'flan', body: '@everyone stand-up in five' });
    store.receive({ from: 'mira', to: 'thom', body: '@everyone, and this one is for you' });
    expect(titles(browser.shown)).toEqual(['flan mentioned you', 'mira sent you a direct message']);
  });

  it('decides from the fields the bridge computed and never reads a message body', () => {
    lookAt({ focused: false });
    const base = createFakeStore();
    const { store, emit } = manualStore(base);
    const browser = createFakeNotifications('granted');
    createNotifier({ store, clock: base.clock, notificationApi: browser.api, storage: new MemoryStorage() });
    const message = aMessage({ mentions: ['thom'] });
    Object.defineProperty(message, 'body', {
      enumerable: true,
      get() {
        throw new Error('the notifier read a message body');
      },
    });
    emit({ repo: repoKey(base, 'repo'), message });
    expect(titles(browser.shown)).toEqual(['mira mentioned you']);
  });

  it("ignores the member's own messages even if a store passes one on", () => {
    lookAt({ focused: false });
    const base = createFakeStore();
    const { store, emit } = manualStore(base);
    const browser = createFakeNotifications('granted');
    createNotifier({ store, clock: base.clock, notificationApi: browser.api, storage: new MemoryStorage() });
    emit({ repo: repoKey(base, 'repo'), message: aMessage({ from: 'thom', mentions: ['thom'] }) });
    expect(browser.shown).toEqual([]);
  });

  it('stays quiet while nobody is signed in', () => {
    lookAt({ focused: false });
    const base = createFakeStore();
    const { store, emit } = manualStore(base, () => ({ ...base.getSnapshot(), session: { status: 'signed-out', error: null } }));
    const browser = createFakeNotifications('granted');
    createNotifier({ store, clock: base.clock, notificationApi: browser.api, storage: new MemoryStorage() });
    emit({ repo: repoKey(base, 'repo'), message: aMessage({ to: 'thom' }) });
    expect(browser.shown).toEqual([]);
  });
});

describe('when the member is already looking (D17)', () => {
  it('is silent for a message in the open conversation while the window is visible and focused', () => {
    const { store, browser } = setup();
    store.receive({ from: 'mira', body: 'hello @thom' });
    expect(browser.shown).toEqual([]);
  });

  it('notifies when the page is hidden, even in the open conversation', () => {
    lookAt({ visible: false, focused: true });
    const { store, browser } = setup();
    store.receive({ from: 'mira', body: 'hello @thom' });
    expect(titles(browser.shown)).toEqual(['mira mentioned you']);
  });

  it('notifies when the window is not focused, even in the open conversation', () => {
    lookAt({ visible: true, focused: false });
    const { store, browser } = setup();
    store.receive({ from: 'mira', body: 'hello @thom' });
    expect(titles(browser.shown)).toEqual(['mira mentioned you']);
  });

  it('notifies for a message in another repo while the window is visible and focused', () => {
    const { store, browser } = setup();
    store.receive({ from: 'mira', body: 'over here @thom', repo: repoKey(store, 'site') });
    expect(titles(browser.shown)).toEqual(['mira mentioned you']);
    expect(browser.shown[0]?.options?.body).toBe('Repository: site');
  });

  it('notifies for a DM while #chat is the open conversation', () => {
    const { store, browser } = setup();
    store.receive({ from: 'mira', to: 'thom', body: 'in private' });
    expect(titles(browser.shown)).toEqual(['mira sent you a direct message']);
  });

  it('notifies for a #chat mention while a DM is the open conversation', () => {
    const { store, browser } = setup();
    select(store, 'DM with mira');
    store.receive({ from: 'grace', body: 'hello @thom' });
    expect(titles(browser.shown)).toEqual(['grace mentioned you']);
  });

  it('notifies for a DM from someone else while another DM is the open conversation', () => {
    const { store, browser } = setup();
    select(store, 'DM with mira');
    store.receive({ from: 'grace', to: 'thom', body: 'in private' });
    expect(titles(browser.shown)).toEqual(['grace sent you a direct message']);
  });

  it('is silent for a DM in the DM that is open', () => {
    const { store, browser } = setup();
    select(store, 'DM with mira');
    store.receive({ from: 'mira', to: 'thom', body: 'in private' });
    expect(browser.shown).toEqual([]);
  });

  it('judges each message by what is open when it arrives', () => {
    const { store, browser } = setup();
    select(store, 'DM with mira');
    store.receive({ from: 'mira', to: 'thom', body: 'one' });
    select(store, CHANNEL);
    store.receive({ from: 'mira', to: 'thom', body: 'two' });
    store.selectRepo(repoKey(store, 'site'));
    store.receive({ from: 'mira', body: 'three @thom', repo: repoKey(store, 'repo') });
    expect(titles(browser.shown)).toEqual(['mira sent you a direct message', 'mira mentioned you']);
  });

  it('is silent for an observed DM while that DM is open, whichever way it went, and notifies when it is not', () => {
    const { store, browser } = setup({ as: 'flan' });
    store.receive({ from: 'mira', to: 'grace', body: 'ask @flan about it' });
    expect(titles(browser.shown)).toEqual(['mira mentioned you']);
    select(store, 'DM grace to mira');
    store.clock.advance(NOTIFY_THROTTLE_MS);
    // One conversation covers both directions, whichever handle sorts first: neither of these is shown.
    store.receive({ from: 'mira', to: 'grace', body: 'and @flan too' });
    store.receive({ from: 'grace', to: 'mira', body: 'and @flan again' });
    expect(titles(browser.shown)).toEqual(['mira mentioned you']);
  });
});

// The store knows which conversation is selected, not which view of the app is open: the shell tells the
// notifier (setChatOpen). Without that, a mention in the selected channel was silent with the window
// focused even while Board, Members or Admin was showing, and Chat's announcements region is not mounted
// there either, so the member got no signal at all (G2 round 1, finding 7).
describe('only the Chat view puts a conversation in view (T12)', () => {
  it('notifies once for a mention in the open channel while another view is open and the window is focused', () => {
    const { store, browser } = setup({ chatOpen: false });
    store.receive({ from: 'mira', body: 'hello @thom' });
    expect(titles(browser.shown)).toEqual(['mira mentioned you']);
  });

  // The DM has to be the open conversation: a DM that arrives while #chat is open notifies without this change.
  it('notifies once for a DM in the open DM while another view is open and the window is focused', () => {
    const { store, browser } = setup({ chatOpen: false });
    select(store, 'DM with mira');
    store.receive({ from: 'mira', to: 'thom', body: 'in private' });
    expect(titles(browser.shown)).toEqual(['mira sent you a direct message']);
  });

  it('stays silent for the same mention and the same DM while Chat is open', () => {
    const { store, browser } = setup({ chatOpen: true });
    store.receive({ from: 'mira', body: 'hello @thom' });
    select(store, 'DM with mira');
    store.receive({ from: 'mira', to: 'thom', body: 'in private' });
    expect(browser.shown).toEqual([]);
  });

  it('follows the shell: silent in Chat, notifies when the view moves away from it, silent again when it returns', () => {
    const { store, browser, notifier } = setup();
    store.receive({ from: 'mira', body: 'one @thom' });
    expect(browser.shown).toEqual([]);
    notifier.setChatOpen(false);
    store.receive({ from: 'mira', body: 'two @thom' });
    expect(titles(browser.shown)).toEqual(['mira mentioned you']);
    notifier.setChatOpen(true);
    // Past the throttle, so that the silence is the view's doing and not the window's.
    store.clock.advance(NOTIFY_THROTTLE_MS);
    store.receive({ from: 'mira', body: 'three @thom' });
    expect(titles(browser.shown)).toEqual(['mira mentioned you']);
  });

  it('counts nothing as in view until the shell has said that Chat is open', () => {
    const { store, browser, notifier } = setup({ chatOpen: null });
    store.receive({ from: 'mira', body: 'one @thom' });
    expect(titles(browser.shown)).toEqual(['mira mentioned you']);
    notifier.setChatOpen(true);
    store.clock.advance(NOTIFY_THROTTLE_MS);
    store.receive({ from: 'mira', body: 'two @thom' });
    expect(titles(browser.shown)).toEqual(['mira mentioned you']);
  });

  // A guard, green before the change as well: another view widens the in-view rule and nothing else.
  it('still needs a mention or a DM, the preference and the permission while another view is open', () => {
    const { store, browser, notifier } = setup({ chatOpen: false });
    store.receive({ from: 'mira', body: 'good morning everybody' });
    notifier.getSettings().onEnabledChange(false);
    store.receive({ from: 'mira', body: 'hello @thom' });
    notifier.getSettings().onEnabledChange(true);
    browser.setPermission('denied');
    store.receive({ from: 'mira', to: 'thom', body: 'in private' });
    expect(browser.shown).toEqual([]);
    browser.setPermission('granted');
    store.receive({ from: 'mira', to: 'thom', body: 'and now' });
    expect(titles(browser.shown)).toEqual(['mira sent you a direct message']);
  });
});

describe('what a notification carries (D17)', () => {
  it('shows the sender, the reason and the repository, and nothing else', () => {
    lookAt({ focused: false });
    const { store, browser } = setup();
    store.receive({ from: 'mira', body: 'hello @thom' });
    store.receive({ from: 'grace', to: 'thom', body: 'in private' });
    expect(browser.shown.map((n) => [n.title, n.options?.body])).toEqual([
      ['mira mentioned you', 'Repository: repo'],
      ['grace sent you a direct message', 'Repository: repo'],
    ]);
    for (const notification of browser.shown) expect(Object.keys(notification.options ?? {}).sort()).toEqual(['body', 'tag']);
  });

  it('puts no message text in any field the browser is given', () => {
    lookAt({ focused: false });
    const { store, browser } = setup();
    const secret = 'the-launch-codes-are-in-the-drawer';
    store.receive({ from: 'mira', body: `@thom ${secret}` });
    store.receive({ from: 'grace', to: 'thom', body: `${secret}, in private` });
    // Past the throttle, so that the second #chat message is shown too.
    store.clock.advance(NOTIFY_THROTTLE_MS);
    store.receive({ from: 'flan', body: `@everyone ${secret}` });
    expect(browser.shown).toHaveLength(3);
    for (const notification of browser.shown) {
      expect(JSON.stringify([notification.title, notification.options])).not.toContain(secret);
    }
  });

  it('shows the repo key when the repo is not in the list', () => {
    lookAt({ focused: false });
    const base = createFakeStore();
    const { store, emit } = manualStore(base);
    const browser = createFakeNotifications('granted');
    createNotifier({ store, clock: base.clock, notificationApi: browser.api, storage: new MemoryStorage() });
    emit({ repo: 'gone-12345678', message: aMessage({ mentions: ['thom'] }) });
    expect(browser.shown[0]?.options?.body).toBe('Repository: gone-12345678');
  });

  it('tags a notification with the repo and the conversation, so that a repeat replaces it', () => {
    lookAt({ focused: false });
    const { store, browser } = setup();
    store.receive({ from: 'mira', body: 'one @thom' });
    store.clock.advance(NOTIFY_THROTTLE_MS);
    store.receive({ from: 'grace', body: 'two @thom' });
    store.receive({ from: 'mira', to: 'thom', body: 'three' });
    store.receive({ from: 'grace', to: 'thom', body: 'four' });
    store.receive({ from: 'mira', body: 'five @thom', repo: repoKey(store, 'site') });
    const tags = browser.shown.map((n) => n.options?.tag);
    expect(tags).toHaveLength(5);
    // #chat twice (the same tag), then each DM and the other repo's #chat have tags of their own.
    expect(tags[0]).toBe(tags[1]);
    expect(new Set(tags).size).toBe(4);
    expect(tags.every((tag) => typeof tag === 'string' && tag.length > 0)).toBe(true);
    expect(tags.join(' ')).toContain(repoKey(store, 'repo'));
    expect(tags.join(' ')).toContain(repoKey(store, 'site'));
  });
});

describe('at most one per conversation per 10 seconds (D17)', () => {
  it('shows one notification, not two, for two mentions in the same conversation within 10 seconds', () => {
    lookAt({ focused: false });
    const { store, browser } = setup();
    store.receive({ from: 'mira', body: 'one @thom' });
    store.clock.advance(1_000);
    store.receive({ from: 'grace', body: 'two @thom' });
    expect(titles(browser.shown)).toEqual(['mira mentioned you']);
  });

  it('drops a repeat at 9,999 ms and shows it at 10,000 ms', () => {
    lookAt({ focused: false });
    const { store, browser } = setup();
    store.receive({ from: 'mira', body: 'one @thom' });
    // Literal, not the constant: the brief says ten seconds, so a changed constant must show up here.
    store.clock.advance(9_999);
    store.receive({ from: 'mira', body: 'two @thom' });
    expect(browser.shown).toHaveLength(1);
    store.clock.advance(1);
    store.receive({ from: 'mira', body: 'three @thom' });
    expect(browser.shown).toHaveLength(2);
  });

  it('does not let one conversation, or one repo, throttle another', () => {
    lookAt({ focused: false });
    const { store, browser } = setup();
    store.receive({ from: 'mira', body: 'one @thom' });
    store.receive({ from: 'mira', to: 'thom', body: 'two' });
    store.receive({ from: 'grace', to: 'thom', body: 'three' });
    store.receive({ from: 'mira', body: 'four @thom', repo: repoKey(store, 'site') });
    expect(browser.shown).toHaveLength(4);
  });

  it('does not start the window for a message that was not shown', () => {
    const { store, browser } = setup();
    store.receive({ from: 'mira', body: 'seen at once @thom' });
    expect(browser.shown).toEqual([]);
    lookAt({ focused: false });
    store.clock.advance(1_000);
    store.receive({ from: 'mira', body: 'missed @thom' });
    expect(browser.shown).toHaveLength(1);
  });

  it('does not extend the window for a repeat it dropped', () => {
    lookAt({ focused: false });
    const { store, browser } = setup();
    store.receive({ from: 'mira', body: 'one @thom' });
    store.clock.advance(6_000);
    store.receive({ from: 'mira', body: 'two @thom' });
    store.clock.advance(4_000);
    store.receive({ from: 'mira', body: 'three @thom' });
    expect(browser.shown).toHaveLength(2);
  });

  it('is not muted by a clock that was set backwards', () => {
    lookAt({ focused: false });
    const base = createFakeStore();
    let now = 5_000_000;
    const clock: Clock = { now: () => now, schedule: () => () => undefined };
    const browser = createFakeNotifications('granted');
    createNotifier({ store: base, clock, notificationApi: browser.api, storage: new MemoryStorage() });
    base.receive({ from: 'mira', body: 'one @thom' });
    now = 1_000_000;
    base.receive({ from: 'mira', body: 'two @thom' });
    expect(browser.shown).toHaveLength(2);
  });

  it('survives a browser that refuses to build the notification, and does not count it', () => {
    lookAt({ focused: false });
    const { store, browser } = setup();
    browser.failToConstruct();
    expect(() => store.receive({ from: 'mira', body: 'one @thom' })).not.toThrow();
    expect(browser.shown).toEqual([]);
    // The refusal started no window: the next one, right after, is shown.
    browser.failToConstruct(false);
    store.receive({ from: 'mira', body: 'two @thom' });
    expect(titles(browser.shown)).toEqual(['mira mentioned you']);
  });
});

describe('clicking a notification (T9 brief)', () => {
  it('focuses the window, selects the repo the message came in and closes the notification', () => {
    lookAt({ focused: false });
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    const { store, browser } = setup();
    const site = repoKey(store, 'site');
    store.receive({ from: 'mira', body: 'over here @thom', repo: site });
    expect(store.getSnapshot().selectedRepo).toBe(repoKey(store, 'repo'));
    browser.shown[0]?.click();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().selectedRepo).toBe(site);
    expect(browser.shown[0]?.closed).toBe(true);
  });

  it('does nothing after the notifier is disposed', () => {
    lookAt({ focused: false });
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    const { store, browser, notifier } = setup();
    store.receive({ from: 'mira', body: 'over here @thom', repo: repoKey(store, 'site') });
    notifier.dispose();
    browser.shown[0]?.click();
    expect(focus).not.toHaveBeenCalled();
    expect(store.getSnapshot().selectedRepo).toBe(repoKey(store, 'repo'));
  });
});

describe('the enabled preference (D17)', () => {
  it('is on by default', () => {
    expect(setup().notifier.getSettings().enabled).toBe(true);
  });

  it('stays quiet while it is off, and notifies again when it is back on', () => {
    lookAt({ focused: false });
    const { store, browser, notifier } = setup();
    notifier.getSettings().onEnabledChange(false);
    store.receive({ from: 'mira', body: 'one @thom' });
    store.receive({ from: 'mira', to: 'thom', body: 'two' });
    expect(browser.shown).toEqual([]);
    notifier.getSettings().onEnabledChange(true);
    store.receive({ from: 'grace', to: 'thom', body: 'three' });
    expect(titles(browser.shown)).toEqual(['grace sent you a direct message']);
  });

  it('keeps the choice under one key', () => {
    const storage = new MemoryStorage();
    const { notifier } = setup({ storage });
    notifier.getSettings().onEnabledChange(false);
    expect([...storage.data.entries()]).toEqual([[NOTIFICATIONS_STORAGE_KEY, 'off']]);
    notifier.getSettings().onEnabledChange(true);
    expect([...storage.data.entries()]).toEqual([[NOTIFICATIONS_STORAGE_KEY, 'on']]);
  });

  it('stores nothing else: neither the prompt, nor a message, nor its text', async () => {
    lookAt({ focused: false });
    const storage = new MemoryStorage();
    const { store, browser, notifier } = setup({ storage, permission: 'default' });
    notifier.getSettings().onEnabledChange(false);
    notifier.getSettings().onEnabledChange(true);
    notifier.getSettings().onRequestPermission();
    await settle();
    store.receive({ from: 'mira', body: 'hello @thom' });
    // The message was shown, so a notification path that stored something would have run.
    expect(browser.shown).toHaveLength(1);
    expect(storage.writes).toEqual([NOTIFICATIONS_STORAGE_KEY, NOTIFICATIONS_STORAGE_KEY]);
    expect([...storage.data.keys()]).toEqual([NOTIFICATIONS_STORAGE_KEY]);
  });

  it('starts with the stored choice, so an off survives a reload', () => {
    lookAt({ focused: false });
    const storage = new MemoryStorage();
    storage.data.set(NOTIFICATIONS_STORAGE_KEY, 'off');
    const { store, browser, notifier } = setup({ storage });
    expect(notifier.getSettings().enabled).toBe(false);
    store.receive({ from: 'mira', body: 'hello @thom' });
    expect(browser.shown).toEqual([]);
  });

  it('treats a stored value it does not know as the default, which is on', () => {
    const storage = new MemoryStorage();
    storage.data.set(NOTIFICATIONS_STORAGE_KEY, 'perhaps');
    expect(setup({ storage }).notifier.getSettings().enabled).toBe(true);
  });

  it('works when storage throws: on by default, and a change still applies for this page', () => {
    lookAt({ focused: false });
    const { store, browser, notifier } = setup({ storage: new BrokenStorage() });
    expect(notifier.getSettings().enabled).toBe(true);
    expect(() => notifier.getSettings().onEnabledChange(false)).not.toThrow();
    expect(notifier.getSettings().enabled).toBe(false);
    store.receive({ from: 'mira', body: 'hello @thom' });
    expect(browser.shown).toEqual([]);
  });

  it('works when there is no storage at all, and then writes nowhere, not even to localStorage', () => {
    const { notifier } = setup({ storage: null });
    expect(notifier.getSettings().enabled).toBe(true);
    notifier.getSettings().onEnabledChange(false);
    expect(notifier.getSettings().enabled).toBe(false);
    expect(window.localStorage.length).toBe(0);
  });

  it('uses localStorage by default, under the same key', () => {
    const store = createFakeStore();
    const browser = createFakeNotifications('granted');
    const first = createNotifier({ store, clock: store.clock, notificationApi: browser.api });
    first.getSettings().onEnabledChange(false);
    expect(window.localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)).toBe('off');
    expect(window.localStorage.length).toBe(1);
    const second = createNotifier({ store, clock: store.clock, notificationApi: browser.api });
    expect(second.getSettings().enabled).toBe(false);
  });

  it('works when merely reading window.localStorage throws, as it does when site data is blocked', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('storage is blocked', 'SecurityError');
    });
    // The precondition: the page really cannot touch localStorage.
    expect(() => window.localStorage).toThrow();
    const store = createFakeStore();
    const browser = createFakeNotifications('granted');
    const notifier = createNotifier({ store, clock: store.clock, notificationApi: browser.api });
    expect(notifier.getSettings().enabled).toBe(true);
    expect(() => notifier.getSettings().onEnabledChange(false)).not.toThrow();
    expect(notifier.getSettings().enabled).toBe(false);
  });

  it('tells subscribers about a change, and not about a repeat of the same value', () => {
    const { notifier } = setup();
    const heard = vi.fn();
    notifier.subscribe(heard);
    const first = notifier.getSettings();
    first.onEnabledChange(true);
    expect(heard).not.toHaveBeenCalled();
    first.onEnabledChange(false);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(heard).toHaveBeenLastCalledWith(notifier.getSettings());
    expect(notifier.getSettings().enabled).toBe(false);
    expect(notifier.getSettings()).not.toBe(first);
  });

  it('hands out the same settings object, with the same handlers, until something changes', () => {
    const { notifier } = setup();
    const first = notifier.getSettings();
    expect(notifier.getSettings()).toBe(first);
    first.onEnabledChange(false);
    const second = notifier.getSettings();
    expect(second).not.toBe(first);
    expect(second.onRequestPermission).toBe(first.onRequestPermission);
    expect(second.onEnabledChange).toBe(first.onEnabledChange);
  });
});

describe('permission is asked for from the Settings button only (D17)', () => {
  it('asks for nothing when it is created, when messages arrive, or when settings are read', () => {
    lookAt({ focused: false });
    const { store, browser, notifier } = setup({ permission: 'default' });
    notifier.getSettings();
    store.receive({ from: 'mira', body: 'hello @thom' });
    store.receive({ from: 'mira', to: 'thom', body: 'in private' });
    expect(browser.requests).toBe(0);
    expect(browser.shown).toEqual([]);
  });

  it('asks once, inside the click that calls it, not later', () => {
    const { browser, notifier } = setup({ permission: 'default' });
    // No await: a prompt started after one would no longer count as the person's click.
    notifier.getSettings().onRequestPermission();
    expect(browser.requests).toBe(1);
  });

  it('shows the answer, tells subscribers, and then notifies', async () => {
    lookAt({ focused: false });
    const { store, browser, notifier } = setup({ permission: 'default' });
    const heard = vi.fn();
    notifier.subscribe(heard);
    store.receive({ from: 'mira', body: 'before the answer @thom' });
    expect(browser.shown).toEqual([]);
    notifier.getSettings().onRequestPermission();
    await settle();
    expect(notifier.getSettings().permission).toBe('granted');
    expect(heard).toHaveBeenCalledTimes(1);
    expect(heard).toHaveBeenLastCalledWith(notifier.getSettings());
    // A message that was held back for want of permission started no throttle window.
    store.receive({ from: 'mira', body: 'after the answer @thom' });
    expect(titles(browser.shown)).toEqual(['mira mentioned you']);
  });

  it('keeps quiet when the answer is no, and does not ask again', async () => {
    lookAt({ focused: false });
    const { store, browser, notifier } = setup({ permission: 'default' });
    browser.answerWith('denied');
    notifier.getSettings().onRequestPermission();
    await settle();
    expect(notifier.getSettings().permission).toBe('denied');
    notifier.getSettings().onRequestPermission();
    await settle();
    expect(browser.requests).toBe(1);
    store.receive({ from: 'mira', body: 'hello @thom' });
    expect(browser.shown).toEqual([]);
  });

  it('leaves the permission undecided when the prompt is dismissed, and may ask again', async () => {
    const { browser, notifier } = setup({ permission: 'default' });
    const heard = vi.fn();
    notifier.subscribe(heard);
    browser.answerWith('default');
    notifier.getSettings().onRequestPermission();
    await settle();
    expect(notifier.getSettings().permission).toBe('default');
    expect(heard).not.toHaveBeenCalled();
    browser.answerWith('granted');
    notifier.getSettings().onRequestPermission();
    await settle();
    expect(browser.requests).toBe(2);
    expect(notifier.getSettings().permission).toBe('granted');
  });

  it('survives a prompt that rejects and one that throws', async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', record);
    try {
      const { browser, notifier } = setup({ permission: 'default' });
      browser.failPrompt('reject');
      expect(() => notifier.getSettings().onRequestPermission()).not.toThrow();
      await settle();
      browser.failPrompt('throw');
      expect(() => notifier.getSettings().onRequestPermission()).not.toThrow();
      await settle();
      expect(browser.requests).toBe(2);
      expect(notifier.getSettings().permission).toBe('default');
    } finally {
      process.off('unhandledRejection', record);
    }
    expect(unhandled).toEqual([]);
  });

  it.each<NotificationPermission>(['granted', 'denied'])('does not ask when the permission is already %s', async (permission) => {
    const { browser, notifier } = setup({ permission });
    notifier.getSettings().onRequestPermission();
    await settle();
    expect(browser.requests).toBe(0);
  });

  it("notices a permission changed in the browser's own settings, at the next read and at the next message", () => {
    lookAt({ focused: false });
    const { store, browser, notifier } = setup({ permission: 'default' });
    expect(notifier.getSettings().permission).toBe('default');
    browser.setPermission('granted');
    expect(notifier.getSettings().permission).toBe('granted');
    store.receive({ from: 'mira', body: 'hello @thom' });
    expect(browser.shown).toHaveLength(1);
    browser.setPermission('denied');
    store.clock.advance(NOTIFY_THROTTLE_MS);
    store.receive({ from: 'mira', body: 'hello again @thom' });
    expect(browser.shown).toHaveLength(1);
    expect(notifier.getSettings().permission).toBe('denied');
  });

  it('tells subscribers about an answer even when a read had already shown it', async () => {
    const { browser, notifier } = setup({ permission: 'default' });
    const heard = vi.fn();
    notifier.subscribe(heard);
    notifier.getSettings().onRequestPermission();
    // The browser changed the permission at once; this read picks it up before the prompt's promise settles.
    expect(notifier.getSettings().permission).toBe('granted');
    await settle();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(browser.requests).toBe(1);
  });

  it('is unsupported, and quiet, without a Notification', () => {
    lookAt({ focused: false });
    const store = createFakeStore();
    const notifier = createNotifier({ store, clock: store.clock, notificationApi: null, storage: new MemoryStorage() });
    expect(notifier.getSettings().permission).toBe('unsupported');
    expect(() => notifier.getSettings().onRequestPermission()).not.toThrow();
    expect(() => store.receive({ from: 'mira', body: 'hello @thom' })).not.toThrow();
  });

  it('is unsupported by default where the page has no Notification, as in jsdom', () => {
    expect(typeof globalThis.Notification).toBe('undefined');
    const store = createFakeStore();
    expect(createNotifier({ store, clock: store.clock, storage: null }).getSettings().permission).toBe('unsupported');
  });

  it("uses the page's own Notification by default", () => {
    lookAt({ focused: false });
    const browser = createFakeNotifications('granted');
    vi.stubGlobal('Notification', browser.api);
    const store = createFakeStore();
    const notifier = createNotifier({ store, clock: store.clock, storage: null });
    expect(notifier.getSettings().permission).toBe('granted');
    store.receive({ from: 'mira', body: 'hello @thom' });
    expect(browser.shown).toHaveLength(1);
  });
});

describe('dispose', () => {
  it('unsubscribes from the store', () => {
    const base = createFakeStore();
    const { store, listeners } = manualStore(base);
    const notifier = createNotifier({ store, clock: base.clock, notificationApi: null, storage: null });
    expect(listeners.size).toBe(1);
    notifier.dispose();
    expect(listeners.size).toBe(0);
  });

  it('stops notifying and telling subscribers, and ignores a permission request, a second dispose and an unsubscribe after it', async () => {
    lookAt({ focused: false });
    const { store, browser, notifier } = setup({ permission: 'default' });
    const heard = vi.fn();
    const stop = notifier.subscribe(heard);
    notifier.dispose();
    notifier.getSettings().onEnabledChange(false);
    notifier.getSettings().onRequestPermission();
    await settle();
    browser.setPermission('granted');
    store.receive({ from: 'mira', body: 'hello @thom' });
    expect(browser.shown).toEqual([]);
    expect(browser.requests).toBe(0);
    expect(heard).not.toHaveBeenCalled();
    expect(() => {
      stop();
      notifier.dispose();
    }).not.toThrow();
  });

  it('lets a subscriber unsubscribe', () => {
    const { notifier } = setup();
    const heard = vi.fn();
    const stop = notifier.subscribe(heard);
    stop();
    notifier.getSettings().onEnabledChange(false);
    expect(heard).not.toHaveBeenCalled();
  });

  it('does not let a throwing subscriber stop the others, and reports it', () => {
    const report = vi.fn();
    vi.stubGlobal('reportError', report);
    const { notifier } = setup();
    const heard = vi.fn();
    notifier.subscribe(() => {
      throw new Error('a subscriber failed');
    });
    notifier.subscribe(heard);
    expect(() => notifier.getSettings().onEnabledChange(false)).not.toThrow();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(1);
  });
});
