import type { ComponentChildren } from 'preact';
import { useId, useRef } from 'preact/hooks';
import { Dialog } from '../shell';
import type { Outcome } from './outcome';
import { useSubmit } from './use-submit';

export interface ConfirmDialogProps {
  title: string;
  confirmLabel: string;
  /** Revoking is the one action that cannot be taken back, so it gets the danger button. */
  danger?: boolean;
  /** What will happen, in words; it is also what a screen reader hears as the dialog's description. */
  children: ComponentChildren;
  onConfirm: () => Promise<Outcome>;
  onCancel: () => void;
}

// Asks before an action that cuts someone off. Focus starts on Cancel, the safe answer, so Enter on
// arrival does nothing; the confirm button is one Tab away.
export function ConfirmDialog({ title, confirmLabel, danger = false, children, onConfirm, onCancel }: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const descriptionId = useId();
  const { busy, message, run } = useSubmit();

  return (
    <Dialog title={title} onClose={onCancel} initialFocusRef={cancelRef} describedBy={descriptionId}>
      <div id={descriptionId} class="stack">
        {children}
      </div>
      {message !== null && (
        <p role="alert" class="alert tone-danger">
          {message}
        </p>
      )}
      <div class="dialog__actions">
        <button ref={cancelRef} type="button" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          class={danger ? 'button--danger' : 'button--primary'}
          aria-disabled={busy ? 'true' : undefined}
          onClick={() => void run(onConfirm)}
        >
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
