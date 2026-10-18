// @vitest-environment node
// V5 finding 2: an admin who rotates their own token used to lose the session (the old token's stream ends
// with `bye token_rotated`, the next request is a 401, and the new token existed only in the dialog). The
// store now follows the rotation: followRotation takes the new token in the moment the bridge's answer
// arrives. Written against the real store over the scripted bridge, which does what the real one does on a
// rotation: the byes go to the member's streams before the answer, and the old token is dead from then on.
// The tokens here are the scripted bridge's throwaways.
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, ERROR_CODES, NetworkError } from '../api/errors';
import { ManualClock } from '../api/clock';
import type { Api } from '../api/client';
import { recordedError } from '../../test/fixtures/recorded';
import type { StreamTiming } from '../api/stream';
import { BRIDGE_ROUTES, FakeBridge, MAIN_REPO, type BridgeRoute } from './fake-api';
import type { FakeMember } from './fake';
import { createStore } from './store';
import type { Store, StoreSnapshot } from './types';

const QUIET: Partial<StreamTiming> = { deadAfterMs: 24 * 60 * 60_000 };
const TEN_MINUTES = 10 * 60_000;
// With random() at 0.5 the stream waits floor(0.5 * 1000) ms before it reconnects after a bye.
const RECONNECT_WAIT_MS = 500;
const refusal = (name: string) => {
  const { code, message } = recordedError(name);
  return { code, message };
};

const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

interface Options {
  readonly as?: FakeMember;
  /** 'token' signs in with the member's token; 'identity' is a session through the tailnet identity header, which has no token. */
  readonly via?: 'token' | 'identity';
  /** Held before the store signs in, so a request can be caught in flight. */
  readonly hold?: readonly BridgeRoute[];
}

async function start(options: Options = {}) {
  const as = options.as ?? 'flan';
  const via = options.via ?? 'token';
  const clock = new ManualClock();
  const bridge = new FakeBridge({ clock, identity: via === 'identity' ? as : null });
  for (const route of options.hold ?? []) bridge.hold(route);
  const errors: unknown[] = [];
  let holder: (() => string | null) | null = null;
  let panel: Api | null = null;
  const store = createStore({
    api: (getToken) => {
      holder = getToken;
      panel = bridge.api(getToken);
      return panel;
    },
    clock,
    random: () => 0.5,
    streamTiming: QUIET,
    reportError: (error) => errors.push(error),
  });
  stores.push(store);
  const snapshots: StoreSnapshot[] = [];
  store.subscribe((snapshot) => snapshots.push(snapshot));
  await settle();
  const now = (): StoreSnapshot => store.getSnapshot();
  const token = (): string | null => {
    if (!holder) throw new Error('the store built no Api');
    return holder();
  };
  const call = (): Api => {
    if (!panel) throw new Error('the store built no Api');
    return panel;
  };
  if (via === 'token') {
    expect(await store.signIn(bridge.tokenOf(as))).toBe(true);
    await settle();
  }
  // What counts is what the session shows from here on, not the signed-out form the page started with.
  const began = snapshots.length;
  const harness = {
    clock,
    bridge,
    store,
    errors,
    snapshots,
    now,
    token,
    /** The panel's call on its own, as the Api it holds makes it: the bridge rotates, and nobody follows. */
    rotateOnly: (handle: string) => call().rotateToken(handle),
    /** The same call as the app wires it: the store runs it and follows the answer. */
    rotate: (handle: string) => store.followRotation(handle, () => call().rotateToken(handle)),
    async advance(ms: number): Promise<void> {
      clock.advance(ms);
      await settle();
    },
    /** True when no snapshot, since the session began, showed anything but a signed-in member. */
    stayedSignedIn: (): boolean => snapshots.slice(began).every((snapshot) => snapshot.session.status === 'signed-in'),
  };
  return harness;
}

