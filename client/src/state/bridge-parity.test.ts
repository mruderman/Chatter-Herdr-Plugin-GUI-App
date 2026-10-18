// @vitest-environment node
// The fakes copy the bridge's rules for what a member may send: the fake store (fake.ts, which the
// views are tested against) and the scripted bridge (fake-api.ts, which the real store is tested
// against) both use fake.ts's refuseWrite and mentionsOf. This test does not trust that copy. It starts
// the real bridge over the real Chatter CLI (bridge/test/helpers.js makeEnv, as the Admin view's
// integration test does), sends the same table of messages as three members and compares what comes
// back. Needs CHATTER_JS, like the bridge's contract tests; skipped without it, and skipped is not
// passing.
//
// The last block (the conversation list, V5 finding 9) compares something else: the answer of the bridge's
// GET /conversations with the scripted bridge's, given the same rows, and the conversations the real store
// lists over each, including pairs older than the newest page and the admin's observed ones.
//
// What is compared for each message and sender in the first block:
//   outcome  accepted or refused, and the code. The scripted bridge also gives the status; the fake
//            store has none to show, because the store contract carries only the code and the words.
//   words    the refusal's message, which is what the member reads.
//   stored   when it is accepted, the row as stored (to, kind, body, mentions, everyone) and, from the
//            scripted bridge, the rest of the answer: who was mentioned, how a DM to an agent was
//            delivered, which agents a post pushed to (" (queued)" when no pane was live: the world has no
//            Herdr, so every push is) and the warnings Chatter wrote. The fake store has no answer to show;
//            what it does with them is the send notice (sendNotice), which is compared too.
// Not compared, because nothing here can produce it: pushes that a live Herdr pane takes, and the warning
// that @everyone is reserved for the human (the world's admin is one); rate limits; a name that is an agent
// in another repo only (the world has one repo; it would be refused like the departed `rowan`, and for the
// same reason the fake cannot follow it).
// The bridge decides what a name is the start of from the repo's live roster; the fake has only the
// directory, which lists every agent of every repo, departed ones too. Where the two differ the fake
// cannot follow, and UNMODELLED names those cases.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi } from '../api/client';
import { ManualClock } from '../api/clock';
import { ApiError } from '../api/errors';
import { parseConversations, parseDirectory, parseMe, parseSendResult } from '../api/guards';
import { CHANNEL, type Directory, type Me, type Message, type SendResult } from '../api/types';
import { createFakeStore, type FakeMember } from './fake';
import { FakeBridge, MAIN_REPO } from './fake-api';
import { noticeLines, queuedText } from './send-notice';
import { createStore } from './store';
import type { Store, StoreSnapshot } from './types';

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

/**
 * The three senders: one of each standing the rules tell apart. Each has a member whose handle is the
 * start of the sender's own (`ownPrefix`) and a departed agent whose name is (`ownDeparted`).
 */
const SENDERS = [
  { role: 'restricted', handle: 'kieran', ownPrefix: 'kier', ownDeparted: 'kie' },
  { role: 'permitted', handle: 'mira', ownPrefix: 'mir', ownDeparted: 'mi' },
  { role: 'admin', handle: 'flan', ownPrefix: 'fla', ownDeparted: 'fl' },
] as const satisfies readonly { role: string; handle: FakeMember; ownPrefix: string; ownDeparted: string }[];
type Sender = (typeof SENDERS)[number];

/**
 * The world, the same for the bridge and for the fakes (which are given the bridge's own directory):
 * agents seeded in alphabetical order, because the bridge lists the agents a name is the start of in the
 * order of its roster and the directory lists them sorted. Departed: `wren-old`, which no live name
 * starts with; `rowan`, which is the start of the live `rowan-worker`; and `fl`, `kie` and `mi`, each the
 * start of one sender's handle and of no live name.
 */
const AGENTS = ['codex-worker', 'fl', 'ivy-one', 'ivy-two', 'kie', 'mi', 'rowan', 'rowan-worker', 'thomas-worker', 'wren-old'] as const;
const DEPARTED = ['fl', 'kie', 'mi', 'rowan', 'wren-old'] as const;
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
  /** "#chat", a handle, or a name made from the sender's own handle. */
  readonly to: string | typeof OWN_PREFIX | typeof OWN_DEPARTED | typeof THEMSELVES;
  readonly body: string;
}
const OWN_PREFIX = Symbol('a proper prefix of the sender\'s own handle');
const OWN_DEPARTED = Symbol('a departed agent whose name is the start of the sender\'s own handle');
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
  // The reproduction of the exploratory pass's finding 10: an agent's name mistyped.
  post('a mention of nobody, @nobodyhere', 'is anybody there? @nobodyhere'),
  post('a mistyped agent name, @codexx', 'hi @codexx'),
  post('the same unknown mention twice', '@zzz and again @zzz'),
  post('an unknown mention ended by a capital letter', 'hi @zzZ'),
  post('an e-mail address', 'mail a@b.c'),
  post('an agent and an unknown name', '@codex and @nobodyhere'),
  // Only the departed agent `fl` (in the directory, not on the roster) and flan's own handle start with "f".
  post('a mention that starts only the human\'s name, @f', 'hi @f'),
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
  dm('a DM to a departed agent whose name is the start of the sender\'s own handle', OWN_DEPARTED),
];

