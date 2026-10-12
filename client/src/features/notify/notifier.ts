// Desktop notifications for mentions and direct messages (D17), driven by the store's onIncoming.
//
// What a notification may say is fixed by D17: who it is from, why ("mentioned you" or "sent you a
// direct message") and which repository, never any message text. Notification centres keep what
// they are given, show it on a locked screen and may sync it to other devices, so `show` builds its
// two arguments from a handle, a repo label and a fixed phrase, and nothing in this file reads a
// message body: whether a message mentions the member is answered by the fields the bridge
// computed (`mentions`, `everyone`, `to`), not by looking at the text.
//
// The browser is asked for permission only when the Settings button calls `onRequestPermission`:
// browsers ignore a request that is not made from a click, and a prompt nobody asked for trains
// people to dismiss it. The one thing stored is the enabled preference.
import { systemClock, type Clock } from '../../api/clock';
import type { Me, Message } from '../../api/types';
import { CHANNEL, type Conversation, type IncomingMessage, type Store, type StoreSnapshot } from '../../state/types';
import type { NotificationPermissionState, NotificationSettings } from '../shell';

/** The part of a browser notification the notifier uses. The real one and the test fake both have it. */
export interface NotificationHandle {
  onclick: ((event: Event) => unknown) | null;
  close(): void;
}

/** The part of the browser's `Notification` the notifier uses, so tests can supply their own. */
export interface NotificationApi {
  readonly permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  new (title: string, options?: NotificationOptions): NotificationHandle;
}

/** What the preference needs of `localStorage`. */
export type NotifierStorage = Pick<Storage, 'getItem' | 'setItem'>;

export interface NotifierOptions {
  readonly store: Store;
  /** Only `now` is used, for the throttle. Default: the system clock. */
  readonly clock?: Clock;
  /** The browser's `Notification`, or null when there is none. Default: the page's own, if it has one. */
  readonly notificationApi?: NotificationApi | null;
  /** Where the enabled preference is kept, or null for nowhere. Default: `window.localStorage`. */
  readonly storage?: NotifierStorage | null;
}

export interface Notifier {
  /**
   * What the shell's Settings dialog takes. The same object until something in it changes. The
   * browser's permission is read afresh on every call, so a change made in the browser's own site
   * settings shows at the next call; nothing announces that change, so what shows it is the next
   * render of the component that calls this (see useNotifier).
   */
  getSettings(): NotificationSettings;
  /** Calls `listener` with the new settings after each change the notifier makes: the preference, an answered prompt. */
  subscribe(listener: (settings: NotificationSettings) => void): () => void;
  /**
   * Tells the notifier whether the Chat view is the view the member has open. A conversation counts as
   * in view, and a message in it stays silent while the window is focused, only while it is: with Board,
   * Members or Admin open the selected conversation is not on screen, and the Chat view's announcements
   * are not mounted either, so a notification is the only signal the member would get. It starts false,
   * so that a notifier nobody has told errs towards a notification nobody needed and not towards a
   * missing one. It takes no view id: which view shows conversations is the shell's to say (see
   * src/wiring/root.tsx), and this feature does not import the registry.
   */
  setChatOpen(open: boolean): void;
  /** Stops listening to the store. The notifier is not used afterwards. */
  dispose(): void;
}

export const NOTIFICATIONS_STORAGE_KEY = 'chatter.notifications';
const STORED_ON = 'on';
const STORED_OFF = 'off';

/** At most one notification per conversation in this long (the T9 brief). */
export const NOTIFY_THROTTLE_MS = 10_000;

type Reason = 'mention' | 'direct';
const REASON_TEXT: Readonly<Record<Reason, string>> = {
  mention: 'mentioned you',
  direct: 'sent you a direct message',
};
const REPOSITORY_PREFIX = 'Repository: ';

