// The token lives in the store's closure and nowhere else (D14, UI contract section 7): not in a
// snapshot, web storage, a cookie, a property of the store, or an error. jsdom, because web storage
// exists only there.
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../api/clock';
import { ERROR_CODES } from '../api/errors';
import { CHANNEL } from '../api/types';
import { BRIDGE_ROUTES, FakeBridge } from './fake-api';
import { createStore } from './store';
import type { StoreSnapshot } from './types';

const QUIET = { deadAfterMs: 24 * 60 * 60_000 };

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Every string reachable through own properties, getters included; a closure's variables are the
 * one place this cannot look, which is the point.
 */
function strings(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value !== 'object' || value === null || seen.has(value)) return [];
  seen.add(value);
  return Reflect.ownKeys(value).flatMap((key) => [...(typeof key === 'string' ? [key] : []), ...strings(Reflect.get(value, key), seen)]);
}

function webStorage(): string[] {
  const all: string[] = [];
  for (const storage of [localStorage, sessionStorage]) {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i) ?? '';
      all.push(key, storage.getItem(key) ?? '');
    }
  }
  return all;
}

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('the member\'s token', () => {
  it('is held in the store\'s closure only, and forgotten on sign-out, after a refusal and when the bridge stops accepting it', async () => {
    const clock = new ManualClock();
    const bridge = new FakeBridge({ clock });
    const holders: Array<() => string | null> = [];
    const errors: unknown[] = [];
    const store = createStore({
      api: (getToken) => {
        holders.push(getToken);
        return bridge.api(getToken);
      },
      clock,
      random: () => 0.5,
      streamTiming: QUIET,
      reportError: (error) => errors.push(error),
    });
    const snapshots: StoreSnapshot[] = [];
    store.subscribe((snapshot) => snapshots.push(snapshot));
    await settle();
    const token = bridge.tokenOf('thom');
    // A count, never the strings themselves: a failure must not print what it guards.
    const leaks = (): number => [
      ...strings(snapshots),
      ...strings(store.getSnapshot()),
      ...strings(store),
      ...webStorage(),
      document.cookie,
      ...errors.map(String),
    ].filter((text) => text.includes(token)).length;

    expect(await store.signIn(`  ${token}  `)).toBe(true);
    await settle();
    expect(holders).toHaveLength(1);
    expect(holders[0]?.()).toBe(token);
    // Everything a session does, refusals included.
    await store.send({ to: CHANNEL, body: 'hello' });
    await store.send({ to: CHANNEL, body: '@everyone no' });
    bridge.write({ from: 'mira', body: 'hi thom' });
    await settle();
    await store.markRead();
    await store.refreshDirectory();
    expect(store.getSnapshot().sendError?.code).toBe(ERROR_CODES.everyoneAdminOnly);
    expect(leaks(), 'places the token was found in').toBe(0);

    store.signOut();
    expect(holders[0]?.()).toBeNull();

    expect(await store.signIn('not-the-token')).toBe(false);
    expect(holders[0]?.()).toBeNull();
    expect(strings(store.getSnapshot()).filter((text) => text.includes('not-the-token')).length).toBe(0);

    expect(await store.signIn(token)).toBe(true);
    await settle();
    bridge.rotate('thom');
    await settle();
    clock.advance(500);
    await settle();
    expect(store.getSnapshot().session).toMatchObject({ status: 'signed-out', error: { code: ERROR_CODES.badToken } });
    expect(holders[0]?.()).toBeNull();
    expect(leaks(), 'places the token was found in').toBe(0);
    expect(bridge.requests.filter((r) => r.route === BRIDGE_ROUTES.me).map((r) => r.withToken)).toEqual([false, true, true, true]);
    store.dispose();
  });
});
