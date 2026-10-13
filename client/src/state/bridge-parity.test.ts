// @vitest-environment node
// The fakes copy the bridge's rules for what a member may send: the fake store (fake.ts, which the
// views are tested against) and the scripted bridge (fake-api.ts, which the real store is tested
// against) both use fake.ts's refuseWrite and mentionsOf. This test does not trust that copy. It starts
// the real bridge over the real Chatter CLI (bridge/test/helpers.js makeEnv, as the Admin view's
// integration test does), sends the same table of messages as three members and compares what comes
// back. Needs CHATTER_JS, like the bridge's contract tests; skipped without it, and skipped is not
// passing.
//
// What is compared for each message and sender:
//   outcome  accepted or refused, and the code. The scripted bridge also gives the status; the fake
//            store has none to show, because the store contract carries only the code and the words.
//   words    the refusal's message, which is what the member reads.
//   stored   when it is accepted, the row as stored (to, kind, body, mentions, everyone) and, from the
//            scripted bridge, who was mentioned and how a DM to an agent was delivered.
// Not compared, because nothing here can produce it: the pushes and warnings that come from live Herdr
// agents; rate limits; a name that is an agent in another repo only (the world has one repo; it would be
// refused like the departed `rowan`, and for the same reason the fake cannot follow it).
// The bridge decides what a name is the start of from the repo's live roster; the fake has only the
// directory, which lists every agent of every repo, departed ones too. Where the two differ the fake
// cannot follow, and UNMODELLED names those cases.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '../api/errors';
import { parseDirectory, parseMe } from '../api/guards';
import { CHANNEL, type Directory, type Me, type Message } from '../api/types';
import { createFakeStore, type FakeMember } from './fake';
import { FakeBridge, MAIN_REPO } from './fake-api';

const CHATTER_JS = process.env.CHATTER_JS ?? '';
const HAVE_CHATTER = CHATTER_JS !== '' && existsSync(CHATTER_JS);
const SLOW = 180_000;
// A variable, not a literal: Vite takes `new URL('./x', import.meta.url)` for an asset import and rewrites it.
const HELPERS = '../../../bridge/test/helpers.js';
const CREATED = 201;

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

/** The part of makeEnv's result this test uses (bridge/test/helpers.js is plain JavaScript). */
interface Env {
  readonly repoInfo: { readonly dir: string };
  addMember(handle: string, options?: { kind?: string; role?: string; can_address_agents?: boolean }): string;
  /** A direct write to the scratch Chatter database, as the bridge's own tests do. */
  seedAgent(name: string): void;
  api(who: string, method: string, path: string, body?: unknown): Promise<Reply>;
  post(who: string, to: string, body: string): Promise<Reply>;
  messages(who: string, query?: string): Promise<Reply>;
  stop(): Promise<void>;
}

interface Database {
  prepare(sql: string): { run(...values: string[]): unknown };
  close(): void;
}

type MakeEnv = (options?: { limits?: { maxBody: number; postsPerMinute: number } }) => Promise<Env>;

/** The three senders: one of each standing the rules tell apart, and a member whose handle another member's is the start of. */
const SENDERS = [
  { role: 'restricted', handle: 'kieran', ownPrefix: 'kier' },
  { role: 'permitted', handle: 'mira', ownPrefix: 'mir' },
  { role: 'admin', handle: 'flan', ownPrefix: 'fla' },
] as const satisfies readonly { role: string; handle: FakeMember; ownPrefix: string }[];
type Sender = (typeof SENDERS)[number];

/**
 * The world, the same for the bridge and for the fakes (which are given the bridge's own directory):
 * agents seeded in alphabetical order, because the bridge lists the agents a name is the start of in the
 * order of its roster and the directory lists them sorted. Two have departed: `wren-old`, which no live
 * name starts with, and `rowan`, which is the start of the live `rowan-worker`.
 */
