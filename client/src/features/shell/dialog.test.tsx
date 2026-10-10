import { fireEvent, screen } from '@testing-library/dom';
import type { RefObject } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { describe, expect, it, vi } from 'vitest';
import { render } from '../../../test/render';
import { Dialog } from './dialog';
import { setupUser } from './test-utils';

interface HarnessProps {
  onClose?: () => void;
  focusSaveFirst?: boolean;
  empty?: boolean;
  describedBy?: string;
}

// A page with an opener, a second control, and a dialog the opener shows. `onClose` is called as well
// as closing, so a test can count the calls.
function Harness({ onClose, focusSaveFirst, empty, describedBy }: HarnessProps) {
  const [open, setOpen] = useState(false);
  const saveRef = useRef<HTMLButtonElement>(null);
  const close = () => {
    onClose?.();
    setOpen(false);
  };
  return (
    <>
      <main id="main-content" tabIndex={-1}>
        <button type="button" onClick={() => setOpen(true)}>
          Open it
        </button>
        <button type="button">Other control</button>
      </main>
      {open && (
        <Dialog
          title="Edit alice"
          onClose={close}
          initialFocusRef={focusSaveFirst ? (saveRef as RefObject<HTMLElement>) : undefined}
          describedBy={describedBy}
        >
          {empty ? (
            <p>Nothing to do here.</p>
          ) : (
            <>
              <p id="why">Changes apply at once.</p>
              <label>
                Name <input type="text" />
              </label>
              <button type="button" ref={saveRef}>
                Save
              </button>
              <button type="button" onClick={close}>
                Cancel
              </button>
            </>
          )}
        </Dialog>
      )}
    </>
  );
}

async function openDialog(props: HarnessProps = {}) {
  const user = setupUser();
  render(<Harness {...props} />);
  const opener = screen.getByRole('button', { name: 'Open it' });
  await user.click(opener);
  return { user, opener, dialog: screen.getByRole('dialog', { name: 'Edit alice' }) };
}

