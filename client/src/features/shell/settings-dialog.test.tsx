import { screen, within } from '@testing-library/dom';
import { describe, expect, it, vi } from 'vitest';
import { render } from '../../../test/render';
import { SettingsDialog, type SettingsDialogProps } from './settings-dialog';
import { setupUser } from './test-utils';
import type { NotificationPermissionState, NotificationSettings } from './types';

function notifications(overrides: Partial<NotificationSettings> = {}): NotificationSettings {
  return { permission: 'default', enabled: false, onRequestPermission: () => undefined, onEnabledChange: () => undefined, ...overrides };
}

function renderSettings(overrides: Partial<SettingsDialogProps> = {}) {
  const props: SettingsDialogProps = {
    onClose: () => undefined,
    themeChoice: 'system',
    onThemeChange: () => undefined,
    notifications: notifications(),
    ...overrides,
  };
  render(<SettingsDialog {...props} />);
  return within(screen.getByRole('dialog', { name: 'Settings' }));
}

describe('Settings dialog (ui-contract section 4)', () => {
  it('has the Theme select, the notification button and checkbox, and Close', () => {
    const dialog = renderSettings();
    expect(dialog.getByRole('combobox', { name: 'Theme' }).tagName).toBe('SELECT');
    expect(dialog.getByRole('button', { name: 'Enable desktop notifications' })).toBeTruthy();
    expect(dialog.getByRole('checkbox', { name: 'Notify me about mentions and direct messages' })).toBeTruthy();
    expect(dialog.getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  it('offers System, Light, Dark and High contrast, in that order', () => {
    const dialog = renderSettings();
    const options = within(dialog.getByRole('combobox', { name: 'Theme' })).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['System', 'Light', 'Dark', 'High contrast']);
  });

  it('shows the chosen theme and reports each change with its value', async () => {
    const onThemeChange = vi.fn();
    const user = setupUser();
    const dialog = renderSettings({ themeChoice: 'dark', onThemeChange });
    const select = dialog.getByRole('combobox', { name: 'Theme' }) as HTMLSelectElement;
    expect(select.value).toBe('dark');
    await user.selectOptions(select, 'Light');
    await user.selectOptions(select, 'High contrast');
    await user.selectOptions(select, 'System');
    expect(onThemeChange.mock.calls.map(([choice]) => choice)).toEqual(['light', 'hc', 'system']);
  });

  it('closes through its Close button and through Escape', async () => {
    const onClose = vi.fn();
    const user = setupUser();
    const dialog = renderSettings({ onClose });
    await user.click(dialog.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('Settings dialog: notification controls take their state and handlers from props', () => {
  it('asks for permission through the button while permission is still undecided', async () => {
    const onRequestPermission = vi.fn();
    const user = setupUser();
    const dialog = renderSettings({ notifications: notifications({ onRequestPermission }) });
    await user.click(dialog.getByRole('button', { name: 'Enable desktop notifications' }));
    expect(onRequestPermission).toHaveBeenCalledTimes(1);
  });

  it.each<NotificationPermissionState>(['granted', 'denied', 'unsupported'])(
    'disables the button and explains why when permission is %s',
    (permission) => {
      const dialog = renderSettings({ notifications: notifications({ permission }) });
      const button = dialog.getByRole('button', { name: 'Enable desktop notifications' }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      const description = button.getAttribute('aria-describedby');
      expect(description).toBeTruthy();
      expect(document.getElementById(description ?? '')?.textContent).not.toBe('');
    },
  );

  it('keeps the checkbox usable whatever the permission, since it is a preference', () => {
    const dialog = renderSettings({ notifications: notifications({ permission: 'denied' }) });
    const checkbox = dialog.getByRole('checkbox', { name: 'Notify me about mentions and direct messages' }) as HTMLInputElement;
    expect(checkbox.disabled).toBe(false);
  });

  it('reflects `enabled` in the checkbox and reports a change', async () => {
    const onEnabledChange = vi.fn();
    const user = setupUser();
    const dialog = renderSettings({ notifications: notifications({ enabled: true, onEnabledChange }) });
    const checkbox = dialog.getByRole('checkbox', { name: 'Notify me about mentions and direct messages' }) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    await user.click(checkbox);
    expect(onEnabledChange).toHaveBeenCalledWith(false);
  });

  it('leaves the notification section out when none is connected', () => {
    const dialog = renderSettings({ notifications: undefined });
    expect(dialog.queryByRole('button', { name: 'Enable desktop notifications' })).toBeNull();
    expect(dialog.queryByRole('checkbox')).toBeNull();
    expect(dialog.getByRole('combobox', { name: 'Theme' })).toBeTruthy();
  });
});
