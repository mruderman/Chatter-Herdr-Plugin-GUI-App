import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { VIEW_ID, VIEWS, type ViewDefinition, type ViewId } from './features';
import {
  CHAT_SKIP_LINKS,
  Header,
  MAIN_SKIP_LINKS,
  PendingSessionView,
  PrimaryNav,
  SKIP_TARGET,
  SettingsDialog,
  SignInView,
  SkipLinks,
  type NotificationSettings,
  type ShellSession,
  type ThemeChoice,
} from './features/shell';

export interface AppProps {
  session: ShellSession;
  themeChoice: ThemeChoice;
  onThemeChange: (choice: ThemeChoice) => void;
  /** Left out until the notifications feature is connected; Settings then has no notification section. */
  notifications?: NotificationSettings;
  /** The registry to show; defaults to the app's own. Tests pass a smaller one. */
  views?: readonly ViewDefinition[];
  /** The view shown after sign-in; defaults to the first entry of the registry, which is Chat. */
  defaultViewId?: ViewId;
}

// Composes the shell from props. It owns only what is purely about the screen (which view is open,
// whether Settings is open); everything about the session arrives through `session`.
export function App({ session, themeChoice, onThemeChange, notifications, views = VIEWS, defaultViewId }: AppProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const startView = defaultViewId ?? views[0]?.id;
  const [viewId, setViewId] = useState<ViewId | undefined>(startView);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const previousStatus = useRef(session.status);
  useLayoutEffect(() => {
    if (previousStatus.current === session.status) return;
    previousStatus.current = session.status;
    // Every sign-in starts at the default view, whatever was open in an earlier session.
    if (session.status === 'signed-in') setViewId(startView);
    // When the sign-in form disappears the focused field goes with it and focus falls back to <body>,
    // where the browser may continue from wherever the field was. Putting it on the root first makes
    // the next Tab reach the first skip link, which is what the contract lists as the first tab stop.
    if (document.activeElement === document.body) rootRef.current?.focus();
  }, [session.status]);

  const member = session.status === 'signed-in' ? session.member : null;
  const visibleViews = member ? views.filter((view) => !view.adminOnly || member.isAdmin) : [];
  const current = visibleViews.find((view) => view.id === viewId) ?? visibleViews[0];

  let content: ComponentChildren = null;
  if (session.status === 'unknown') {
    content = <PendingSessionView />;
  } else if (session.status === 'signed-out') {
    content = <SignInView error={session.error} onSubmit={session.onSignIn} />;
  } else if (current) {
    const View = current.component;
    content = <View key={current.id} />;
  }

  // The chat links point into the chat view, so they exist only there; other views get one link to <main>.
  let skipLinks = CHAT_SKIP_LINKS;
  if (!current) skipLinks = [];
  else if (current.id !== VIEW_ID.chat) skipLinks = MAIN_SKIP_LINKS;

  return (
    <div class="app" ref={rootRef} tabIndex={-1}>
      <SkipLinks links={skipLinks} />
      <Header
        onOpenSettings={() => setSettingsOpen(true)}
        workspace={
          session.status === 'signed-in'
            ? {
                member: session.member,
                repos: session.repos,
                repoKey: session.repoKey,
                onSelectRepo: session.onSelectRepo,
                connection: session.connection,
              }
            : undefined
        }
      />
      {current && (
        <PrimaryNav
          items={visibleViews.map(({ id, label }) => ({ id, label }))}
          currentId={current.id}
          onNavigate={(id) => {
            const next = visibleViews.find((view) => view.id === id);
            if (next) setViewId(next.id);
          }}
        />
      )}
      <main id={SKIP_TARGET.main} class="app-main" tabIndex={-1}>
        {content}
      </main>
      {settingsOpen && (
        <SettingsDialog
          onClose={() => setSettingsOpen(false)}
          themeChoice={themeChoice}
          onThemeChange={onThemeChange}
          notifications={notifications}
        />
      )}
    </div>
  );
}