const DEPARTED_AGENT = 'the directory lists a departed agent, which the bridge leaves out when it decides what a name is the start of; the fake has the directory and no roster';
const OWN_HANDLE_NOT_LIVE = 'the directory offers a departed agent\'s name that is the start of the sender\'s own handle; the bridge refuses a DM to it with 409 "is the start of your own handle ... is not a live agent of this repo", checked before the permission, because only an exact name on the live roster is matched before the sender; the fake takes every agent of the directory for a live one';
const NOT_ON_THE_ROSTER = 'the directory offers a name that is not on this repo\'s live roster (a departed agent, or an agent of another repo) and is the start of a name that is; the bridge refuses a DM to it with 409 "is not a live agent of this repo", checked before the permission, while the fake takes every agent of the directory for a live one';

/**
 * The cases the fakes cannot answer as the bridge does, each with the reason. The test asserts this list
 * is exact: a case that differs and is not here fails, and so does a case here that does not differ, so a
 * gap is a decision written down and not an accident. Keys are "<case name> as <sender role>".
 */
const UNMODELLED: Readonly<Record<string, string>> = {
  'a mention that starts only the human\'s name, @f as restricted': 'the directory lists the departed agent `fl`, which the fake takes for an agent that "@f" starts and so refuses a restricted sender with agents_not_allowed; the roster has no live agent starting with "f", so the bridge accepts it and warns that the mention matches no agent',
  'a mention of @wren as restricted': DEPARTED_AGENT,
  'a DM to wren as restricted': DEPARTED_AGENT,
  'a DM to wren as permitted': DEPARTED_AGENT,
  'a DM to wren as admin': DEPARTED_AGENT,
  'a DM to rowan, a departed agent that is the start of a live one as restricted': NOT_ON_THE_ROSTER,
  'a DM to rowan, a departed agent that is the start of a live one as permitted': NOT_ON_THE_ROSTER,
  'a DM to rowan, a departed agent that is the start of a live one as admin': NOT_ON_THE_ROSTER,
  'a DM to a departed agent whose name is the start of the sender\'s own handle as restricted': OWN_HANDLE_NOT_LIVE,
  'a DM to a departed agent whose name is the start of the sender\'s own handle as permitted': OWN_HANDLE_NOT_LIVE,
  'a DM to a departed agent whose name is the start of the sender\'s own handle as admin': OWN_HANDLE_NOT_LIVE,
};

/**
 * The cases whose pushes, warnings or notice the fakes cannot give as the bridge does, each with the reason;
 * exact, like UNMODELLED: a case that differs and is not here fails, and so does one here that does not
 * differ. Keys are "<case name> as <sender role>".
 */
const DEPARTED_MENTION = 'Chatter resolves a mention through the repo\'s roster, which leaves out departed agents; the fake has the directory, which lists them, so it takes a departed agent for the one the mention names or starts, and its push (and the notice made of it) names the departed agent where the bridge pushes to the live one, or to nobody';
const HUMAN_NAME_MENTION = 'the directory lists the departed agent `fl`, which the fake takes for the agent "@f" starts (it refuses a restricted sender, and pushes to `fl (queued)` for the others), while the roster has no agent starting with "f": the bridge warns a member that the mention matches no agent, and says nothing to the admin, for whom Chatter resolves it to their own name (the human\'s name it counts among the candidates, which the fake does not know)';
const UNMODELLED_NOTICE: Readonly<Record<string, string>> = {
  'a mention that starts only the human\'s name, @f as permitted': HUMAN_NAME_MENTION,
  'a mention that starts only the human\'s name, @f as admin': HUMAN_NAME_MENTION,
  'a mention of @wren as permitted': DEPARTED_MENTION,
  'a mention of @wren as admin': DEPARTED_MENTION,
  '@rowan, a departed agent that is the start of a live one as permitted': DEPARTED_MENTION,
  '@rowan, a departed agent that is the start of a live one as admin': DEPARTED_MENTION,
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
  /**
   * What the answer says besides the id: who was mentioned, the delivery, the agents pushed to and the
   * warnings; null for the fake store, whose send has no answer.
   */
  readonly answer: {
    readonly mentioned: readonly string[];
    readonly delivery: string | null;
    readonly pushed: readonly string[];
    readonly warnings: readonly string[];
  } | null;
  /** What the sender is told about the accepted send (the send notice's lines); null when it was refused. */
  readonly notice: readonly string[] | null;
}

