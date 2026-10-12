// The app's registry: the shell's (features/index.ts) with each placeholder replaced by the real view,
// connected to the store. Each entry is a component defined once, here, at module level: a component
// made inside a render is a new type on every snapshot, and Preact would remount the feed each time,
// losing the reader's place.
import type { ComponentType } from 'preact';
import { VIEWS, type ViewDefinition, type ViewId } from '../features';
import { BoardView } from '../features/board';
import { ChatView } from '../features/chat';
import { Composer } from '../features/chat/composer';
import { MembersView } from '../features/members';
import { useSnapshot, useStore } from '../state/provider';
import { AdminScreen } from './admin-screen';
import { useServices } from './services-context';

export function ChatScreen() {
  const store = useStore();
  const snapshot = useSnapshot();
  return <ChatView snapshot={snapshot} store={store} composer={<Composer snapshot={snapshot} store={store} />} />;
}

export function BoardScreen() {
  const { api, clock } = useServices();
  const { connection, selectedRepo } = useSnapshot();
  // Once the bridge has revoked the member every request is refused, so the board is given no repository
  // and asks for nothing, rather than polling for a 401 every 15 seconds.
  const repoKey = connection === 'revoked' ? null : selectedRepo;
  return <BoardView api={api} repoKey={repoKey} clock={clock} />;
}

export function MembersScreen() {
  const { directory } = useSnapshot();
  return <MembersView directory={directory} />;
}

// A Record over every ViewId, so a view added to the shell's registry without a screen does not compile.
const SCREENS: Readonly<Record<ViewId, ComponentType>> = {
  chat: ChatScreen,
  board: BoardScreen,
  members: MembersScreen,
  admin: AdminScreen,
};

/** The shell's ids, labels, order and admin-only flags, with the real views. */
export const APP_VIEWS: readonly ViewDefinition[] = VIEWS.map((view) => ({ ...view, component: SCREENS[view.id] }));
