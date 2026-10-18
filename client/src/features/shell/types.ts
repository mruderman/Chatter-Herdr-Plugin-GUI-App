// Props the shell components take. They are plain data and callbacks on purpose: the shell knows
// nothing about the API module or the store, so whoever wires the app maps those onto these types.
import { ACCESS_REVOKED } from '../../wording';

export type MemberKind = 'human' | 'computational';

export const MEMBER_KIND_LABEL: Readonly<Record<MemberKind, string>> = {
  human: 'Human',
  computational: 'Computational',
};

/** The four states of the connection indicator; the label is the text the indicator shows. */
export type ConnectionStatus = 'online' | 'syncing' | 'offline' | 'revoked';

export const CONNECTION_LABEL: Readonly<Record<ConnectionStatus, string>> = {
  online: 'Online',
  syncing: 'Syncing',
  offline: 'Offline',
  revoked: ACCESS_REVOKED,
};

export interface ShellMember {
  handle: string;
  displayName: string;
  kind: MemberKind;
  isAdmin: boolean;
}

/** One entry of the repository select: `key` identifies the repo, `label` is the option text. */
export interface RepoOption {
  key: string;
  label: string;
}

export type ShellSession =
  /** Waiting for the first answer from the bridge. */
  | { status: 'unknown' }
  | {
      status: 'signed-out';
      /**
       * The bridge's message for why there is no session yet: a failed attempt, or on first load a 403
       * (not registered). Left out when nothing has been tried, as after a plain 401. The sign-in view
       * shows it as the alert, prefixed "Sign-in failed: ".
       */
      error?: string;
      /** Called with the typed token. Success is the session turning `signed-in`; failure is `error`. */
      onSignIn: (token: string) => void | Promise<void>;
    }
  | {
      status: 'signed-in';
      member: ShellMember;
      repos: readonly RepoOption[];
      repoKey: string | null;
      onSelectRepo: (key: string) => void;
      connection: ConnectionStatus;
    };

/** Mirrors the browser's Notification.permission, plus `unsupported` when there is no Notification API. */
export type NotificationPermissionState = 'default' | 'granted' | 'denied' | 'unsupported';

/** State and handlers for the notification controls in Settings; the notifications feature supplies them. */
export interface NotificationSettings {
  permission: NotificationPermissionState;
  enabled: boolean;
  onRequestPermission: () => void;
  onEnabledChange: (enabled: boolean) => void;
}
