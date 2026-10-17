// What the bridge's answer to an accepted send tells the sender (SPEC section 5), worded once, for the fake
// store and the real one. Plain text only: the views render these strings as text nodes, never as markup.
//
// Three things in the answer matter to a sender, and each is shown as the bridge reported it, no more:
//  - `warnings`: Chatter's own notices for a post. bridge/src/server.js lets exactly two forms through
//    (KNOWN_WARNINGS: a mention that matches no agent, and @everyone reserved for the human); anything else
//    Chatter writes could name a host path and stays in the bridge's log. So a warning is safe to show whole.
//  - `delivery`: "queued" for a DM to an agent that no live session took.
//  - `pushed`: for a post, the agents a mention was pushed to, with " (queued)" when none was live.
// "Queued" is all the bridge knows: Chatter returns it when the agent has no live pane, when its pane is in a
// state that cannot take input, and when the prompt failed (Chatter 0.19.0 sendMessage), and nothing in the
// answer tells these apart. The wording therefore says the message is saved and was not taken, and promises
// nothing about later delivery.
import type { SendResult } from '../api/types';
import type { SendDraft, SendNotice } from './types';

/** How bridge/src/server.js marks a pushed agent that had no live pane. */
const QUEUED_SUFFIX = ' (queued)';

/** Opens the notice with words that say the message went, so it is not told from "Not sent: " by colour alone. */
export const NOTICE_LEAD = 'Message sent. Please note:';

export function queuedText(agent: string): string {
  return `@${agent} has not received it yet: the message is saved, but no session of @${agent} could take it just now.`;
}

/** The lines to show, in order: the bridge's warnings as it gave them, then each agent that could only be queued for. */
export function noticeLines(draft: SendDraft, result: SendResult): readonly string[] {
  // Chatter writes one warning per occurrence of a mention, so "@zzz @zzz" is the same line twice.
  const lines = [...new Set(result.warnings)];
  const queued = new Set<string>();
  if (result.delivery === 'queued') queued.add(draft.to);
  for (const entry of result.pushed) if (entry.endsWith(QUEUED_SUFFIX)) queued.add(entry.slice(0, -QUEUED_SUFFIX.length));
  for (const agent of queued) lines.push(queuedText(agent));
  return lines;
}

/** The notice for an accepted send, or null when there is nothing to tell. */
export function makeNotice(draft: SendDraft, result: SendResult, seq: number): SendNotice | null {
  const lines = noticeLines(draft, result);
  return lines.length === 0 ? null : Object.freeze({ lead: NOTICE_LEAD, lines: Object.freeze(lines), seq });
}

/** What the polite Announcements region says for a notice: the lead and every line, as one text. */
export function announcementOf(notice: SendNotice): string {
  return [notice.lead, ...notice.lines].join(' ');
}