const AGENTS = ['codex-worker', 'ivy-one', 'ivy-two', 'rowan', 'rowan-worker', 'thomas-worker', 'wren-old'] as const;
const DEPARTED = ['rowan', 'wren-old'] as const;
const MEMBERS = [
  { handle: 'mira', kind: 'human', can_address_agents: true },
  { handle: 'kieran', kind: 'computational', can_address_agents: false },
  { handle: 'thom', kind: 'computational', can_address_agents: true },
  { handle: 'ana', kind: 'human', can_address_agents: true },
  { handle: 'ivy', kind: 'human', can_address_agents: true },
  { handle: 'wren', kind: 'human', can_address_agents: true },
  { handle: 'kier', kind: 'human', can_address_agents: true },
  { handle: 'mir', kind: 'human', can_address_agents: true },
  { handle: 'fla', kind: 'human', can_address_agents: true },
] as const;

interface Case {
  readonly name: string;
  /** "#chat", a handle, or the proper prefix of the sender's own handle. */
  readonly to: string | typeof OWN_PREFIX | typeof THEMSELVES;
  readonly body: string;
}
const OWN_PREFIX = Symbol('a proper prefix of the sender\'s own handle');
const THEMSELVES = Symbol('the sender');

const post = (name: string, body: string): Case => ({ name, to: CHANNEL, body });
const dm = (name: string, to: Case['to']): Case => ({ name, to, body: 'a private word' });

const CASES: readonly Case[] = [
  post('@everyone', '@everyone standup'),
  post('@Everyone', '@Everyone standup'),
  post('@everyoneX', '@everyoneX standup'),
  post('a@everyone', 'mail a@everyone'),
  post('@codex, the start of codex-worker', 'hi @codex'),
  post('@cod', 'hi @cod'),
  post('@codX', 'hi @codX'),
  post('@CODEX', 'hi @CODEX'),
  post('@codex-worker, the exact name', 'hi @codex-worker'),
  post('@codex-workerZ', 'hi @codex-workerZ'),
  post('@ivy, the start of two agents', 'hi @ivy'),
  post('@thomX, a member whose handle is the start of an agent', 'hi @thomX'),
  post('@codex before @everyone', '@codex @everyone'),
  post('a mention of a member', 'hi @ana'),
  post('a capitalised mention before a lower-case one', 'hi @Mira and @ana'),
  post('a mention nobody holds', 'hi @zzz'),
  post('a mention of @wren', 'hi @wren'),
  dm('a DM to cod, who is no member', 'cod'),
  dm('a DM to thom, the start of thomas-worker', 'thom'),
  dm('a DM to ivy, the start of two agents', 'ivy'),
  dm('a DM to codex-worker, the exact name', 'codex-worker'),
  dm('a DM to a proper prefix of the sender\'s own handle', OWN_PREFIX),
  dm('a DM to a member', 'ana'),
  dm('a DM to oneself', THEMSELVES),
  dm('a DM to wren', 'wren'),
  dm('a DM to nobody', 'nobody'),
  post('@rowan, a departed agent that is the start of a live one', 'hi @rowan'),
  dm('a DM to rowan-worker, the live agent', 'rowan-worker'),
  dm('a DM to wren-old, a departed agent that is the start of no live one', 'wren-old'),
  dm('a DM to rowan, a departed agent that is the start of a live one', 'rowan'),
];

const DEPARTED_AGENT = 'the directory lists a departed agent, which the bridge leaves out when it decides what a name is the start of; the fake has the directory and no roster';
const NOT_ON_THE_ROSTER = 'the directory offers a name that is not on this repo\'s live roster (a departed agent, or an agent of another repo) and is the start of a name that is; the bridge refuses a DM to it with 409 "is not a live agent of this repo", checked before the permission, while the fake takes every agent of the directory for a live one';

/**
 * The cases the fakes cannot answer as the bridge does, each with the reason. The test asserts this list
 * is exact: a case that differs and is not here fails, and so does a case here that does not differ, so a
 * gap is a decision written down and not an accident. Keys are "<case name> as <sender role>".
 */
