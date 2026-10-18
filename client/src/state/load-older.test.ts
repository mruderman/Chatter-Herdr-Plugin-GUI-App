// @vitest-environment node
// V5 finding 5. "Load older messages" pages the whole repo (`before_id`: 100 rows of every conversation the
// member may see), but the feed shows one conversation, so in a DM older than a page one press could load a page
// of other people's rows and change nothing on screen. The press of a direct or observed conversation now keeps
// asking until a message of it was added, the repo has no older page left, or a bound is reached (10 pages or
// 1,000 messages); #chat keeps one page per press. The real store (store.ts, repo-sync.ts) over the scripted
// bridge, with what the store returns and asks written out; conformance.test.ts runs the same cases against the
// fake store as well.
//
// The recordings: thom sees 13 rows (ids 1 to 9 and 11 to 14; his DMs are 4 and 5 with mira, 6 with grace, 8
// with codex); flan sees 15 (the same and 15 and 16, both with codex), and 10 is a mention copy nobody sees. The
// scripted bridge pages as bridge/src/messages.js does: `limit` rows older than `before_id`, has_more when more remain.
import { afterEach, describe, expect, it } from 'vitest';
import type { Api } from '../api/client';
import { ManualClock } from '../api/clock';
import { NetworkError } from '../api/errors';
import type { MessagesQuery } from '../api/types';
import type { FakeMember } from './fake';
import { BRIDGE_ROUTES, FakeBridge, MAIN_REPO } from './fake-api';
import { createStore } from './store';
import type { Store } from './types';

const QUIET = { deadAfterMs: 24 * 60 * 60_000 };
const NOT_LOOKED_BACK = { lookedBack: null };

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

interface StartOptions {
  readonly as?: FakeMember;
  readonly pageSize: number;
  /** Scripts the bridge before the store asks it anything. */
  readonly before?: (bridge: FakeBridge) => void;
  /** A layer between the store and the scripted bridge, for a test that must fail or watch a request. */
  readonly wrap?: (api: Api) => Api;
}

async function start(options: StartOptions) {
  const clock = new ManualClock();
  const as = options.as ?? 'thom';
  const bridge = new FakeBridge({ clock, identity: as });
  options.before?.(bridge);
  const errors: unknown[] = [];
  const { wrap } = options;
  const store = createStore({
    api: wrap ? (getToken) => wrap(bridge.api(getToken)) : bridge.api,
    clock,
    random: () => 0.5,
    streamTiming: QUIET,
    pageSize: options.pageSize,
    reportError: (error) => errors.push(error),
  });
  stores.push(store);
  await settle();
  return {
    bridge,
    store,
    errors,
    now: () => store.getSnapshot(),
    ids: (): number[] => store.getSnapshot().messages.map((message) => message.id),
    open(label: string): void {
      const conversation = store.getSnapshot().conversations.find((candidate) => candidate.label === label);
      if (!conversation) throw new Error(`no conversation "${label}"`);
      store.selectConversation(conversation.id);
    },
    /** Every request for an older page so far, as the bridge saw it, in order. */
    older: (): MessagesQuery[] =>
      bridge.requests.flatMap((request) => (request.route === BRIDGE_ROUTES.messages && request.query?.beforeId !== undefined ? [request.query] : [])),
  };
}

/** `count` channel posts by mira, newer than everything recorded, so that every recorded DM is further back. */
function postsAfter(count: number): (bridge: FakeBridge) => void {
  return (bridge) => {
    for (let i = 1; i <= count; i += 1) bridge.write({ from: 'mira', body: `a later post ${i}` });
  };
}

const askedFor = (query: readonly MessagesQuery[]): Array<number | undefined> => query.map((q) => q.beforeId);

