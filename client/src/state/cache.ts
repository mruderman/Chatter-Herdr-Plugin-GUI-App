// The message list of one repo: ascending ids, each once, however a message arrived (newest page,
// older page, stream, replay after a reconnect). Ids only rise but a member's view of them has gaps
// (other people's DMs, Chatter's mention copies), so a missing id means nothing here, and a page's
// max_id, which counts rows the member cannot see, is never used as a count.
import type { Message } from '../api/types';

/** What a repo keeps by itself; older pages the member asks for are kept on top of it. */
export const CACHE_LIMIT = 1_000;

export interface Merged {
  /** `existing` itself when nothing was new, so callers can tell that nothing changed. */
  readonly messages: readonly Message[];
  /** The messages that were not there before, ascending. */
  readonly added: readonly Message[];
}

function freeze(message: Message): Message {
  Object.freeze(message.mentions);
  return Object.freeze(message);
}

export function merge(existing: readonly Message[], incoming: readonly Message[]): Merged {
  const seen = new Set(existing.map((message) => message.id));
  const added: Message[] = [];
  for (const message of incoming) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    added.push(freeze(message));
  }
  if (added.length === 0) return { messages: existing, added };
  added.sort((a, b) => a.id - b.id);
  const last = existing.at(-1);
  const first = added[0];
  // The usual case, a live message newer than everything held, needs no sort.
  const messages = last === undefined || (first !== undefined && first.id > last.id)
    ? [...existing, ...added]
    : [...existing, ...added].sort((a, b) => a.id - b.id);
  return { messages, added };
}

/** The newest `limit` messages; `trimmed` says whether older ones were let go. */
export function newest(messages: readonly Message[], limit: number): { readonly messages: readonly Message[]; readonly trimmed: boolean } {
  return messages.length > limit ? { messages: messages.slice(-limit), trimmed: true } : { messages, trimmed: false };
}
