// Mention suggestions: which names the composer offers after "@", and how an accepted one is written
// into the draft. Pure functions, so the rules (ui-contract sections 3 and 8) are tested without a DOM.
// Who may mention whom is the bridge's decision; this only decides what is offered as a convenience.
import type { Directory, Me, MemberRole } from '../../../api/types';
import { MEMBER_KIND_LABEL } from '../../shell';

export const MENTION_TRIGGER = '@';
/** The bridge's word for every member (bridge/src/util.js, mentionsOf). */
export const EVERYONE = 'everyone';
const ADMIN: MemberRole = 'admin';
const AGENT_KIND_LABEL = 'Agent';
const EVERYONE_LABEL = `${EVERYONE} (all members)`;
const WHITESPACE = /\s/;

export interface MentionCandidate {
  /** What goes into the text after "@": a handle, an agent name, or "everyone". */
  readonly value: string;
  /** The option's text, which is also its accessible name. */
  readonly label: string;
}

/**
 * Everyone the member may be offered, in the directory's order: other members with their kind, then
 * agents when the member may address them, then "everyone" for an admin.
 */
export function mentionCandidates(me: Me, directory: Directory | null): MentionCandidate[] {
  const members = (directory?.members ?? [])
    .filter((member) => member.handle !== me.handle)
    .map((member) => ({ value: member.handle, label: `${member.handle} (${MEMBER_KIND_LABEL[member.kind]})` }));
  // The bridge lets an admin address agents whatever the flag says (bridge/src/policy.js), so an admin is offered them too.
  const agents = me.role === ADMIN || me.can_address_agents
    ? (directory?.agents ?? []).map((name) => ({ value: name, label: `${name} (${AGENT_KIND_LABEL})` }))
    : [];
  const everyone = me.role === ADMIN ? [{ value: EVERYONE, label: EVERYONE_LABEL }] : [];
  return [...members, ...agents, ...everyone];
}

/** The candidates whose name starts with what was typed after "@", ignoring case. */
export function matchCandidates(candidates: readonly MentionCandidate[], prefix: string): MentionCandidate[] {
  const wanted = prefix.toLowerCase();
  return candidates.filter((candidate) => candidate.value.toLowerCase().startsWith(wanted));
}

export interface MentionContext {
  /** Index of the "@". */
  readonly start: number;
  /** Index just past the word the caret is in. */
  readonly end: number;
  /** What was typed between the "@" and the caret. */
  readonly prefix: string;
}

/**
 * The mention being typed: the word under the caret when it begins with "@", which is then at the start
 * of the text or right after whitespace (so "name@host" is not one). Null otherwise.
 */
export function mentionAt(text: string, caret: number): MentionContext | null {
  let start = caret;
  while (start > 0 && !WHITESPACE.test(text.charAt(start - 1))) start -= 1;
  if (start >= caret || text.charAt(start) !== MENTION_TRIGGER) return null;
  let end = caret;
  while (end < text.length && !WHITESPACE.test(text.charAt(end))) end += 1;
  return { start, end, prefix: text.slice(start + 1, caret) };
}

/**
 * Replaces the whole word under the caret with "@" and the accepted name. A space follows unless
 * whitespace already does, and the caret lands after it, so the next character starts a new word and
 * the finished mention does not reopen the list.
 */
export function insertMention(text: string, context: MentionContext, value: string): { text: string; caret: number } {
  const before = text.slice(0, context.start);
  const after = text.slice(context.end);
  const spaced = after !== '' && WHITESPACE.test(after.charAt(0));
  const inserted = `${MENTION_TRIGGER}${value}${spaced ? '' : ' '}`;
  return { text: `${before}${inserted}${after}`, caret: before.length + inserted.length + (spaced ? 1 : 0) };
}
