// The Admin entry of the app's registry, and the one place the admin panel (src/features/admin) is
// wired in. The panel calls the bridge through the store's own Api, so the token stays in the store's
// closure and nothing here is ever given it. After each change it asks the store for the directory
// again, so the composer's "To" select and @-completion see the new member list. It is told the
// signed-in member's handle, so that revoking or rotating one's own account says so (ui-contract
// section 8).
//
// One call does not go straight to the Api: rotating a token. It runs inside the store's followRotation,
// so that when the admin rotates their own token the session goes on with the new one, in the same tick
// the bridge's answer arrives and before the panel (which reloads its lists the moment the call ends)
// can ask for anything with the dead one. The panel itself knows nothing of this: it sees the answer.
import { useMemo } from 'preact/hooks';
import { AdminView, type AdminApi } from '../features/admin';
import { useSnapshot, useStore } from '../state/provider';
import { useServices } from './services-context';

export function AdminScreen() {
  const { api } = useServices();
  const store = useStore();
  const { session } = useSnapshot();
  const admin = useMemo<AdminApi>(
    () => ({ ...api, rotateToken: (handle, options) => store.followRotation(handle, () => api.rotateToken(handle, options)) }),
    [api, store],
  );
  // The shell offers Admin only while an admin is signed in; the check is for the type.
  const selfHandle = session.status === 'signed-in' ? session.me.handle : undefined;
  return <AdminView api={admin} refreshDirectory={() => store.refreshDirectory()} selfHandle={selfHandle} />;
}
