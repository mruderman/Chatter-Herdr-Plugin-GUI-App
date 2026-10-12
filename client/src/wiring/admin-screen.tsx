// The Admin entry of the app's registry, and the one place the admin panel is wired in. The panel
// (T7, src/features/admin) is not on this branch yet, so this shows the shell's placeholder for now.
// T10b replaces the body with AdminView({ api, refreshDirectory, selfHandle }): `api` from
// useServices() (the store's own Api), `refreshDirectory` as store.refreshDirectory from useStore(),
// and `selfHandle` the signed-in member's handle from useSnapshot() (ui-contract section 8).
import { createStubView } from '../features/shell';

const Placeholder = createStubView('Admin');

export function AdminScreen() {
  return <Placeholder />;
}