describe('one press of "Load older messages" in a direct message conversation', () => {
  it('reaches a DM that is four pages back, asking below the lowest id held each time, and adds nothing to the other conversations\' view', async () => {
    const h = await start({ pageSize: 2 });
    h.open('DM with mira');
    expect(h.now()).toMatchObject({ messages: [], hasMore: true });
    expect(await h.store.loadOlder()).toEqual(NOT_LOOKED_BACK);
    expect(h.ids()).toEqual([4, 5]);
    expect(h.older()).toEqual([
      { beforeId: 13, limit: 2 },
      { beforeId: 11, limit: 2 },
      { beforeId: 8, limit: 2 },
      { beforeId: 6, limit: 2 },
    ]);
    // 1, 2 and 3 are still older: the button stays, and the next press is the member's to make.
    expect(h.now().hasMore).toBe(true);
    expect(h.errors).toEqual([]);
  });

  it('works the same for the admin\'s observed pair', async () => {
    const h = await start({ as: 'flan', pageSize: 2 });
    h.open('DM mira to thom');
    expect(h.ids()).toEqual([]);
    expect(await h.store.loadOlder()).toEqual(NOT_LOOKED_BACK);
    expect(h.ids()).toEqual([4, 5]);
    expect(askedFor(h.older())).toEqual([15, 13, 11, 8, 6]);
  });

  it('stops at the first page that adds a message of the conversation, even when it adds others too', async () => {
    const h = await start({ pageSize: 5 });
    h.open('DM with mira');
    expect(await h.store.loadOlder()).toEqual(NOT_LOOKED_BACK);
    // Older than 14, 13, 12, 11 and 9: the page of 8, 7, 6, 5 and 4 holds 5 and 4, so it is the only one asked for.
    expect(askedFor(h.older())).toEqual([9]);
    expect(h.ids()).toEqual([4, 5]);
  });

  it('counts a message found on the page that reaches the bound as found', async () => {
    // flan's newest page is 16; pages of one reach 5 (his DM with mira and thom is 4 and 5) on exactly the tenth older page.
    const h = await start({ as: 'flan', pageSize: 1 });
    h.open('DM mira to thom');
    expect(await h.store.loadOlder()).toEqual(NOT_LOOKED_BACK);
    expect(askedFor(h.older())).toEqual([16, 15, 14, 13, 12, 11, 9, 8, 7, 6]);
    expect(h.ids()).toEqual([5]);
  });

  it('gives up at 10 pages with nothing of the conversation, says how many messages it looked through, and goes on from there at the next press', async () => {
    // 40 more posts: the DM with mira (4 and 5) is the 49th and 50th row from the newest, 24 pages of two back.
    const h = await start({ pageSize: 2, before: postsAfter(40) });
    h.open('DM with mira');
    expect(h.ids()).toEqual([]);
    expect(await h.store.loadOlder()).toEqual({ lookedBack: 20 });
    expect(h.older()).toHaveLength(10);
    expect(h.ids()).toEqual([]);
    expect(h.now().hasMore).toBe(true);

    expect(await h.store.loadOlder()).toEqual({ lookedBack: 20 });
    expect(h.older()).toHaveLength(20);
    // Each page below the lowest id of the one before: the second press starts where the first stopped.
    const asked = askedFor(h.older());
    expect(asked.slice(10).every((id, i) => id !== undefined && id < (asked[9 + i] ?? 0))).toBe(true);

    expect(await h.store.loadOlder()).toEqual(NOT_LOOKED_BACK);
    expect(h.ids()).toEqual([4, 5]);
    expect(h.older()).toHaveLength(24);
    expect(h.errors).toEqual([]);
  });

  it('gives up at 1,000 messages before it reaches 10 pages, when the pages are large', async () => {
    // Pages of 500: two older pages make 1,000 loaded by that press, short of 10 pages. 1,700 posts leave the
    // DM (4 and 5) among the last 213 rows, past both.
    const h = await start({ pageSize: 500, before: postsAfter(1_700) });
    h.open('DM with mira');
    expect(await h.store.loadOlder()).toEqual({ lookedBack: 1_000 });
    expect(h.older()).toHaveLength(2);
    expect(h.ids()).toEqual([]);
    expect(h.now().hasMore).toBe(true);
  });

  it('stops when the repo has no older page left, and says nothing: the button goes', async () => {
    const h = await start({ pageSize: 2 });
    h.open('DM with codex');
    // Id 8 is the member's only DM with codex; once it is in, nothing older belongs to it, and the rest of the history is read.
    expect(await h.store.loadOlder()).toEqual(NOT_LOOKED_BACK);
    expect(h.ids()).toEqual([8]);
    expect(await h.store.loadOlder()).toEqual(NOT_LOOKED_BACK);
    expect(h.now().hasMore).toBe(false);
    expect(askedFor(h.older()).slice(-4)).toEqual([8, 6, 4, 2]);
  });

  it('does not look further than the one page for #chat, even when the page adds nothing to it', async () => {
    // flan's newest page is 16, a DM; the page before it is 15, another DM of the pair, and then #chat posts.
    const h = await start({ as: 'flan', pageSize: 1 });
    expect(h.ids()).toEqual([]);
    expect(await h.store.loadOlder()).toEqual(NOT_LOOKED_BACK);
    expect(h.older()).toEqual([{ beforeId: 16, limit: 1 }]);
    expect(h.ids()).toEqual([]);
    expect(await h.store.loadOlder()).toEqual(NOT_LOOKED_BACK);
    expect(h.older()).toEqual([{ beforeId: 16, limit: 1 }, { beforeId: 15, limit: 1 }]);
    expect(h.ids()).toEqual([14]);
  });

  it('loads exactly one page per press for #chat when the page adds #chat messages', async () => {
    const h = await start({ pageSize: 2 });
    expect(h.ids()).toEqual([13, 14]);
    await h.store.loadOlder();
    expect(h.older()).toHaveLength(1);
    expect(h.ids()).toEqual([11, 12, 13, 14]);
  });

  describe('a failure, overlap and a stop', () => {
    it('shares one chain between overlapping presses, and one request at a time', async () => {
      const h = await start({ pageSize: 2 });
      h.open('DM with mira');
      h.bridge.hold(BRIDGE_ROUTES.messages);
      const first = h.store.loadOlder();
      const second = h.store.loadOlder();
      expect(second).toBe(first);
      expect(h.older()).toHaveLength(1);
      h.bridge.release(BRIDGE_ROUTES.messages);
      expect(await first).toEqual(NOT_LOOKED_BACK);
      expect(h.older()).toHaveLength(4);
      expect(h.ids()).toEqual([4, 5]);
    });

    it('shares the chain with a press made in another conversation while it runs, and starts nothing of its own', async () => {
      const h = await start({ pageSize: 2 });
      h.open('DM with mira');
      h.bridge.hold(BRIDGE_ROUTES.messages);
      const first = h.store.loadOlder();
      h.store.selectConversation('#chat');
      const second = h.store.loadOlder();
      expect(second).toBe(first);
      h.bridge.release(BRIDGE_ROUTES.messages);
      await first;
      expect(h.older()).toHaveLength(4);
    });

    it('ends quietly when a request fails in the middle: no error, the button stays, and the next press goes on from the lowest id held', async () => {
      let olderAsked = 0;
      const h = await start({
        pageSize: 2,
        wrap: (api) => ({
          ...api,
          messages: (repo, query, options) => {
            if (query?.beforeId !== undefined) {
              olderAsked += 1;
              if (olderAsked === 2) return Promise.reject(new NetworkError('could not reach the bridge'));
            }
            return api.messages(repo, query, options);
          },
        }),
      });
      h.open('DM with mira');
      expect(await h.store.loadOlder()).toEqual(NOT_LOOKED_BACK);
      expect(olderAsked).toBe(2);
      expect(h.ids()).toEqual([]);
      expect(h.now().hasMore).toBe(true);
      expect(h.errors).toEqual([]);

      expect(await h.store.loadOlder()).toEqual(NOT_LOOKED_BACK);
      expect(h.ids()).toEqual([4, 5]);
      // The failed page is asked for again: 13 succeeded, 11 failed, and the second press begins at 11.
      expect(askedFor(h.older())).toEqual([13, 11, 8, 6]);
    });

    it.each([
      ['signing out', (h: Awaited<ReturnType<typeof start>>) => h.store.signOut()],
      ['the bridge revoking the member', (h: Awaited<ReturnType<typeof start>>) => h.bridge.revoke('thom')],
    ] as const)('asks for no more pages once the session is over: %s, with a request out', async (_how, end) => {
      const h = await start({ pageSize: 2 });
      h.open('DM with mira');
      h.bridge.hold(BRIDGE_ROUTES.messages);
      const press = h.store.loadOlder();
      expect(h.older()).toHaveLength(1);
      end(h);
      await settle();
      h.bridge.release(BRIDGE_ROUTES.messages);
      expect(await press).toEqual(NOT_LOOKED_BACK);
      await settle();
      expect(h.older()).toHaveLength(1);
      expect(h.errors).toEqual([]);
    });

    it('asks for no more pages when the session ends as a page arrives', async () => {
      const handle: { store?: Store } = {};
      const h = await start({
        pageSize: 2,
        wrap: (api) => ({
          ...api,
          messages: async (repo, query, options) => {
            const page = await api.messages(repo, query, options);
            // The member signs out in the moment the page is handed back: nothing may be asked after it.
            if (query?.beforeId !== undefined) handle.store?.signOut();
            return page;
          },
        }),
      });
      handle.store = h.store;
      h.open('DM with mira');
      expect(await h.store.loadOlder()).toEqual(NOT_LOOKED_BACK);
      await settle();
      expect(h.older()).toHaveLength(1);
    });

    it('ends when the repo\'s database is replaced while a page is out: the page belongs to no one', async () => {
      const h = await start({ pageSize: 2 });
      h.open('DM with mira');
      h.bridge.hold(BRIDGE_ROUTES.messages);
      const press = h.store.loadOlder();
      h.bridge.purge(MAIN_REPO);
      await settle();
      h.bridge.release(BRIDGE_ROUTES.messages);
      expect(await press).toEqual(NOT_LOOKED_BACK);
      await settle();
      expect(h.older()).toHaveLength(1);
      expect(h.ids()).toEqual([]);
    });
  });
});