/** Where a message sits, in the words the contract uses for conversations (state/types.ts, `Conversation`). */
type Place =
  | { readonly kind: 'channel' }
  | { readonly kind: 'direct'; readonly peer: string }
  | { readonly kind: 'observed'; readonly from: string; readonly to: string };

function placeOf(message: Message, me: Me): Place {
  if (message.to === CHANNEL) return { kind: 'channel' };
  if (message.to === me.handle) return { kind: 'direct', peer: message.from };
  // Only an admin is shown a DM between two others; the pair is named in alphabetical order, as the store names it.
  const [from, to] = message.from <= message.to ? [message.from, message.to] : [message.to, message.from];
  return { kind: 'observed', from, to };
}

function isIn(conversation: Conversation | undefined, place: Place): boolean {
  if (!conversation) return false;
  switch (place.kind) {
    case 'channel':
      return conversation.kind === 'channel';
    case 'direct':
      return conversation.kind === 'direct' && conversation.peer === place.peer;
    case 'observed':
      return conversation.kind === 'observed' && conversation.from === place.from && conversation.to === place.to;
  }
}

/**
 * This conversation of this repo is the one the store has selected. The snapshot lists only the
 * selected repo's conversations and their ids are opaque, so the message is matched by who is in it.
 * Whether that selection is on screen is for `chatOpen` to say, not the store.
 */
function inView(snapshot: StoreSnapshot, repo: string, place: Place): boolean {
  if (snapshot.selectedRepo !== repo) return false;
  return isIn(snapshot.conversations.find((conversation) => conversation.id === snapshot.selectedConversation), place);
}

/** The repo key and handles only: the tag stays with the notification in the notification centre. */
function tagOf(repo: string, place: Place): string {
  switch (place.kind) {
    case 'channel':
      return JSON.stringify([repo, CHANNEL]);
    case 'direct':
      return JSON.stringify([repo, place.peer]);
    case 'observed':
      return JSON.stringify([repo, place.from, place.to]);
  }
}

function reasonFor(message: Message, me: Me): Reason | null {
  if (message.to === me.handle) return 'direct';
  // The bridge sets `everyone` from the text of any message, but only a post to #chat broadcasts: in a DM it is
  // plain text (bridge/src/policy.js writes it false). Counting it there would let any member make an admin's
  // notifier fire by typing it into a DM between two others, which the admin is shown.
  if (message.mentions.includes(me.handle) || (message.everyone && message.to === CHANNEL)) return 'mention';
  return null;
}

