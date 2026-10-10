// The options of the composer's "To" select (ui-contract section 8). Nothing is left out for policy
// reasons: an agent the member may not address is still listed, because refusing is the bridge's job.
import type { Directory, Me } from '../../../api/types';
import { CHANNEL, type Conversation } from '../../../state/types';

export interface RecipientOption {
  /** What `send` gets as `to`: "#chat", a member handle or an agent name. */
  readonly value: string;
  readonly label: string;
}

/**
 * "#chat", then every active member other than the signed-in one, then every agent, in the directory's
 * order. `current` is the recipient the select must show; one the directory does not list (a member
 * revoked since the conversation began, say) gets an option of its own, so the select never shows a
 * recipient other than the one a send would go to.
 */
export function recipientOptions(me: Me | null, directory: Directory | null, current: string | null): RecipientOption[] {
  const options: RecipientOption[] = [{ value: CHANNEL, label: CHANNEL }];
  for (const member of directory?.members ?? []) {
    if (member.handle !== me?.handle) options.push({ value: member.handle, label: `${member.display_name} (${member.handle})` });
  }
  for (const agent of directory?.agents ?? []) options.push({ value: agent, label: `${agent} (agent)` });
  if (current !== null && !options.some((option) => option.value === current)) options.push({ value: current, label: current });
  return options;
}

/** The recipient a selected conversation stands for; null for an admin's view of others' DM. */
export function recipientOf(conversation: Conversation): string | null {
  if (conversation.kind === 'channel') return CHANNEL;
  if (conversation.kind === 'direct') return conversation.peer;
  return null;
}

/** The member's own DM conversation with `peer`, if one exists yet. */
export function directConversationWith(conversations: readonly Conversation[], peer: string): Conversation | undefined {
  return conversations.find((conversation) => conversation.kind === 'direct' && conversation.peer === peer);
}
