// @vitest-environment node
// The fake store keeps the store contract (types.ts) and the bridge's refusals, so views built
// against it behave the same against the real store.
import { describe, expect, it } from 'vitest';
import { body, recordedError } from '../../test/fixtures/recorded';
import { parseDirectory, parseMessagesPage, parseRepos } from '../api/guards';
import { CHANNEL, type Directory, type Message } from '../api/types';
import { createFakeStore, FAKE_TOKEN, type FakeStoreOptions } from './fake';
import type { IncomingMessage, StoreSnapshot } from './types';

function fake(options: FakeStoreOptions = {}) {
  const store = createFakeStore(options);
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
  return { store, snapshots, incoming, now, labels, open };
}

const recordedPage = (who: string): readonly Message[] => parseMessagesPage(body(`messages-${who}`)).messages;
const MAIN = parseMessagesPage(body('messages-flan')).repo;
const SITE = parseMessagesPage(body('messages-site')).repo;
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

describe('fake store: seeded from the recordings', () => {
  it('starts signed in as thom with the recorded directory, repos and #chat', () => {
    const f = fake();
    const s = f.now();
    expect(s.session).toEqual({ status: 'signed-in', me: { handle: 'thom', display_name: 'Thom', kind: 'computational', role: 'member', can_address_agents: true } });
    expect(s.connection).toBe('online');
    expect(s.directory).toEqual(parseDirectory(body('directory')));
    expect(s.repos).toEqual(parseRepos(body('repos-member')).repos.map(({ key, label }) => ({ key, label })));
    expect(s.selectedRepo).toBe(MAIN);
    expect(s.selectedConversation).toBe(CHANNEL);
    expect(s.messages).toEqual(recordedPage('thom').filter((m) => m.to === CHANNEL));
    expect(s.hasMore).toBe(false);
    expect(s.sendError).toBeNull();
    expect(s.announcement).toBeNull();
  });

  it('derives thom\'s DM conversations from his messages, sorted by peer', () => {
    expect(fake().labels()).toEqual(['#chat', 'DM with codex', 'DM with grace', 'DM with mira']);
  });

  it('gives the admin his own DMs and every other DM, each labelled by its two handles in alphabetical order', () => {
    const f = fake({ as: 'flan' });
    expect(f.labels()).toEqual(['#chat', 'DM with codex', 'DM codex to thom', 'DM grace to thom', 'DM mira to thom']);
    // `from` and `to` are the same alphabetical order and say nothing about who wrote first.
    expect(f.now().conversations.flatMap((c) => (c.kind === 'observed' ? [[c.from, c.to]] : []))).toEqual([
      ['codex', 'thom'],
      ['grace', 'thom'],
      ['mira', 'thom'],
    ]);
  });

  it('gives kieran, who has no DMs, #chat alone', () => {
    expect(fake({ as: 'kieran' }).labels()).toEqual(['#chat']);
  });

  it('shows both directions of a DM in one conversation, oldest first', () => {
    const f = fake({ as: 'mira' });
    f.open('DM with thom');
    expect(f.now().messages.map((m) => [m.from, m.to])).toEqual([['thom', 'mira'], ['mira', 'thom']]);
    expect(f.now().messages.map((m) => m.id)).toEqual([...f.now().messages.map((m) => m.id)].sort((a, b) => a - b));
  });

  it('can start signed out or unknown, with nothing loaded', () => {
    for (const session of ['signed-out', 'unknown'] as const) {
      const s = fake({ session }).now();
      expect(s.session.status).toBe(session);
      expect([s.directory, s.selectedRepo, s.selectedConversation]).toEqual([null, null, null]);
      expect([s.repos, s.conversations, s.messages]).toEqual([[], [], []]);
    }
  });

  it('hands out frozen snapshots, a new one per change and the same one when nothing changed', () => {
    const f = fake();
    const before = f.now();
    expect(Object.isFrozen(before)).toBe(true);
    expect(Object.isFrozen(before.messages)).toBe(true);
    expect(Object.isFrozen(before.messages[0])).toBe(true);
    f.store.selectConversation(CHANNEL);
    expect(f.now()).toBe(before);
    expect(f.snapshots).toHaveLength(0);
    f.open('DM with mira');
    expect(f.now()).not.toBe(before);
    expect(f.snapshots).toEqual([f.now()]);
  });
});