describe('Dialog: what it is', () => {
  it('is a named modal dialog with a level-2 heading as its name', async () => {
    const { dialog } = await openDialog();
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const heading = screen.getByRole('heading', { name: 'Edit alice', level: 2 });
    expect(dialog.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(dialog.contains(heading)).toBe(true);
  });

  it('points aria-describedby at the element it is given', async () => {
    const { dialog } = await openDialog({ describedBy: 'why' });
    expect(dialog.getAttribute('aria-describedby')).toBe('why');
    expect(document.getElementById('why')?.textContent).toBe('Changes apply at once.');
  });

  it('is open while mounted and gone after closing', async () => {
    const { user, dialog } = await openDialog();
    expect(dialog.hasAttribute('open')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Dialog: focus moves in on open', () => {
  it('focuses the first control inside', async () => {
    const { dialog } = await openDialog();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Name' }));
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('focuses the element named by initialFocusRef instead', async () => {
    await openDialog({ focusSaveFirst: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Save' }));
  });

  it('focuses the dialog itself when it holds nothing focusable', async () => {
    const { dialog } = await openDialog({ empty: true });
    expect(document.activeElement).toBe(dialog);
  });
});

describe('Dialog: Tab and Shift+Tab stay inside', () => {
  it('wraps from the last control to the first with Tab', async () => {
    const { user } = await openDialog();
    screen.getByRole('button', { name: 'Cancel' }).focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Name' }));
  });

  it('wraps from the first control to the last with Shift+Tab', async () => {
    const { user } = await openDialog();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Name' }));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('never lets focus reach the page behind it, in either direction', async () => {
    const { user, dialog } = await openDialog();
    for (let press = 0; press < 8; press += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    for (let press = 0; press < 8; press += 1) {
      await user.tab({ shift: true });
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('keeps focus on the dialog when there is nothing to tab to', async () => {
    const { user, dialog } = await openDialog({ empty: true });
    await user.tab();
    expect(document.activeElement).toBe(dialog);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(dialog);
  });

  it('skips disabled controls and elements with tabindex -1', async () => {
    const user = setupUser();
    render(
      <Dialog title="Mixed" onClose={() => undefined}>
        <button type="button">First</button>
        <button type="button" disabled>
          Disabled
        </button>
        <button type="button" tabIndex={-1}>
          Not in the tab order
        </button>
        <button type="button">Last</button>
      </Dialog>,
    );
    screen.getByRole('button', { name: 'Last' }).focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First' }));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Last' }));
  });
});

describe('Dialog: Escape closes', () => {
  it('asks the parent to close once, and focus returns to the opener', async () => {
    const onClose = vi.fn();
    const { user, opener } = await openDialog({ onClose });
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('does not close while an input method is composing text', async () => {
    const onClose = vi.fn();
    const { dialog } = await openDialog({ onClose });
    fireEvent.keyDown(document.activeElement ?? dialog, { key: 'Escape', isComposing: true });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('calls the latest onClose, not the one from the first render', async () => {
    const calls: string[] = [];
    function Latest() {
      const [label, setLabel] = useState('first');
      return (
        <Dialog title="Latest" onClose={() => calls.push(label)}>
          <button type="button" onClick={() => setLabel('second')}>
            Change handler
          </button>
        </Dialog>
      );
    }
    const user = setupUser();
    render(<Latest />);
    await user.click(screen.getByRole('button', { name: 'Change handler' }));
    await user.keyboard('{Escape}');
    expect(calls).toEqual(['second']);
  });
});

describe('Dialog: focus returns to the opener', () => {
  it('after Cancel as well as after Escape', async () => {
    const { user, opener } = await openDialog();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(opener);
  });

  it('lands on the view when the opener has left the page', async () => {
    const user = setupUser();
    function Vanishing() {
      const [openerShown, setOpenerShown] = useState(true);
      const [open, setOpen] = useState(false);
      return (
        <>
          <main id="main-content" tabIndex={-1}>
            {openerShown && (
              <button type="button" onClick={() => setOpen(true)}>
                Revoke alice
              </button>
            )}
          </main>
          {open && (
            <Dialog title="Revoke alice?" onClose={() => setOpen(false)}>
              <button
                type="button"
                onClick={() => {
                  setOpenerShown(false);
                  setOpen(false);
                }}
              >
                Revoke
              </button>
            </Dialog>
          )}
        </>
      );
    }
    render(<Vanishing />);
    await user.click(screen.getByRole('button', { name: 'Revoke alice' }));
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(document.activeElement).toBe(document.getElementById('main-content'));
  });

  it('lands on the view when nothing had focus at open time (a click that does not focus its button)', async () => {
    function Programmatic() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <main id="main-content" tabIndex={-1}>
            <button type="button" data-testid="trigger" onClick={() => setOpen(true)}>
              Trigger
            </button>
          </main>
          {open && (
            <Dialog title="Programmatic" onClose={() => setOpen(false)}>
              <button type="button">Inside</button>
            </Dialog>
          )}
        </>
      );
    }
    const user = setupUser();
    render(<Programmatic />);
    // fireEvent.click does not focus anything, like a mouse click in browsers that do not focus buttons.
    fireEvent.click(screen.getByTestId('trigger'));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Inside' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(document.getElementById('main-content'));
  });

  it('moves focus on from a disabled opener to the view', async () => {
    function Disabling() {
      const [open, setOpen] = useState(false);
      const [done, setDone] = useState(false);
      return (
        <>
          <main id="main-content" tabIndex={-1}>
            <button type="button" disabled={done} onClick={() => setOpen(true)}>
              Rotate token
            </button>
          </main>
          {open && (
            <Dialog title="Rotate?" onClose={() => setOpen(false)}>
              <button
                type="button"
                onClick={() => {
                  setDone(true);
                  setOpen(false);
                }}
              >
                Confirm
              </button>
            </Dialog>
          )}
        </>
      );
    }
    const user = setupUser();
    render(<Disabling />);
    await user.click(screen.getByRole('button', { name: 'Rotate token' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(document.activeElement).toBe(document.getElementById('main-content'));
  });
});

describe('Dialog: closes the browser can cause', () => {
  it('treats a cancel event as a request to close and keeps the browser from closing it itself', async () => {
    const onClose = vi.fn();
    const { dialog } = await openDialog({ onClose });
    const cancel = new Event('cancel', { cancelable: true });
    dialog.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('tells the parent when the dialog is closed natively', async () => {
    const onClose = vi.fn();
    const { dialog } = await openDialog({ onClose });
    dialog.dispatchEvent(new Event('close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not call onClose again for the close it causes itself on unmount', async () => {
    const onClose = vi.fn();
    const { user } = await openDialog({ onClose });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