const UNMODELLED: Readonly<Record<string, string>> = {
  'a mention of @wren as restricted': DEPARTED_AGENT,
  'a DM to wren as restricted': DEPARTED_AGENT,
  'a DM to wren as permitted': DEPARTED_AGENT,
  'a DM to wren as admin': DEPARTED_AGENT,
  'a DM to rowan, a departed agent that is the start of a live one as restricted': NOT_ON_THE_ROSTER,
  'a DM to rowan, a departed agent that is the start of a live one as permitted': NOT_ON_THE_ROSTER,
  'a DM to rowan, a departed agent that is the start of a live one as admin': NOT_ON_THE_ROSTER,
};

interface Stored {
  readonly to: string;
  readonly kind: string;
  readonly body: string;
  readonly mentions: readonly string[];
  readonly everyone: boolean;
}

interface Observed {
  /** The HTTP status; null for the fake store, whose contract has none. */
  readonly status: number | null;
  readonly refusal: { readonly code: string; readonly message: string } | null;
  readonly stored: Stored | null;
  /** Who the answer says was mentioned, and the delivery; null for the fake store, whose send has no answer. */
  readonly answer: { readonly mentioned: readonly string[]; readonly delivery: string | null } | null;
}

interface Row {
  readonly key: string;
  readonly real: Observed;
  readonly bridge: Observed;
  readonly store: Observed;
}

const toWhom = (sender: Sender, to: Case['to']): string => {
  if (to === OWN_PREFIX) return sender.ownPrefix;
  return to === THEMSELVES ? sender.handle : to;
};

const storedOf = (row: Message): Stored => ({ to: row.to, kind: row.kind, body: row.body, mentions: row.mentions, everyone: row.everyone });

const refusedWith = (status: number | null, code: string, message: string): Observed => ({ status, refusal: { code, message }, stored: null, answer: null });

/** The real bridge: a send over HTTP, then the stored row read back through the member's own view. */
async function askReal(env: Env, sender: Sender, to: string, text: string): Promise<Observed> {
  const reply = await env.post(sender.handle, to, text);
  if (reply.status !== CREATED) {
    const { error } = reply.body as { error?: { code?: string; message?: string } };
    return refusedWith(reply.status, error?.code ?? '', error?.message ?? '');
  }
  const sent = reply.body as { id: number | null; mentioned_members: string[]; delivery: string | null };
  const page = await env.messages(sender.handle, '?limit=500');
  const row = (page.body as { messages: Message[] }).messages.find((candidate) => candidate.id === sent.id);
  if (!row) throw new Error(`the real bridge accepted "${text}" as ${sender.handle} but gave no row to read back (id ${String(sent.id)})`);
  return { status: reply.status, refusal: null, stored: storedOf(row), answer: { mentioned: sent.mentioned_members, delivery: sent.delivery } };
}

/** The scripted bridge, fresh for each row, serving the real directory. */
async function askScriptedBridge(directory: Directory, sender: Sender, to: string, text: string): Promise<Observed> {
  const bridge = new FakeBridge();
  bridge.setDirectory(directory);
  try {
    const sent = await bridge.api(() => bridge.tokenOf(sender.handle)).send(MAIN_REPO, { to, body: text });
    const row = bridge.rows(MAIN_REPO).find((candidate) => candidate.id === sent.id);
    if (!row) throw new Error(`the scripted bridge accepted "${text}" as ${sender.handle} but stored no row`);
    return { status: CREATED, refusal: null, stored: storedOf(row), answer: { mentioned: sent.mentioned_members, delivery: sent.delivery } };
  } catch (error) {
    if (error instanceof ApiError) return refusedWith(error.status, error.code, error.message);
    throw error;
  }
}

