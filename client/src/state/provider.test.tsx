// The Preact glue: the provider hands the store down, useSnapshot follows what it publishes, and
// unmounting lets go of the subscription. Driven with the fake store, as the views will be.
import { useState } from 'preact/hooks';
import { act } from 'preact/test-utils';
import { describe, expect, it } from 'vitest';
import { cleanup, render } from '../../test/render';
import { createFakeStore, type FakeStore } from './fake';
import { StoreProvider, useSnapshot, useStore } from './provider';
import type { Store, StoreSnapshot } from './types';

function Status() {
  const snapshot = useSnapshot();
  const store = useStore();
  const who = snapshot.session.status === 'signed-in' ? snapshot.session.me.handle : snapshot.session.status;
  return (
    <p>
      <span data-testid="who">{who}</span>
      <span data-testid="count">{snapshot.messages.length}</span>
      <button type="button" onClick={() => store.signOut()}>Sign out</button>
    </p>
  );
}

/** The fake store, counting live subscriptions. */
function counted(store: FakeStore): { store: Store; active: () => number } {
  let active = 0;
  const wrapped: Store = {
    ...store,
    subscribe(listener: (snapshot: StoreSnapshot) => void) {
      active += 1;
      const off = store.subscribe(listener);
      return () => {
        active -= 1;
        off();
      };
    },
  };
  return { store: wrapped, active: () => active };
}

const text = (root: HTMLElement, id: string): string | null => root.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;

describe('StoreProvider, useStore and useSnapshot', () => {
  it('renders the current snapshot and renders again when the store publishes', () => {
    const fake = createFakeStore();
    const root = render(<StoreProvider store={fake}><Status /></StoreProvider>);
    expect(text(root, 'who')).toBe('thom');
    const before = Number(text(root, 'count'));
    act(() => {
      fake.receive({ from: 'mira', body: 'hello' });
    });
    expect(Number(text(root, 'count'))).toBe(before + 1);
    act(() => {
      root.querySelector('button')?.click();
    });
    expect(text(root, 'who')).toBe('signed-out');
  });

  it('subscribes once while mounted and lets go when unmounted', () => {
    const { store, active } = counted(createFakeStore());
    render(<StoreProvider store={store}><Status /></StoreProvider>);
    expect(active()).toBe(1);
    cleanup();
    expect(active()).toBe(0);
  });

  it('follows a store that replaces another at once', () => {
    const first = createFakeStore({ as: 'thom' });
    const second = createFakeStore({ as: 'mira' });
    let swap = (): void => undefined;
    function Holder() {
      const [store, setStore] = useState<Store>(first);
      swap = () => setStore(second);
      return <StoreProvider store={store}><Status /></StoreProvider>;
    }
    const root = render(<Holder />);
    expect(text(root, 'who')).toBe('thom');
    act(() => swap());
    expect(text(root, 'who')).toBe('mira');
    act(() => {
      second.receive({ from: 'thom', body: 'to mira' });
    });
    expect(Number(text(root, 'count'))).toBe(second.getSnapshot().messages.length);
  });

  it('refuses to work without a provider, saying so', () => {
    expect(() => render(<Status />)).toThrow('useStore() needs a StoreProvider above it');
  });
});
