import type { ComponentChildren, RefObject } from 'preact';
import { useId, useLayoutEffect, useRef } from 'preact/hooks';
import { SKIP_TARGET } from './skip-targets';

// Modal dialog primitive. Mount it to open, unmount it to close; it does not manage visibility itself.
// It is a native <dialog> opened with showModal(), so the browser makes everything else inert and
// puts the dialog on top; the code here adds what the contract asks for on top of that: focus moves
// in, Tab and Shift+Tab wrap, Escape asks to close, and focus goes back to whatever opened it.

const FOCUSABLE =
  'a[href], area[href], button, input, select, textarea, summary, [tabindex], [contenteditable]:not([contenteditable="false"])';

// jsdom has no layout and no checkVisibility(); there every element counts as rendered.
function isRendered(element: HTMLElement): boolean {
  return typeof element.checkVisibility === 'function' ? element.checkVisibility({ visibilityProperty: true }) : true;
}

// Elements a Tab press can land on, in document order. `tabIndex` honours both the default (0 for
// buttons and links) and an explicit tabindex="-1".
function tabbables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.matches(':disabled') &&
      !(element instanceof HTMLInputElement && element.type === 'hidden') &&
      !element.closest('[hidden], [inert]') &&
      isRendered(element),
  );
}

function openModal(dialog: HTMLDialogElement): void {
  if (dialog.hasAttribute('open')) return;
  // jsdom's dialog is a bare element without showModal(); the attribute is enough for unit tests.
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function closeModal(dialog: HTMLDialogElement): void {
  if (!dialog.hasAttribute('open')) return;
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
}

function restoreFocus(opener: HTMLElement | null): void {
  opener?.focus();
  // The render that closes a dialog can also remove or disable the opener (a row that disappears, a
  // button that is now inactive), and that happens after this runs, so focus is checked again once the
  // render is over. Landing on the view beats dropping focus on <body>.
  queueMicrotask(() => {
    const active = document.activeElement;
    const lost = !active || active === document.body || (active instanceof HTMLElement && active.matches(':disabled'));
    if (lost) document.getElementById(SKIP_TARGET.main)?.focus();
  });
}

export interface DialogProps {
  /** The accessible name, shown as the dialog's heading. */
  title: string;
  /** Called when the person asks to close (Escape). The parent unmounts the dialog in response. */
  onClose: () => void;
  children: ComponentChildren;
  /** Element to focus on open; by default the first control, or the dialog itself when it has none. */
  initialFocusRef?: RefObject<HTMLElement>;
  /** Id of an element inside the dialog that describes it; screen readers read it on open. */
  describedBy?: string;
}

export function Dialog({ title, onClose, children, initialFocusRef, describedBy }: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  // The effect below runs once; it must still call the latest handler.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;

    // Taken before focus moves: this is the control that opened the dialog.
    const active = document.activeElement;
    const opener = active instanceof HTMLElement && active !== document.body ? active : null;
    let mounted = true;

    openModal(dialog);
    (initialFocusRef?.current ?? tabbables(dialog)[0] ?? dialog).focus();

    // The browser can close a modal dialog without our asking (a second Escape after a prevented
    // cancel, for one); the parent must hear about it or it keeps believing the dialog is open.
    const onNativeClose = () => {
      if (mounted) onCloseRef.current();
    };
    dialog.addEventListener('close', onNativeClose);

    return () => {
      mounted = false;
      dialog.removeEventListener('close', onNativeClose);
      // Close before focusing: while a modal dialog is open the rest of the page is inert and focus() is a no-op.
      closeModal(dialog);
      restoreFocus(opener);
    };
  }, []);

  function onKeyDown(event: KeyboardEvent): void {
    const dialog = dialogRef.current;
    if (!dialog || event.isComposing) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
      return;
    }

    if (event.key !== 'Tab') return;
    const items = tabbables(dialog);
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    const current = document.activeElement;
    if (event.shiftKey && (current === first || current === dialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && current === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <dialog
      ref={dialogRef}
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={describedBy}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onCancel={(event) => {
        // Escape normally ends in keydown above; this is the other route (for example a back gesture).
        event.preventDefault();
        onCloseRef.current();
      }}
    >
      <div class="dialog__body">
        <h2 id={titleId} class="dialog__title">
          {title}
        </h2>
        {children}
      </div>
    </dialog>
  );
}
