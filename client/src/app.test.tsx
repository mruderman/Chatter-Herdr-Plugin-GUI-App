import { screen, within } from '@testing-library/dom';
import { useState } from 'preact/hooks';
import { describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '../test/render';
import { App, type AppProps } from './app';
import { VIEW_ID, VIEWS, type ViewDefinition } from './features';
import type { ConnectionStatus, NotificationSettings, ShellMember, ShellSession } from './features/shell';
import { expectNoAxeViolations, setupUser } from './features/shell/test-utils';

// Names, roles and strings below are written out as docs/ui-contract.md has them, not read from the
// constants the components use, so changing a constant cannot quietly change the contract.

const ADMIN: ShellMember = { handle: 'flan', displayName: 'Flan Example', kind: 'human', isAdmin: true };
const MEMBER: ShellMember = { handle: 'ada', displayName: 'Ada Example', kind: 'computational', isAdmin: false };

const REPOS = [
  { key: 'alpha', label: 'Alpha repository' },
  { key: 'beta', label: 'Beta repository' },
];

function signedIn(overrides: Partial<Extract<ShellSession, { status: 'signed-in' }>> = {}): ShellSession {
  return {
    status: 'signed-in',
    member: ADMIN,
    repos: REPOS,
    repoKey: 'alpha',
    onSelectRepo: () => undefined,
    connection: 'online',
    ...overrides,
  };
}

function signedOut(overrides: Partial<Extract<ShellSession, { status: 'signed-out' }>> = {}): ShellSession {
  return { status: 'signed-out', onSignIn: () => undefined, ...overrides };
}

const NOTIFICATIONS: NotificationSettings = {
  permission: 'default',
  enabled: false,
  onRequestPermission: () => undefined,
  onEnabledChange: () => undefined,
};

// What the chat view will provide once it exists: the two elements the skip links jump to. The default
// stubs have neither, and axe flags a skip link whose target is missing, so the axe runs use this.
const CHAT_WITH_TARGETS: ViewDefinition = {
  id: VIEW_ID.chat,
  label: 'Chat',
  adminOnly: false,
  component: () => (
    <>
      <h1>Chat</h1>
      <div role="log" aria-label="Messages" aria-live="off" id="chat-messages" tabIndex={0} />
      <textarea aria-label="Message" id="chat-message-box" />
    </>
  ),
};
const VIEWS_WITH_CHAT_TARGETS: readonly ViewDefinition[] = [CHAT_WITH_TARGETS, ...VIEWS.slice(1)];

function renderApp(overrides: Partial<AppProps> = {}) {
  const props: AppProps = {
    session: signedIn(),
    themeChoice: 'system',
    onThemeChange: () => undefined,
    ...overrides,
  };
  return render(<App {...props} />);
}

describe('signed-in shell: structure (ui-contract section 2)', () => {
  it('has a banner, a Primary navigation, a main landmark and exactly one h1', () => {
    renderApp();
    expect(screen.getByRole('banner')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeTruthy();
    expect(screen.getAllByRole('main')).toHaveLength(1);
    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings.map((heading) => heading.textContent)).toEqual(['Chat']);
    expect(within(screen.getByRole('main')).getByRole('heading', { level: 1 })).toBe(headings[0]);
  });

  it('puts the name, repository select, connection status, member and Settings in the banner', () => {
    renderApp();
    const banner = within(screen.getByRole('banner'));
    expect(banner.getByText('Chatter')).toBeTruthy();
    const select = banner.getByRole('combobox', { name: 'Repository' });
    expect(select.tagName).toBe('SELECT');
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Alpha repository',
      'Beta repository',
    ]);
    expect((select as HTMLSelectElement).value).toBe('alpha');
    expect(banner.getByRole('status', { name: 'Connection' }).textContent).toBe('Online');
    expect(banner.getByText('Flan Example (flan)')).toBeTruthy();
    expect(banner.getByText('Human')).toBeTruthy();
    expect(banner.getByRole('button', { name: 'Settings' })).toBeTruthy();
  });

  it('keeps the member text and the kind badge in separate elements', () => {
    renderApp({ session: signedIn({ member: MEMBER }) });
    const identity = screen.getByText('Ada Example (ada)');
    const badge = screen.getByText('Computational');
    expect(identity.textContent).toBe('Ada Example (ada)');
    expect(badge.textContent).toBe('Computational');
    expect(identity.contains(badge)).toBe(false);
  });

  it.each<[ConnectionStatus, string]>([
    ['online', 'Online'],
    ['syncing', 'Syncing'],
    ['offline', 'Offline'],
    ['revoked', 'Access revoked'],
  ])('%s connection: the status text is exactly "%s"', (connection, text) => {
    renderApp({ session: signedIn({ connection }) });
    const status = screen.getByRole('status', { name: 'Connection' });
    expect(status.textContent).toBe(text);
    expect(status.children).toHaveLength(0);
  });

  it('lists Chat, Board and Members for a member, and Admin as well for an admin', () => {
    renderApp({ session: signedIn({ member: MEMBER }) });
    const nav = within(screen.getByRole('navigation', { name: 'Primary' }));
    expect(nav.getAllByRole('button').map((button) => button.textContent)).toEqual(['Chat', 'Board', 'Members']);
    cleanup();
    renderApp();
    const adminNav = within(screen.getByRole('navigation', { name: 'Primary' }));
    expect(adminNav.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Chat',
      'Board',
      'Members',
      'Admin',
    ]);
  });
});

