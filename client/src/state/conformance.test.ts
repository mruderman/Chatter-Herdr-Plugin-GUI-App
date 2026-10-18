// @vitest-environment node
// The same expectations against the fake store (fake.ts, which the views are tested against) and
// the real one (store.ts over a scripted bridge, fake-api.ts), for everything the store contract
// fixes: labels and order, the new marker, send errors, announcements, the directory, sessions.
// A difference between the two is a bug in one of them.
import { describe, expect, it } from 'vitest';
import { body, recordedError } from '../../test/fixtures/recorded';
import type { Api } from '../api/client';
import { ManualClock } from '../api/clock';
import { parseDirectory, parseMessagesPage, parseRepos } from '../api/guards';
import { CHANNEL, type Directory, type Message } from '../api/types';
import { createFakeStore, FAKE_TOKEN, type FakeMember } from './fake';
import { FakeBridge, MAIN_REPO, SITE_REPO } from './fake-api';
import { NOTICE_LEAD, queuedText } from './send-notice';
import { createStore } from './store';
import type { IncomingMessage, Store, StoreSnapshot } from './types';

// Not a bridge token: the fake store never holds one.
const FAKE_ROTATED_TOKEN = 'fake-rotated-token';

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
  /** The bridge revokes the signed-in member, as an admin does from the panel or the CLI. */
  revoke(): Promise<void>;
  /** The admin panel rotates `handle`'s token through the store, as the app wires it; the token the answer carried. */
  rotate(handle: string): Promise<string>;
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
    revoke: async () => store.setConnection('revoked'),
    // The fake holds no token, so its answer is any string; what is checked is that the session goes on.
    rotate: async (handle) => (await store.followRotation(handle, async () => ({ token: FAKE_ROTATED_TOKEN }))).token,
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
  // The Api the panel calls the bridge with: the store's own getter of its token, as services.ts hands it on.
  let panel: Api | null = null;
  const store = createStore({
    api: (getToken) => {
      panel = bridge.api(getToken);
      return panel;
    },
    clock,
    random: () => 0.5,
    streamTiming: QUIET,
    pageSize: options.pageSize,
  });
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
    revoke: async () => {
      bridge.revoke(as);
      await settle();
    },
    rotate: async (handle) => {
      const api = panel;
      if (!api) throw new Error('the store built no Api');
      const answered = await store.followRotation(handle, () => api.rotateToken(handle));
      await settle();
      return answered.token;
    },
  });
};

