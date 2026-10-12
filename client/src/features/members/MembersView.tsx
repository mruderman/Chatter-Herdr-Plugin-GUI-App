import type { Directory } from '../../api/types';
import { KindBadge } from '../shell';
import './members.css';
import { handleLabel, MEMBERS_TEXT } from './members-text';

export interface MembersViewProps {
  /** The store's directory (`StoreSnapshot['directory']`): active members and agent names, or null until it has loaded. */
  readonly directory: Directory | null;
}

// Read-only list of who is in the chat, with each member's kind as a badge, and of the agents that
// messages can be addressed to (docs/ui-contract.md section 4). Everything comes from the directory
// the store already holds, in the bridge's order, and every field is shown as plain text.
export function MembersView({ directory }: MembersViewProps) {
  return (
    <div class="stack">
      <h1>{MEMBERS_TEXT.title}</h1>
      {directory === null ? (
        <p role="status">{MEMBERS_TEXT.loading}</p>
      ) : (
        <>
          {directory.members.length > 0 ? (
            // role="list" because some screen readers drop the list role from a list whose bullets are hidden.
            <ul class="members__list" role="list" aria-label={MEMBERS_TEXT.membersList}>
              {directory.members.map((member) => (
                <li key={member.handle} class="members__item">
                  <span class="members__name">{member.display_name}</span>{' '}
                  <span class="members__handle">{handleLabel(member.handle)}</span>{' '}
                  <KindBadge kind={member.kind} />
                </li>
              ))}
            </ul>
          ) : (
            <p>{MEMBERS_TEXT.noMembers}</p>
          )}
          <div class="members__agents">
            <h2>{MEMBERS_TEXT.agentsHeading}</h2>
            <p class="field__hint members__hint">{MEMBERS_TEXT.agentsHint}</p>
            {directory.agents.length > 0 ? (
              <ul class="members__list" role="list" aria-label={MEMBERS_TEXT.agentsList}>
                {directory.agents.map((name) => (
                  <li key={name} class="members__item">
                    <span class="members__name">{name}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p>{MEMBERS_TEXT.noAgents}</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
