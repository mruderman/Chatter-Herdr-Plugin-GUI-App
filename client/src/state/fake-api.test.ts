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
import { FakeBridge, MAIN_REPO } from './fake-api';

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
