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
  /**
   * The registry to show. Defaults to the shell's own, whose views are placeholders that need no store;
   * the running app passes the real views (src/wiring/views.tsx), and tests pass a smaller one.
   */
  views?: readonly ViewDefinition[];
  /** The view shown after sign-in; defaults to the first entry of the registry, which is Chat. */
  defaultViewId?: ViewId;
  /**
   * Told which view is open: the one <main> shows, after the default view and the admin filter, or null
   * while there is none (before sign-in, and after sign-out). Called once when the app mounts and again
   * each time that changes, in the commit that changes the screen. The latest function given is the one
   * called, so an arrow made afresh on every render of the parent does not repeat the report.
   */
  onOpenViewChange?: (viewId: ViewId | null) => void;
}

/**
 * How many times this App has seen the session turn signed-in. It moves during the render that first
 * shows the new session, so that render already knows a choice made in an earlier session is stale.
 * Comparing with the last status seen keeps it from moving twice for one sign-in.
 */
function useSignInCount(status: ShellSession['status']): number {
  const seen = useRef({ status, count: 0 });
  if (seen.current.status !== status) {
    seen.current = { status, count: status === 'signed-in' ? seen.current.count + 1 : seen.current.count };
  }
  return seen.current.count;
}

/** The view the member opened, and in which sign-in they opened it. */
interface ViewChoice {
  readonly signIn: number;
  readonly viewId: ViewId | undefined;
}

// Composes the shell from props. It owns only what is purely about the screen (which view is open,
// whether Settings is open); everything about the session arrives through `session`.
export function App({ session, themeChoice, onThemeChange, notifications, views = VIEWS, defaultViewId, onOpenViewChange }: AppProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const startView = defaultViewId ?? views[0]?.id;
  const signIn = useSignInCount(session.status);
  const [choice, setChoice] = useState<ViewChoice>(() => ({ signIn, viewId: startView }));
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Every sign-in starts at the default view, whatever was open in an earlier session. Decided here, in
  // the render, rather than reset afterwards: a reset after the commit would mount the old view first.
  const viewId = choice.signIn === signIn ? choice.viewId : startView;

  const previousStatus = useRef(session.status);
  useLayoutEffect(() => {
    if (previousStatus.current === session.status) return;
    previousStatus.current = session.status;
    // When the sign-in form disappears the focused field goes with it and focus falls back to <body>,
    // where the browser may continue from wherever the field was. Putting it on the root first makes
    // the next Tab reach the first skip link, which is what the contract lists as the first tab stop.
    if (document.activeElement === document.body) rootRef.current?.focus();
  }, [session.status]);

  const member = session.status === 'signed-in' ? session.member : null;
  const visibleViews = member ? views.filter((view) => !view.adminOnly || member.isAdmin) : [];
  const current = visibleViews.find((view) => view.id === viewId) ?? visibleViews[0];

  // What the host is told is `current`, the view <main> really shows: not the member's last choice, which
  // an admin filter may have overruled, and not the registry's first entry. No view is shown before
  // sign-in or after sign-out, so that is null, which is also how a sign-out clears what was reported.
  const openViewId = current?.id ?? null;
  const reportOpenView = useRef(onOpenViewChange);
  reportOpenView.current = onOpenViewChange;
  // A layout effect, so that the host knows in the commit that puts the view on screen and not a frame after.
  useLayoutEffect(() => {
    reportOpenView.current?.(openViewId);
  }, [openViewId]);

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
            if (next) setChoice({ signIn, viewId: next.id });
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