/** Whether the person can be assumed to see the page: it is shown and its window has focus. */
function pageIsActive(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

function browserNotification(): NotificationApi | null {
  return typeof globalThis.Notification === 'function' ? globalThis.Notification : null;
}

/** Reports without interrupting the caller; rethrown on its own microtask where reportError is missing, as the store does. */
function reportLater(error: unknown): void {
  if (typeof globalThis.reportError === 'function') {
    globalThis.reportError(error);
    return;
  }
  queueMicrotask(() => {
    throw error;
  });
}

export function createNotifier(options: NotifierOptions): Notifier {
  const { store } = options;
  const clock = options.clock ?? systemClock;
  const api = options.notificationApi === undefined ? browserNotification() : options.notificationApi;
  // Looked up on every use: merely reading window.localStorage throws when site data is blocked.
  const getStorage = options.storage === undefined ? (): Storage => window.localStorage : (): NotifierStorage | null => options.storage ?? null;

  const listeners = new Set<(settings: NotificationSettings) => void>();
  const lastShown = new Map<string, number>();
  let disposed = false;
  // False until the shell says otherwise (see Notifier.setChatOpen): no conversation is assumed to be on screen.
  let chatOpen = false;
  let enabled = readEnabled();
  let settings = build(readPermission());
  // What subscribers were last told; `settings` can move ahead of it when a read notices a new permission.
  let announced = settings;
  const stopIncoming = store.onIncoming(onIncoming);

  function readEnabled(): boolean {
    try {
      // Anything but an explicit "off" is the default, which is on (D17).
      return getStorage()?.getItem(NOTIFICATIONS_STORAGE_KEY) !== STORED_OFF;
    } catch {
      return true;
    }
  }

  function writeEnabled(value: boolean): void {
    try {
      getStorage()?.setItem(NOTIFICATIONS_STORAGE_KEY, value ? STORED_ON : STORED_OFF);
    } catch {
      // The choice still applies for this page; it just will not survive a reload.
    }
  }

  function readPermission(): NotificationPermissionState {
    return api ? api.permission : 'unsupported';
  }

  function build(permission: NotificationPermissionState): NotificationSettings {
    return Object.freeze({ permission, enabled, onRequestPermission: requestPermission, onEnabledChange: setEnabled });
  }

  function current(): NotificationSettings {
    const permission = readPermission();
    if (permission !== settings.permission) settings = build(permission);
    return settings;
  }

  function publish(): void {
    const next = current();
    if (next === announced) return;
    announced = next;
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch (error) {
        reportLater(error);
      }
    }
  }

  function setEnabled(next: boolean): void {
    if (disposed || next === enabled) return;
    enabled = next;
    writeEnabled(next);
    settings = build(readPermission());
    publish();
  }

  function requestPermission(): void {
    if (disposed || !api || readPermission() !== 'default') return;
    let answer: Promise<unknown>;
    try {
      // Called here, inside the click that led to it: a prompt started later would no longer count as the person's request.
      answer = Promise.resolve(api.requestPermission());
    } catch {
      return;
    }
    const settled = (): void => {
      if (!disposed) publish();
    };
    void answer.then(settled, settled);
  }

  function throttled(tag: string, now: number): boolean {
    const last = lastShown.get(tag);
    if (last === undefined) return false;
    const age = now - last;
    // A clock set backwards must not mute a conversation until it catches up.
    return age >= 0 && age < NOTIFY_THROTTLE_MS;
  }

  /** True when the browser built the notification. It is given the sender, not the message, so there is no text to leak. */
  function show(repo: string, sender: string, reason: Reason, snapshot: StoreSnapshot, tag: string): boolean {
    if (!api) return false;
    const label = snapshot.repos.find((choice) => choice.key === repo)?.label ?? repo;
    let notification: NotificationHandle;
    try {
      // The only place a notification is made: a title and two fields, all free of message text.
      notification = new api(`${sender} ${REASON_TEXT[reason]}`, { body: `${REPOSITORY_PREFIX}${label}`, tag });
    } catch {
      // Some platforms (Chrome on Android) refuse the constructor; there is nothing else to try, and nothing to tell the person.
      return false;
    }
    notification.onclick = () => {
      if (disposed) return;
      window.focus();
      store.selectRepo(repo);
      notification.close();
    };
    return true;
  }

  function onIncoming({ repo, message }: IncomingMessage): void {
    if (disposed || !enabled || readPermission() !== 'granted') return;
    const snapshot = store.getSnapshot();
    if (snapshot.session.status !== 'signed-in') return;
    const me = snapshot.session.me;
    // The store never passes a member's own message on; this keeps a mention of oneself from ever notifying.
    if (message.from === me.handle) return;
    const reason = reasonFor(message, me);
    if (reason === null) return;
    const place = placeOf(message, me);
    // On screen takes all three: Chat is the open view, the window is shown and focused, and the message
    // belongs to the conversation Chat has open. The store's selection alone is not enough: it stays
    // selected while Board, Members or Admin covers it.
    if (chatOpen && pageIsActive() && inView(snapshot, repo, place)) return;
    const tag = tagOf(repo, place);
    const now = clock.now();
    if (throttled(tag, now)) return;
    // A refused notification starts no window: the next message may still be shown.
    if (show(repo, message.from, reason, snapshot, tag)) lastShown.set(tag, now);
  }

  return {
    getSettings: current,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setChatOpen(open) {
      chatOpen = open;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      stopIncoming();
    },
  };
}