interface Row {
  readonly key: string;
  readonly real: Observed;
  readonly bridge: Observed;
  readonly store: Observed;
}

const toWhom = (sender: Sender, to: Case['to']): string => {
  if (to === OWN_PREFIX) return sender.ownPrefix;
  if (to === OWN_DEPARTED) return sender.ownDeparted;
  return to === THEMSELVES ? sender.handle : to;
};

const storedOf = (row: Message): Stored => ({ to: row.to, kind: row.kind, body: row.body, mentions: row.mentions, everyone: row.everyone });

const refusedWith = (status: number | null, code: string, message: string): Observed => ({ status, refusal: { code, message }, stored: null, answer: null, notice: null });

/** The part of an accepted send's answer the comparison reads, and the notice the client makes of it. */
const answerOf = (to: string, text: string, sent: SendResult): Pick<Observed, 'answer' | 'notice'> => ({
  answer: { mentioned: sent.mentioned_members, delivery: sent.delivery, pushed: sent.pushed, warnings: sent.warnings },
  notice: noticeLines({ to, body: text }, sent),
});

/** The real bridge: a send over HTTP, then the stored row read back through the member's own view. */
async function askReal(env: Env, sender: Sender, to: string, text: string): Promise<Observed> {
  const reply = await env.post(sender.handle, to, text);
  if (reply.status !== CREATED) {
    const { error } = reply.body as { error?: { code?: string; message?: string } };
    return refusedWith(reply.status, error?.code ?? '', error?.message ?? '');
  }
  // Through the client's own guard, as the store reads it.
  const sent = parseSendResult(reply.body);
  const page = await env.messages(sender.handle, '?limit=500');
  const row = (page.body as { messages: Message[] }).messages.find((candidate) => candidate.id === sent.id);
  if (!row) throw new Error(`the real bridge accepted "${text}" as ${sender.handle} but gave no row to read back (id ${String(sent.id)})`);
  return { status: reply.status, refusal: null, stored: storedOf(row), ...answerOf(to, text, sent) };
}

