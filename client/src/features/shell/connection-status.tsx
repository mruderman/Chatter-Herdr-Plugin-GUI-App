import { CONNECTION_LABEL, type ConnectionStatus } from './types';

const CONNECTION_TONE: Readonly<Record<ConnectionStatus, string>> = {
  online: 'tone-success',
  syncing: 'tone-info',
  offline: 'tone-warning',
  revoked: 'tone-danger',
};

// The element's text is exactly the label and nothing else: the marker shape is drawn by CSS, and the
// name "Connection" is the accessible name, so the role=status announcement is the bare new state.
export function ConnectionStatusBadge({ status }: { status: ConnectionStatus }) {
  return (
    <span role="status" aria-label="Connection" class={`connection connection--${status} ${CONNECTION_TONE[status]}`}>
      {CONNECTION_LABEL[status]}
    </span>
  );
}
