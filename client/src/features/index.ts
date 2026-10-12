// The view registry: what the primary navigation lists and what <main> shows for each entry. These are
// the shell's own entries, with placeholder views that need no store, so the shell renders and is
// tested on its own. The running app passes App the same entries with the real views, connected to
// the store, from src/wiring/views.tsx.
import type { ComponentType } from 'preact';
import { createStubView } from './shell/stub-views';

export const VIEW_ID = {
  chat: 'chat',
  board: 'board',
  members: 'members',
  admin: 'admin',
} as const;

export type ViewId = (typeof VIEW_ID)[keyof typeof VIEW_ID];

export interface ViewDefinition {
  id: ViewId;
  /** Text of the navigation button; each view's own h1 uses the same word. */
  label: string;
  /** Shown only to admins. */
  adminOnly: boolean;
  component: ComponentType;
}

// Order is the navigation order, and the first entry is the view shown after sign-in: Chat.
export const VIEWS: readonly ViewDefinition[] = [
  { id: VIEW_ID.chat, label: 'Chat', adminOnly: false, component: createStubView('Chat') },
  { id: VIEW_ID.board, label: 'Board', adminOnly: false, component: createStubView('Board') },
  { id: VIEW_ID.members, label: 'Members', adminOnly: false, component: createStubView('Members') },
  { id: VIEW_ID.admin, label: 'Admin', adminOnly: true, component: createStubView('Admin') },
];
