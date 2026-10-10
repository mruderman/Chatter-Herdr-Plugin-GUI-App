import { useId } from 'preact/hooks';
import { Dialog } from './dialog';
import { THEME_CHOICES, THEME_CHOICE_LABEL, parseThemeChoice, type ThemeChoice } from './theme';
import type { NotificationPermissionState, NotificationSettings } from './types';

// What the permission means for the person, next to the button that can only help in the first case.
const PERMISSION_TEXT: Readonly<Record<NotificationPermissionState, string>> = {
  default: 'Your browser will ask for permission.',
  granted: 'Your browser allows desktop notifications.',
  denied: 'Desktop notifications are blocked in your browser settings.',
  unsupported: 'This browser does not support desktop notifications.',
};

export interface SettingsDialogProps {
  onClose: () => void;
  themeChoice: ThemeChoice;
  onThemeChange: (choice: ThemeChoice) => void;
  /** Absent until the notifications feature is connected; the section is then left out. */
  notifications?: NotificationSettings;
}

function NotificationControls({ notifications }: { notifications: NotificationSettings }) {
  const headingId = useId();
  const statusId = useId();
  const { permission, enabled, onRequestPermission, onEnabledChange } = notifications;
  return (
    <section class="settings-section" aria-labelledby={headingId}>
      <h3 id={headingId}>Notifications</h3>
      <p id={statusId} class="field__hint">
        {PERMISSION_TEXT[permission]}
      </p>
      <div class="cluster">
        <button type="button" disabled={permission !== 'default'} aria-describedby={statusId} onClick={onRequestPermission}>
          Enable desktop notifications
        </button>
      </div>
      <label class="check">
        <input type="checkbox" checked={enabled} onChange={(event) => onEnabledChange(event.currentTarget.checked)} />
        Notify me about mentions and direct messages
      </label>
    </section>
  );
}

export function SettingsDialog({ onClose, themeChoice, onThemeChange, notifications }: SettingsDialogProps) {
  const themeId = useId();
  return (
    <Dialog title="Settings" onClose={onClose}>
      <div class="field">
        <label for={themeId}>Theme</label>
        <select id={themeId} value={themeChoice} onChange={(event) => onThemeChange(parseThemeChoice(event.currentTarget.value))}>
          {THEME_CHOICES.map((choice) => (
            <option key={choice} value={choice}>
              {THEME_CHOICE_LABEL[choice]}
            </option>
          ))}
        </select>
      </div>
      {notifications && <NotificationControls notifications={notifications} />}
      <div class="dialog__actions">
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}
