// The app across a sign-out and a new sign-in in the same page. Every sign-in starts at Chat, and the
// view that was open in the earlier session must not mount even for one commit: the real Board starts
// fetching as soon as it mounts, and a Board left over from the last member would ask in their stead.
import { screen } from '@testing-library/dom';
import { useState } from 'preact/hooks';
import { describe, expect, it } from 'vitest';
import { render } from '../../test/render';
import { App } from '../app';
import { VIEW_ID, type ViewDefinition } from '../features';
import type { ShellMember, ShellSession } from '../features/shell';
import { setupUser } from '../features/shell/test-utils';

const MEMBER: ShellMember = { handle: 'ada', displayName: 'Ada Example', kind: 'human', isAdmin: false };

const signedIn: Extract<ShellSession, { status: 'signed-in' }> = {
  status: 'signed-in',
  member: MEMBER,
  repos: [{ key: 'alpha', label: 'Alpha repository' }],
  repoKey: 'alpha',
  onSelectRepo: () => undefined,
  connection: 'online',
};
const signedOut: ShellSession = { status: 'signed-out', onSignIn: () => undefined };

describe('a new sign-in in the same page', () => {
  it('opens Chat without rendering, even once, the view the previous session had open', async () => {
    let boardRenders = 0;
    const views: ViewDefinition[] = [
      { id: VIEW_ID.chat, label: 'Chat', adminOnly: false, component: () => <h1>Chat</h1> },
      {
        id: VIEW_ID.board,
        label: 'Board',
        adminOnly: false,
        component: function CountingBoard() {
          boardRenders += 1;
          return <h1>Board</h1>;
        },
      },
    ];
    function Cycling() {
      const [session, setSession] = useState<ShellSession>(signedIn);
      return (
        <>
          <button type="button" onClick={() => setSession(signedOut)}>
            Sign out
          </button>
          <button type="button" onClick={() => setSession(signedIn)}>
            Sign in again
          </button>
          <App session={session} views={views} themeChoice="system" onThemeChange={() => undefined} />
        </>
      );
    }
    const user = setupUser();
    render(<Cycling />);
    await user.click(screen.getByRole('button', { name: 'Board' }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Board');
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Sign in');

    boardRenders = 0;
    await user.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(boardRenders).toBe(0);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Chat');
    expect(screen.getByRole('button', { name: 'Chat' }).getAttribute('aria-current')).toBe('page');
  });

  it('still keeps the view the member chose while the session goes on', async () => {
    const views: ViewDefinition[] = [
      { id: VIEW_ID.chat, label: 'Chat', adminOnly: false, component: () => <h1>Chat</h1> },
      { id: VIEW_ID.board, label: 'Board', adminOnly: false, component: () => <h1>Board</h1> },
    ];
    function Updating() {
      const [connection, setConnection] = useState<'online' | 'offline'>('online');
      return (
        <>
          <button type="button" onClick={() => setConnection('offline')}>
            Go offline
          </button>
          <App session={{ ...signedIn, connection }} views={views} themeChoice="system" onThemeChange={() => undefined} />
        </>
      );
    }
    const user = setupUser();
    render(<Updating />);
    await user.click(screen.getByRole('button', { name: 'Board' }));
    await user.click(screen.getByRole('button', { name: 'Go offline' }));
    expect(screen.getByRole('status', { name: 'Connection' }).textContent).toBe('Offline');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Board');
  });
});
