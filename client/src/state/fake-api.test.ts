// @vitest-environment node
// The scripted bridge (fake-api.ts) refuses a send the way the real one does, status included, and
// reads mentions the way the real one reads them. The fake store's tests (fake.test.ts) and the
// conformance suite cover the words a member sees; this file covers what only a status can show, and
// the rows the bridge itself writes. bridge-parity.test.ts compares the same rules with a real bridge.
import { describe, expect, it } from 'vitest';
import { body } from '../../test/fixtures/recorded';
import { ApiError } from '../api/errors';
import { parseDirectory } from '../api/guards';
import { CHANNEL, type SendRequest } from '../api/types';
import type { FakeMember } from './fake';
import { BRIDGE_ROUTES, FakeBridge, MAIN_REPO, SITE_REPO } from './fake-api';

/** What the bridge answers to `who` sending `draft`: the 201 body, or the refusal it threw. */
async function send(bridge: FakeBridge, who: FakeMember, draft: SendRequest) {
  const api = bridge.api(() => bridge.tokenOf(who));
  try {
    return { sent: await api.send(MAIN_REPO, draft), refused: null };
  } catch (error) {
    if (error instanceof ApiError) return { sent: null, refused: { status: error.status, code: error.code, message: error.message } };
    throw error;
  }
}

/** The recorded directory with more members, as the admin panel would leave it. */
function withMembers(bridge: FakeBridge, ...handles: string[]): void {
  const { members, agents } = parseDirectory(body('directory'));
  bridge.setDirectory({ members: [...members, ...handles.map((handle) => ({ handle, display_name: handle, kind: 'human' as const }))], agents });
}

describe('the scripted bridge: a send is refused with the real status and code', () => {
  it.each([
    ['kieran', { to: CHANNEL, body: '@cod please' }, 403, 'agents_not_allowed'],
    ['kieran', { to: CHANNEL, body: '@codX please' }, 403, 'agents_not_allowed'],
    ['kieran', { to: CHANNEL, body: '@codex please' }, 403, 'agents_not_allowed'],
    ['thom', { to: CHANNEL, body: '@everyoneX hi' }, 403, 'everyone_admin_only'],
    ['thom', { to: CHANNEL, body: '@Everyone hi' }, 403, 'everyone_admin_only'],
    ['kieran', { to: 'codex', body: 'hello' }, 403, 'agents_not_allowed'],
    ['thom', { to: 'cod', body: 'hello' }, 404, 'unknown_recipient'],
    ['thom', { to: 'thom', body: 'hello' }, 400, 'self_dm'],
    ['thom', { to: 'cod', body: 'hello', members: ['cod'] }, 409, 'ambiguous_recipient'],
    ['flan', { to: 'cod', body: 'hello', members: ['cod'] }, 409, 'ambiguous_recipient'],
    ['kieran', { to: 'kier', body: 'hello', members: ['kier'] }, 409, 'ambiguous_recipient'],
    ['flan', { to: 'fla', body: 'hello', members: ['fla'] }, 409, 'ambiguous_recipient'],
  ] as const)('%s sending %j gets %i %s, and nothing is written', async (who, draft, status, code) => {
    const bridge = new FakeBridge();
    if ('members' in draft) withMembers(bridge, ...draft.members);
    const rows = bridge.rows().length;
    const { refused } = await send(bridge, who, { to: draft.to, body: draft.body });
    expect(refused).toMatchObject({ status, code });
    expect(bridge.rows()).toHaveLength(rows);
  });

  it('accepts what the rules allow, and answers who was mentioned as the bridge does', async () => {
    const bridge = new FakeBridge();
    const first = await send(bridge, 'thom', { to: CHANNEL, body: '@cod hello @mira' });
    expect(first.sent).toMatchObject({ mentioned_members: ['mira'], delivery: null });
    const second = await send(bridge, 'flan', { to: CHANNEL, body: '@everyoneX standup' });
    expect(second.refused).toBeNull();
    expect(bridge.rows().at(-1)).toMatchObject({ everyone: true, mentions: ['everyonex'] });
    const third = await send(bridge, 'thom', { to: 'codex', body: 'hello' });
    expect(third.sent).toMatchObject({ delivery: 'queued' });
  });
});

describe('the scripted bridge: a row it is given is read as the bridge reads it', () => {
  it.each([
    ['@everyoneX', ['everyonex'], true],
    ['@codX', ['cod', 'codx'], false],
    ['@Everyone', [], true],
    ['@gracE and @codX', ['grac', 'cod', 'grace', 'codx'], false],
  ] as const)('%j has mentions %j, everyone %s', (text, handles, everyone) => {
    const row = new FakeBridge().write({ from: 'mira', body: text });
    expect(row.mentions).toEqual(handles);
    expect(row.everyone).toBe(everyone);
  });
});