describe('signed-in shell: primary navigation and aria-current', () => {
  it('marks Chat as the current page to begin with, and nothing else', () => {
    renderApp();
    const nav = within(screen.getByRole('navigation', { name: 'Primary' }));
    expect(nav.getByRole('button', { name: 'Chat' }).getAttribute('aria-current')).toBe('page');
    for (const name of ['Board', 'Members', 'Admin']) {
      expect(nav.getByRole('button', { name }).hasAttribute('aria-current')).toBe(false);
    }
  });

  it('moves aria-current and the h1 together', async () => {
    const user = setupUser();
    renderApp();
    const nav = within(screen.getByRole('navigation', { name: 'Primary' }));
    for (const name of ['Board', 'Members', 'Admin', 'Chat']) {
      await user.click(nav.getByRole('button', { name }));
      expect(nav.getByRole('button', { name }).getAttribute('aria-current')).toBe('page');
      expect(nav.getAllByRole('button').filter((button) => button.hasAttribute('aria-current'))).toHaveLength(1);
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(name);
    }
  });

  it('works from the keyboard alone', async () => {
    const user = setupUser();
    renderApp();
    screen.getByRole('button', { name: 'Board' }).focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Board');
    await user.tab();
    await user.keyboard(' ');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Members');
  });

  it('falls back to the first view when the open one stops being available to the member', async () => {
    function Demoting() {
      const [member, setMember] = useState(ADMIN);
      return (
        <>
          <button type="button" onClick={() => setMember(MEMBER)}>
            Demote
          </button>
          <App session={signedIn({ member })} themeChoice="system" onThemeChange={() => undefined} />
        </>
      );
    }
    const user = setupUser();
    render(<Demoting />);
    await user.click(screen.getByRole('button', { name: 'Admin' }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Admin');
    await user.click(screen.getByRole('button', { name: 'Demote' }));
    expect(screen.queryByRole('button', { name: 'Admin' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Chat');
    expect(screen.getByRole('button', { name: 'Chat' }).getAttribute('aria-current')).toBe('page');
  });

  it('shows a view the registry gives it, not only the stubs', async () => {
    const custom: ViewDefinition[] = [
      { id: VIEW_ID.chat, label: 'Chat', adminOnly: false, component: () => <h1>Custom chat</h1> },
      { id: VIEW_ID.board, label: 'Board', adminOnly: false, component: () => <h1>Custom board</h1> },
    ];
    const user = setupUser();
    renderApp({ views: custom });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Custom chat');
    await user.click(screen.getByRole('button', { name: 'Board' }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Custom board');
  });
});

describe('signed-in shell: repository select', () => {
  it('reports the chosen repository key', async () => {
    const onSelectRepo = vi.fn();
    const user = setupUser();
    renderApp({ session: signedIn({ onSelectRepo }) });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Repository' }), 'Beta repository');
    expect(onSelectRepo).toHaveBeenCalledWith('beta');
  });

  it('is disabled with a plain option while there are no repositories', () => {
    renderApp({ session: signedIn({ repos: [], repoKey: null }) });
    const select = screen.getByRole('combobox', { name: 'Repository' }) as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual(['No repositories']);
  });
});

describe('skip links and tab order (ui-contract sections 2 and 5)', () => {
  it('makes the two chat skip links the first two tab stops, then the header, then the navigation', async () => {
    const user = setupUser();
    renderApp();
    const expected = [
      screen.getByRole('link', { name: 'Skip to messages' }),
      screen.getByRole('link', { name: 'Skip to message box' }),
      screen.getByRole('combobox', { name: 'Repository' }),
      screen.getByRole('button', { name: 'Settings' }),
      screen.getByRole('button', { name: 'Chat' }),
      screen.getByRole('button', { name: 'Board' }),
      screen.getByRole('button', { name: 'Members' }),
      screen.getByRole('button', { name: 'Admin' }),
    ];
    for (const element of expected) {
      await user.tab();
      expect(document.activeElement).toBe(element);
    }
  });

  it('points the chat links at the ids the chat view must carry', () => {
    renderApp();
    expect(screen.getByRole('link', { name: 'Skip to messages' }).getAttribute('href')).toBe('#chat-messages');
    expect(screen.getByRole('link', { name: 'Skip to message box' }).getAttribute('href')).toBe('#chat-message-box');
  });

  it('replaces them with one link to the view on Board, Members and Admin', async () => {
    const user = setupUser();
    renderApp();
    for (const name of ['Board', 'Members', 'Admin']) {
      await user.click(screen.getByRole('button', { name }));
      expect(screen.queryByRole('link', { name: 'Skip to messages' })).toBeNull();
      expect(screen.queryByRole('link', { name: 'Skip to message box' })).toBeNull();
      const links = screen.getAllByRole('link');
      expect(links.map((link) => link.textContent)).toEqual(['Skip to main content']);
      await user.click(links[0] as HTMLElement);
      expect(document.activeElement).toBe(screen.getByRole('main'));
    }
  });

  it('moves focus to the feed and to the message box when the chat view provides them', async () => {
    const user = setupUser();
    renderApp({ views: VIEWS_WITH_CHAT_TARGETS });
    await user.click(screen.getByRole('link', { name: 'Skip to messages' }));
    expect(document.activeElement).toBe(screen.getByRole('log', { name: 'Messages' }));
    await user.click(screen.getByRole('link', { name: 'Skip to message box' }));
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Message' }));
    expect(window.location.hash).toBe('');
  });

  it('does nothing, and does not throw, when the chat view has no such target', async () => {
    const user = setupUser();
    renderApp();
    screen.getByRole('button', { name: 'Settings' }).focus();
    await user.click(screen.getByRole('link', { name: 'Skip to messages' }));
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Skip to messages' }));
    expect(window.location.hash).toBe('');
  });

  it('has no skip links before sign-in', () => {
    renderApp({ session: signedOut() });
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    cleanup();
    renderApp({ session: { status: 'unknown' } });
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('makes a skip link visible by CSS only when it has focus, never by removing it from the tab order', () => {
    renderApp();
    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('tabindex')).toBeNull();
      expect(link.hasAttribute('hidden')).toBe(false);
      expect(link.getAttribute('aria-hidden')).toBeNull();
    }
  });
});

describe('states before sign-in', () => {
  it('shows the sign-in form with only the name and Settings in the banner', () => {
    renderApp({ session: signedOut() });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Sign in');
    const banner = within(screen.getByRole('banner'));
    expect(banner.getByText('Chatter')).toBeTruthy();
    expect(banner.getByRole('button', { name: 'Settings' })).toBeTruthy();
    expect(banner.queryByRole('combobox')).toBeNull();
    expect(banner.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(within(screen.getByRole('main')).getByLabelText('Access token')).toBeTruthy();
  });

  it('shows a pending state while the first answer is awaited', () => {
    renderApp({ session: { status: 'unknown' } });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Chatter');
    expect(screen.getByRole('status').textContent).toBe('Checking your session');
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByLabelText('Access token')).toBeNull();
  });

  it('shows no alert for a plain 401 (no error given), and the message for a 403 not_registered', () => {
    renderApp({ session: signedOut() });
    expect(screen.queryByRole('alert')).toBeNull();
    cleanup();
    renderApp({ session: signedOut({ error: 'your Tailscale login is not registered as a member' }) });
    expect(screen.getByRole('alert').textContent).toBe(
      'Sign-in failed: your Tailscale login is not registered as a member',
    );
    expect(screen.getByLabelText('Access token')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });

  it('shows the error of a failed attempt that the session reports', async () => {
    function Failing() {
      const [error, setError] = useState<string | undefined>();
      return (
        <App
          session={signedOut({ error, onSignIn: () => setError('Invalid or revoked token') })}
          themeChoice="system"
          onThemeChange={() => undefined}
        />
      );
    }
    const user = setupUser();
    render(<Failing />);
    await user.type(screen.getByLabelText('Access token'), 'throwaway-value{Enter}');
    expect((await screen.findByRole('alert')).textContent).toBe('Sign-in failed: Invalid or revoked token');
  });
});

describe('after signing in', () => {
  // The store flips the session to signed in; the form goes away with the focused field in it.
  function SigningIn() {
    const [session, setSession] = useState<ShellSession>(
      signedOut({
        onSignIn: () => {
          setSession(signedIn());
        },
      }),
    );
    return <App session={session} themeChoice="system" onThemeChange={() => undefined} />;
  }

  it('leaves focus at the top, so the next Tab reaches "Skip to messages"', async () => {
    const user = setupUser();
    render(<SigningIn />);
    await user.type(screen.getByLabelText('Access token'), 'throwaway-value{Enter}');
    expect(screen.queryByLabelText('Access token')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Chat');
    expect(document.activeElement).not.toBe(document.body);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Skip to messages' }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Skip to message box' }));
  });

  it('shows the Chat view after sign-in, whatever was open in an earlier session', async () => {
    function Cycling() {
      const [session, setSession] = useState<ShellSession>(signedIn());
      return (
        <>
          <button type="button" onClick={() => setSession(signedOut())}>
            Sign out
          </button>
          <button type="button" onClick={() => setSession(signedIn())}>
            Sign in again
          </button>
          <App session={session} themeChoice="system" onThemeChange={() => undefined} />
        </>
      );
    }
    const user = setupUser();
    render(<Cycling />);
    await user.click(screen.getByRole('button', { name: 'Board' }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Board');
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Sign in');
    await user.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Chat');
    expect(screen.getByRole('button', { name: 'Chat' }).getAttribute('aria-current')).toBe('page');
  });

  it('does not take focus from a control the person had already moved to', async () => {
    const user = setupUser();
    function Moving() {
      const [session, setSession] = useState<ShellSession>(signedOut());
      return (
        <>
          <button type="button" onClick={() => setSession(signedIn())}>
            Flip session
          </button>
          <App session={session} themeChoice="system" onThemeChange={() => undefined} />
        </>
      );
    }
    render(<Moving />);
    await user.click(screen.getByRole('button', { name: 'Flip session' }));
    // The button the person pressed still has focus; the shell must not move it.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Flip session' }));
  });
});

describe('Settings dialog in the shell', () => {
  it('opens from the Settings button and returns focus to it on Close', async () => {
    const user = setupUser();
    renderApp({ notifications: NOTIFICATIONS });
    const opener = screen.getByRole('button', { name: 'Settings' });
    await user.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('closes on Escape and returns focus to the Settings button', async () => {
    const user = setupUser();
    renderApp();
    const opener = screen.getByRole('button', { name: 'Settings' });
    await user.click(opener);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('opens before sign-in too, so the theme can be changed on the sign-in page', async () => {
    const user = setupUser();
    renderApp({ session: signedOut() });
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Theme' })).toBeTruthy();
  });

  it('shows the current theme and reports a new one', async () => {
    const onThemeChange = vi.fn();
    const user = setupUser();
    renderApp({ themeChoice: 'dark', onThemeChange });
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const select = screen.getByRole('combobox', { name: 'Theme' }) as HTMLSelectElement;
    expect(select.value).toBe('dark');
    await user.selectOptions(select, 'High contrast');
    expect(onThemeChange).toHaveBeenCalledWith('hc');
  });
});

describe('every state: the rules that hold everywhere', () => {
  const views = VIEWS_WITH_CHAT_TARGETS;
  const states: Array<[string, () => void]> = [
    ['unknown session', () => void renderApp({ session: { status: 'unknown' } })],
    ['signed out', () => void renderApp({ session: signedOut() })],
    ['signed out, not registered', () => void renderApp({ session: signedOut({ error: 'your Tailscale login is not registered as a member' }) })],
    ['signed in, admin', () => void renderApp({ views })],
    ['signed in, member', () => void renderApp({ views, session: signedIn({ member: MEMBER }) })],
    ['signed in, no repositories', () => void renderApp({ views, session: signedIn({ repos: [], repoKey: null }) })],
    ['signed in, offline', () => void renderApp({ views, session: signedIn({ connection: 'offline' }) })],
    ['signed in, access revoked', () => void renderApp({ views, session: signedIn({ connection: 'revoked' }) })],
  ];

  it.each(states)('%s: no style attribute, no "bot", no remote URL in the markup', (_name, show) => {
    show();
    expect(document.body.querySelectorAll('[style]')).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/\bbot\b/i);
    expect(document.body.innerHTML).not.toMatch(/https?:\/\//i);
    expect(document.body.querySelectorAll('img, iframe, object, embed, script, link')).toHaveLength(0);
  });

  it.each(states)('%s: axe finds no violation in its structure', async (_name, show) => {
    show();
    await expectNoAxeViolations();
  });

  it('Board, Members and Admin: axe finds no violation either', async () => {
    const user = setupUser();
    renderApp({ views });
    for (const name of ['Board', 'Members', 'Admin']) {
      await user.click(screen.getByRole('button', { name }));
      await expectNoAxeViolations();
    }
  });

  it('an open Settings dialog (with and without notification controls): axe finds no violation', async () => {
    const user = setupUser();
    renderApp({ views, notifications: NOTIFICATIONS });
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await expectNoAxeViolations();
    cleanup();
    renderApp({ views });
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await expectNoAxeViolations();
  });

  it('a failed sign-in with its alert: axe finds no violation', async () => {
    function Failing() {
      const [error, setError] = useState<string | undefined>();
      return (
        <App
          session={signedOut({ error, onSignIn: () => setError('Invalid or revoked token') })}
          themeChoice="system"
          onThemeChange={() => undefined}
        />
      );
    }
    const user = setupUser();
    render(<Failing />);
    await user.type(screen.getByLabelText('Access token'), 'throwaway-value{Enter}');
    expect((await screen.findByRole('alert')).textContent).toBe('Sign-in failed: Invalid or revoked token');
    await expectNoAxeViolations();
  });
});

describe('the default registry and the default view', () => {
  it('has Chat, Board, Members and Admin in that order, and only Admin is admin-only', () => {
    expect(VIEWS.map((view) => [view.id, view.label, view.adminOnly])).toEqual([
      ['chat', 'Chat', false],
      ['board', 'Board', false],
      ['members', 'Members', false],
      ['admin', 'Admin', true],
    ]);
  });

  it('shows Chat first, because it is the first entry', () => {
    renderApp();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Chat');
    expect(screen.getByRole('button', { name: 'Chat' }).getAttribute('aria-current')).toBe('page');
  });

  it('shows the first entry of whatever registry it is given', () => {
    const reordered = [VIEWS[1], VIEWS[0]] as ViewDefinition[];
    renderApp({ views: reordered });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Board');
  });

  it('takes the default view as a prop', () => {
    renderApp({ defaultViewId: VIEW_ID.members });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Members');
    expect(screen.getByRole('button', { name: 'Members' }).getAttribute('aria-current')).toBe('page');
  });
});
