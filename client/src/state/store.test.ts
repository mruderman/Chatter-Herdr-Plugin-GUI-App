// @vitest-environment node
// The real store (store.ts) over the scripted bridge (fake-api.ts): sessions, the per-repo sync,
// the cursor, gaps, epochs, revocation, sends, paging, the marker, the directory and robustness.
// What the contract fixes word for word is in conformance.test.ts, against both stores.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { body, recordedError } from '../../test/fixtures/recorded';
import type { Api } from '../api/client';
import { ManualClock } from '../api/clock';
import { ApiError, CLIENT_ERROR_CODES, ERROR_CODES, NetworkError } from '../api/errors';
import { parseDirectory, parseMessagesPage } from '../api/guards';
import { QUERY, ROUTES } from '../api/routes';
import type { StreamTiming } from '../api/stream';
import { CHANNEL, type Directory, type Message } from '../api/types';
import type { FakeMember } from './fake';
import { BRIDGE_ROUTES, FakeBridge, MAIN_REPO, SITE_REPO } from './fake-api';
import { createStore } from './store';
import type { IncomingMessage, Store, StoreSnapshot } from './types';

const QUIET: Partial<StreamTiming> = { deadAfterMs: 24 * 60 * 60_000 };
const TEN_MINUTES = 10 * 60_000;
const refusal = (name: string) => {
  const { code, message } = recordedError(name);
  return { code, message };
};
const apiError = (name: string): ApiError => {
  const { status, code, message } = recordedError(name);
  return new ApiError(status, code, message);
};
const NETWORK = { code: CLIENT_ERROR_CODES.network, message: 'could not reach the bridge' };
const THOM_PAGE = parseMessagesPage(body('messages-thom'));
const THOM_NEWEST = THOM_PAGE.messages.at(-1)?.id ?? 0;

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

type Settled = 'pending' | 'resolved' | 'rejected';

/**
 * What became of a promise, readable at any moment without awaiting it: a store that never settles it
 * must fail on an expectation about the state, not on a timeout.
 */
function watch(promise: Promise<void>): { readonly state: Settled } {
  const watched = { state: 'pending' as Settled };
  void promise.then(
    () => {
      watched.state = 'resolved';
    },
    () => {
      watched.state = 'rejected';
    },
  );
  return watched;
}

/** The directory as the recording has it, then with a member added, then with an agent added too. */
const DIRECTORY_BEFORE = parseDirectory(body('directory'));
const DIRECTORY_AFTER: Directory = { members: [...DIRECTORY_BEFORE.members, { handle: 'wren', display_name: 'Wren', kind: 'human' }], agents: DIRECTORY_BEFORE.agents };
const DIRECTORY_LATER: Directory = { members: DIRECTORY_AFTER.members, agents: [...DIRECTORY_AFTER.agents, 'sage'] };

interface HeldRequest {
  readonly answer: (directory: Directory) => void;
  readonly fail: (error: unknown) => void;
}

/**
 * Takes directory() over once start() is called: every request is then held until the test answers or
 * fails it, so the test decides which request is out and in what order they finish. A request the store
 * drops (sign-out, revocation, dispose) fails with an AbortError, as a fetch does.
 */
function steerDirectory() {
  const asked: HeldRequest[] = [];
  let steering = false;
  const aborted = (): DOMException => new DOMException('The operation was aborted.', 'AbortError');
  return {
    asked,
    start(): void {
      steering = true;
    },
    wrap: (inner: Api): Api => ({
      ...inner,
      directory: (options) => {
        if (!steering) return inner.directory(options);
        return new Promise<Directory>((resolve, reject) => {
          asked.push({ answer: resolve, fail: reject });
          const signal = options?.signal;
          if (signal?.aborted) reject(aborted());
          signal?.addEventListener('abort', () => reject(aborted()), { once: true });
        });
      },
    }),
  };
}

interface HarnessOptions {
  readonly as?: FakeMember;
  /** 'identity': signed in on start through the tailnet header (the default). 'signed-out': a token is needed. */
  readonly start?: 'identity' | 'signed-out';
  readonly lastReadId?: number;
  readonly pageSize?: number;
  readonly streamTiming?: Partial<StreamTiming>;
  /** Scripts the bridge before the store asks it anything. */
  readonly before?: (bridge: FakeBridge) => void;
  /** Puts a layer between the store and the scripted bridge's Api, for a test that must control one route. */
  readonly wrap?: (api: Api) => Api;
}

const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function harness(options: HarnessOptions = {}) {
  const clock = new ManualClock();
  const as = options.as ?? 'thom';
  const bridge = new FakeBridge({ clock, identity: (options.start ?? 'identity') === 'identity' ? as : null, lastReadId: options.lastReadId });
  options.before?.(bridge);
  const errors: unknown[] = [];
  const { wrap } = options;
  const store = createStore({
    api: wrap ? (getToken) => wrap(bridge.api(getToken)) : bridge.api,
    clock,
    random: () => 0.5,
    streamTiming: options.streamTiming ?? QUIET,
    pageSize: options.pageSize,
    reportError: (error) => errors.push(error),
  });
  stores.push(store);
  const snapshots: StoreSnapshot[] = [];
  store.subscribe((snapshot) => snapshots.push(snapshot));
  const incoming: IncomingMessage[] = [];
  store.onIncoming((message) => incoming.push(message));
  await settle();
  const now = (): StoreSnapshot => store.getSnapshot();
  return {
    clock,
    bridge,
    store,
    errors,
    snapshots,
    incoming,
    now,
    bodies: (): string[] => now().messages.map((m) => m.body),
    open(label: string): void {
      const conversation = now().conversations.find((c) => c.label === label);
      if (!conversation) throw new Error(`no conversation "${label}"`);
      store.selectConversation(conversation.id);
    },
    async advance(ms: number): Promise<void> {
      clock.advance(ms);
      await settle();
    },
    /** Time passing in small steps, so retries that follow one another can each run. */
    async walk(ms: number, step = 250): Promise<void> {
      for (let passed = 0; passed < ms; passed += step) {
        clock.advance(step);
        await settle();
      }
    },
    streamCursors: (repo = MAIN_REPO): Array<number | null | undefined> =>
      bridge.requests.filter((r) => r.route === BRIDGE_ROUTES.stream && r.repo === repo).map((r) => r.lastEventId),
  };
}