// bridge/src/messages.js listConversations and bridge/test/conversations.test.js, which pin the real answer.
// bridge-parity.test.ts feeds the real bridge and this one the same rows and compares what they answer.
describe('the scripted bridge: the conversation list (GET /v1/repos/{key}/conversations)', () => {
  const asked = async (bridge: FakeBridge, who: FakeMember, repo = MAIN_REPO) => bridge.api(() => bridge.tokenOf(who)).conversations(repo);
  const pairs = async (bridge: FakeBridge, who: FakeMember) => (await asked(bridge, who)).conversations.map((c) => [c.a, c.b, c.last_id]);
  const SECOND = '2026-10-10T14:06:56Z';

  it('lists a member the pairs they are in, newest first, from the recorded rows, and the admin every pair', async () => {
    const bridge = new FakeBridge();
    expect(await pairs(bridge, 'thom')).toEqual([['codex', 'thom', 8], ['grace', 'thom', 6], ['mira', 'thom', 5]]);
    expect(await pairs(bridge, 'mira')).toEqual([['mira', 'thom', 5]]);
    expect(await pairs(bridge, 'kieran')).toEqual([]);
    expect(await pairs(bridge, 'flan')).toEqual([['codex', 'flan', 16], ['codex', 'thom', 8], ['grace', 'thom', 6], ['mira', 'thom', 5]]);
    expect((await asked(bridge, 'flan')).conversations[0]).toEqual({ a: 'codex', b: 'flan', last_id: 16, last_at: SECOND });
    expect((await asked(bridge, 'thom')).repo).toBe(MAIN_REPO);
  });

  it('names a pair a before b in plain string order, whichever way its messages went', async () => {
    const bridge = new FakeBridge();
    const one = bridge.write({ from: 'thom', to: 'a_b', body: 'one' });
    const two = bridge.write({ from: 'a-b', to: 'thom', body: 'two' });
    expect((await pairs(bridge, 'thom')).slice(0, 2)).toEqual([['a-b', 'thom', two.id], ['a_b', 'thom', one.id]]);
  });

  it('makes a pair written in both directions one entry, ending at the newer message', async () => {
    const bridge = new FakeBridge();
    const newer = bridge.write({ from: 'thom', to: 'mira', body: 'and back' });
    expect(await pairs(bridge, 'mira')).toEqual([['mira', 'thom', newer.id]]);
    expect(await pairs(bridge, 'flan')).toContainEqual(['mira', 'thom', newer.id]);
  });

  it('puts the pair with the newest message at the top, so the order follows last_id and not the first message', async () => {
    const bridge = new FakeBridge();
    const touched = bridge.write({ from: 'mira', to: 'thom', body: 'the oldest pair, newest again' });
    expect((await pairs(bridge, 'thom'))[0]).toEqual(['mira', 'thom', touched.id]);
  });

  it('never lists a channel post, and never lets a per-recipient mention copy make an entry or be a last_id', async () => {
    const bridge = new FakeBridge();
    bridge.write({ from: 'kieran', body: 'a post in the channel' });
    const copy = bridge.write({ from: 'thom', to: 'codex', body: 'hi @codex', kind: 'mention' });
    for (const who of ['thom', 'flan'] as const) {
      const found = (await pairs(bridge, who)).find(([a, b]) => a === 'codex' && b === 'thom');
      expect(found?.[2], who).toBe(8);
      expect(found?.[2], who).not.toBe(copy.id);
    }
    expect(await pairs(bridge, 'kieran')).toEqual([]);
  });

  it('lists no pair that has only mention copies', async () => {
    const bridge = new FakeBridge();
    bridge.write({ from: 'kieran', to: 'rowan', body: '@rowan', kind: 'mention' });
    const seen = (await pairs(bridge, 'flan')).map(([a, b]) => `${a}|${b}`);
    expect(seen).not.toContain('kieran|rowan');
    expect(await pairs(bridge, 'kieran')).toEqual([]);
  });

  it('gives a member no handle of anyone else\'s pair anywhere in the answer, and no text', async () => {
    const bridge = new FakeBridge();
    const answer = JSON.stringify(await asked(bridge, 'kieran'));
    for (const handle of ['thom', 'mira', 'grace', 'codex', 'flan']) expect(answer.includes(handle), handle).toBe(false);
    const thom = await asked(bridge, 'thom');
    expect(Object.keys(thom).sort()).toEqual(['conversations', 'repo']);
    for (const entry of thom.conversations) expect(Object.keys(entry).sort()).toEqual(['a', 'b', 'last_at', 'last_id']);
    expect(JSON.stringify(thom)).not.toContain('hello from thom');
  });

  it('answers for the repo asked, and 404 for one that does not exist, as the other routes do', async () => {
    const bridge = new FakeBridge();
    expect((await asked(bridge, 'thom', SITE_REPO)).conversations).toEqual([]);
    await expect(asked(bridge, 'thom', 'nowhere-00000000')).rejects.toMatchObject({ status: 404, code: 'no_such_repo' });
  });

  it('refuses a token it does not know with the recorded 401, and writes the request down either way', async () => {
    const bridge = new FakeBridge();
    await expect(bridge.api(() => 'not-a-token').conversations(MAIN_REPO)).rejects.toMatchObject({ status: 401 });
    await asked(bridge, 'thom');
    expect(bridge.requests.map((r) => [r.route, r.repo, r.withToken])).toEqual([
      [BRIDGE_ROUTES.conversations, MAIN_REPO, true],
      [BRIDGE_ROUTES.conversations, MAIN_REPO, true],
    ]);
    expect(bridge.count(BRIDGE_ROUTES.conversations)).toBe(2);
    expect(bridge.count(BRIDGE_ROUTES.conversations, SITE_REPO)).toBe(0);
  });

  it('can be made to fail, or to wait, like every route', async () => {
    const bridge = new FakeBridge();
    bridge.failNext(BRIDGE_ROUTES.conversations, new Error('scripted'));
    await expect(asked(bridge, 'thom')).rejects.toThrow('scripted');
    expect((await asked(bridge, 'thom')).conversations).toHaveLength(3);
    bridge.hold(BRIDGE_ROUTES.conversations);
    let done = false;
    const waiting = asked(bridge, 'thom').then(() => {
      done = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(done).toBe(false);
    bridge.release(BRIDGE_ROUTES.conversations);
    await waiting;
    expect(done).toBe(true);
  });

  it('is empty after the repo\'s database is replaced', async () => {
    const bridge = new FakeBridge();
    bridge.purge();
    expect((await asked(bridge, 'flan')).conversations).toEqual([]);
  });
});