describe('fake store: sessions', () => {
  it('signs in with the fake token only', async () => {
    const f = fake({ session: 'signed-out' });
    expect(await f.store.signIn('wrong')).toBe(false);
    expect(f.now().session).toEqual({ status: 'signed-out', error: refusal('me-bad-token') });
    expect(await f.store.signIn('')).toBe(false);
    expect(f.now().session).toEqual({ status: 'signed-out', error: refusal('me-unauthenticated') });
    expect(await f.store.signIn(` ${FAKE_TOKEN} `)).toBe(true);
    expect(f.now().session.status).toBe('signed-in');
    expect(f.now().selectedRepo).toBe(MAIN);
  });

  it('forgets everything on sign-out, with no error to show', () => {
    const f = fake();
    f.store.signOut();
    const s = f.now();
    expect(s.session).toEqual({ status: 'signed-out', error: null });
    expect([s.directory, s.selectedRepo, s.repos, s.messages]).toEqual([null, null, [], []]);
  });

  // UI contract section 1: a first load that gets 403 not_registered shows its error at once, one
  // that gets a plain 401 shows none because nothing has been tried yet.
  it('can start signed out with the bridge\'s 403 not_registered, and nothing loaded', () => {
    const s = fake({ session: 'not-registered' }).now();
    expect(s.session).toEqual({
      status: 'signed-out',
      error: { code: 'not_registered', message: 'your Tailscale login is not registered as a member' },
    });
    expect([s.directory, s.selectedRepo, s.selectedConversation]).toEqual([null, null, null]);
    expect([s.repos, s.conversations, s.messages]).toEqual([[], [], []]);
  });

  it('starts signed out with no error when the first load was a plain 401', () => {
    expect(fake({ session: 'signed-out' }).now().session).toEqual({ status: 'signed-out', error: null });
  });

  it('replaces the 403 with the failure of a token that is tried, and signs in with the right one', async () => {
    const f = fake({ session: 'not-registered' });
    expect(f.now().session).toMatchObject({ status: 'signed-out', error: { code: 'not_registered' } });
    expect(await f.store.signIn('wrong')).toBe(false);
    expect(f.now().session).toEqual({ status: 'signed-out', error: refusal('me-bad-token') });
    expect(await f.store.signIn(FAKE_TOKEN)).toBe(true);
    expect(f.now().session.status).toBe('signed-in');
  });
});

describe('fake store: the directory', () => {
  it('keeps the old directory until refreshDirectory() runs, then publishes the staged one', async () => {
    const f = fake();
    const before = f.now();
    const staged = changedDirectory();
    f.store.setDirectory(staged);
    expect(f.now()).toBe(before);
    expect(f.snapshots).toHaveLength(0);
    await f.store.refreshDirectory();
    expect(f.now().directory).toEqual(staged);
    expect(f.now()).not.toBe(before);
    expect(f.snapshots).toEqual([f.now()]);
    expect(Object.isFrozen(f.now().directory)).toBe(true);
    // The snapshot holds a copy: freezing it must not reach into the test's own object.
    expect(Object.isFrozen(staged)).toBe(false);
  });

  it('publishes nothing when the directory has not changed since it was loaded or last refreshed', async () => {
    const f = fake();
    const before = f.now();
    await f.store.refreshDirectory();
    expect(f.now()).toBe(before);
    f.store.setDirectory(changedDirectory());
    await f.store.refreshDirectory();
    const after = f.now();
    await f.store.refreshDirectory();
    expect(f.now()).toBe(after);
    expect(f.snapshots).toEqual([after]);
  });

  it('does nothing while nobody is signed in, and a later sign-in loads the directory the bridge has by then', async () => {
    for (const session of ['signed-out', 'unknown', 'not-registered'] as const) {
      const f = fake({ session });
      f.store.setDirectory(changedDirectory());
      await f.store.refreshDirectory();
      expect(f.now().directory).toBeNull();
      expect(f.snapshots).toHaveLength(0);
    }
    const f = fake();
    f.store.signOut();
    f.store.setDirectory(changedDirectory());
    const published = f.snapshots.length;
    await f.store.refreshDirectory();
    expect(f.now().directory).toBeNull();
    expect(f.snapshots).toHaveLength(published);
    expect(await f.store.signIn(FAKE_TOKEN)).toBe(true);
    expect(f.now().directory).toEqual(changedDirectory());
  });

  it('after dispose, leaves the directory and the snapshot as they were', async () => {
    const f = fake();
    const before = f.now();
    f.store.dispose();
    f.store.setDirectory(changedDirectory());
    await f.store.refreshDirectory();
    expect(f.now()).toBe(before);
  });
});