const recordedPage = (who: string): readonly Message[] => parseMessagesPage(body(`messages-${who}`)).messages;
// bridge/src/policy.js, checkWrite, worded for the recorded directory's one agent, "codex".
const PREFIX_MENTION = (handle: string): string => `@${handle} is the start of the name of the Herdr agent codex, and Chatter could deliver it there; you may not address Herdr agents, so nothing was posted`;
const DM_START_OF_AN_AGENT = (handle: string): string => `"${handle}" is the start of the name of the Herdr agent codex, so Chatter could deliver this message to the agent instead; nothing was sent. An admin can rename the member or the agent.`;
const DM_START_OF_OWN_HANDLE = (handle: string): string => `"${handle}" is the start of your own handle, so Chatter would take it for you; nothing was sent. ${handle} can still message you, or an admin can rename one of you.`;
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

    // bridge/src/util.js mentionsOf: every mention is read as Chatter reads it and then whole, lower-cased.
    it.each([
      ['@everyoneX', ['everyonex'], true],
      ['@Everyone', [], true],
      ['@codX', ['cod', 'codx'], false],
      ['@gracE and @codX', ['grac', 'cod', 'grace', 'codx'], false],
      ['hi @codex-workerZ', ['codex-worker', 'codex-workerz'], false],
    ] as const)('reads the mentions of an arriving message %j as %j, everyone %s', async (text, handles, everyone) => {
      const d = await make();
      const message = await d.receive({ from: 'mira', body: text });
      expect(message.mentions).toEqual(handles);
      expect(message.everyone).toBe(everyone);
    });

    it.each([
      ['kieran', '@cod please', { code: 'agents_not_allowed', message: PREFIX_MENTION('cod') }],
      ['kieran', '@codX please', { code: 'agents_not_allowed', message: PREFIX_MENTION('cod') }],
      ['kieran', '@CODEX please', refusal('post-agents-not-allowed')],
      ['thom', '@everyoneX hi', refusal('post-everyone-member')],
      ['thom', 'mail a@everyone', refusal('post-everyone-member')],
      ['kieran', '@cod @everyone', refusal('post-everyone-member')],
    ] as const)('refuses %s sending %j as the bridge does, and writes nothing', async (as, text, expected) => {
      const d = await make({ as });
      expect(await d.store.send({ to: CHANNEL, body: text })).toBe(false);
      expect(d.now().sendError).toEqual(expected);
      expect(d.written()).toBe(0);
    });

    it('lets a member who may address agents mention one by the start of its name, and the admin post an @everyone that Chatter ends at a capital letter', async () => {
      const thom = await make({ as: 'thom' });
      expect(await thom.store.send({ to: CHANNEL, body: '@cod hello' })).toBe(true);
      expect(thom.now().messages.at(-1)).toMatchObject({ mentions: ['cod'], everyone: false });
      const flan = await make({ as: 'flan' });
      expect(await flan.store.send({ to: CHANNEL, body: '@everyoneX standup' })).toBe(true);
      expect(flan.now().messages.at(-1)).toMatchObject({ mentions: ['everyonex'], everyone: true });
    });

    // The recorded directory has no member whose handle is the start of an agent's name or of a sender's handle, so the
    // admin panel adds one and the store takes it up with a refresh.
    const withMembers = async (d: Driver, ...handles: string[]): Promise<void> => {
      const { members, agents } = parseDirectory(body('directory'));
      d.setDirectory({ members: [...members, ...handles.map((handle) => ({ handle, display_name: handle, kind: 'human' as const }))], agents });
      await d.store.refreshDirectory();
      await d.settle();
    };

    it.each(['kieran', 'thom', 'flan'] as const)('refuses %s a direct message to a member whose handle is the start of the name of an agent, with the bridge\'s ambiguous_recipient, and writes nothing', async (as) => {
      const d = await make({ as });
      await withMembers(d, 'cod');
      expect(await d.store.send({ to: 'cod', body: 'for cod, not for codex' })).toBe(false);
      expect(d.now().sendError).toEqual({ code: 'ambiguous_recipient', message: DM_START_OF_AN_AGENT('cod') });
      expect(d.written()).toBe(0);
    });

    it.each([
      ['kieran', 'kier'],
      ['thom', 'tho'],
      ['flan', 'fla'],
    ] as const)('refuses %s a direct message to %s, a proper prefix of the sender\'s own handle, and writes nothing', async (as, prefix) => {
      const d = await make({ as });
      await withMembers(d, prefix);
      expect(await d.store.send({ to: prefix, body: 'hello?' })).toBe(false);
      expect(d.now().sendError).toEqual({ code: 'ambiguous_recipient', message: DM_START_OF_OWN_HANDLE(prefix) });
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
        // Read as Chatter reads it (a capital letter ends the token) and then whole: "grace" first.
        created_at: '2026-10-10T12:00:00Z', mentions: ['grace', 'mira'], everyone: false,
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

  // SPEC section 5: a send the bridge accepts can still carry a warning (Chatter's notice that a mention
  // reaches nobody), and a message to an agent that no live session took is "queued". The sender is told, in
  // plain words beside the composer and in the Announcements region, until the next send, another
  // conversation or repo, or dismissal; never on a timer.
  describe('what the bridge says about a send it accepted (the send notice)', () => {
    const noAgent = (name: string): string => `mention @${name} matches no agent in this repo — not pushed`;

    it('has no notice before anything is sent, after an ordinary send, or after a DM to a member', async () => {
      const d = await make();
      expect(d.now().sendNotice).toBeNull();
      expect(await d.store.send({ to: CHANNEL, body: 'good morning @mira' })).toBe(true);
      expect(d.now().sendNotice).toBeNull();
      expect(await d.store.send({ to: 'mira', body: 'a private word' })).toBe(true);
      expect(d.now().sendNotice).toBeNull();
      expect(d.now().announcement).toBeNull();
    });

    it('shows the warning of a mention that reaches nobody as the bridge gave it, announces it, and still accepts the send', async () => {
      const d = await make();
      expect(await d.store.send({ to: CHANNEL, body: 'is anybody there @nobodyhere' })).toBe(true);
      expect(d.now().messages.at(-1)?.body).toBe('is anybody there @nobodyhere');
      expect(d.now().sendNotice).toEqual({ lead: NOTICE_LEAD, lines: [noAgent('nobodyhere')], seq: 1 });
      expect(d.now().announcement).toEqual({ text: `${NOTICE_LEAD} ${noAgent('nobodyhere')}`, seq: 1 });
      expect(d.now().sendError).toBeNull();
      expect(Object.isFrozen(d.now().sendNotice)).toBe(true);
    });

    it('says that a DM to an agent was saved but not delivered, and a mention that could only be queued the same way', async () => {
      const d = await make();
      expect(await d.store.send({ to: 'codex', body: 'ping' })).toBe(true);
      expect(d.now().sendNotice?.lines).toEqual([queuedText('codex')]);
      expect(d.now().selectedConversation).toBe(CHANNEL);
      expect(await d.store.send({ to: CHANNEL, body: 'hello @codex' })).toBe(true);
      expect(d.now().sendNotice).toEqual({ lead: NOTICE_LEAD, lines: [queuedText('codex')], seq: 2 });
    });

    it('lists a warning before the agents that were only queued', async () => {
      const d = await make();
      expect(await d.store.send({ to: CHANNEL, body: '@codex and @nobodyhere' })).toBe(true);
      expect(d.now().sendNotice?.lines).toEqual([noAgent('nobodyhere'), queuedText('codex')]);
    });

    it('stays while time passes: no timer takes it away', async () => {
      const d = await make();
      await d.store.send({ to: CHANNEL, body: '@nobodyhere' });
      const shown = d.now().sendNotice;
      await d.advance(60 * 60_000);
      expect(d.now().sendNotice).toBe(shown);
    });

    it('is replaced by the next send: cleared by an ordinary one, and a new notice of the same text has a new sequence number', async () => {
      const d = await make();
      await d.store.send({ to: CHANNEL, body: '@nobodyhere' });
      expect(await d.store.send({ to: CHANNEL, body: 'plain' })).toBe(true);
      expect(d.now().sendNotice).toBeNull();
      await d.store.send({ to: CHANNEL, body: '@nobodyhere' });
      expect(d.now().sendNotice?.seq).toBe(2);
      await d.store.send({ to: CHANNEL, body: '@nobodyhere' });
      expect(d.now().sendNotice?.seq).toBe(3);
      expect(d.now().announcement?.seq).toBe(3);
    });

    it('is cleared by a send that is refused, which shows its own error instead', async () => {
      const d = await make();
      await d.store.send({ to: CHANNEL, body: '@nobodyhere' });
      expect(await d.store.send({ to: CHANNEL, body: '@everyone wake up' })).toBe(false);
      expect(d.now().sendNotice).toBeNull();
      expect(d.now().sendError).not.toBeNull();
    });

    it('is cleared by opening another conversation, and kept for the conversation the message went to', async () => {
      const d = await make();
      await d.store.send({ to: 'codex', body: 'ping' });
      expect(d.now().sendNotice).not.toBeNull();
      d.open('DM with codex');
      expect(d.now().sendNotice?.lines).toEqual([queuedText('codex')]);
      d.open('#chat');
      expect(d.now().sendNotice).toBeNull();
      await d.store.send({ to: CHANNEL, body: '@nobodyhere' });
      d.open('DM with mira');
      expect(d.now().sendNotice).toBeNull();
    });

    it('is cleared by selecting another repo', async () => {
      const d = await make();
      await d.store.send({ to: CHANNEL, body: '@nobodyhere' });
      d.store.selectRepo(SITE_REPO);
      await d.settle();
      expect(d.now().sendNotice).toBeNull();
    });

    it('is cleared by dismissing it, which publishes once and does nothing when there is none', async () => {
      const d = await make();
      const before = d.now();
      d.store.dismissSendNotice();
      expect(d.now()).toBe(before);
      await d.store.send({ to: CHANNEL, body: '@nobodyhere' });
      d.store.dismissSendNotice();
      expect(d.now().sendNotice).toBeNull();
      const after = d.now();
      d.store.dismissSendNotice();
      expect(d.now()).toBe(after);
    });

    it('goes with the member on sign-out', async () => {
      const d = await make();
      await d.store.send({ to: CHANNEL, body: '@nobodyhere' });
      d.store.signOut();
      expect(d.now().sendNotice).toBeNull();
      expect(await d.store.signIn(d.token)).toBe(true);
      await d.settle();
      expect(d.now().sendNotice).toBeNull();
    });

    it('is announced at once, even right after someone else\'s message was, and the 3 seconds run from it', async () => {
      const d = await make();
      await d.receive({ from: 'mira', body: 'hello' });
      expect(d.now().announcement).toEqual({ text: 'mira: hello', seq: 1 });
      await d.store.send({ to: CHANNEL, body: '@nobodyhere' });
      expect(d.now().announcement).toEqual({ text: `${NOTICE_LEAD} ${noAgent('nobodyhere')}`, seq: 2 });
      await d.receive({ from: 'mira', body: 'again' });
      expect(d.now().announcement?.seq).toBe(2);
      await d.advance(3_000);
      expect(d.now().announcement).toEqual({ text: 'mira: again', seq: 3 });
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
      // The conversation list does not wait for the pages: the bridge lists every pair (V5 finding 9).
      expect(d.labels()).toEqual(['#chat', 'DM with codex', 'DM codex to thom', 'DM grace to thom', 'DM mira to thom']);
      expect(d.now().messages.map((m) => m.id)).toEqual(all.slice(-4).filter((m) => m.to === CHANNEL).map((m) => m.id));
      while (d.now().hasMore) await d.store.loadOlder();
      expect(d.now().messages).toEqual(all.filter((m) => m.to === CHANNEL));
      expect(d.labels()).toHaveLength(5);
    });

    // V5 finding 9. The recorded page holds 13 rows a member may see; a page of two leaves every DM of thom's
    // out of the loaded messages, and the conversation list must still have them, as the bridge's list does.
    describe('a direct message conversation older than the newest page (the conversation list from the bridge)', () => {
      it('is on the list from the start, with the id and the label of the loaded messages\' own conversation', async () => {
        const d = await make({ pageSize: 2 });
        expect(d.now().messages.map((m) => m.id)).toEqual([13, 14]);
        expect(d.now().conversations).toEqual([
          { kind: 'channel', id: CHANNEL, label: '#chat' },
          { kind: 'direct', id: 'dm:["codex","thom"]', label: 'DM with codex', peer: 'codex' },
          { kind: 'direct', id: 'dm:["grace","thom"]', label: 'DM with grace', peer: 'grace' },
          { kind: 'direct', id: 'dm:["mira","thom"]', label: 'DM with mira', peer: 'mira' },
        ]);
        // Exactly what the same member's list is when every message is loaded.
        expect((await make()).now().conversations).toEqual(d.now().conversations);
      });

      it('gives the admin every other pair too, observed and labelled by its two handles in alphabetical order, and his own as "DM with"', async () => {
        const d = await make({ as: 'flan', pageSize: 2 });
        expect(d.now().messages).toEqual([]);
        expect(d.now().conversations).toEqual([
          { kind: 'channel', id: CHANNEL, label: '#chat' },
          { kind: 'direct', id: 'dm:["codex","flan"]', label: 'DM with codex', peer: 'codex' },
          { kind: 'observed', id: 'dm:["codex","thom"]', label: 'DM codex to thom', from: 'codex', to: 'thom' },
          { kind: 'observed', id: 'dm:["grace","thom"]', label: 'DM grace to thom', from: 'grace', to: 'thom' },
          { kind: 'observed', id: 'dm:["mira","thom"]', label: 'DM mira to thom', from: 'mira', to: 'thom' },
        ]);
        expect((await make({ as: 'flan' })).now().conversations).toEqual(d.now().conversations);
      });

      it('lists a member whose pairs are all older than the page, and one with none, and shows neither the other\'s', async () => {
        expect((await make({ as: 'mira', pageSize: 2 })).labels()).toEqual(['#chat', 'DM with thom']);
        expect((await make({ as: 'kieran', pageSize: 2 })).labels()).toEqual(['#chat']);
      });

      it('opens empty, with older pages left, and shows its messages once they are paged in, oldest first', async () => {
        const d = await make({ pageSize: 2 });
        d.open('DM with mira');
        expect(d.now()).toMatchObject({ selectedConversation: 'dm:["mira","thom"]', messages: [], hasMore: true, newMarkerBeforeId: null });
        while (d.now().messages.length === 0 && d.now().hasMore) await d.store.loadOlder();
        expect(d.now().messages.map((m) => [m.id, m.from, m.to])).toEqual([[4, 'thom', 'mira'], [5, 'mira', 'thom']]);
      });

      it('is one entry when a message of the pair arrives later, in either direction', async () => {
        const d = await make({ pageSize: 2 });
        await d.receive({ from: 'mira', to: 'thom', body: 'a new word in an old DM' });
        expect(d.labels().filter((label) => label === 'DM with mira')).toHaveLength(1);
        expect(d.labels()).toEqual(['#chat', 'DM with codex', 'DM with grace', 'DM with mira']);
        d.open('DM with mira');
        expect(d.now().messages.map((m) => m.body)).toEqual(['a new word in an old DM']);
      });

      it('is one entry when the member sends the next message of it', async () => {
        const d = await make({ pageSize: 2 });
        expect(await d.store.send({ to: 'mira', body: 'my turn' })).toBe(true);
        expect(d.labels()).toEqual(['#chat', 'DM with codex', 'DM with grace', 'DM with mira']);
        d.open('DM with mira');
        expect(d.now().messages.map((m) => m.body)).toEqual(['my turn']);
      });

      it('is listed when the admin\'s page holds an observed pair\'s newest message in either direction, once', async () => {
        const d = await make({ as: 'flan', pageSize: 2 });
        await d.receive({ from: 'grace', to: 'thom', body: 'newer than anything loaded' });
        await d.receive({ from: 'thom', to: 'grace', body: 'and the answer' });
        expect(d.labels()).toEqual(['#chat', 'DM with codex', 'DM codex to thom', 'DM grace to thom', 'DM mira to thom']);
      });

      it('goes on being listed after sign-out and back in', async () => {
        const d = await make({ pageSize: 2 });
        d.store.signOut();
        expect(d.labels()).toEqual([]);
        expect(await d.store.signIn(d.token)).toBe(true);
        await d.settle();
        expect(d.labels()).toEqual(['#chat', 'DM with codex', 'DM with grace', 'DM with mira']);
      });
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

  // V5 finding 3: the Connection says "Access revoked"; a send then used to go nowhere without a word.
  describe('a session the bridge revoked', () => {
    it('tells the member that nothing was sent when they press Send, makes no write, and keeps everything readable', async () => {
      const d = await make();
      const loaded = d.now().messages;
      const written = d.written();
      await d.revoke();
      expect(d.now().connection).toBe('revoked');
      expect(await d.store.send({ to: CHANNEL, body: 'is anybody there?' })).toBe(false);
      expect(d.now().sendError).toEqual({ code: 'access_revoked', message: 'Access revoked, so nothing was sent.' });
      expect(d.written()).toBe(written);
      expect(d.now()).toMatchObject({ session: { status: 'signed-in' }, connection: 'revoked' });
      expect(d.now().messages).toEqual(loaded);
    });
  });

  // V5 finding 2: an admin who rotates their own token must stay signed in, on the new one.
  describe('the admin panel rotating a token through the store', () => {
    it('goes on as the same session when it is the member\'s own token: nothing is reloaded or lost', async () => {
      const d = await make({ session: 'signed-out', as: 'flan' });
      expect(await d.store.signIn(d.token)).toBe(true);
      await d.settle();
      const before = d.now();
      const fresh = await d.rotate('flan');
      await d.settle();
      expect(typeof fresh).toBe('string');
      expect(d.now()).toMatchObject({ session: before.session, connection: 'online', selectedRepo: before.selectedRepo, selectedConversation: before.selectedConversation });
      expect(d.now().messages).toEqual(before.messages);
      expect(d.now().conversations).toEqual(before.conversations);
      expect(d.snapshots.some((snapshot) => snapshot.session.status !== 'signed-in')).toBe(false);
    });

    it('passes the answer back and changes nothing when it is another member\'s token', async () => {
      const d = await make({ session: 'signed-out', as: 'flan' });
      expect(await d.store.signIn(d.token)).toBe(true);
      await d.settle();
      const before = d.now();
      expect(typeof (await d.rotate('mira'))).toBe('string');
      await d.settle();
      expect(d.now()).toBe(before);
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
