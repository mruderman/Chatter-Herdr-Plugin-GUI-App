// The rules behind the mention suggestions (ui-contract sections 3 and 8), checked without rendering.
import { describe, expect, it } from 'vitest';
import { body } from '../../../../test/fixtures/recorded';
import { parseDirectory, parseMe } from '../../../api/guards';
import { EVERYONE, insertMention, matchCandidates, mentionAt, mentionCandidates } from './mentions';

const directory = parseDirectory(body('directory'));
const admin = parseMe(body('me-admin'));
const member = parseMe(body('me-computational'));
const restricted = parseMe(body('me-restricted'));
const labels = (candidates: ReadonlyArray<{ label: string }>): string[] => candidates.map((candidate) => candidate.label);

describe('mentionAt: the word under the caret, when it is a mention', () => {
  it('starts a mention at the start of the text', () => {
    expect(mentionAt('@', 1)).toEqual({ start: 0, end: 1, prefix: '' });
    expect(mentionAt('@th', 3)).toEqual({ start: 0, end: 3, prefix: 'th' });
  });

  it('starts one after a space or a line break', () => {
    expect(mentionAt('hi @mi', 6)).toEqual({ start: 3, end: 6, prefix: 'mi' });
    expect(mentionAt('line one\n@gr', 12)).toEqual({ start: 9, end: 12, prefix: 'gr' });
  });

  it('does not start one inside a word, as in an address', () => {
    expect(mentionAt('mail@host', 9)).toBeNull();
    expect(mentionAt('mail@', 5)).toBeNull();
  });

  it('is nothing once the word has ended, or before its "@"', () => {
    expect(mentionAt('@mira ', 6)).toBeNull();
    expect(mentionAt('@mira', 0)).toBeNull();
    expect(mentionAt('plain words', 11)).toBeNull();
    expect(mentionAt('', 0)).toBeNull();
  });

  it('takes the prefix up to the caret and the word to its end', () => {
    expect(mentionAt('@miranda later', 3)).toEqual({ start: 0, end: 8, prefix: 'mi' });
  });
});

describe('mentionCandidates: who is offered (ui-contract section 3)', () => {
  it('offers a member the other members with their kind and the agents, and not everyone', () => {
    expect(labels(mentionCandidates(member, directory))).toEqual([
      'flan (Human)',
      'mira (Human)',
      'ezra (Human)',
      'kieran (Computational)',
      'grace (Computational)',
      'temp (Computational)',
      'codex (Agent)',
    ]);
  });

  it('offers everyone to an admin, as "everyone (all members)", and never the admin themself', () => {
    const offered = mentionCandidates(admin, directory);
    expect(offered.at(-1)).toEqual({ value: EVERYONE, label: 'everyone (all members)' });
    expect(offered.map((candidate) => candidate.value)).not.toContain(admin.handle);
    expect(labels(offered)).toContain('codex (Agent)');
  });

  it('offers no agent to a member who may not address agents', () => {
    expect(restricted.can_address_agents).toBe(false);
    const offered = labels(mentionCandidates(restricted, directory));
    expect(offered.some((label) => label.endsWith('(Agent)'))).toBe(false);
    expect(offered).not.toContain('everyone (all members)');
  });

  it('offers agents to an admin even without can_address_agents, because the bridge lets an admin address them', () => {
    // bridge/src/policy.js refuses agents only when the sender is neither an admin nor allowed.
    const offered = labels(mentionCandidates({ ...admin, can_address_agents: false }, directory));
    expect(offered).toContain('codex (Agent)');
    expect(offered).toContain('everyone (all members)');
  });

  it('offers only everyone, to an admin, before the directory has loaded', () => {
    expect(labels(mentionCandidates(admin, null))).toEqual(['everyone (all members)']);
    expect(mentionCandidates(member, null)).toEqual([]);
  });
});

describe('matchCandidates: narrowing by what was typed', () => {
  const offered = mentionCandidates(admin, directory);

  it('keeps every candidate for a bare "@"', () => {
    expect(matchCandidates(offered, '')).toEqual(offered);
  });

  it('matches the start of the name, ignoring case', () => {
    expect(labels(matchCandidates(offered, 'mi'))).toEqual(['mira (Human)']);
    expect(labels(matchCandidates(offered, 'MI'))).toEqual(['mira (Human)']);
    expect(labels(matchCandidates(offered, 'Ev'))).toEqual(['everyone (all members)']);
    expect(labels(matchCandidates(offered, 'e'))).toEqual(['ezra (Human)', 'everyone (all members)']);
  });

  it('matches nothing in the middle of a name', () => {
    expect(matchCandidates(offered, 'ira')).toEqual([]);
  });
});

describe('insertMention: what accepting writes', () => {
  it('writes "@" and the name and a space, and puts the caret after the space', () => {
    const text = 'hi @mi';
    expect(insertMention(text, { start: 3, end: 6, prefix: 'mi' }, 'mira')).toEqual({ text: 'hi @mira ', caret: 9 });
  });

  it('adds no second space when one follows, and steps over it', () => {
    const text = 'hi @mi there';
    expect(insertMention(text, { start: 3, end: 6, prefix: 'mi' }, 'mira')).toEqual({ text: 'hi @mira there', caret: 9 });
  });

  it('replaces the whole word, not only what was typed before the caret', () => {
    expect(insertMention('@mixx', { start: 0, end: 5, prefix: 'mi' }, 'mira')).toEqual({ text: '@mira ', caret: 6 });
  });
});
