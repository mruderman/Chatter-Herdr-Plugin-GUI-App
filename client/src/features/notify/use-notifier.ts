import { useEffect, useState } from 'preact/hooks';
import type { NotificationSettings } from '../shell';
import type { Notifier } from './notifier';

/**
 * The notifier's settings for the shell's `notifications` prop, rendered again whenever the notifier
 * says they changed.
 */
export function useNotifier(notifier: Notifier): NotificationSettings {
  // The state only triggers renders; what is returned is read from the notifier, which re-reads the
  // browser's permission, so any render of the component that calls this hook is never stale. A
  // permission changed in the browser's own settings is seen at that component's next render, not
  // when it happens: nothing in the browser tells the page, short of the Permissions API.
  const [, setSeen] = useState<NotificationSettings>(() => notifier.getSettings());
  useEffect(() => notifier.subscribe(setSeen), [notifier]);
  return notifier.getSettings();
}
