// Desktop notifications for mentions and direct messages (D17), for the integration task: create one
// notifier next to the store, pass `useNotifier(notifier)` to the shell's `notifications` prop, tell it
// with `setChatOpen` whether the Chat view is the open view (src/wiring/root.tsx does), and dispose it
// with the store. The fake Notification (fake-notification.ts) is for tests only.
export {
  NOTIFICATIONS_STORAGE_KEY,
  NOTIFY_THROTTLE_MS,
  createNotifier,
  type NotificationApi,
  type NotificationHandle,
  type Notifier,
  type NotifierOptions,
  type NotifierStorage,
} from './notifier';
export { useNotifier } from './use-notifier';