describe('fake store: sending, refused the way the bridge refuses', () => {
  it('refuses a member\'s @everyone with the bridge\'s words, keeps nothing and shows the error', async () => {
    const f = fake();
    const before = f.now().messages;
    expect(await f.store.send({ to: CHANNEL, body: '@everyone wake up' })).toBe(false);
    expect(f.now().sendError).toEqual({ code: 'everyone_admin_only', message: '@everyone is reserved for the admin; nothing was posted' });
    expect(f.now().sendError).toEqual(refusal('post-everyone-member'));
    expect(f.now().messages).toEqual(before);
    expect(f.store.sent).toEqual([]);
  });

  it('lets the admin use @everyone', async () => {
    const f = fake({ as: 'flan' });
    expect(await f.store.send({ to: CHANNEL, body: '@everyone standup again' })).toBe(true);
    expect(f.now().messages.at(-1)).toMatchObject({ from: 'flan', everyone: true, mentions: [] });
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
    const f = fake({ as });
    expect(await f.store.send(draft)).toBe(false);
    expect(f.now().sendError).toEqual(refusal(name));
  });

  it('refuses a NUL with the bridge\'s code', async () => {
    const f = fake();
    expect(await f.store.send({ to: CHANNEL, body: 'a\u0000b' })).toBe(false);
    expect(f.now().sendError?.code).toBe('invalid_body');
  });

  it('applies the checks in the bridge\'s order: an empty @everyone is empty_body, not everyone_admin_only', async () => {
    const f = fake();
    await f.store.send({ to: CHANNEL, body: '  ' });
    expect(f.now().sendError?.code).toBe('empty_body');
  });

  it('accepts a post as the bridge would store it, and clears the error', async () => {
    const f = fake();
    await f.store.send({ to: CHANNEL, body: '@everyone no' });
    expect(f.now().sendError).not.toBeNull();
    expect(await f.store.send({ to: CHANNEL, body: '  hi @Mira and @grace  ' })).toBe(true);
    const sent = f.now().messages.at(-1);
    const maxId = parseMessagesPage(body('messages-thom')).max_id;
    expect(sent).toEqual({
      id: maxId + 1, from: 'thom', to: CHANNEL, body: 'hi @Mira and @grace', kind: 'post', ref_id: null,
      created_at: '2026-10-10T12:00:00Z', mentions: ['mira', 'grace'], everyone: false,
    });
    expect(f.now().sendError).toBeNull();
    expect(f.store.sent).toEqual([{ to: CHANNEL, body: '  hi @Mira and @grace  ' }]);
    expect(f.now().announcement).toBeNull();
    expect(f.incoming).toEqual([]);
  });

  it('opens a new DM conversation when the member sends the first DM to someone', async () => {
    const f = fake();
    expect(f.labels()).not.toContain('DM with kieran');
    expect(await f.store.send({ to: 'kieran', body: 'hello kieran' })).toBe(true);
    expect(f.labels()).toEqual(['#chat', 'DM with codex', 'DM with grace', 'DM with kieran', 'DM with mira']);
    f.open('DM with kieran');
    expect(f.now().messages.map((m) => m.body)).toEqual(['hello kieran']);
  });

  it('clears the send error when another conversation is opened', async () => {
    const f = fake();
    await f.store.send({ to: CHANNEL, body: '@everyone no' });
    f.open('DM with mira');
    expect(f.now().sendError).toBeNull();
  });

  it('sends nothing when signed out', async () => {
    const f = fake({ session: 'signed-out' });
    expect(await f.store.send({ to: CHANNEL, body: 'hi' })).toBe(false);
    expect(f.store.sent).toEqual([]);
  });
});

