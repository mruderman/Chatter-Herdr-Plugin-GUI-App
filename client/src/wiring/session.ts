// The store's snapshot in the shape the shell takes (features/shell/types.ts). The shell knows nothing
// of the store, so this is the one place the two meet.
import type { Me, MemberRole } from '../api/types';
import type { ShellMember, ShellSession } from '../features/shell';
import type { Store, StoreSnapshot } from '../state/types';

const ADMIN: MemberRole = 'admin';

export function toShellMember(me: Me): ShellMember {
  return { handle: me.handle, displayName: me.display_name, kind: me.kind, isAdmin: me.role === ADMIN };
}

export function toShellSession(snapshot: StoreSnapshot, store: Store): ShellSession {
  const { session } = snapshot;
  switch (session.status) {
    case 'unknown':
      return { status: 'unknown' };
    case 'signed-out': {
      // The typed token goes from the form straight into the store, which keeps it; nothing here holds
      // on to it. The answer comes back as the session (signed in, or this error), so the promise only
      // tells the form when the attempt is over: the store resolves false on a refusal, never rejects.
      const onSignIn = async (token: string): Promise<void> => {
        await store.signIn(token);
      };
      // A null error (a plain 401 on first load, or a deliberate sign-out) is nothing to explain, so no alert.
      return session.error === null ? { status: 'signed-out', onSignIn } : { status: 'signed-out', error: session.error.message, onSignIn };
    }
    case 'signed-in':
      return {
        status: 'signed-in',
        member: toShellMember(session.me),
        repos: snapshot.repos,
        repoKey: snapshot.selectedRepo,
        onSelectRepo: (key) => store.selectRepo(key),
        connection: snapshot.connection,
      };
  }
}
