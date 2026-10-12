// The store's session as the shell's ShellSession (T10 brief, "Wiring"), from the fake store's snapshots.
import { describe, expect, it, vi } from 'vitest';
import { createFakeStore, FAKE_TOKEN } from '../state/fake';
import { toShellSession } from './session';

describe('toShellSession', () => {
  it('passes "unknown" on as it is', () => {
    const store = createFakeStore({ session: 'unknown' });
    expect(toShellSession(store.getSnapshot(), store)).toEqual({ status: 'unknown' });
  });

  it('signed out after a plain 401: no error, so the sign-in view shows no alert', () => {
    const store = createFakeStore({ session: 'signed-out' });
    const session = toShellSession(store.getSnapshot(), store);
    expect(session.status).toBe('signed-out');
    expect('error' in session).toBe(false);
  });

  it('signed out after a 403 not_registered: the bridge\'s message, for "Sign-in failed: ..."', () => {
    const store = createFakeStore({ session: 'not-registered' });
    const session = toShellSession(store.getSnapshot(), store);
    expect(session).toMatchObject({ status: 'signed-out', error: 'your Tailscale login is not registered as a member' });
  });

  it('hands the typed token to store.signIn and settles without a value, whether or not it was accepted', async () => {
    const store = createFakeStore({ session: 'signed-out' });
    const signIn = vi.spyOn(store, 'signIn');
    const session = toShellSession(store.getSnapshot(), store);
    if (session.status !== 'signed-out') throw new Error('expected the signed-out session');
    await expect(session.onSignIn('not-the-token')).resolves.toBeUndefined();
    expect(signIn).toHaveBeenLastCalledWith('not-the-token');
    expect(toShellSession(store.getSnapshot(), store)).toMatchObject({ status: 'signed-out', error: expect.any(String) });
    await expect(session.onSignIn(FAKE_TOKEN)).resolves.toBeUndefined();
    expect(store.getSnapshot().session.status).toBe('signed-in');
  });

  it('signed in: the member with isAdmin from the role, the repos, the selected repo and the connection', () => {
    const admin = createFakeStore({ as: 'flan' });
    expect(toShellSession(admin.getSnapshot(), admin)).toMatchObject({
      status: 'signed-in',
      member: { handle: 'flan', displayName: 'flan', kind: 'human', isAdmin: true },
      repos: [
        { key: 'repo-c522d9cf', label: 'repo' },
        { key: 'site-24538864', label: 'site' },
      ],
      repoKey: 'repo-c522d9cf',
      connection: 'online',
    });
    const member = createFakeStore({ as: 'thom' });
    member.setConnection('revoked');
    expect(toShellSession(member.getSnapshot(), member)).toMatchObject({
      status: 'signed-in',
      member: { handle: 'thom', displayName: 'Thom', kind: 'computational', isAdmin: false },
      connection: 'revoked',
    });
  });

  it('selects a repository through the store', () => {
    const store = createFakeStore({ as: 'thom' });
    const session = toShellSession(store.getSnapshot(), store);
    if (session.status !== 'signed-in') throw new Error('expected the signed-in session');
    session.onSelectRepo('site-24538864');
    expect(store.getSnapshot().selectedRepo).toBe('site-24538864');
  });
});
