// The top of the running app: the services in context, and the component that renders App from the
// store's snapshot.
import { App } from '../app';
import { VIEW_ID } from '../features';
import { useNotifier, type Notifier } from '../features/notify';
import { useTheme, type ThemeManager } from '../features/shell';
import { useSnapshot, useStore } from '../state/provider';
import type { Services } from './services';
import { ServicesProvider } from './services-context';
import { toShellSession } from './session';
import { APP_VIEWS } from './views';

export interface AppRootProps {
  readonly services: Services;
  readonly themeManager: ThemeManager;
}

export function AppRoot({ services, themeManager }: AppRootProps) {
  return (
    <ServicesProvider services={services}>
      <Root notifier={services.notifier} themeManager={themeManager} />
    </ServicesProvider>
  );
}

interface RootProps {
  readonly notifier: Notifier;
  readonly themeManager: ThemeManager;
}

// The component that renders App, and so renders again on every snapshot. useNotifier belongs here
// and not lower down: it reads the browser's permission afresh at each render of the component that
// calls it, and nothing tells the page when the permission is changed in the browser's own settings,
// so a component that rarely renders would show a stale one in Settings.
function Root({ notifier, themeManager }: RootProps) {
  const store = useStore();
  const snapshot = useSnapshot();
  const theme = useTheme(themeManager);
  const notifications = useNotifier(notifier);
  return (
    <App
      session={toShellSession(snapshot, store)}
      views={APP_VIEWS}
      themeChoice={theme.choice}
      onThemeChange={theme.setChoice}
      notifications={notifications}
      // Only the Chat view puts a conversation on screen. With Board, Members or Admin open, a message in
      // the conversation the store has selected is still news to the member, so the notifier is told
      // whether Chat is the open view and nothing more: it does not know the registry's ids.
      onOpenViewChange={(viewId) => notifier.setChatOpen(viewId === VIEW_ID.chat)}
    />
  );
}
