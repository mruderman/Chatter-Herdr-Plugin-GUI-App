// The Chat view (ui-contract sections 2, 3 and 5). Its order in the page is its Tab order:
// conversations, then the feed, then the composer. The composer is passed in, so this view does not
// depend on how it is built.
import type { ComponentChildren } from 'preact';
import type { Store, StoreSnapshot } from '../../state/types';
import { Announcements } from './announcements/announcements';
import { Conversations } from './conversations/conversations';
import { Feed } from './feed/feed';
import './ChatView.css';

/** The view's h1, the same word as its navigation button. */
export const CHAT_TITLE = 'Chat';

export interface ChatViewProps {
  readonly snapshot: StoreSnapshot;
  readonly store: Store;
  /** The message composer, shown under the feed. */
  readonly composer: ComponentChildren;
  /** For the feed's day headings; see Feed. */
  readonly locale?: string;
  readonly timeZone?: string;
}

export function ChatView({ snapshot, store, composer, locale, timeZone }: ChatViewProps) {
  const conversation = snapshot.conversations.find((candidate) => candidate.id === snapshot.selectedConversation);
  return (
    <div class="chat">
      <h1>{CHAT_TITLE}</h1>
      <div class="chat__layout">
        <Conversations snapshot={snapshot} store={store} />
        <div class="chat__conversation">
          {/* Heads the feed, so its day headings (h3) sit under a level-2 heading. */}
          {conversation && <h2 class="chat__conversation-title">{conversation.label}</h2>}
          <Feed snapshot={snapshot} store={store} locale={locale} timeZone={timeZone} />
          {composer}
        </div>
      </div>
      <Announcements snapshot={snapshot} store={store} />
    </div>
  );
}
