// How messages group into the Conversations navigation. The ids, labels and order are the fake
// store's (fake.ts, conversationsOf): the views and the E2E specs were written against them, so a
// change here is a contract change, and the conformance suite runs both stores to keep them equal.
import { CHANNEL, type Me, type Message } from '../api/types';
import type { Conversation, ConversationId } from './types';

type Direct = Extract<Conversation, { kind: 'direct' }>;
type Observed = Extract<Conversation, { kind: 'observed' }>;

export const CHANNEL_CONVERSATION: Conversation = Object.freeze({ kind: 'channel', id: CHANNEL, label: CHANNEL });

/**
 * The two handles of a DM in alphabetical order, whichever way a message went. Plain code-unit
 * comparison, as `[a, b].sort()` does: `localeCompare` ranks `_` and `-` differently and its answer
 * depends on the runtime's ICU.
 */
export function pairOf(a: string, b: string): readonly [string, string] {
  return a <= b ? [a, b] : [b, a];
}

/** Both directions of a DM share one id. */
export function dmId(a: string, b: string): ConversationId {
  return `dm:${JSON.stringify(pairOf(a, b))}`;
}

export function belongsTo(message: Message, id: ConversationId): boolean {
  return id === CHANNEL ? message.to === CHANNEL : message.to !== CHANNEL && dmId(message.from, message.to) === id;
}

/** The conversation a message belongs to, seen from the member's side. */
export function conversationOf(message: Message, member: Me): Conversation {
  if (message.to === CHANNEL) return CHANNEL_CONVERSATION;
  const id = dmId(message.from, message.to);
  if (message.from === member.handle || message.to === member.handle) {
    const peer = message.from === member.handle ? message.to : message.from;
    return { kind: 'direct', id, label: `DM with ${peer}`, peer };
  }
  const [from, to] = pairOf(message.from, message.to);
  return { kind: 'observed', id, label: `DM ${from} to ${to}`, from, to };
}

/**
 * "#chat" first, then the member's DMs by peer, then (an admin's view) others' DMs by their pair.
 * The list order uses `localeCompare` because the fake's does; only the labels need code-unit order.
 */
export function ordered(conversations: Iterable<Conversation>): Conversation[] {
  const direct: Direct[] = [];
  const observed: Observed[] = [];
  for (const conversation of conversations) {
    if (conversation.kind === 'direct') direct.push(conversation);
    else if (conversation.kind === 'observed') observed.push(conversation);
  }
  direct.sort((a, b) => a.peer.localeCompare(b.peer));
  const pairKey = (c: Observed): string => `${c.from} ${c.to}`;
  observed.sort((a, b) => pairKey(a).localeCompare(pairKey(b)));
  return [CHANNEL_CONVERSATION, ...direct, ...observed];
}