/** The scripted bridge, fresh for each row, serving the real directory. */
async function askScriptedBridge(directory: Directory, sender: Sender, to: string, text: string): Promise<Observed> {
  const bridge = new FakeBridge();
  bridge.setDirectory(directory);
  try {
    const sent = await bridge.api(() => bridge.tokenOf(sender.handle)).send(MAIN_REPO, { to, body: text });
    const row = bridge.rows(MAIN_REPO).find((candidate) => candidate.id === sent.id);
    if (!row) throw new Error(`the scripted bridge accepted "${text}" as ${sender.handle} but stored no row`);
    return { status: CREATED, refusal: null, stored: storedOf(row), ...answerOf(to, text, sent) };
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
  const { sendError, conversations, sendNotice } = store.getSnapshot();
  if (!accepted) {
    if (!sendError) throw new Error(`the fake store refused "${text}" as ${sender.handle} without saying why`);
    return refusedWith(null, sendError.code, sendError.message);
  }
  const conversation = conversations.find((candidate) => (to === CHANNEL ? candidate.kind === 'channel' : candidate.kind === 'direct' && candidate.peer === to));
  if (!conversation) throw new Error(`the fake store accepted "${text}" as ${sender.handle} but shows no conversation for it`);
  store.selectConversation(conversation.id);
  const row = store.getSnapshot().messages.at(-1);
  if (!row) throw new Error(`the fake store accepted "${text}" as ${sender.handle} but shows no message`);
  return { status: null, refusal: null, stored: storedOf(row), answer: null, notice: sendNotice?.lines ?? [] };
}

type Aspect = 'outcome' | 'words' | 'stored' | 'notice';

/** How a fake's answer differs from the real bridge's, by what differs. */
function against(real: Observed, fake: Observed): Aspect[] {
  const found: Aspect[] = [];
  const realCode = real.refusal?.code ?? null;
  const fakeCode = fake.refusal?.code ?? null;
  if (realCode !== fakeCode || (fake.status !== null && fake.status !== real.status)) found.push('outcome');
  else if (real.refusal && fake.refusal && real.refusal.message !== fake.refusal.message) found.push('words');
  else if (real.stored && fake.stored) {
    // Who was mentioned and how a DM was delivered belong to what is stored; the pushes and warnings, and the
    // notice the sender is shown, to what the sender is told (the departed agents make the two come apart).
    const same = (pick: (answer: NonNullable<Observed['answer']>) => unknown): boolean =>
      real.answer === null || fake.answer === null || JSON.stringify(pick(real.answer)) === JSON.stringify(pick(fake.answer));
    if (JSON.stringify(real.stored) !== JSON.stringify(fake.stored) || !same((a) => [a.mentioned, a.delivery])) found.push('stored');
    if (JSON.stringify(real.notice) !== JSON.stringify(fake.notice) || !same((a) => [a.pushed, a.warnings])) found.push('notice');
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

  // The same guard for the own-handle rule: a departed name that starts the sender's handle and no live
  // name is refused as the sender's own handle, with the advice for a name only the directory offers.
  it('has the real bridge refuse a DM to a departed name that starts the sender\'s own handle as "not a live agent of this repo", checked before the permission', () => {
    for (const sender of SENDERS) {
      const row = rows.find((candidate) => candidate.key === `a DM to a departed agent whose name is the start of the sender's own handle as ${sender.role}`);
      expect(row?.real.status, sender.role).toBe(409);
      expect(row?.real.refusal?.code, sender.role).toBe('ambiguous_recipient');
      expect(row?.real.refusal?.message, sender.role).toBe(`"${sender.ownDeparted}" is the start of your own handle, so Chatter would take it for you; nothing was sent. "${sender.ownDeparted}" is not a live agent of this repo.`);
    }
  });

  it('refuses in the bridge\'s own words', () => {
    expect(rows.filter((row) => disagreements(row).includes('words')).map(describeRow)).toEqual([]);
  });

  it('stores what it accepts as the bridge stores it: the same mentions, kind and everyone flag, and the same answer', () => {
    expect(rows.filter((row) => disagreements(row).includes('stored')).map(describeRow)).toEqual([]);
  });

  it('has the fake store and the scripted bridge answer every message alike', () => {
    const alike = (a: Observed, b: Observed): boolean => JSON.stringify([a.refusal, a.stored, a.notice]) === JSON.stringify([b.refusal, b.stored, b.notice]);
    expect(rows.filter((row) => !alike(row.store, row.bridge)).map(describeRow)).toEqual([]);
  });

  const rowOf = (name: string, sender: Sender): Row => {
    const row = rows.find((candidate) => candidate.key === `${name} as ${sender.role}`);
    if (!row) throw new Error(`no row "${name} as ${sender.role}"`);
    return row;
  };

  // Exploratory pass, finding 10: a mistyped agent name was a normal, successful send in the client.
  it('has the real bridge warn that a mention reaches nobody, in the words Chatter writes, and both fakes say the same to the sender', () => {
    const warning = 'mention @nobodyhere matches no agent in this repo — not pushed';
    for (const sender of SENDERS) {
      const row = rowOf('a mention of nobody, @nobodyhere', sender);
      expect(row.real.status, sender.role).toBe(CREATED);
      expect(row.real.answer?.warnings, sender.role).toEqual([warning]);
      expect(row.bridge.answer?.warnings, sender.role).toEqual([warning]);
      expect(row.store.notice, sender.role).toEqual([warning]);
    }
  });

  it('has the real bridge warn once for each occurrence, read a mention as Chatter does (a capital letter ends it), and call an e-mail address a mention', () => {
    for (const sender of SENDERS) {
      expect(rowOf('the same unknown mention twice', sender).real.answer?.warnings, sender.role).toEqual([
        'mention @zzz matches no agent in this repo — not pushed',
        'mention @zzz matches no agent in this repo — not pushed',
      ]);
      expect(rowOf('an unknown mention ended by a capital letter', sender).real.answer?.warnings, sender.role).toEqual(['mention @zz matches no agent in this repo — not pushed']);
      expect(rowOf('an e-mail address', sender).real.answer?.warnings, sender.role).toEqual(['mention @b matches no agent in this repo — not pushed']);
    }
  });

  it('has the real bridge say nothing for a mention of a member, who is no agent but is not nobody', () => {
    for (const sender of SENDERS) expect(rowOf('a mention of a member', sender).real.answer?.warnings, sender.role).toEqual([]);
  });

  it('has the real bridge queue a DM to a live agent, and a mention of one, when no pane is live (the world has no Herdr), and both fakes say so', () => {
    for (const sender of SENDERS.filter((one) => one.role !== 'restricted')) {
      const direct = rowOf('a DM to codex-worker, the exact name', sender);
      expect(direct.real.answer?.delivery, sender.role).toBe('queued');
      expect(direct.real.notice, sender.role).toEqual([queuedText('codex-worker')]);
      expect(direct.bridge.notice, sender.role).toEqual(direct.real.notice);
      expect(direct.store.notice, sender.role).toEqual(direct.real.notice);

      const mention = rowOf('@codex, the start of codex-worker', sender);
      expect(mention.real.answer?.pushed, sender.role).toEqual(['codex-worker (queued)']);
      expect(mention.real.notice, sender.role).toEqual([queuedText('codex-worker')]);
      expect(mention.bridge.answer?.pushed, sender.role).toEqual(['codex-worker (queued)']);
      expect(mention.store.notice, sender.role).toEqual(mention.real.notice);
    }
  });

  it('gives the real bridge\'s pushes, warnings and delivery from the scripted bridge, and its notice from the fake store, except for the cases named as unmodelled', () => {
    const differing = rows.filter((row) => disagreements(row).includes('stored') || disagreements(row).includes('notice'));
    const listed = Object.keys(UNMODELLED_NOTICE);
    expect({
      unlisted: differing.filter((row) => !listed.includes(row.key)).map(describeRow),
      listedButAgreeing: listed.filter((key) => !differing.some((row) => row.key === key)),
    }).toEqual({ unlisted: [], listedButAgreeing: [] });
  });

  it('gives a reason for each case unmodelled in the notice', () => {
    for (const [key, why] of Object.entries(UNMODELLED_NOTICE)) expect(why.length, key).toBeGreaterThan(20);
  });
});

// V5 finding 9 (T19b). The real bridge and the scripted one are given the very same rows, those of a scratch
// Chatter database read back after real sends, and must answer the conversation list alike for each member;
// and the real store, over the real bridge and over the scripted one, must then list the same conversations.
// Every DM is older than the newest page, which holds channel posts only: what the list shows of a pair is what
// the bridge says, and never more. The world is the one the scripted bridge can sign in: flan the admin, thom,
// mira and kieran, who is in no DM at all and is the third member whose view must hold nobody else's pair.
const PAIR_WORLD = {
  agent: 'codex-worker',
  // thom and mira write in both directions (the second is newer); flan writes to mira, thom to the agent.
  dms: [
    { from: 'thom', to: 'mira', text: 'thom to mira, the first word' },
    { from: 'mira', to: 'thom', text: 'mira to thom, the answer' },
    { from: 'flan', to: 'mira', text: 'flan to mira' },
    { from: 'thom', to: 'codex-worker', text: 'thom to the agent' },
  ],
  // A channel post that mentions the agent makes Chatter write a per-recipient copy: a row to the agent, never a pair.
  mention: { from: 'thom', text: 'thom in the channel, @codex-worker look' },
  posts: 12,
  pageSize: 3,
} as const;
/** What each member's list must read: the bridge's pairs, as the member's own DMs or, for the admin, observed ones. */
const PAIR_LABELS: Readonly<Record<'flan' | 'thom' | 'mira' | 'kieran', readonly string[]>> = {
  flan: ['#chat', 'DM with mira', 'DM codex-worker to thom', 'DM mira to thom'],
  thom: ['#chat', 'DM with codex-worker', 'DM with mira'],
  mira: ['#chat', 'DM with flan', 'DM with thom'],
  kieran: ['#chat'],
};
const PAIR_MEMBERS = ['flan', 'thom', 'mira', 'kieran'] as const;
type PairMember = (typeof PAIR_MEMBERS)[number];
// Quick reconnects for a test; the bridge pings every 1.5 s at pollMs 50, far inside the silence limit.
const LIVE_TIMING = { baseDelayMs: 50, maxDelayMs: 200, deadAfterMs: 10_000 };

interface WorldEnv extends Env {
  readonly base: string;
  readonly key: string;
  readonly tokens: Readonly<Record<string, string>>;
}

interface Sqlite {
  prepare(sql: string): { run(...values: string[]): unknown; all(...values: string[]): Array<Record<string, unknown>> };
  close(): void;
}
type OpenSqlite = new (file: string, options?: { readOnly?: boolean }) => Sqlite;

/** Resolves once `read` gives a value; polls, because the real store answers on real timers. */
async function eventually<T>(read: () => T | undefined, what: string, ms = 10_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const idsOf = (snapshot: StoreSnapshot): string[] => snapshot.conversations.map((c) => c.id);

describe.skipIf(!HAVE_CHATTER)('the conversation list against the real bridge and Chatter (needs CHATTER_JS)', () => {
  let env: WorldEnv;
  let rows: Message[];
  const stores: Store[] = [];

  /** The scripted bridge holding exactly the rows of the real one's database. */
  const scriptedBridge = (identity: PairMember): FakeBridge => {
    const bridge = new FakeBridge({ identity });
    bridge.addRepo({ key: env.key, label: 'parity', rows });
    return bridge;
  };

  const realAnswer = async (who: PairMember): Promise<unknown> => {
    const reply = await env.api(who, 'GET', `/v1/repos/${env.key}/conversations`);
    expect(reply.status, `${who}: ${JSON.stringify(reply.body)}`).toBe(200);
    return parseConversations(reply.body);
  };

  const scriptedAnswer = async (who: PairMember): Promise<unknown> => {
    const bridge = scriptedBridge(who);
    return bridge.api(() => null).conversations(env.key);
  };

  /**
   * A store over the real bridge, signed in as `who`, judged only after the bridge has answered its request for the
   * conversation list. The api is wrapped to see that answer come back: a fixed pause could end before a slow
   * answer, and a third member whose list is checked before it would pass whatever the answer holds.
   */
  async function realStore(who: PairMember): Promise<Store> {
    let asked = 0;
    let answered = false;
    const store = createStore({
      api: (getToken) => {
        const api = createApi({ baseUrl: env.base, getToken });
        return {
          ...api,
          conversations: async (repo, options) => {
            asked += 1;
            try {
              return await api.conversations(repo, options);
            } finally {
              answered = true;
            }
          },
        };
      },
      streamTiming: LIVE_TIMING,
      pageSize: PAIR_WORLD.pageSize,
    });
    stores.push(store);
    await eventually(() => (store.getSnapshot().session.status === 'signed-out' ? true : undefined), 'the first /v1/me');
    const token = env.tokens[who];
    if (!token) throw new Error(`no token for ${who}`);
    expect(await store.signIn(token)).toBe(true);
    await eventually(() => (answered ? true : undefined), `the bridge's answer to ${who}'s conversation list`);
    expect(asked, `${who}: the store asked for the conversation list`).toBeGreaterThanOrEqual(1);
    // The answer is in; let the store merge it and publish.
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    const wanted = PAIR_LABELS[who].length;
    await eventually(() => (store.getSnapshot().connection === 'online' && store.getSnapshot().conversations.length >= wanted ? true : undefined), `${who}'s list`);
    return store;
  }

  /** A store over the scripted bridge, signed in as `who` through the tailnet identity, on the parity repo. */
  async function scriptedStore(who: PairMember): Promise<Store> {
    const clock = new ManualClock();
    const bridge = scriptedBridge(who);
    const store = createStore({ api: bridge.api, clock, random: () => 0.5, streamTiming: { deadAfterMs: 24 * 60 * 60_000 }, pageSize: PAIR_WORLD.pageSize });
    stores.push(store);
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    store.selectRepo(env.key);
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    return store;
  }

  beforeAll(async () => {
    const { makeEnv } = (await import(/* @vite-ignore */ new URL(HELPERS, import.meta.url).href)) as { makeEnv: (options?: { limits?: { maxBody: number; postsPerMinute: number } }) => Promise<WorldEnv> };
    env = await makeEnv({ limits: { maxBody: 8_000, postsPerMinute: 10_000 } });
    env.addMember('thom', { kind: 'computational', can_address_agents: true });
    env.addMember('mira', { kind: 'human' });
    env.addMember('kieran', { kind: 'computational', can_address_agents: false });
    env.seedAgent(PAIR_WORLD.agent);
    for (const dm of PAIR_WORLD.dms) {
      const reply = await env.post(dm.from, dm.to, dm.text);
      expect(reply.status, `${dm.from} to ${dm.to}: ${JSON.stringify(reply.body)}`).toBe(CREATED);
    }
    const mention = await env.post(PAIR_WORLD.mention.from, CHANNEL, PAIR_WORLD.mention.text);
    expect(mention.status, JSON.stringify(mention.body)).toBe(CREATED);
    // The posts that push every DM past the newest page, written to the scratch database as bridge/test/hardening.test.js does:
    // sending them one by one would spend a Chatter run on each.
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: OpenSqlite };
    const write = new DatabaseSync(path.join(env.repoInfo.dir, 'chatter.db'));
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    for (let i = 1; i <= PAIR_WORLD.posts; i += 1) {
      write.prepare('INSERT INTO messages (from_agent, to_agent, body, kind, created_at) VALUES (?, ?, ?, ?, ?)').run('mira', CHANNEL, `channel post ${i}`, 'post', stamp);
    }
    write.close();
    const read = new DatabaseSync(path.join(env.repoInfo.dir, 'chatter.db'), { readOnly: true });
    rows = read.prepare('SELECT id, from_agent, to_agent, body, kind, ref_id, created_at FROM messages ORDER BY id').all().map((r) => ({
      id: Number(r['id']),
      from: String(r['from_agent']),
      to: String(r['to_agent']),
      body: String(r['body']),
      kind: String(r['kind']),
      ref_id: r['ref_id'] === null ? null : String(r['ref_id']),
      created_at: `${String(r['created_at']).replace(' ', 'T')}Z`,
      mentions: [],
      everyone: false,
    }));
    read.close();
  }, SLOW);

  afterAll(async () => {
    // Before the bridge goes: its shutdown byes would start reconnects on real timers.
    for (const store of stores) store.dispose();
    await env?.stop();
  });

  it('holds what the comparisons rely on: every DM older than the newest page, and a mention copy that is no pair', () => {
    const page = rows.slice(-PAIR_WORLD.pageSize);
    expect(page.every((row) => row.to === CHANNEL)).toBe(true);
    const direct = rows.filter((row) => row.to !== CHANNEL && row.kind !== 'mention');
    expect(direct.map((row) => row.body)).toEqual(PAIR_WORLD.dms.map((dm) => dm.text));
    expect(Math.max(...direct.map((row) => row.id))).toBeLessThan(page[0]?.id ?? 0);
    const copies = rows.filter((row) => row.kind === 'mention');
    expect(copies.map((row) => [row.from, row.to])).toEqual([['thom', PAIR_WORLD.agent]]);
    // The copy is newer than thom's DM to the agent, so a list that counted it would end that pair at the copy.
    expect(copies[0]?.id ?? 0).toBeGreaterThan(direct.at(-1)?.id ?? Number.POSITIVE_INFINITY);
  });

  it('has the scripted bridge answer the conversation list as the real bridge does, for the admin and for each member, to the byte', async () => {
    for (const who of PAIR_MEMBERS) expect(await scriptedAnswer(who), who).toEqual(await realAnswer(who));
  });

  it('answers each member the pairs they are in and the admin all of them, newest first, and the third member nothing', async () => {
    const pairs = async (who: PairMember): Promise<string[]> => ((await realAnswer(who)) as { conversations: Array<{ a: string; b: string }> }).conversations.map((c) => `${c.a}|${c.b}`);
    expect(await pairs('flan')).toEqual(['codex-worker|thom', 'flan|mira', 'mira|thom']);
    expect(await pairs('thom')).toEqual(['codex-worker|thom', 'mira|thom']);
    expect(await pairs('mira')).toEqual(['flan|mira', 'mira|thom']);
    expect(await pairs('kieran')).toEqual([]);
  });

  it('lists the same conversations in the real store over the real bridge as over the scripted one, for each member, though every DM is older than the page', async () => {
    for (const who of PAIR_MEMBERS) {
      const real = await realStore(who);
      const scripted = await scriptedStore(who);
      const wanted = PAIR_LABELS[who];
      expect(real.getSnapshot().conversations.map((c) => c.label), `${who}, real bridge`).toEqual(wanted);
      expect(scripted.getSnapshot().conversations.map((c) => c.label), `${who}, scripted bridge`).toEqual(wanted);
      expect(real.getSnapshot().conversations, who).toEqual(scripted.getSnapshot().conversations);
      expect(idsOf(real.getSnapshot()), who).toEqual(idsOf(scripted.getSnapshot()));
      // Older than the page: the newest page held channel posts only, so each DM opens empty with pages left.
      const dm = real.getSnapshot().conversations.find((c) => c.kind !== 'channel');
      if (dm) {
        real.selectConversation(dm.id);
        scripted.selectConversation(dm.id);
        expect(real.getSnapshot(), who).toMatchObject({ selectedConversation: dm.id, messages: [], hasMore: true });
        expect(scripted.getSnapshot(), who).toMatchObject({ selectedConversation: dm.id, messages: [], hasMore: true });
      }
    }
  }, SLOW);

  it('shows a third member nobody else\'s pair: their list holds no handle of a DM they are not in, in the real store over the real bridge', async () => {
    const kieran = await realStore('kieran');
    const shown = JSON.stringify(kieran.getSnapshot().conversations);
    for (const handle of ['thom', 'mira', 'flan', PAIR_WORLD.agent]) expect(shown.includes(handle), `${handle} in ${shown}`).toBe(false);
    expect(kieran.getSnapshot().conversations.map((c) => c.label)).toEqual(['#chat']);
    // Nor in what he can load: paging all the way back brings in no DM message.
    while (kieran.getSnapshot().hasMore) await kieran.loadOlder();
    expect(kieran.getSnapshot().conversations.map((c) => c.label)).toEqual(['#chat']);
    // An ordinary member sees their own pairs and not the others': thom has none with flan, kieran or mira's with flan.
    const thom = await realStore('thom');
    const thomShown = JSON.stringify(thom.getSnapshot().conversations);
    expect(thomShown.includes('flan')).toBe(false);
    expect(thomShown.includes('kieran')).toBe(false);
  }, SLOW);
});

// V5 finding 4, against the real bridge: the "New messages" marker is for other people's messages. The conformance
// suite holds the two stores to the same rule over the scripted bridge; this checks the rule on the rows the real
// bridge writes (the sender's handle is Chatter's own `from_agent`), in a world of its own so that the DMs it makes
// change nobody else's list.
describe.skipIf(!HAVE_CHATTER)('the new marker against the real bridge and Chatter (needs CHATTER_JS)', () => {
  let env: WorldEnv;
  const stores: Store[] = [];

  /** A store over the real bridge signed in as `who`, once it shows the channel. */
  async function storeFor(who: string): Promise<Store> {
    const store = createStore({ api: (getToken) => createApi({ baseUrl: env.base, getToken }), streamTiming: LIVE_TIMING });
    stores.push(store);
    await eventually(() => (store.getSnapshot().session.status === 'signed-out' ? true : undefined), 'the first /v1/me');
    const token = env.tokens[who];
    if (!token) throw new Error(`no token for ${who}`);
    expect(await store.signIn(token)).toBe(true);
    await eventually(() => (store.getSnapshot().connection === 'online' && store.getSnapshot().messages.length > 0 ? true : undefined), `${who}'s channel`);
    return store;
  }

  beforeAll(async () => {
    const { makeEnv } = (await import(/* @vite-ignore */ new URL(HELPERS, import.meta.url).href)) as { makeEnv: (options?: { limits?: { maxBody: number; postsPerMinute: number } }) => Promise<WorldEnv> };
    env = await makeEnv({ limits: { maxBody: 8_000, postsPerMinute: 10_000 } });
    env.addMember('ann', { kind: 'human' });
    env.addMember('bob', { kind: 'human' });
  }, SLOW);

  afterAll(async () => {
    // Before the bridge goes: its shutdown byes would start reconnects on real timers.
    for (const store of stores) store.dispose();
    await env?.stop();
  });

  it('has no marker above the member\'s own first message in a new DM', async () => {
    const ann = await storeFor('ann');
    expect(await ann.send({ to: 'bob', body: 'hello bob' })).toBe(true);
    const dm = await eventually(() => ann.getSnapshot().conversations.find((c) => c.kind === 'direct' && c.peer === 'bob'), 'the DM in the list');
    ann.selectConversation(dm.id);
    await eventually(() => (ann.getSnapshot().messages.some((m) => m.body === 'hello bob') ? true : undefined), 'the DM\'s message');
    expect(ann.getSnapshot().selectedConversation).toBe(dm.id);
    expect(ann.getSnapshot().newMarkerBeforeId).toBeNull();
  }, SLOW);

  it('puts the marker above the first unread message from someone else, not above the member\'s own before it', async () => {
    const first = await storeFor('ann');
    // Ann has read everything there is: the setup message (and her DM, if the test above ran first, is not in #chat).
    await first.markRead();
    expect(await first.send({ to: CHANNEL, body: 'ann answers' })).toBe(true);
    const bob = await env.post('bob', CHANNEL, 'bob goes on');
    expect(bob.status, JSON.stringify(bob.body)).toBe(CREATED);
    const bobId = parseSendResult(bob.body).id;
    // A fresh store reads the pointer the bridge kept and puts the marker where a reload would.
    const again = await storeFor('ann');
    await eventually(() => (again.getSnapshot().messages.some((m) => m.id === bobId) ? true : undefined), 'bob\'s message');
    expect(again.getSnapshot().messages.map((m) => m.from)).toEqual(['flan', 'ann', 'bob']);
    expect(again.getSnapshot().newMarkerBeforeId).toBe(bobId);
  }, SLOW);
});
