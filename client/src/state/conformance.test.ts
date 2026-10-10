// @vitest-environment node
// The same expectations against the fake store (fake.ts, which the views are tested against) and
// the real one (store.ts over a scripted bridge, fake-api.ts), for everything the store contract
// fixes: labels and order, the new marker, send errors, announcements, the directory, sessions.
// A difference between the two is a bug in one of them.
import { describe, expect, it } from 'vitest';
import { body, recordedError } from '../../test/fixtures/recorded';
import { ManualClock } from '../api/clock';
import { parseDirectory, parseMessagesPage, parseRepos } from '../api/guards';
import { CHANNEL, type Directory, type Message } from '../api/types';
import { createFakeStore, FAKE_TOKEN, type FakeMember } from './fake';
import { FakeBridge, MAIN_REPO, SITE_REPO } from './fake-api';
import { createStore } from './store';
import type { IncomingMessage, Store, StoreSnapshot } from './types';

type StartAs = 'signed-in' | 'signed-out' | 'unknown' | 'not-registered';

interface DriverOptions {
  readonly as?: FakeMember;
  readonly session?: StartAs;
  readonly pageSize?: number;
  readonly lastReadId?: number;
}

interface Arriving {
  readonly from: string;
  readonly to?: string;
  readonly body: string;
  readonly repo?: string;
}

interface Driver {
  readonly store: Store;
  /** The token this side signs in with. */
  readonly token: string;
  /** Snapshots published after the start settled. */
  readonly snapshots: StoreSnapshot[];
  readonly incoming: IncomingMessage[];
  now(): StoreSnapshot;
  labels(): string[];
  open(label: string): void;
  /** Someone else's message arrives through the stream. */
  receive(arriving: Arriving): Promise<Message>;
  advance(ms: number): Promise<void>;
  settle(): Promise<void>;
  setDirectory(directory: Directory): void;
  readPointer(repo: string): number;
  /** Drafts the bridge accepted and stored. */
  written(): number;
  scheduled(): number;
}

type MakeDriver = (options?: DriverOptions) => Promise<Driver>;

/** Lets every pending promise, stream read and callback run; the clock only moves in advance(). */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function finish(store: Store, rest: Omit<Driver, 'store' | 'snapshots' | 'incoming' | 'now' | 'labels' | 'open'>): Driver {
  const snapshots: StoreSnapshot[] = [];
  store.subscribe((snapshot) => snapshots.push(snapshot));
  const incoming: IncomingMessage[] = [];
  store.onIncoming((message) => incoming.push(message));
  const now = (): StoreSnapshot => store.getSnapshot();
  const labels = (): string[] => now().conversations.map((c) => c.label);
  const open = (label: string): void => {
    const conversation = now().conversations.find((c) => c.label === label);
    if (!conversation) throw new Error(`no conversation "${label}" in ${labels().join(', ')}`);
    store.selectConversation(conversation.id);
  };
  return { store, snapshots, incoming, now, labels, open, ...rest };
}

const fakeDriver: MakeDriver = async (options = {}) => {
  const clock = new ManualClock();
  const store = createFakeStore({ as: options.as, session: options.session, pageSize: options.pageSize, lastReadId: options.lastReadId, clock });
  return finish(store, {
    token: FAKE_TOKEN,
    receive: async (arriving) => store.receive(arriving),
    advance: async (ms) => clock.advance(ms),
    settle,
    setDirectory: (directory) => store.setDirectory(directory),
    readPointer: (repo) => store.readPointer(repo),
    written: () => store.sent.length,
    scheduled: () => clock.scheduled,
  });
};

// Long enough that no test's clock jump makes a quiet stream look dead.
const QUIET = { deadAfterMs: 24 * 60 * 60_000 };

