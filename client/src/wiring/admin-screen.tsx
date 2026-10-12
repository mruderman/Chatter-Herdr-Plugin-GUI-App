// The Admin entry of the app's registry, and the one place the admin panel (src/features/admin) is
// wired in. The panel calls the bridge through the store's own Api, so the token stays in the store's
// closure and nothing here is ever given it. After each change it asks the store for the directory
// again, so the composer's "To" select and @-completion see the new member list. It is told the
// signed-in member's handle, so that revoking or rotating one's own account says so (ui-contract
// section 8).
import { AdminView } from '../features/admin';
import { useSnapshot, useStore } from '../state/provider';
import { useServices } from './services-context';

export function AdminScreen() {
  const { api } = useServices();
  const store = useStore();
  const { session } = useSnapshot();
  // The shell offers Admin only while an admin is signed in; the check is for the type.
  const selfHandle = session.status === 'signed-in' ? session.me.handle : undefined;
  return <AdminView api={api} refreshDirectory={() => store.refreshDirectory()} selfHandle={selfHandle} />;
}