/** The fake store, fresh for each row, holding the real directory. */
async function askFakeStore(directory: Directory, sender: Sender, to: string, text: string): Promise<Observed> {
  const store = createFakeStore({ as: sender.handle });
  store.setDirectory(directory);
  await store.refreshDirectory();
  const accepted = await store.send({ to, body: text });
  const { sendError, conversations } = store.getSnapshot();
  if (!accepted) {
    if (!sendError) throw new Error(`the fake store refused "${text}" as ${sender.handle} without saying why`);
    return refusedWith(null, sendError.code, sendError.message);
  }
  const conversation = conversations.find((candidate) => (to === CHANNEL ? candidate.kind === 'channel' : candidate.kind === 'direct' && candidate.peer === to));
  if (!conversation) throw new Error(`the fake store accepted "${text}" as ${sender.handle} but shows no conversation for it`);
  store.selectConversation(conversation.id);
  const row = store.getSnapshot().messages.at(-1);
  if (!row) throw new Error(`the fake store accepted "${text}" as ${sender.handle} but shows no message`);
  return { status: null, refusal: null, stored: storedOf(row), answer: null };
}

type Aspect = 'outcome' | 'words' | 'stored';

/** How a fake's answer differs from the real bridge's, by what differs. */
function against(real: Observed, fake: Observed): Aspect[] {
  const found: Aspect[] = [];
  const realCode = real.refusal?.code ?? null;
  const fakeCode = fake.refusal?.code ?? null;
  if (realCode !== fakeCode || (fake.status !== null && fake.status !== real.status)) found.push('outcome');
  else if (real.refusal && fake.refusal && real.refusal.message !== fake.refusal.message) found.push('words');
  else if (real.stored && fake.stored) {
    const answers = real.answer && fake.answer ? JSON.stringify(real.answer) !== JSON.stringify(fake.answer) : false;
    if (JSON.stringify(real.stored) !== JSON.stringify(fake.stored) || answers) found.push('stored');
  }
  return found;
}

const disagreements = (row: Row): Aspect[] => [...new Set([...against(row.real, row.bridge), ...against(row.real, row.store)])];

function show(observed: Observed): string {
  if (!observed.refusal) return `accepted${observed.status === null ? '' : ` ${observed.status}`}`;
  return `${observed.status === null ? 'refused' : observed.status} ${observed.refusal.code}`;
}

const describeRow = (row: Row): string => `${row.key}: real bridge ${show(row.real)}; scripted bridge ${show(row.bridge)}; fake store ${show(row.store)}`;

/** The real bridge's own view of a directory it served, through the client's guard. */
const directoryOf = (reply: Reply): Directory => parseDirectory(reply.body);