describe('the session', () => {
  it('with no api option, wraps createApi on the page\'s own origin around the token in its closure', async () => {
    // A throwaway that opens nothing anywhere.
    const token = 'test-token-default-api';
    const sent: Array<{ readonly url: string; readonly authorization: string | null }> = [];
    const answer = (status: number, json: unknown): Response => Response.json(json, { status });
    vi.stubGlobal('fetch', async (url: string, init: RequestInit): Promise<Response> => {
      const authorization = new Headers(init.headers).get('authorization');
      sent.push({ url, authorization });
      if (url === ROUTES.me) return authorization === `Bearer ${token}` ? answer(200, body('me-computational')) : answer(401, body('me-unauthenticated'));
      if (url === ROUTES.directory) return answer(200, body('directory'));
      if (url === ROUTES.repos) return answer(200, body('repos-member'));
      return answer(404, body('not-found'));
    });
    const errors: unknown[] = [];
    const store = createStore({ clock: new ManualClock(), reportError: (error) => errors.push(error) });
    stores.push(store);
    await settle();
    expect(store.getSnapshot().session).toEqual({ status: 'signed-out', error: null });
    expect(await store.signIn(`  ${token}  `)).toBe(true);
    await settle();
    expect(store.getSnapshot()).toMatchObject({ session: { status: 'signed-in', me: { handle: 'thom' } }, selectedRepo: MAIN_REPO });
    expect(sent.filter((s) => s.url === ROUTES.me).map((s) => s.authorization)).toEqual([null, `Bearer ${token}`]);
    const afterSignIn = sent.slice(2);
    const newestPage = `${ROUTES.messages(MAIN_REPO)}?${QUERY.limit}=100`;
    expect(afterSignIn.map((s) => s.url)).toEqual(expect.arrayContaining([ROUTES.directory, ROUTES.repos, newestPage]));
    expect(afterSignIn.every((s) => s.authorization === `Bearer ${token}`)).toBe(true);
    expect(sent.filter((s) => s.url.includes(token))).toHaveLength(0);
    expect(errors).toEqual([]);
  });

  it('asks /v1/me on start without a token, and a 200 signs the member in', async () => {
    const h = await harness();
    expect(h.bridge.requests[0]).toEqual({ route: 'me', repo: null, withToken: false });
    expect(h.now().session).toMatchObject({ status: 'signed-in', me: { handle: 'thom' } });
    expect(h.errors).toEqual([]);
  });

  it('stays unknown while the bridge cannot be reached, asking again with backoff from 1 s up to 30 s', async () => {
    const h = await harness({ before: (bridge) => bridge.cut() });
    expect(h.now().session).toEqual({ status: 'unknown' });
    const delays: number[] = [];
    for (let round = 0; round < 7; round += 1) {
      const [delay] = h.clock.delays;
      if (delay === undefined) throw new Error('nothing scheduled');
      delays.push(delay);
      await h.advance(delay);
      expect(h.now().session.status).toBe('unknown');
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    expect(h.bridge.count(BRIDGE_ROUTES.me)).toBe(8);
    h.bridge.restore();
    await h.advance(30_000);
    expect(h.now().session.status).toBe('signed-in');
  });

  it('signIn trims the token and sends it; a wrong one is refused with the bridge\'s words', async () => {
    const h = await harness({ start: 'signed-out' });
    expect(h.now().session).toEqual({ status: 'signed-out', error: null });
    expect(await h.store.signIn('not-a-token')).toBe(false);
    expect(h.now().session).toEqual({ status: 'signed-out', error: refusal('me-bad-token') });
    expect(await h.store.signIn(`  ${h.bridge.tokenOf('thom')}\n`)).toBe(true);
    expect(h.bridge.requests.filter((r) => r.route === BRIDGE_ROUTES.me).map((r) => r.withToken)).toEqual([false, true, true]);
    await settle();
    expect(h.now()).toMatchObject({ session: { status: 'signed-in' }, connection: 'online', selectedRepo: MAIN_REPO });
  });

  it('signIn reports an unreachable bridge in the client\'s words', async () => {
    const h = await harness({ start: 'signed-out' });
    h.bridge.cut();
    expect(await h.store.signIn(h.bridge.tokenOf('thom'))).toBe(false);
    expect(h.now().session).toEqual({ status: 'signed-out', error: NETWORK });
  });

  it('signOut closes every stream, stops every timer and forgets everything loaded', async () => {
    const h = await harness();
    expect(h.bridge.openStreams()).toBe(2);
    h.store.signOut();
    await settle();
    expect(h.bridge.openStreams()).toBe(0);
    expect(h.clock.scheduled).toBe(0);
    expect(h.now()).toMatchObject({ session: { status: 'signed-out', error: null }, directory: null, repos: [], messages: [] });
    const asked = h.bridge.requests.length;
    await h.advance(TEN_MINUTES);
    expect(h.bridge.requests.length).toBe(asked);
  });

  it('ends the session, signed out with the bridge\'s error, when a stream closes as unauthorized (the token was rotated)', async () => {
    const h = await harness({ start: 'signed-out' });
    expect(await h.store.signIn(h.bridge.tokenOf('thom'))).toBe(true);
    await settle();
    expect(h.now().connection).toBe('online');
    h.bridge.rotate('thom');
    await settle();
    expect(h.now()).toMatchObject({ session: { status: 'signed-in' }, connection: 'offline' });
    await h.advance(500);
    expect(h.now().session).toEqual({ status: 'signed-out', error: refusal('me-bad-token') });
    expect(h.now().messages).toEqual([]);
    expect(h.bridge.openStreams()).toBe(0);
    expect(h.clock.scheduled).toBe(0);
    const asked = h.bridge.requests.length;
    await h.advance(TEN_MINUTES);
    expect(h.bridge.requests.length).toBe(asked);
  });

  it('ends the session when the repo list or a newest page is refused for credentials, since no stream runs yet to say so', async () => {
    const list = await harness({ before: (bridge) => bridge.failNext(BRIDGE_ROUTES.repos, apiError('me-bad-token')) });
    expect(list.now().session).toEqual({ status: 'signed-out', error: refusal('me-bad-token') });
    const page = await harness({ before: (bridge) => bridge.failNext(BRIDGE_ROUTES.messages, apiError('me-bad-token')) });
    expect(page.now().session).toEqual({ status: 'signed-out', error: refusal('me-bad-token') });
    expect(page.bridge.openStreams()).toBe(0);
  });
});

describe('revocation', () => {
  it('shows Access revoked, keeps what was loaded, and asks the bridge nothing more', async () => {
    const h = await harness();
    const loaded = h.now().messages;
    const asked = h.bridge.requests.length;
    h.bridge.revoke('thom');
    await settle();
    expect(h.now()).toMatchObject({ session: { status: 'signed-in' }, connection: 'revoked' });
    expect(h.now().messages).toEqual(loaded);
    await h.advance(TEN_MINUTES);
    expect(await h.store.send({ to: CHANNEL, body: 'still here?' })).toBe(false);
    await h.store.loadOlder();
    await h.store.markRead();
    await h.store.refreshDirectory();
    h.store.selectRepo(SITE_REPO);
    expect(h.bodies()).toEqual(['site repo kickoff']);
    await h.advance(TEN_MINUTES);
    expect(h.bridge.requests.length).toBe(asked);
    expect(h.bridge.openStreams()).toBe(0);
    expect(h.clock.scheduled).toBe(0);
    expect(h.now()).toMatchObject({ connection: 'revoked', sendError: null });
  });
});

describe('following repos', () => {
  it('follows every repo that is not an orphan, at most 8: the newest page, then a stream after the newest id that page held', async () => {
    const h = await harness({
      before: (bridge) => {
        for (let i = 0; i < 10; i += 1) bridge.addRepo({ key: `extra-${i}`, label: `extra${i}`, orphan: i === 0 });
      },
    });
    const followed = [MAIN_REPO, SITE_REPO, ...[1, 2, 3, 4, 5, 6].map((i) => `extra-${i}`)];
    const pages = h.bridge.requests.filter((r) => r.route === BRIDGE_ROUTES.messages);
    expect(pages.map((r) => r.repo)).toEqual(followed);
    expect(pages.map((r) => r.query)).toEqual(followed.map(() => ({ limit: 100 })));
    expect(h.bridge.openStreams()).toBe(8);
    // max_id is 16, but 15 and 16 are flan's DMs, which thom cannot see: the stream starts after 14.
    expect(THOM_PAGE.max_id).toBe(16);
    expect(h.streamCursors()).toEqual([THOM_NEWEST]);
    expect(h.streamCursors(SITE_REPO)).toEqual([1]);
    expect(h.streamCursors('extra-1')).toEqual([0]);
    expect(h.now().repos.map((r) => r.key)).toEqual([MAIN_REPO, SITE_REPO, ...Array.from({ length: 10 }, (_, i) => `extra-${i}`)]);

    // A repo outside them is followed while it is selected, and only then.
    h.store.selectRepo('extra-0');
    await settle();
    expect(h.now()).toMatchObject({ selectedRepo: 'extra-0', connection: 'online' });
    expect(h.bridge.openStreams()).toBe(9);
    h.store.selectRepo(MAIN_REPO);
    await settle();
    expect(h.bridge.openStreams()).toBe(8);
    expect(h.bodies()).toEqual(THOM_PAGE.messages.filter((m) => m.to === CHANNEL).map((m) => m.body));
  });

  it('starts each stream after the newest id its page held, so a row written in between is not lost', async () => {
    const h = await harness({ before: (bridge) => bridge.hold(BRIDGE_ROUTES.stream) });
    expect(h.streamCursors()).toEqual([THOM_NEWEST]);
    const between = h.bridge.write({ from: 'mira', body: 'written between the page and the stream' });
    h.bridge.release(BRIDGE_ROUTES.stream);
    await settle();
    expect(h.now().messages.at(-1)).toEqual(between);
    expect(h.incoming.map((i) => i.message.id)).toEqual([between.id]);
  });

  it('reports Syncing while the selected repo loads, Online once its stream is open, Offline while it retries, then Online', async () => {
    const h = await harness({ before: (bridge) => bridge.hold(BRIDGE_ROUTES.messages) });
    expect(h.now()).toMatchObject({ session: { status: 'signed-in' }, connection: 'syncing', selectedRepo: MAIN_REPO, messages: [] });
    h.bridge.release(BRIDGE_ROUTES.messages);
    await settle();
    expect(h.now().connection).toBe('online');
    h.bridge.cut();
    await settle();
    expect(h.now().connection).toBe('offline');
    await h.advance(500);
    expect(h.now().connection).toBe('offline');
    h.bridge.restore();
    await h.advance(30_000);
    expect(h.now().connection).toBe('online');
  });

  it('reports Syncing, not Offline, while a stream that never opened is still connecting', async () => {
    const h = await harness({
      before: (bridge) => bridge.failNext(BRIDGE_ROUTES.stream, new NetworkError('could not reach the bridge'), new NetworkError('could not reach the bridge')),
    });
    expect(h.now().connection).toBe('syncing');
    await h.advance(500);
    expect(h.now().connection).toBe('online');
  });

  it('presumes a silent stream dead: Offline, then Online once it reconnects', async () => {
    const h = await harness({ streamTiming: {} });
    expect(h.now().connection).toBe('online');
    await h.advance(45_000);
    expect(h.now().connection).toBe('offline');
    await h.advance(500);
    expect(h.now().connection).toBe('online');
  });

  it('replays what was missed while the network was down, once each and in order, and passes it on', async () => {
    const h = await harness();
    h.bridge.cut();
    await settle();
    expect(h.now().connection).toBe('offline');
    const missed = ['one', 'two', 'three'].map((text) => h.bridge.write({ from: 'mira', body: text }));
    h.bridge.restore();
    await h.advance(500);
    expect(h.now().connection).toBe('online');
    expect(h.now().messages.slice(-3)).toEqual(missed);
    expect(h.incoming.map((i) => i.message)).toEqual(missed);
    expect(h.streamCursors()).toEqual([THOM_NEWEST, THOM_PAGE.max_id]);
  });

  it('restarts a stream that failed from where the stream was, not from the top of the cache', async () => {
    const h = await harness();
    h.bridge.holdDelivery();
    const theirs = h.bridge.write({ from: 'mira', body: 'not yet delivered' });
    const sending = h.store.send({ to: CHANNEL, body: 'mine' });
    await settle();
    await h.advance(1_000);
    expect(await sending).toBe(true);
    expect(h.bodies()).toContain('mine');
    expect(h.bodies()).not.toContain(theirs.body);
    h.bridge.cut();
    await settle();
    const gone = new ApiError(404, ERROR_CODES.noSuchRepo, `no repo "${MAIN_REPO}"`);
    h.bridge.failNext(BRIDGE_ROUTES.stream, gone, gone);
    h.bridge.restore();
    h.bridge.releaseDelivery();
    await h.advance(500);
    expect(h.now().connection).toBe('offline');
    await h.advance(1_000);
    expect(h.now().connection).toBe('online');
    expect(h.streamCursors().at(-1)).toBe(THOM_PAGE.max_id);
    expect(h.incoming.map((i) => i.message)).toEqual([theirs]);
    expect(h.now().messages.filter((m) => m.body === 'mine')).toHaveLength(1);
  });
});

describe('messages', () => {
  it('keeps every message across gaps in the ids, and never reads a gap as a purge', async () => {
    const h = await harness();
    const asked = h.bridge.requests.length;
    h.bridge.writeInvisible();
    h.bridge.writeInvisible();
    const first = h.bridge.write({ from: 'mira', body: 'after a gap' });
    for (let i = 0; i < 10; i += 1) h.bridge.writeInvisible();
    const second = h.bridge.write({ from: 'grace', body: 'after a wider gap' });
    await settle();
    expect(second.id - first.id).toBe(11);
    expect(h.now().messages.slice(-2)).toEqual([first, second]);
    expect(h.now().messages.map((m) => m.id)).toEqual(THOM_PAGE.messages.filter((m) => m.to === CHANNEL).map((m) => m.id).concat(first.id, second.id));
    expect(h.now().hasMore).toBe(false);
    await h.store.loadOlder();
    expect(h.bridge.requests.length).toBe(asked);
  });

  it('shows a message that came back through both the send catch-up and the stream once', async () => {
    const h = await harness();
    h.bridge.holdDelivery();
    const sending = h.store.send({ to: CHANNEL, body: 'held back' });
    await settle();
    const pagesBefore = h.bridge.count(BRIDGE_ROUTES.messages);
    await h.advance(999);
    expect(h.bridge.count(BRIDGE_ROUTES.messages)).toBe(pagesBefore);
    await h.advance(1);
    expect(await sending).toBe(true);
    expect(h.bridge.requests.filter((r) => r.route === BRIDGE_ROUTES.messages).at(-1)?.query).toEqual({ afterId: THOM_NEWEST, limit: 500 });
    expect(h.bodies().filter((text) => text === 'held back')).toHaveLength(1);
    h.bridge.releaseDelivery();
    await settle();
    expect(h.bodies().filter((text) => text === 'held back')).toHaveLength(1);
    expect(h.bridge.count(BRIDGE_ROUTES.messages)).toBe(pagesBefore + 1);
    expect(h.now().announcement).toBeNull();
    expect(h.incoming).toEqual([]);
  });

  it('a send resolves once the stream brings the message back, with no page fetched', async () => {
    const h = await harness();
    const pages = h.bridge.count(BRIDGE_ROUTES.messages);
    expect(await h.store.send({ to: 'mira', body: 'quick one' })).toBe(true);
    expect(h.bridge.count(BRIDGE_ROUTES.messages)).toBe(pages);
    h.open('DM with mira');
    expect(h.bodies().at(-1)).toBe('quick one');
  });

  it('does not depend on the id in the send answer: with none, it waits for the message itself', async () => {
    const h = await harness();
    h.bridge.sendIdNull = true;
    const pages = h.bridge.count(BRIDGE_ROUTES.messages);
    const timers = h.clock.scheduled;
    expect(await h.store.send({ to: CHANNEL, body: '  no id came back  ' })).toBe(true);
    expect(h.bodies().at(-1)).toBe('no id came back');
    expect(h.bridge.count(BRIDGE_ROUTES.messages)).toBe(pages);
    // The 1 s wait was cancelled when the message came back.
    expect(h.clock.scheduled).toBe(timers);
  });

  it('the catch-up keeps only the member\'s own messages: the others still arrive through the stream and are passed on', async () => {
    const h = await harness();
    h.bridge.holdDelivery();
    const theirs = h.bridge.write({ from: 'mira', body: 'theirs, held' });
    const sending = h.store.send({ to: CHANNEL, body: 'mine, held' });
    await settle();
    await h.advance(1_000);
    expect(await sending).toBe(true);
    expect(h.bodies().slice(-1)).toEqual(['mine, held']);
    h.bridge.releaseDelivery();
    await settle();
    expect(h.bodies().slice(-2)).toEqual(['theirs, held', 'mine, held']);
    expect(h.incoming.map((i) => i.message)).toEqual([theirs]);
    expect(h.now().announcement).toEqual({ text: 'mira: theirs, held', seq: 1 });
  });

  it('a refused send or an unreachable bridge resolves false with the error to show', async () => {
    const h = await harness();
    h.bridge.failNext(BRIDGE_ROUTES.send, apiError('post-rate-limited'));
    expect(await h.store.send({ to: CHANNEL, body: 'too fast' })).toBe(false);
    expect(h.now().sendError).toEqual(refusal('post-rate-limited'));
    h.bridge.cut();
    expect(await h.store.send({ to: CHANNEL, body: 'offline' })).toBe(false);
    expect(h.now().sendError).toEqual(NETWORK);
    h.bridge.restore();
    h.bridge.failNext(BRIDGE_ROUTES.send, apiError('me-bad-token'));
    expect(await h.store.send({ to: CHANNEL, body: 'stale token' })).toBe(false);
    expect(h.now()).toMatchObject({ session: { status: 'signed-in' }, sendError: refusal('me-bad-token') });
    expect(h.bodies()).not.toContain('too fast');
  });

  it('does not show a send error in a conversation the member moved to while it was being sent', async () => {
    const h = await harness();
    h.bridge.hold(BRIDGE_ROUTES.send);
    h.bridge.failNext(BRIDGE_ROUTES.send, apiError('post-rate-limited'));
    const sending = h.store.send({ to: CHANNEL, body: 'slow' });
    h.open('DM with mira');
    h.bridge.release(BRIDGE_ROUTES.send);
    expect(await sending).toBe(false);
    expect(h.now().sendError).toBeNull();
  });

  it('drops the cache on an epoch change, then refetches the repo list and the newest page and restarts the stream', async () => {
    const h = await harness();
    h.open('DM with mira');
    const repos = h.bridge.count(BRIDGE_ROUTES.repos);
    const pages = h.bridge.count(BRIDGE_ROUTES.messages, MAIN_REPO);
    h.bridge.hold(BRIDGE_ROUTES.messages);
    h.bridge.purge(MAIN_REPO);
    await settle();
    expect(h.now()).toMatchObject({ connection: 'syncing', messages: [], conversations: [{ id: CHANNEL }] });
    expect(h.bridge.count(BRIDGE_ROUTES.repos)).toBe(repos + 1);
    h.bridge.release(BRIDGE_ROUTES.messages);
    await settle();
    expect(h.bridge.count(BRIDGE_ROUTES.messages, MAIN_REPO)).toBe(pages + 1);
    expect(h.now()).toMatchObject({ connection: 'online', selectedConversation: CHANNEL, newMarkerBeforeId: null });
    expect(h.streamCursors()).toEqual([THOM_NEWEST, 0]);
    const fresh = h.bridge.write({ from: 'mira', body: 'a new database' });
    await settle();
    expect(fresh.id).toBe(1);
    expect(h.now().messages).toEqual([fresh]);
    expect(h.incoming.map((i) => i.message)).toEqual([fresh]);
  });

  it('keeps the newest 1,000 by itself; a trim means older ones exist, and a page the member asks for is not dropped at once', async () => {
    const h = await harness();
    h.bridge.holdDelivery();
    for (let i = 0; i < 1_100; i += 1) h.bridge.write({ from: 'mira', body: `bulk ${i}` });
    h.bridge.releaseDelivery();
    await settle();
    expect(h.now().messages).toHaveLength(1_000);
    expect(h.now().messages[0]?.body).toBe('bulk 100');
    expect(h.now().hasMore).toBe(true);
    // The DMs went out of the cache, not out of the conversation list.
    expect(h.now().conversations.map((c) => c.label)).toEqual(['#chat', 'DM with codex', 'DM with grace', 'DM with mira']);
    await h.store.loadOlder();
    expect(h.now().messages).toHaveLength(1_100);
    expect(h.now().messages[0]?.body).toBe('bulk 0');
    expect(h.now().hasMore).toBe(true);
  });
});

describe('paging, the marker and the read pointer', () => {
  it('pages back with before_id of the lowest id held; overlapping calls share one request; a page may add nothing here', async () => {
    const h = await harness({ as: 'flan', pageSize: 2 });
    h.open('DM with codex');
    const shown = h.now().messages;
    expect(shown.map((m) => m.id)).toEqual([15, 16]);
    h.bridge.hold(BRIDGE_ROUTES.messages);
    const first = h.store.loadOlder();
    const second = h.store.loadOlder();
    expect(second).toBe(first);
    h.bridge.release(BRIDGE_ROUTES.messages);
    await first;
    expect(h.bridge.requests.filter((r) => r.route === BRIDGE_ROUTES.messages && r.query?.beforeId !== undefined).map((r) => r.query)).toEqual([{ beforeId: 15, limit: 2 }]);
    expect(h.now().messages).toEqual(shown);
    expect(h.now().hasMore).toBe(true);
  });

  it('places the marker when the selected conversation\'s messages first load, and fixes it there', async () => {
    const h = await harness({ as: 'mira', before: (bridge) => bridge.hold(BRIDGE_ROUTES.messages) });
    expect(h.now()).toMatchObject({ selectedConversation: CHANNEL, newMarkerBeforeId: null });
    h.bridge.release(BRIDGE_ROUTES.messages);
    await settle();
    expect(h.now().newMarkerBeforeId).toBe(7);
    h.bridge.write({ from: 'thom', body: 'later' });
    await settle();
    await h.store.markRead();
    expect(h.now().newMarkerBeforeId).toBe(7);
    // Past the moved pointer now, and still not where the marker goes until the conversation is opened again.
    h.bridge.write({ from: 'grace', body: 'after reading' });
    await settle();
    expect(h.now().newMarkerBeforeId).toBe(7);
  });

  it('posts the newest id of the selected conversation, and never one at or behind the pointer', async () => {
    const h = await harness({ as: 'mira' });
    await h.store.markRead();
    expect(h.bridge.requests.filter((r) => r.route === BRIDGE_ROUTES.read).map((r) => r.upToId)).toEqual([14]);
    expect(h.bridge.readPointer('mira')).toBe(14);
    h.open('DM with thom');
    await h.store.markRead();
    expect(h.bridge.count(BRIDGE_ROUTES.read)).toBe(1);

    const ahead = await harness({ as: 'mira', lastReadId: 100 });
    ahead.open('DM with thom');
    await ahead.store.markRead();
    ahead.open('#chat');
    await ahead.store.markRead();
    expect(ahead.bridge.count(BRIDGE_ROUTES.read)).toBe(0);
    expect(ahead.now().newMarkerBeforeId).toBeNull();
  });
});

describe('the directory', () => {
  it('is fetched on sign-in, for an unknown sender at most once a minute per handle, and every 5 minutes', async () => {
    const h = await harness();
    expect(h.bridge.count(BRIDGE_ROUTES.directory)).toBe(1);
    h.bridge.write({ from: 'mira', body: 'known' });
    await settle();
    expect(h.bridge.count(BRIDGE_ROUTES.directory)).toBe(1);
    h.bridge.write({ from: 'wren', body: 'new here' });
    await settle();
    expect(h.bridge.count(BRIDGE_ROUTES.directory)).toBe(2);
    h.bridge.write({ from: 'wren', body: 'still new' });
    await h.advance(59_999);
    h.bridge.write({ from: 'wren', body: 'within the minute' });
    await settle();
    expect(h.bridge.count(BRIDGE_ROUTES.directory)).toBe(2);
    await h.advance(1);
    h.bridge.write({ from: 'wren', body: 'a minute later' });
    await settle();
    expect(h.bridge.count(BRIDGE_ROUTES.directory)).toBe(3);
    await h.advance(5 * 60_000 - 60_000);
    expect(h.bridge.count(BRIDGE_ROUTES.directory)).toBe(4);
    await h.advance(5 * 60_000);
    expect(h.bridge.count(BRIDGE_ROUTES.directory)).toBe(5);
  });

  it('keeps the old directory when the bridge cannot be reached, and still resolves', async () => {
    const h = await harness();
    const before = h.now().directory;
    h.bridge.failNext(BRIDGE_ROUTES.directory, new NetworkError('could not reach the bridge'));
    await expect(h.store.refreshDirectory()).resolves.toBeUndefined();
    expect(h.now().directory).toBe(before);
    expect(h.errors).toEqual([]);
  });
});

/** A signed-in store whose directory requests, from now on, wait for the test (the sign-in load is done). */
async function steered() {
  const steer = steerDirectory();
  const h = await harness({ wrap: steer.wrap });
  steer.start();
  return { ...h, asked: steer.asked };
}
type Steered = Awaited<ReturnType<typeof steered>>;

// The admin panel calls refreshDirectory() once its change is made. A request that was already out
// may have been answered before the change, so a call is answered by a request that started after it:
// it may share one that is queued and has not started, never one that is running.
describe('the directory, when a request is already in flight', () => {
  it('lets two calls with nothing in flight share one request', async () => {
    const h = await steered();
    const first = watch(h.store.refreshDirectory());
    const second = watch(h.store.refreshDirectory());
    await settle();
    expect(h.asked).toHaveLength(1);
    expect([first.state, second.state]).toEqual(['pending', 'pending']);
    h.asked[0]?.answer(DIRECTORY_AFTER);
    await settle();
    expect([first.state, second.state]).toEqual(['resolved', 'resolved']);
    expect(h.asked).toHaveLength(1);
    expect(h.now().directory).toEqual(DIRECTORY_AFTER);
  });

  it('starts a second request only after the running one has settled, and resolves the call with that second answer', async () => {
    const h = await steered();
    expect(h.now().directory).toEqual(DIRECTORY_BEFORE);
    const running = watch(h.store.refreshDirectory());
    await settle();
    expect(h.asked).toHaveLength(1);
    // The panel's call, made after its change: the running request may be older than the change.
    const call = watch(h.store.refreshDirectory());
    await settle();
    expect(h.asked).toHaveLength(1);
    // The running request answers as the bridge had things before the change.
    h.asked[0]?.answer(DIRECTORY_BEFORE);
    await settle();
    expect(running.state).toBe('resolved');
    expect(h.asked).toHaveLength(2);
    expect(call.state).toBe('pending');
    h.asked[1]?.answer(DIRECTORY_AFTER);
    await settle();
    expect(call.state).toBe('resolved');
    expect(h.asked).toHaveLength(2);
    expect(h.now().directory).toEqual(DIRECTORY_AFTER);
  });

  it('shares the queued follow-up among the calls that arrive before it starts, and gives one that arrives while it runs a third request', async () => {
    const h = await steered();
    const running = watch(h.store.refreshDirectory());
    await settle();
    const early = watch(h.store.refreshDirectory());
    const sharing = watch(h.store.refreshDirectory());
    await settle();
    expect(h.asked).toHaveLength(1);
    h.asked[0]?.answer(DIRECTORY_BEFORE);
    await settle();
    expect(h.asked).toHaveLength(2);
    expect([running.state, early.state, sharing.state]).toEqual(['resolved', 'pending', 'pending']);
    const late = watch(h.store.refreshDirectory());
    await settle();
    expect(h.asked).toHaveLength(2);
    h.asked[1]?.answer(DIRECTORY_AFTER);
    await settle();
    expect(h.asked).toHaveLength(3);
    expect([early.state, sharing.state, late.state]).toEqual(['resolved', 'resolved', 'pending']);
    h.asked[2]?.answer(DIRECTORY_LATER);
    await settle();
    expect(late.state).toBe('resolved');
    expect(h.asked).toHaveLength(3);
    expect(h.now().directory).toEqual(DIRECTORY_LATER);
  });

  it('runs the follow-up when the request before it failed, and the failed one still resolves', async () => {
    const h = await steered();
    const running = watch(h.store.refreshDirectory());
    await settle();
    const call = watch(h.store.refreshDirectory());
    await settle();
    h.asked[0]?.fail(new NetworkError('could not reach the bridge'));
    await settle();
    expect(running.state).toBe('resolved');
    expect(h.asked).toHaveLength(2);
    expect(call.state).toBe('pending');
    h.asked[1]?.answer(DIRECTORY_AFTER);
    await settle();
    expect(call.state).toBe('resolved');
    expect(h.now().directory).toEqual(DIRECTORY_AFTER);
    expect(h.errors).toEqual([]);
  });

  it.each([
    ['the periodic refresh', async (h: Steered) => h.advance(5 * 60_000)],
    [
      'a message from a sender the directory does not know',
      async (h: Steered) => {
        h.bridge.write({ from: 'wren', body: 'new here' });
        await settle();
      },
    ],
  ])('gives the call that follows %s a request of its own, started later', async (_trigger, start) => {
    const h = await steered();
    await start(h);
    expect(h.asked).toHaveLength(1);
    const call = watch(h.store.refreshDirectory());
    await settle();
    expect(h.asked).toHaveLength(1);
    h.asked[0]?.answer(DIRECTORY_BEFORE);
    await settle();
    expect(h.asked).toHaveLength(2);
    expect(call.state).toBe('pending');
    h.asked[1]?.answer(DIRECTORY_AFTER);
    await settle();
    expect(call.state).toBe('resolved');
    expect(h.now().directory).toEqual(DIRECTORY_AFTER);
  });

  it.each([
    ['the member signs out', (h: Steered) => h.store.signOut()],
    ['the bridge revokes the member', (h: Steered) => h.bridge.revoke('thom')],
    ['the store is disposed', (h: Steered) => h.store.dispose()],
  ])('lets a follow-up that is still queued when %s go without a request, and resolves its callers', async (_end, end) => {
    const h = await steered();
    const running = watch(h.store.refreshDirectory());
    await settle();
    const queued = watch(h.store.refreshDirectory());
    await settle();
    expect(h.asked).toHaveLength(1);
    end(h);
    await settle();
    expect([running.state, queued.state]).toEqual(['resolved', 'resolved']);
    expect(h.asked).toHaveLength(1);
  });
});

describe('robustness', () => {
  it('a listener that throws does not stop the other listeners or the store', async () => {
    const clock = new ManualClock();
    const bridge = new FakeBridge({ clock, identity: 'thom' });
    const errors: unknown[] = [];
    const store = createStore({ api: bridge.api, clock, random: () => 0.5, streamTiming: QUIET, reportError: (error) => errors.push(error) });
    stores.push(store);
    store.subscribe(() => {
      throw new Error('a view bug');
    });
    const seen: StoreSnapshot[] = [];
    store.subscribe((snapshot) => seen.push(snapshot));
    store.onIncoming(() => {
      throw new Error('a notification bug');
    });
    const passed: IncomingMessage[] = [];
    store.onIncoming((incoming) => passed.push(incoming));
    await settle();
    expect(seen.at(-1)).toBe(store.getSnapshot());
    expect(store.getSnapshot().connection).toBe('online');
    const message = bridge.write({ from: 'mira', body: 'still flowing' });
    await settle();
    expect(passed.map((p) => p.message)).toEqual([message]);
    expect(await store.send({ to: CHANNEL, body: 'and sending' })).toBe(true);
    expect(store.getSnapshot().messages.at(-1)?.body).toBe('and sending');
    expect(errors.length).toBeGreaterThan(1);
    expect(errors.every((error) => error instanceof Error && /bug/.test(error.message))).toBe(true);
  });

  it('by default reports a listener\'s error on its own, without breaking the store', async () => {
    const thrown: unknown[] = [];
    const original = globalThis.queueMicrotask;
    vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((callback) => original(() => {
      try {
        callback();
      } catch (error) {
        thrown.push(error);
      }
    }));
    const clock = new ManualClock();
    const bridge = new FakeBridge({ clock, identity: 'thom' });
    const store = createStore({ api: bridge.api, clock, random: () => 0.5, streamTiming: QUIET });
    stores.push(store);
    store.subscribe(() => {
      throw new Error('a view bug');
    });
    await settle();
    expect(store.getSnapshot().connection).toBe('online');
    expect(thrown.length).toBeGreaterThan(0);
  });

  it('lets no rejection go unhandled, whatever fails', async () => {
    const unhandled: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const h = await harness({
        before: (bridge) => {
          bridge.failNext(BRIDGE_ROUTES.directory, new NetworkError('down'), new ApiError(500, ERROR_CODES.internal, 'internal error'));
          bridge.failNext(BRIDGE_ROUTES.repos, new ApiError(502, CLIENT_ERROR_CODES.unexpectedStatus, 'the bridge answered HTTP 502'));
          bridge.failNext(BRIDGE_ROUTES.messages, new NetworkError('down'));
          bridge.failNext(BRIDGE_ROUTES.stream, new ApiError(503, ERROR_CODES.schemaMismatch, 'layout changed'));
        },
      });
      await h.walk(60_000);
      expect(h.now().connection).toBe('online');
      expect(h.now().directory).not.toBeNull();
      h.bridge.failNext(BRIDGE_ROUTES.send, new NetworkError('down'));
      await h.store.send({ to: CHANNEL, body: 'x' });
      h.bridge.failNext(BRIDGE_ROUTES.read, new NetworkError('down'));
      await h.store.markRead();
      h.bridge.failNext(BRIDGE_ROUTES.directory, new ApiError(500, ERROR_CODES.internal, 'internal error'));
      await h.store.refreshDirectory();
      h.bridge.cut();
      await h.walk(60_000);
      h.bridge.restore();
      await h.walk(60_000);
      expect(h.now().connection).toBe('online');
      h.bridge.hold(BRIDGE_ROUTES.send);
      const pending = h.store.send({ to: CHANNEL, body: 'in flight' });
      h.store.signOut();
      h.bridge.release(BRIDGE_ROUTES.send);
      expect(await pending).toBe(false);
      expect(await h.store.signIn('wrong')).toBe(false);
      h.store.dispose();
      await settle();
      expect(h.errors).toEqual([]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('after dispose, nothing runs: no snapshot, no request, no timer', async () => {
    const h = await harness({ before: (bridge) => bridge.hold(BRIDGE_ROUTES.messages) });
    const published = h.snapshots.length;
    const asked = h.bridge.requests.length;
    const last = h.now();
    h.store.dispose();
    h.bridge.release(BRIDGE_ROUTES.messages);
    await settle();
    h.bridge.write({ from: 'mira', body: 'nobody listens' });
    await h.advance(TEN_MINUTES);
    expect(h.snapshots).toHaveLength(published);
    expect(h.now()).toBe(last);
    expect(h.bridge.requests.length).toBe(asked);
    expect(h.bridge.openStreams()).toBe(0);
    expect(h.clock.scheduled).toBe(0);
  });
});

describe('the cache', () => {
  it('never holds a message twice, even when a page and the stream overlap', async () => {
    const { merge } = await import('./cache');
    const page = THOM_PAGE.messages.map((m): Message => ({ ...m, mentions: [...m.mentions] }));
    const first = merge([], page.slice(0, 8));
    const second = merge(first.messages, page.slice(5));
    expect(second.messages.map((m) => m.id)).toEqual(page.map((m) => m.id));
    expect(second.added.map((m) => m.id)).toEqual(page.slice(8).map((m) => m.id));
    const again = merge(second.messages, [...page].reverse());
    expect(again.messages).toBe(second.messages);
    expect(again.added).toEqual([]);
  });
});