describe('fake store: repos, paging and the new marker', () => {
  it('switches repos, opening #chat there', () => {
    const f = fake();
    f.open('DM with mira');
    f.store.selectRepo(SITE);
    expect(f.now().selectedRepo).toBe(SITE);
    expect(f.now().selectedConversation).toBe(CHANNEL);
    expect(f.now().messages.map((m) => m.body)).toEqual(['site repo kickoff']);
    f.store.selectRepo('no-such-repo');
    expect(f.now().selectedRepo).toBe(SITE);
  });

  it('pages back over all of the member\'s messages, as the bridge does', async () => {
    const all = recordedPage('flan');
    const f = fake({ as: 'flan', pageSize: 4 });
    expect(f.now().hasMore).toBe(true);
    expect(f.labels()).toEqual(['#chat', 'DM with codex']);
    expect(f.now().messages.map((m) => m.id)).toEqual(all.slice(-4).filter((m) => m.to === CHANNEL).map((m) => m.id));
    while (f.now().hasMore) await f.store.loadOlder();
    expect(f.now().messages).toEqual(all.filter((m) => m.to === CHANNEL));
    expect(f.labels()).toHaveLength(5);
  });

  it('puts the marker before the first message past the read pointer, and keeps it there', async () => {
    const f = fake({ as: 'mira' });
    const firstUnread = recordedPage('mira').find((m) => m.to === CHANNEL && m.id > 5);
    expect(f.now().newMarkerBeforeId).toBe(firstUnread?.id);
    f.store.receive({ from: 'thom', body: 'later' });
    await f.store.markRead();
    expect(f.now().newMarkerBeforeId).toBe(firstUnread?.id);
    expect(f.store.readPointer(MAIN)).toBe(f.now().messages.at(-1)?.id);
  });

  it('adds no marker for a message that arrives after the conversation opened with nothing unread', () => {
    const f = fake({ as: 'mira', lastReadId: parseMessagesPage(body('messages-mira')).max_id });
    expect(f.now().newMarkerBeforeId).toBeNull();
    f.store.receive({ from: 'thom', body: 'arrived while open' });
    expect(f.now().newMarkerBeforeId).toBeNull();
  });

  it('has no marker when nothing was unread, and recomputes it when a conversation opens', async () => {
    const f = fake({ as: 'mira' });
    await f.store.markRead();
    f.open('DM with thom');
    expect(f.now().newMarkerBeforeId).toBeNull();
    f.open('#chat');
    expect(f.now().newMarkerBeforeId).toBeNull();
  });

  it('never moves the read pointer backward', async () => {
    const f = fake({ as: 'mira', lastReadId: 100 });
    await f.store.markRead();
    expect(f.store.readPointer(MAIN)).toBe(100);
    expect(f.now().newMarkerBeforeId).toBeNull();
  });
});