describe.skipIf(!HAVE_CHATTER)('the fakes against the real bridge and Chatter (needs CHATTER_JS)', () => {
  let env: Env;
  let directory: Directory;
  const rows: Row[] = [];

  beforeAll(async () => {
    // Loaded by URL so the type checker does not look for types the JavaScript helper does not have.
    const { makeEnv } = (await import(/* @vite-ignore */ new URL(HELPERS, import.meta.url).href)) as { makeEnv: MakeEnv };
    // The limits replace the bridge's defaults whole; 75 sends from three members are well over 20 a minute.
    env = await makeEnv({ limits: { maxBody: 8_000, postsPerMinute: 10_000 } });
    for (const member of MEMBERS) env.addMember(member.handle, { kind: member.kind, can_address_agents: member.can_address_agents });
    for (const name of AGENTS) env.seedAgent(name);
    // A direct write to Chatter's scratch database, as bridge/test/hardening.test.js does for the same purpose.
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (file: string) => Database };
    const db = new DatabaseSync(path.join(env.repoInfo.dir, 'chatter.db'));
    for (const name of DEPARTED) db.prepare('UPDATE agents SET departed_at = ? WHERE name = ?').run('2026-10-09 01:00:00', name);
    db.close();
    directory = directoryOf(await env.api('flan', 'GET', '/v1/directory'));

    for (const sender of SENDERS) {
      for (const one of CASES) {
        const to = toWhom(sender, one.to);
        rows.push({
          key: `${one.name} as ${sender.role}`,
          real: await askReal(env, sender, to, one.body),
          bridge: await askScriptedBridge(directory, sender, to, one.body),
          store: await askFakeStore(directory, sender, to, one.body),
        });
      }
    }
  }, SLOW);

  afterAll(async () => {
    await env?.stop();
  });

  it('serves the directory the fakes are given: every member and agent of the world, the departed agents included', () => {
    expect(directory.agents).toEqual([...AGENTS]);
    expect(directory.members.map((member) => member.handle).sort()).toEqual(['flan', ...MEMBERS.map((member) => member.handle)].sort());
  });

  it('has the senders stand the same way in the bridge and in both fakes', async () => {
    // What the rules read of a sender; the display name is not one of them.
    const standing = (me: Me): Pick<Me, 'handle' | 'kind' | 'role' | 'can_address_agents'> => ({ handle: me.handle, kind: me.kind, role: me.role, can_address_agents: me.can_address_agents });
    for (const sender of SENDERS) {
      const real = parseMe((await env.api(sender.handle, 'GET', '/v1/me')).body);
      const bridge = new FakeBridge();
      const scripted = await bridge.api(() => bridge.tokenOf(sender.handle)).me();
      const session = createFakeStore({ as: sender.handle }).getSnapshot().session;
      expect(session.status, sender.handle).toBe('signed-in');
      expect(standing(scripted), sender.handle).toEqual(standing(real));
      if (session.status === 'signed-in') expect(standing(session.me), sender.handle).toEqual(standing(real));
    }
  });

  it('covers every answer the rules can give: an acceptance and each refusal the prefix rules add', () => {
    const answers = new Set(rows.map((row) => row.real.refusal?.code ?? 'accepted'));
    for (const wanted of ['accepted', 'everyone_admin_only', 'agents_not_allowed', 'ambiguous_recipient', 'unknown_recipient', 'self_dm']) {
      expect(answers.has(wanted), wanted).toBe(true);
    }
    expect(new Set(rows.map((row) => row.real.status))).toEqual(new Set([CREATED, 400, 403, 404, 409]));
  });

  it('gives the real bridge\'s status and code from both fakes, except for the cases named as unmodelled', () => {
    const differing = rows.filter((row) => disagreements(row).includes('outcome'));
    const listed = Object.keys(UNMODELLED);
    expect({
      unlisted: differing.filter((row) => !listed.includes(row.key)).map(describeRow),
      listedButAgreeing: listed.filter((key) => !differing.some((row) => row.key === key)),
    }).toEqual({ unlisted: [], listedButAgreeing: [] });
  });

  it('gives a reason for each unmodelled case', () => {
    for (const [key, why] of Object.entries(UNMODELLED)) expect(why.length, key).toBeGreaterThan(20);
  });

  // Without this the departed `rowan` could be live in the world (a seeding that did not take) and the
  // listed rows would differ for some other reason, or not at all.
  it('has the real bridge refuse a DM to a departed name that starts a live one as "not a live agent of this repo", checked before the permission', () => {
    for (const sender of SENDERS) {
      const row = rows.find((candidate) => candidate.key === `a DM to rowan, a departed agent that is the start of a live one as ${sender.role}`);
      expect(row?.real.status, sender.role).toBe(409);
      expect(row?.real.refusal?.code, sender.role).toBe('ambiguous_recipient');
      expect(row?.real.refusal?.message, sender.role).toMatch(/^"rowan" is the start of the name of the Herdr agent rowan-worker, .* "rowan" is not a live agent of this repo\.$/);
    }
  });

  it('refuses in the bridge\'s own words', () => {
    expect(rows.filter((row) => disagreements(row).includes('words')).map(describeRow)).toEqual([]);
  });

  it('stores what it accepts as the bridge stores it: the same mentions, kind and everyone flag, and the same answer', () => {
    expect(rows.filter((row) => disagreements(row).includes('stored')).map(describeRow)).toEqual([]);
  });

  it('has the fake store and the scripted bridge answer every message alike', () => {
    const alike = (a: Observed, b: Observed): boolean => JSON.stringify([a.refusal, a.stored]) === JSON.stringify([b.refusal, b.stored]);
    expect(rows.filter((row) => !alike(row.store, row.bridge)).map(describeRow)).toEqual([]);
  });
});
