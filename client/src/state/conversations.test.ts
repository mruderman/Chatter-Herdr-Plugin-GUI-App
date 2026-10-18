// @vitest-environment node
// The conversation of a pair of handles (what GET /v1/repos/{key}/conversations lists) must be the very
// conversation a message of that pair belongs to (what the loaded messages give), or an entry from the
// route and one from a message would be two buttons for one DM.
import { describe, expect, it } from 'vitest';
import type { Me, Message } from '../api/types';
import { conversationOf, conversationOfPair, dmId } from './conversations';

const member = (handle: string, role: Me['role'] = 'member'): Me => ({ handle, display_name: handle, kind: 'human', role, can_address_agents: true });

const message = (from: string, to: string): Message => ({
  id: 1, from, to, body: 'hi', kind: 'chat', ref_id: null, created_at: '2026-10-10T14:06:56Z', mentions: [], everyone: false,
});

describe('conversationOfPair', () => {
  it.each([
    ['a member\'s own pair, who is the second handle', 'thom', ['mira', 'thom'] as const],
    ['a member\'s own pair, who is the first handle', 'mira', ['mira', 'thom'] as const],
    ['a member\'s pair with an agent', 'thom', ['codex-worker', 'thom'] as const],
    ['an admin\'s own pair', 'flan', ['codex', 'flan'] as const],
    ['an admin\'s observed pair of two others', 'flan', ['mira', 'thom'] as const],
    ['handles that plain string order and locale order rank differently', 'flan', ['a-b', 'a_b'] as const],
  ])('is the conversation of a message in either direction: %s', (_what, who, [x, y]) => {
    const me = member(who, who === 'flan' ? 'admin' : 'member');
    const there = conversationOf(message(x, y), me);
    const back = conversationOf(message(y, x), me);
    expect(conversationOfPair(x, y, me)).toEqual(there);
    expect(conversationOfPair(y, x, me)).toEqual(there);
    expect(back).toEqual(there);
  });

  it('gives a member\'s own pair the kind "direct", the id of both directions and the label "DM with {peer}"', () => {
    expect(conversationOfPair('mira', 'thom', member('thom'))).toEqual({ kind: 'direct', id: dmId('mira', 'thom'), label: 'DM with mira', peer: 'mira' });
    expect(conversationOfPair('thom', 'mira', member('mira'))).toEqual({ kind: 'direct', id: 'dm:["mira","thom"]', label: 'DM with thom', peer: 'thom' });
  });

  it('gives an admin\'s pair of two others the kind "observed", labelled by the two handles in plain string order', () => {
    expect(conversationOfPair('thom', 'mira', member('flan', 'admin'))).toEqual({
      kind: 'observed', id: 'dm:["mira","thom"]', label: 'DM mira to thom', from: 'mira', to: 'thom',
    });
    // "_" sorts after "-" by code unit; localeCompare would put them the other way round.
    expect(conversationOfPair('a_b', 'a-b', member('flan', 'admin')).label).toBe('DM a-b to a_b');
  });

  it('never makes a channel: its id is a DM id', () => {
    expect(conversationOfPair('mira', 'thom', member('thom')).id.startsWith('dm:')).toBe(true);
  });
});
