// What the running app is made of: one store, the one Api it talks to the bridge through, and one
// notifier listening to it. main.tsx makes them once for the life of the page; tests make their own.
import { createApi, type Api, type FetchLike } from '../api/client';
import { systemClock, type Clock } from '../api/clock';
import { createNotifier, type NotificationApi, type Notifier, type NotifierStorage } from '../features/notify';
import { createStore } from '../state/store';
import type { Store } from '../state/types';

export interface Services {
  readonly store: Store;
  /**
   * The Api the store sends its own requests through, for the views that call the bridge themselves
   * (the Board and the Admin panel). It reads the token from the store's closure on every request and
   * keeps no copy, so the token stays where the store put it and nowhere else.
   */
  readonly api: Api;
  readonly notifier: Notifier;
  /** Time for the views that run their own timers (the Board's refresh), the same clock the store and notifier use. */
  readonly clock: Clock;
  /** Ends the notifier and the store together: the notifier listens to the store, so it never outlives it. */
  dispose(): void;
}

export interface ServicesOptions {
  /** The page's own fetch unless given; tests pass a stub. */
  readonly fetch?: FetchLike;
  readonly clock?: Clock;
  /** See NotifierOptions: the browser's Notification unless given, null for none. */
  readonly notificationApi?: NotificationApi | null;
  /** See NotifierOptions: localStorage unless given, null for nowhere. */
  readonly storage?: NotifierStorage | null;
}

export function createServices(options: ServicesOptions = {}): Services {
  const clock = options.clock ?? systemClock;
  // createStore builds its Api at once, around the getter of its own token. Keeping hold of that Api
  // is how the views share it with no change to the store's contract and no copy of the token.
  const built: { api?: Api } = {};
  const store = createStore({ clock, api: (getToken) => (built.api = createApi({ getToken, fetch: options.fetch })) });
  const { api } = built;
  if (!api) {
    store.dispose();
    throw new Error('the store did not build its Api');
  }
  const notifier = createNotifier({ store, clock, notificationApi: options.notificationApi, storage: options.storage });
  return {
    store,
    api,
    notifier,
    clock,
    dispose() {
      notifier.dispose();
      store.dispose();
    },
  };
}