const realDriver: MakeDriver = async (options = {}) => {
  const clock = new ManualClock();
  const as = options.as ?? 'thom';
  const session = options.session ?? 'signed-in';
  const identity = session === 'signed-in' ? as : session === 'not-registered' ? 'not-registered' : null;
  const bridge = new FakeBridge({ clock, identity, lastReadId: options.lastReadId });
  if (session === 'unknown') bridge.cut();
  const store = createStore({ api: bridge.api, clock, random: () => 0.5, streamTiming: QUIET, pageSize: options.pageSize });
  await settle();
  const rowsAtStart = bridge.rows(MAIN_REPO).length + bridge.rows(SITE_REPO).length;
  let received = 0;
  return finish(store, {
    token: bridge.tokenOf(as),
    receive: async (arriving) => {
      received += 1;
      const message = bridge.write(arriving);
      await settle();
      return message;
    },
    advance: async (ms) => {
      clock.advance(ms);
      await settle();
    },
    settle,
    setDirectory: (directory) => bridge.setDirectory(directory),
    readPointer: (repo) => bridge.readPointer(as, repo),
    written: () => bridge.rows(MAIN_REPO).length + bridge.rows(SITE_REPO).length - rowsAtStart - received,
    scheduled: () => clock.scheduled,
  });
};

const recordedPage = (who: string): readonly Message[] => parseMessagesPage(body(`messages-${who}`)).messages;
const refusal = (name: string) => {
  const { code, message } = recordedError(name);
  return { code, message };
};
/** The directory after the admin panel revoked ezra and temp, and a new member and a new agent turned up. */
const changedDirectory = (): Directory => {
  const { members, agents } = parseDirectory(body('directory'));
  return {
    members: [...members.filter((m) => m.handle !== 'ezra' && m.handle !== 'temp'), { handle: 'wren', display_name: 'Wren', kind: 'human' }],
    agents: [...agents, 'sage'],
  };
};