describe('rotating one\'s own token with a token session', () => {
  it('goes on as the same session on the new token: nothing is reloaded, and the streams reopen at once', async () => {
    const h = await start();
    expect(h.now()).toMatchObject({ connection: 'online', selectedRepo: MAIN_REPO });
    const before = h.now();
    const streams = h.bridge.openStreams();
    expect(streams).toBe(2);
    const first = h.token();
    const asked = h.bridge.requests.length;

    const answered = await h.rotate('flan');
    // No clock moves: waiting out the reconnect's backoff would take RECONNECT_WAIT_MS of it.
    await settle();

    expect(answered.token).not.toBe(first);
    expect(h.token()).toBe(answered.token);
    expect(h.now().session).toBe(before.session);
    expect(h.now()).toMatchObject({ connection: 'online', selectedRepo: before.selectedRepo, selectedConversation: before.selectedConversation });
    expect(h.now().messages).toEqual(before.messages);
    expect(h.now().conversations).toEqual(before.conversations);
    expect(h.bridge.openStreams()).toBe(streams);
    // Everything asked since carries a token: the new one, never a request without credentials.
    expect(h.bridge.requests.slice(asked).every((request) => request.withToken)).toBe(true);

    // The new stream is live and resumes from where the old one was: a row written now arrives, once.
    const written = h.bridge.write({ from: 'mira', body: 'written after the rotation' });
    await settle();
    expect(h.now().messages.filter((message) => message.id === written.id)).toHaveLength(1);
    await h.advance(TEN_MINUTES);
    expect(h.now()).toMatchObject({ session: { status: 'signed-in' }, connection: 'online' });
    expect(h.stayedSignedIn()).toBe(true);
    expect(h.errors).toEqual([]);
  });

  it('asks a request again with the new token when it was sent with the old one and refused after the swap, where a refusal ends the session (the repo list)', async () => {
    const h = await start({ hold: [BRIDGE_ROUTES.repos] });
    // Signed in, with the repo list in flight under the first token.
    expect(h.now()).toMatchObject({ session: { status: 'signed-in' }, repos: [] });
    const first = h.token();

    const answered = await h.rotate('flan');
    h.bridge.release(BRIDGE_ROUTES.repos);
    await settle();

    expect(h.now().session.status).toBe('signed-in');
    expect(h.token()).toBe(answered.token);
    expect(h.token()).not.toBe(first);
    expect(h.now().repos.length).toBeGreaterThan(0);
    expect(h.now()).toMatchObject({ connection: 'online', selectedRepo: MAIN_REPO });
    expect(h.stayedSignedIn()).toBe(true);
  });

  it('asks a newest page again with the new token when the old one was refused after the swap, and opens the stream with the new one', async () => {
    const h = await start({ hold: [BRIDGE_ROUTES.messages] });
    // Signed in, the repo list is here, and the newest page is in flight under the first token.
    expect(h.now().repos.length).toBeGreaterThan(0);
    expect(h.now().messages).toEqual([]);
    expect(h.bridge.openStreams()).toBe(0);

    await h.rotate('flan');
    h.bridge.release(BRIDGE_ROUTES.messages);
    await settle();

    expect(h.now().session.status).toBe('signed-in');
    expect(h.now().messages.length).toBeGreaterThan(0);
    expect(h.now().connection).toBe('online');
    expect(h.bridge.openStreams()).toBe(2);
    expect(h.stayedSignedIn()).toBe(true);
  });

  it('waits for an answer that is still on its way: a 401 for the old token in the meantime does not end the session', async () => {
    const h = await start();
    let arrive!: () => void;
    const delayed = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    // The bridge has rotated and sent its byes; the answer to the panel is not here yet.
    const rotating = h.store.followRotation('flan', async () => {
      const answered = await h.rotateOnly('flan');
      await delayed;
      return answered;
    });
    await settle();
    expect(h.now().connection).toBe('offline');

    // The stream reconnects with the token it still holds, which is dead: the refusal waits for the answer.
    await h.advance(RECONNECT_WAIT_MS);
    expect(h.now().session.status).toBe('signed-in');

    arrive();
    const answered = await rotating;
    await settle();
    expect(h.token()).toBe(answered.token);
    expect(h.now()).toMatchObject({ session: { status: 'signed-in' }, connection: 'online' });
    expect(h.bridge.openStreams()).toBe(2);
    expect(h.stayedSignedIn()).toBe(true);
  });

  it('ends the session as always when the call fails after the bridge had rotated and refused the old token meanwhile', async () => {
    const h = await start();
    let fail!: () => void;
    const delayed = new Promise<void>((resolve) => {
      fail = resolve;
    });
    const rotating = h.store.followRotation('flan', async () => {
      await h.rotateOnly('flan');
      await delayed;
      throw new NetworkError('could not reach the bridge');
    });
    const outcome = rotating.then(() => null, (failure: unknown) => failure);
    await settle();
    await h.advance(RECONNECT_WAIT_MS);
    expect(h.now().session.status).toBe('signed-in');

    fail();
    expect(await outcome).toBeInstanceOf(NetworkError);
    await settle();
    // No new token came, so the old one's refusal stands.
    expect(h.now().session).toEqual({ status: 'signed-out', error: refusal('me-bad-token') });
    expect(h.token()).toBeNull();
  });

  it('still ends the session when the credential that is refused is the current one: a second rotation, by someone else, after the first was followed', async () => {
    const h = await start();
    await h.rotate('flan');
    await settle();
    expect(h.now().session.status).toBe('signed-in');

    // Another admin rotates it again; this store is not told, so its token is dead now.
    h.bridge.rotate('flan');
    await settle();
    await h.advance(RECONNECT_WAIT_MS);
    expect(h.now().session).toEqual({ status: 'signed-out', error: refusal('me-bad-token') });
    expect(h.token()).toBeNull();
    expect(h.now().messages).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  it('follows a second rotation of its own as it did the first', async () => {
    const h = await start();
    const one = await h.rotate('flan');
    await settle();
    const two = await h.rotate('flan');
    await settle();
    expect(two.token).not.toBe(one.token);
    expect(h.token()).toBe(two.token);
    expect(h.now()).toMatchObject({ session: { status: 'signed-in' }, connection: 'online' });
    expect(h.stayedSignedIn()).toBe(true);
  });
});

describe('a rotation that is not the session\'s own token', () => {
  it('passes the answer back and leaves the token, the session and the streams alone when it is another member\'s token', async () => {
    const h = await start();
    const first = h.token();
    const before = h.now();
    const asked = h.bridge.requests.length;

    const answered = await h.rotate('mira');
    await settle();
    await h.advance(TEN_MINUTES);

    expect(typeof answered.token).toBe('string');
    expect(h.token()).toBe(first);
    expect(h.now().session).toBe(before.session);
    expect(h.now().connection).toBe('online');
    // Only the rotation itself was asked of the bridge: no stream was reopened, no page reloaded.
    const since = h.bridge.requests.slice(asked).map((request) => request.route);
    expect(since.filter((route) => route === BRIDGE_ROUTES.rotate)).toHaveLength(1);
    expect(since.filter((route) => route === BRIDGE_ROUTES.stream || route === BRIDGE_ROUTES.messages || route === BRIDGE_ROUTES.repos)).toEqual([]);
    expect(h.stayedSignedIn()).toBe(true);
  });

  it('ends the session of a member whose token someone else rotated, after the same unrelated rotation was followed or not', async () => {
    const h = await start({ as: 'thom' });
    // A member is no admin, so thom cannot rotate; an admin elsewhere does. This store only hears the byes.
    await h.store.followRotation('mira', async () => ({ token: 'not-a-bridge-token' }));
    expect(h.token()).not.toBe('not-a-bridge-token');
    h.bridge.rotate('thom');
    await settle();
    await h.advance(RECONNECT_WAIT_MS);
    expect(h.now().session).toEqual({ status: 'signed-out', error: refusal('me-bad-token') });
    expect(h.token()).toBeNull();
  });

  it('passes a failure of the call on unchanged and leaves the token and the session alone', async () => {
    const h = await start();
    const first = h.token();
    const refused = new ApiError(403, ERROR_CODES.adminOnly, 'only an admin can do that');
    await expect(h.store.followRotation('flan', () => Promise.reject(refused))).rejects.toBe(refused);
    await settle();
    expect(h.token()).toBe(first);
    expect(h.now()).toMatchObject({ session: { status: 'signed-in' }, connection: 'online' });
    expect(h.stayedSignedIn()).toBe(true);
  });

  it('with a session through the tailnet identity there is no token to replace: nothing is adopted, and the streams come back by themselves', async () => {
    const h = await start({ via: 'identity' });
    expect(h.now().session.status).toBe('signed-in');
    expect(h.token()).toBeNull();
    const before = h.now();

    const answered = await h.rotate('flan');
    await settle();
    // The bridge's byes reach a tailnet stream too (closeStreamsFor); it reconnects after its backoff, as before.
    expect(h.now().connection).toBe('offline');
    await h.advance(RECONNECT_WAIT_MS);

    expect(typeof answered.token).toBe('string');
    expect(h.token()).toBeNull();
    expect(h.now().session).toBe(before.session);
    expect(h.now().connection).toBe('online');
    expect(h.bridge.requests.filter((request) => request.withToken)).toEqual([]);
    expect(h.stayedSignedIn()).toBe(true);
  });
});
