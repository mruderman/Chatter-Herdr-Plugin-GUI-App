// The notifier through the shell's Settings dialog, the way the integration task will connect them:
// useNotifier supplies the dialog's `notifications` prop, and the dialog's own controls drive it.
import { screen } from '@testing-library/dom';
import { useState } from 'preact/hooks';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '../../../test/render';
import { createFakeStore } from '../../state/fake';
import { SettingsDialog } from '../shell';
import { setupUser } from '../shell/test-utils';
import { createFakeNotifications } from './fake-notification';
import { NOTIFICATIONS_STORAGE_KEY, createNotifier, type Notifier } from './notifier';
import { useNotifier } from './use-notifier';

const BUTTON = 'Enable desktop notifications';
const CHECKBOX = 'Notify me about mentions and direct messages';

function Harness({ notifier }: { notifier: Notifier }) {
  const notifications = useNotifier(notifier);
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Open settings
      </button>
      {open && (
        <SettingsDialog onClose={() => setOpen(false)} themeChoice="system" onThemeChange={() => undefined} notifications={notifications} />
      )}
    </div>
  );
}

/** Lets a permission prompt's answer reach the notifier, and the page render what follows. */
const answered = (): Promise<void> =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

function setup(permission: NotificationPermission | null = 'default') {
  const store = createFakeStore();
  const browser = createFakeNotifications(permission ?? 'default');
  const notifier = createNotifier({ store, clock: store.clock, notificationApi: permission === null ? null : browser.api });
  render(<Harness notifier={notifier} />);
  return { store, browser, notifier, user: setupUser() };
}

async function openSettings(user: ReturnType<typeof setupUser>): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Open settings' }));
}

const button = (): HTMLButtonElement => screen.getByRole('button', { name: BUTTON });
const checkbox = (): HTMLInputElement => screen.getByRole('checkbox', { name: CHECKBOX });
const hint = (): string => document.getElementById(button().getAttribute('aria-describedby') ?? '')?.textContent ?? '';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('Settings with the notifier', () => {
  it('asks the browser for nothing until the button is pressed, and says it will ask', async () => {
    const { browser, user } = setup();
    expect(browser.requests).toBe(0);
    await openSettings(user);
    expect(browser.requests).toBe(0);
    expect(button().disabled).toBe(false);
    expect(hint()).toBe('Your browser will ask for permission.');
    expect(checkbox().checked).toBe(true);
  });

  it('asks once when the button is pressed, then shows that notifications are allowed', async () => {
    const { browser, user } = setup();
    await openSettings(user);
    await user.click(button());
    expect(browser.requests).toBe(1);
    await answered();
    expect(button().disabled).toBe(true);
    expect(hint()).toBe('Your browser allows desktop notifications.');
  });

  it('shows that the browser has no notifications, and still lets the preference be set', async () => {
    const { user } = setup(null);
    await openSettings(user);
    expect(button().disabled).toBe(true);
    expect(hint()).toBe('This browser does not support desktop notifications.');
    expect(checkbox().disabled).toBe(false);
  });

  it("reads the permission afresh at each render of the component using the hook, after a change in the browser's own settings", async () => {
    const { browser, user } = setup();
    await openSettings(user);
    await user.keyboard('{Escape}');
    browser.setPermission('denied');
    await openSettings(user);
    expect(hint()).toBe('Desktop notifications are blocked in your browser settings.');
  });

  it('turns notifications off and on through the checkbox, and remembers the choice', async () => {
    const { store, browser, user } = setup('granted');
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    await openSettings(user);
    await user.click(checkbox());
    expect(checkbox().checked).toBe(false);
    expect(window.localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)).toBe('off');
    store.receive({ from: 'mira', body: 'hello @thom' });
    expect(browser.shown).toEqual([]);
    await user.click(checkbox());
    expect(checkbox().checked).toBe(true);
    expect(window.localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)).toBe('on');
    store.receive({ from: 'grace', body: 'hello @thom' });
    expect(browser.shown).toHaveLength(1);
  });

  it('shows the remembered choice in a notifier made later, as after a reload', async () => {
    window.localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, 'off');
    const { user } = setup('granted');
    await openSettings(user);
    expect(checkbox().checked).toBe(false);
  });

  it('shows the settings of a notifier it is given later, and stops listening to the old one', async () => {
    const store = createFakeStore();
    const listening = { first: 0, second: 0 };
    const counted = (name: keyof typeof listening, notifier: Notifier): Notifier => ({
      ...notifier,
      subscribe(listener) {
        listening[name] += 1;
        const stop = notifier.subscribe(listener);
        return () => {
          listening[name] -= 1;
          stop();
        };
      },
    });
    const first = counted('first', createNotifier({ store, clock: store.clock, notificationApi: null, storage: null }));
    const second = counted(
      'second',
      createNotifier({ store, clock: store.clock, notificationApi: createFakeNotifications('granted').api, storage: null }),
    );
    function Swap() {
      const [which, setWhich] = useState<Notifier>(first);
      const settings = useNotifier(which);
      return (
        <div>
          <button type="button" onClick={() => setWhich(second)}>
            Use the second
          </button>
          <p>{settings.permission}</p>
        </div>
      );
    }
    render(<Swap />);
    const user = setupUser();
    expect(screen.getByText('unsupported')).toBeTruthy();
    expect(listening).toEqual({ first: 1, second: 0 });
    await user.click(screen.getByRole('button', { name: 'Use the second' }));
    expect(screen.getByText('granted')).toBeTruthy();
    expect(listening).toEqual({ first: 0, second: 1 });
  });
});