describe.each([
  ['fake', fakeDriver],
  ['real', realDriver],
] as const)('%s store, against the store contract', (_name, make) => {
  describe('seeded from the recordings', () => {
    it('starts signed in as thom with the recorded directory, repos and #chat', async () => {
      const s = (await make()).now();
      expect(s.session).toEqual({ status: 'signed-in', me: { handle: 'thom', display_name: 'Thom', kind: 'computational', role: 'member', can_address_agents: true } });
      expect(s.connection).toBe('online');
      expect(s.directory).toEqual(parseDirectory(body('directory')));
      expect(s.repos).toEqual(parseRepos(body('repos-member')).repos.map(({ key, label }) => ({ key, label })));
      expect(s.selectedRepo).toBe(MAIN_REPO);
      expect(s.selectedConversation).toBe(CHANNEL);
      expect(s.messages).toEqual(recordedPage('thom').filter((m) => m.to === CHANNEL));
      expect(s.hasMore).toBe(false);
      expect(s.newMarkerBeforeId).toBe(recordedPage('thom').find((m) => m.to === CHANNEL)?.id);
      expect(s.sendError).toBeNull();
      expect(s.announcement).toBeNull();
    });

    it('derives thom\'s DM conversations from his messages, sorted by peer', async () => {
      expect((await make()).labels()).toEqual(['#chat', 'DM with codex', 'DM with grace', 'DM with mira']);
    });

    it('gives the admin his own DMs and every other DM, each labelled by its two handles in alphabetical order', async () => {
      const d = await make({ as: 'flan' });
      expect(d.labels()).toEqual(['#chat', 'DM with codex', 'DM codex to thom', 'DM grace to thom', 'DM mira to thom']);
      expect(d.now().conversations).toEqual([
        { kind: 'channel', id: CHANNEL, label: '#chat' },
        { kind: 'direct', id: 'dm:["codex","flan"]', label: 'DM with codex', peer: 'codex' },
        { kind: 'observed', id: 'dm:["codex","thom"]', label: 'DM codex to thom', from: 'codex', to: 'thom' },
        { kind: 'observed', id: 'dm:["grace","thom"]', label: 'DM grace to thom', from: 'grace', to: 'thom' },
        { kind: 'observed', id: 'dm:["mira","thom"]', label: 'DM mira to thom', from: 'mira', to: 'thom' },
      ]);
    });

    it('gives kieran, who has no DMs, #chat alone', async () => {
      expect((await make({ as: 'kieran' })).labels()).toEqual(['#chat']);
    });

    it('shows both directions of a DM in one conversation, oldest first', async () => {
      const d = await make({ as: 'mira' });
      d.open('DM with thom');
      expect(d.now().messages.map((m) => [m.id, m.from, m.to])).toEqual([[4, 'thom', 'mira'], [5, 'mira', 'thom']]);
    });

    it('can start signed out or unknown, with nothing loaded', async () => {
      for (const session of ['signed-out', 'unknown'] as const) {
        const s = (await make({ session })).now();
        expect(s.session.status).toBe(session);
        expect([s.directory, s.selectedRepo, s.selectedConversation, s.newMarkerBeforeId]).toEqual([null, null, null, null]);
        expect([s.repos, s.conversations, s.messages]).toEqual([[], [], []]);
      }
    });

    it('hands out frozen snapshots, a new one per change and the same one when nothing changed', async () => {
      const d = await make();
      const before = d.now();
      expect(Object.isFrozen(before)).toBe(true);
      expect(Object.isFrozen(before.messages)).toBe(true);
      expect(Object.isFrozen(before.messages[0])).toBe(true);
      expect(Object.isFrozen(before.conversations[0])).toBe(true);
      d.store.selectConversation(CHANNEL);
      d.store.selectConversation('dm:["nobody","thom"]');
      expect(d.now()).toBe(before);
      expect(d.snapshots).toHaveLength(0);
      d.open('DM with mira');
      expect(d.now()).not.toBe(before);
      expect(d.snapshots).toEqual([d.now()]);
    });
  });

  describe('sessions', () => {
    it('signs in with the right token only', async () => {
      const d = await make({ session: 'signed-out' });
      expect(await d.store.signIn('wrong')).toBe(false);
      expect(d.now().session).toEqual({ status: 'signed-out', error: refusal('me-bad-token') });
      expect(await d.store.signIn('')).toBe(false);
      expect(d.now().session).toEqual({ status: 'signed-out', error: refusal('me-unauthenticated') });
      expect(await d.store.signIn(` ${d.token} `)).toBe(true);
      await d.settle();
      expect(d.now().session.status).toBe('signed-in');
      expect(d.now().selectedRepo).toBe(MAIN_REPO);
      expect(d.now().selectedConversation).toBe(CHANNEL);
      expect(d.now().messages).toEqual(recordedPage('thom').filter((m) => m.to === CHANNEL));
    });

    it('forgets everything on sign-out, with no error to show', async () => {
      const d = await make();
      d.store.signOut();
      const s = d.now();
      expect(s.session).toEqual({ status: 'signed-out', error: null });
      expect([s.directory, s.selectedRepo, s.selectedConversation, s.newMarkerBeforeId, s.announcement]).toEqual([null, null, null, null, null]);
      expect([s.repos, s.conversations, s.messages]).toEqual([[], [], []]);
    });

    it('can start signed out with the bridge\'s 403 not_registered, and nothing loaded', async () => {
      const s = (await make({ session: 'not-registered' })).now();
      expect(s.session).toEqual({
        status: 'signed-out',
        error: { code: 'not_registered', message: 'your Tailscale login is not registered as a member' },
      });
      expect([s.directory, s.selectedRepo, s.selectedConversation]).toEqual([null, null, null]);
      expect([s.repos, s.conversations, s.messages]).toEqual([[], [], []]);
    });

    it('starts signed out with no error when the first load was a plain 401', async () => {
      expect((await make({ session: 'signed-out' })).now().session).toEqual({ status: 'signed-out', error: null });
    });

    it('replaces the 403 with the failure of a token that is tried, and signs in with the right one', async () => {
      const d = await make({ session: 'not-registered' });
      expect(await d.store.signIn('wrong')).toBe(false);
      expect(d.now().session).toEqual({ status: 'signed-out', error: refusal('me-bad-token') });
      expect(await d.store.signIn(d.token)).toBe(true);
      expect(d.now().session.status).toBe('signed-in');
    });
  });

  describe('the directory', () => {
    it('keeps the old directory until refreshDirectory() runs, then publishes the staged one', async () => {
      const d = await make();
      const before = d.now();
      const staged = changedDirectory();
      d.setDirectory(staged);
      expect(d.now()).toBe(before);
      await d.store.refreshDirectory();
      expect(d.now().directory).toEqual(staged);
      expect(d.snapshots).toEqual([d.now()]);
      expect(Object.isFrozen(d.now().directory)).toBe(true);
      expect(Object.isFrozen(staged)).toBe(false);
    });

    it('publishes nothing when the directory has not changed since it was loaded or last refreshed', async () => {
      const d = await make();
      const before = d.now();
      await d.store.refreshDirectory();
      expect(d.now()).toBe(before);
      d.setDirectory(changedDirectory());
      await d.store.refreshDirectory();
      const after = d.now();
      await d.store.refreshDirectory();
      expect(d.now()).toBe(after);
      expect(d.snapshots).toEqual([after]);
    });

    it('does nothing while nobody is signed in, and a later sign-in loads the directory the bridge has by then', async () => {
      for (const session of ['signed-out', 'unknown', 'not-registered'] as const) {
        const d = await make({ session });
        d.setDirectory(changedDirectory());
        await d.store.refreshDirectory();
        expect(d.now().directory).toBeNull();
        expect(d.snapshots).toHaveLength(0);
      }
      const d = await make();
      d.store.signOut();
      d.setDirectory(changedDirectory());
      const published = d.snapshots.length;
      await d.store.refreshDirectory();
      expect(d.now().directory).toBeNull();
      expect(d.snapshots).toHaveLength(published);
      expect(await d.store.signIn(d.token)).toBe(true);
      await d.settle();
      expect(d.now().directory).toEqual(changedDirectory());
    });

    it('after dispose, leaves the directory and the snapshot as they were', async () => {
      const d = await make();
      const before = d.now();
      d.store.dispose();
      d.setDirectory(changedDirectory());
      await d.store.refreshDirectory();
      expect(d.now()).toBe(before);
    });
  });

  describe('sending, refused the way the bridge refuses', () => {
    it('refuses a member\'s @everyone with the bridge\'s words, keeps nothing and shows the error', async () => {
      const d = await make();
      const before = d.now().messages;
      expect(await d.store.send({ to: CHANNEL, body: '@everyone wake up' })).toBe(false);
      expect(d.now().sendError).toEqual({ code: 'everyone_admin_only', message: '@everyone is reserved for the admin; nothing was posted' });
      expect(d.now().sendError).toEqual(refusal('post-everyone-member'));
      expect(d.now().messages).toEqual(before);
      expect(d.written()).toBe(0);
    });

    it('lets the admin use @everyone', async () => {
      const d = await make({ as: 'flan' });
      expect(await d.store.send({ to: CHANNEL, body: '@everyone standup again' })).toBe(true);
      expect(d.now().messages.at(-1)).toMatchObject({ from: 'flan', everyone: true, mentions: [] });
    });

    it.each([
      ['kieran', { to: CHANNEL, body: '@codex hello' }, 'post-agents-not-allowed'],
      ['kieran', { to: 'codex', body: 'hello' }, 'post-dm-agent-not-allowed'],
      ['thom', { to: CHANNEL, body: '   ' }, 'post-empty'],
      ['thom', { to: 'thom', body: 'note to self' }, 'post-self-dm'],
      ['thom', { to: 'nobody', body: 'hello?' }, 'post-unknown-recipient'],
      ['thom', { to: CHANNEL, body: 'x'.repeat(8_001) }, 'post-too-long'],
      ['thom', { to: '', body: 'no recipient' }, 'post-missing-to'],
    ] as const)('refuses %s sending %j like the recording %s', async (as, draft, name) => {
      const d = await make({ as });
      expect(await d.store.send(draft)).toBe(false);
      expect(d.now().sendError).toEqual(refusal(name));
      expect(d.written()).toBe(0);
    });

    it('refuses a NUL with the bridge\'s code', async () => {
      const d = await make();
      expect(await d.store.send({ to: CHANNEL, body: 'a\u0000b' })).toBe(false);
      expect(d.now().sendError?.code).toBe('invalid_body');
    });

    it('applies the checks in the bridge\'s order: an empty body is empty_body before anything else', async () => {
      const d = await make();
      await d.store.send({ to: CHANNEL, body: '  ' });
      expect(d.now().sendError?.code).toBe('empty_body');
    });

    it('accepts a post as the bridge would store it, and clears the error', async () => {
      const d = await make();
      await d.store.send({ to: CHANNEL, body: '@everyone no' });
      expect(d.now().sendError).not.toBeNull();
      expect(await d.store.send({ to: CHANNEL, body: '  hi @Mira and @grace  ' })).toBe(true);
      const maxId = parseMessagesPage(body('messages-thom')).max_id;
      expect(d.now().messages.at(-1)).toEqual({
        id: maxId + 1, from: 'thom', to: CHANNEL, body: 'hi @Mira and @grace', kind: 'post', ref_id: null,
        created_at: '2026-10-10T12:00:00Z', mentions: ['mira', 'grace'], everyone: false,
      });
      expect(d.now().sendError).toBeNull();
      expect(d.written()).toBe(1);
      await d.advance(5_000);
      expect(d.now().announcement).toBeNull();
      expect(d.incoming).toEqual([]);
    });

    it('opens a new DM conversation when the member sends the first DM to someone', async () => {
      const d = await make();
      expect(d.labels()).not.toContain('DM with kieran');
      expect(await d.store.send({ to: 'kieran', body: 'hello kieran' })).toBe(true);
      expect(d.labels()).toEqual(['#chat', 'DM with codex', 'DM with grace', 'DM with kieran', 'DM with mira']);
      d.open('DM with kieran');
      expect(d.now().messages.map((m) => m.body)).toEqual(['hello kieran']);
    });

    it('clears the send error when another conversation is opened', async () => {
      const d = await make();
      await d.store.send({ to: CHANNEL, body: '@everyone no' });
      d.open('DM with mira');
      expect(d.now().sendError).toBeNull();
    });

    it('sends nothing when signed out', async () => {
      const d = await make({ session: 'signed-out' });
      expect(await d.store.send({ to: CHANNEL, body: 'hi' })).toBe(false);
      expect(d.now().sendError).toBeNull();
      expect(d.written()).toBe(0);
    });
  });

  describe('repos, paging and the new marker', () => {
    it('switches repos, opening #chat there', async () => {
      const d = await make();
      d.open('DM with mira');
      d.store.selectRepo(SITE_REPO);
      await d.settle();
      expect(d.now().selectedRepo).toBe(SITE_REPO);
      expect(d.now().selectedConversation).toBe(CHANNEL);
      expect(d.now().messages.map((m) => m.body)).toEqual(['site repo kickoff']);
      expect(d.labels()).toEqual(['#chat']);
      d.store.selectRepo('no-such-repo');
      expect(d.now().selectedRepo).toBe(SITE_REPO);
    });

    it('pages back over all of the member\'s messages, as the bridge does', async () => {
      const all = recordedPage('flan');
      const d = await make({ as: 'flan', pageSize: 4 });
      expect(d.now().hasMore).toBe(true);
      expect(d.labels()).toEqual(['#chat', 'DM with codex']);
      expect(d.now().messages.map((m) => m.id)).toEqual(all.slice(-4).filter((m) => m.to === CHANNEL).map((m) => m.id));
      while (d.now().hasMore) await d.store.loadOlder();
      expect(d.now().messages).toEqual(all.filter((m) => m.to === CHANNEL));
      expect(d.labels()).toHaveLength(5);
    });

    it('puts the marker before the first message past the read pointer, and keeps it there', async () => {
      const d = await make({ as: 'mira' });
      const firstUnread = recordedPage('mira').find((m) => m.to === CHANNEL && m.id > 5);
      expect(d.now().newMarkerBeforeId).toBe(firstUnread?.id);
      await d.receive({ from: 'thom', body: 'later' });
      await d.store.markRead();
      expect(d.now().newMarkerBeforeId).toBe(firstUnread?.id);
      expect(d.readPointer(MAIN_REPO)).toBe(d.now().messages.at(-1)?.id);
    });

    it('adds no marker for a message that arrives after the conversation opened with nothing unread', async () => {
      const d = await make({ as: 'mira', lastReadId: parseMessagesPage(body('messages-mira')).max_id });
      expect(d.now().newMarkerBeforeId).toBeNull();
      await d.receive({ from: 'thom', body: 'arrived while open' });
      expect(d.now().messages.at(-1)?.body).toBe('arrived while open');
      expect(d.now().newMarkerBeforeId).toBeNull();
    });

    it('has no marker when nothing was unread, and recomputes it when a conversation opens', async () => {
      const d = await make({ as: 'mira' });
      expect(d.now().newMarkerBeforeId).not.toBeNull();
      await d.store.markRead();
      d.open('DM with thom');
      expect(d.now().newMarkerBeforeId).toBeNull();
      d.open('#chat');
      expect(d.now().newMarkerBeforeId).toBeNull();
    });

    it('never moves the read pointer backward', async () => {
      const d = await make({ as: 'mira', lastReadId: 100 });
      await d.store.markRead();
      expect(d.readPointer(MAIN_REPO)).toBe(100);
      expect(d.now().newMarkerBeforeId).toBeNull();
    });
  });

  describe('arrivals, announcements and notifications', () => {
    it('shows an arriving message, announces it and passes it on for notifications', async () => {
      const d = await make();
      const message = await d.receive({ from: 'mira', body: 'hello @thom' });
      expect(d.now().messages.at(-1)).toEqual(message);
      expect(message).toMatchObject({ mentions: ['thom'], kind: 'post', created_at: '2026-10-10T12:00:00Z' });
      expect(d.now().announcement).toEqual({ text: 'mira: hello @thom', seq: 1 });
      expect(d.incoming).toEqual([{ repo: MAIN_REPO, message }]);
    });

    it('announces at most once per 3 seconds; a burst is counted, by conversation', async () => {
      const d = await make();
      await d.receive({ from: 'mira', body: 'one' });
      await d.receive({ from: 'mira', body: 'two' });
      await d.receive({ from: 'grace', body: 'three' });
      expect(d.now().announcement).toEqual({ text: 'mira: one', seq: 1 });
      await d.advance(2_999);
      expect(d.now().announcement?.seq).toBe(1);
      await d.advance(1);
      expect(d.now().announcement).toEqual({ text: '2 new messages in #chat', seq: 2 });
    });

    it('counts the conversations a burst spans instead of naming them, and repeats an identical text under a new seq', async () => {
      const d = await make();
      await d.receive({ from: 'mira', body: 'first' });
      await d.receive({ from: 'mira', to: 'thom', body: 'in private' });
      await d.receive({ from: 'grace', body: 'in public' });
      await d.advance(3_000);
      expect(d.now().announcement).toEqual({ text: '2 new messages in 2 conversations', seq: 2 });
      await d.advance(10_000);
      await d.receive({ from: 'mira', body: 'first' });
      expect(d.now().announcement).toEqual({ text: 'mira: first', seq: 3 });
    });

    it('counts messages and conversations separately: three messages in two conversations', async () => {
      const d = await make();
      await d.receive({ from: 'mira', body: 'one' });
      await d.receive({ from: 'mira', body: 'two' });
      await d.receive({ from: 'mira', to: 'thom', body: 'three' });
      await d.receive({ from: 'grace', body: 'four' });
      await d.advance(3_000);
      expect(d.now().announcement).toEqual({ text: '3 new messages in 2 conversations', seq: 2 });
    });

    it('names the conversation when a whole burst is in one DM', async () => {
      const d = await make();
      await d.receive({ from: 'mira', to: 'thom', body: 'one' });
      await d.receive({ from: 'mira', to: 'thom', body: 'two' });
      await d.receive({ from: 'mira', to: 'thom', body: 'three' });
      await d.advance(3_000);
      expect(d.now().announcement).toEqual({ text: '2 new messages in DM with mira', seq: 2 });
    });

    it('cuts a long announcement at 140 characters, not inside one', async () => {
      const d = await make();
      await d.receive({ from: 'mira', body: '𝄞'.repeat(150) });
      expect(d.now().announcement?.text).toBe(`mira: ${'𝄞'.repeat(140)}`);
    });

    it('never announces or passes on the member\'s own messages', async () => {
      const d = await make();
      await d.receive({ from: 'thom', body: 'echo of my own' });
      expect(d.now().messages.at(-1)?.body).toBe('echo of my own');
      await d.advance(5_000);
      expect(d.now().announcement).toBeNull();
      expect(d.incoming).toEqual([]);
    });

    it.each([
      ['mira', 'grace'],
      ['grace', 'mira'],
    ] as const)('shows the admin a new DM pair as one conversation labelled in alphabetical order (%s first)', async (first, second) => {
      const d = await make({ as: 'flan' });
      await d.receive({ from: first, to: second, body: 'hi' });
      await d.receive({ from: second, to: first, body: 'hi back' });
      expect(d.labels().filter((label) => label === 'DM grace to mira' || label === 'DM mira to grace')).toEqual(['DM grace to mira']);
      expect(d.now().conversations.find((c) => c.label === 'DM grace to mira')).toMatchObject({ kind: 'observed', from: 'grace', to: 'mira' });
      d.open('DM grace to mira');
      expect(d.now().messages.map((m) => m.body)).toEqual(['hi', 'hi back']);
    });

    it('orders the two handles by plain string comparison, which localeCompare would not for _ and -', async () => {
      const d = await make({ as: 'flan' });
      await d.receive({ from: 'a_b', to: 'a-b', body: 'hi' });
      expect(d.labels()).toContain('DM a-b to a_b');
      expect(d.labels()).not.toContain('DM a_b to a-b');
    });

    it('passes on a message for another repo without announcing it', async () => {
      const d = await make();
      const message = await d.receive({ from: 'mira', body: 'over in site', repo: SITE_REPO });
      expect(d.now().announcement).toBeNull();
      expect(d.incoming).toEqual([{ repo: SITE_REPO, message }]);
      expect(d.now().messages.map((m) => m.body)).not.toContain('over in site');
    });
  });

  describe('lifecycle', () => {
    it('after dispose, notifies nobody, drops pending announcements and leaves no timer', async () => {
      const d = await make();
      await d.receive({ from: 'mira', body: 'one' });
      await d.receive({ from: 'mira', body: 'two' });
      const count = d.snapshots.length;
      d.store.dispose();
      await d.advance(10_000);
      d.store.signOut();
      await d.settle();
      expect(d.snapshots).toHaveLength(count);
      expect(d.scheduled()).toBe(0);
    });
  });
});
