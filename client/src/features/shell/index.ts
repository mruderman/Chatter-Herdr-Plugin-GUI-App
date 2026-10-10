// What the rest of the app imports from the shell. The views use Dialog, KindBadge and SKIP_TARGET;
// app.tsx composes the rest.
export { ConnectionStatusBadge } from './connection-status';
export { Dialog, type DialogProps } from './dialog';
export { Header, type HeaderProps, type HeaderWorkspace } from './header';
export { KindBadge } from './kind-badge';
export { PendingSessionView } from './pending-view';
export { PrimaryNav, type NavItem, type PrimaryNavProps } from './primary-nav';
export { SettingsDialog, type SettingsDialogProps } from './settings-dialog';
export { SignInView, type SignInViewProps } from './sign-in';
export { SkipLinks, type SkipLinksProps } from './skip-links';
export { CHAT_SKIP_LINKS, MAIN_SKIP_LINKS, SKIP_TARGET, type SkipLinkSpec } from './skip-targets';
export { createStubView } from './stub-views';
export {
  THEME_CHOICES,
  THEME_CHOICE_LABEL,
  THEME_STORAGE_KEY,
  createThemeManager,
  parseThemeChoice,
  type ThemeChoice,
  type ThemeEnvironment,
  type ThemeManager,
} from './theme';
export {
  CONNECTION_LABEL,
  MEMBER_KIND_LABEL,
  type ConnectionStatus,
  type MemberKind,
  type NotificationPermissionState,
  type NotificationSettings,
  type RepoOption,
  type ShellMember,
  type ShellSession,
} from './types';
export { useTheme } from './use-theme';
