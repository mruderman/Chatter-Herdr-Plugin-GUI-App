// The Chat view's "Conversations" navigation (ui-contract section 3): one button per conversation the
// store lists, named exactly by its label, so nothing else may go inside a button. The labels come
// from the store ("#chat", "DM with {handle}", "DM {a} to {b}"), which keeps one spelling everywhere.
import { useId } from 'preact/hooks';
import type { Store, StoreSnapshot } from '../../../state/types';
import './conversations.css';

export const CONVERSATIONS_TEXT = {
  /** The navigation's accessible name, also its visible heading. */
  name: 'Conversations',
  none: 'No conversations yet.',
} as const;

export interface ConversationsProps {
  readonly snapshot: StoreSnapshot;
  readonly store: Store;
}

export function Conversations({ snapshot, store }: ConversationsProps) {
  const headingId = useId();
  return (
    <nav class="conversations" aria-labelledby={headingId}>
      <h2 id={headingId} class="conversations__heading">
        {CONVERSATIONS_TEXT.name}
      </h2>
      {snapshot.conversations.length === 0 ? (
        <p class="conversations__none">{CONVERSATIONS_TEXT.none}</p>
      ) : (
        <ul class="conversations__list">
          {snapshot.conversations.map((conversation) => (
            <li key={conversation.id}>
              <button
                type="button"
                class="conversations__button"
                aria-current={conversation.id === snapshot.selectedConversation ? 'true' : undefined}
                onClick={() => store.selectConversation(conversation.id)}
              >
                {conversation.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
