// What the rest of the app imports from the Chat view. The composer lives in ./composer and is passed
// to ChatView as a node by whoever wires the app.
export { ChatView, CHAT_TITLE, type ChatViewProps } from './ChatView';
export { Announcements, type AnnouncementsProps } from './announcements/announcements';
export { Conversations, type ConversationsProps } from './conversations/conversations';
export { Feed, type FeedProps } from './feed/feed';