describe('fake store: arrivals, announcements and notifications', () => {
  it('shows an arriving message, announces it and passes it on for notifications', () => {
    const f = fake();
    const message = f.store.receive({ from: 'mira', body: 'hello @thom' });
    expect(f.now().messages.at(-1)).toEqual(message);
    expect(message).toMatchObject({ mentions: ['thom'], kind: 'post', created_at: '2026-10-10T12:00:00Z' });
    expect(f.now().announcement).toEqual({ text: 'mira: hello @thom', seq: 1 });
    expect(f.incoming).toEqual([{ repo: MAIN, message }]);
  });

  it('announces at most once per 3 seconds; a burst is counted, by conversation', () => {
    const f = fake();
    f.store.receive({ from: 'mira', body: 'one' });
    f.store.receive({ from: 'mira', body: 'two' });
    f.store.receive({ from: 'grace', body: 'three' });
    expect(f.now().announcement).toEqual({ text: 'mira: one', seq: 1 });
    f.store.clock.advance(2_999);
    expect(f.now().announcement?.seq).toBe(1);
    f.store.clock.advance(1);
    expect(f.now().announcement).toEqual({ text: '2 new messages in #chat', seq: 2 });
  });

  it('counts the conversations a burst spans instead of naming them, and repeats an identical text under a new seq', () => {
    const f = fake();
    f.store.receive({ from: 'mira', body: 'first' });
    f.store.receive({ from: 'mira', to: 'thom', body: 'in private' });
    f.store.receive({ from: 'grace', body: 'in public' });
    f.store.clock.advance(3_000);
    expect(f.now().announcement).toEqual({ text: '2 new messages in 2 conversations', seq: 2 });
    f.store.clock.advance(10_000);
    f.store.receive({ from: 'mira', body: 'first' });
    expect(f.now().announcement).toEqual({ text: 'mira: first', seq: 3 });
  });

  it('counts messages and conversations separately: three messages in two conversations', () => {
    const f = fake();
    f.store.receive({ from: 'mira', body: 'one' });
    f.store.receive({ from: 'mira', body: 'two' });
    f.store.receive({ from: 'mira', to: 'thom', body: 'three' });
    f.store.receive({ from: 'grace', body: 'four' });
    f.store.clock.advance(3_000);
    expect(f.now().announcement).toEqual({ text: '3 new messages in 2 conversations', seq: 2 });
  });

  it('names the conversation when a whole burst is in one DM', () => {
    const f = fake();
    f.store.receive({ from: 'mira', to: 'thom', body: 'one' });
    f.store.receive({ from: 'mira', to: 'thom', body: 'two' });
    f.store.receive({ from: 'mira', to: 'thom', body: 'three' });
    f.store.clock.advance(3_000);
    expect(f.now().announcement).toEqual({ text: '2 new messages in DM with mira', seq: 2 });
  });

  it('cuts a long announcement at 140 characters, not inside one', () => {
    const f = fake();
    // U+1D11E takes two UTF-16 units: cutting by units would split one in half.
    f.store.receive({ from: 'mira', body: '𝄞'.repeat(150) });
    expect(f.now().announcement?.text).toBe(`mira: ${'𝄞'.repeat(140)}`);
  });

  it('never announces or passes on the member\'s own messages', () => {
    const f = fake();
    f.store.receive({ from: 'thom', body: 'echo of my own' });
    expect(f.now().announcement).toBeNull();
    expect(f.incoming).toEqual([]);
  });

  it('refuses to deliver a DM the bridge would never show this member', () => {
    expect(() => fake().store.receive({ from: 'mira', to: 'grace', body: 'private' })).toThrow();
    expect(() => fake({ as: 'flan' }).store.receive({ from: 'mira', to: 'grace', body: 'private' })).not.toThrow();
  });

  it.each([
    ['mira', 'grace'],
    ['grace', 'mira'],
  ] as const)('shows the admin a new DM pair as one conversation labelled in alphabetical order, whichever way it began (%s first)', (first, second) => {
    const f = fake({ as: 'flan' });
    f.store.receive({ from: first, to: second, body: 'hi' });
    f.store.receive({ from: second, to: first, body: 'hi back' });
    expect(f.labels().filter((label) => label === 'DM grace to mira' || label === 'DM mira to grace')).toEqual(['DM grace to mira']);
    expect(f.now().conversations.find((c) => c.label === 'DM grace to mira')).toMatchObject({ kind: 'observed', from: 'grace', to: 'mira' });
    f.open('DM grace to mira');
    expect(f.now().messages.map((m) => m.body)).toEqual(['hi', 'hi back']);
  });

  it('orders the two handles by plain string comparison, which localeCompare would not for _ and -', () => {
    const f = fake({ as: 'flan' });
    f.store.receive({ from: 'a_b', to: 'a-b', body: 'hi' });
    // Code units rank '-' (0x2D) before '_' (0x5F); ICU's collation ranks '_' first.
    expect(f.labels()).toContain('DM a-b to a_b');
    expect(f.labels()).not.toContain('DM a_b to a-b');
  });

  it('passes on a message for another repo without announcing it', () => {
    const f = fake();
    const message = f.store.receive({ from: 'mira', body: 'over in site', repo: SITE });
    expect(f.now().announcement).toBeNull();
    expect(f.incoming).toEqual([{ repo: SITE, message }]);
  });
});

describe('fake store: lifecycle', () => {
  it('reports the connection a test sets', () => {
    const f = fake();
    f.store.setConnection('revoked');
    expect(f.now().connection).toBe('revoked');
  });

  it('after dispose, notifies nobody and drops pending announcements', () => {
    const f = fake();
    f.store.receive({ from: 'mira', body: 'one' });
    f.store.receive({ from: 'mira', body: 'two' });
    const count = f.snapshots.length;
    f.store.dispose();
    f.store.clock.advance(10_000);
    f.store.signOut();
    expect(f.snapshots).toHaveLength(count);
    expect(f.store.clock.scheduled).toBe(0);
  });
});
