// Hands the store to the views: StoreProvider puts it in context, useStore reads it back, and
// useSnapshot renders again whenever the store publishes. Only preact and preact/hooks, so the views
// stay free of any state library.
import { createContext, type ComponentChildren, type JSX } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';
import type { Store, StoreSnapshot } from './types';

const StoreContext = createContext<Store | null>(null);

export interface StoreProviderProps {
  readonly store: Store;
  readonly children?: ComponentChildren;
}

export function StoreProvider({ store, children }: StoreProviderProps): JSX.Element {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore() needs a StoreProvider above it');
  return store;
}

interface Seen {
  readonly store: Store;
  readonly snapshot: StoreSnapshot;
}

/** The store's current snapshot. */
export function useSnapshot(): StoreSnapshot {
  const store = useStore();
  const [seen, setSeen] = useState<Seen>(() => ({ store, snapshot: store.getSnapshot() }));
  useEffect(() => {
    const show = (snapshot: StoreSnapshot): void => {
      setSeen((old) => (old.store === store && old.snapshot === snapshot ? old : { store, snapshot }));
    };
    // Whatever the store published between the render and this subscription is not lost.
    show(store.getSnapshot());
    return store.subscribe(show);
  }, [store]);
  // Until the effect has run for a store that just replaced another, read the new one directly.
  return seen.store === store ? seen.snapshot : store.getSnapshot();
}
