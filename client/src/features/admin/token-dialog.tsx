import { useId, useRef, useState } from 'preact/hooks';
import { Dialog } from '../shell';

// The one place a member's token is ever on screen (ui-contract sections 4 and 7). What this file
// does with it, so that a reader can check it here and nowhere else:
//   - `token` is a prop. It is read twice: to fill the read-only field and to copy it. It is not put
//     in state, a ref, an attribute, storage, a URL, the console or any message.
//   - The prop comes from the view's state (admin-view.tsx), which holds the token only while this
//     dialog is mounted. Done, Escape, another dialog taking its place and the view going away all
//     replace or discard that state, and nothing in this file keeps a copy that could outlive it.

export interface TokenDialogProps {
  handle: string;
  token: string;
  onClose: () => void;
}

// `press` counts the presses of Copy token. Each result is rendered in a node with a new key, so a
// second press with the same result is announced again instead of leaving the live text unchanged.
interface CopyResult {
  readonly outcome: 'copied' | 'failed';
  readonly press: number;
}

export function TokenDialog({ handle, token, onClose }: TokenDialogProps) {
  const fieldId = useId();
  const noticeId = useId();
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const [copy, setCopy] = useState<CopyResult | null>(null);

  async function copyToken(): Promise<void> {
    let outcome: CopyResult['outcome'] = 'copied';
    try {
      await navigator.clipboard.writeText(token);
    } catch {
      // The error is neither logged nor kept: all that matters is that the person is told, and a log
      // line or a stored error would be one more place the token could end up. With the field
      // selected, copying by hand is one key away.
      outcome = 'failed';
      fieldRef.current?.select();
    }
    setCopy((previous) => ({ outcome, press: (previous?.press ?? 0) + 1 }));
  }

  return (
    <Dialog title={`New token for ${handle}`} onClose={onClose} describedBy={noticeId}>
      <p id={noticeId}>This token is shown once</p>
      <p class="field__hint">Copy it now and hand it over privately. When this dialog closes it cannot be shown again; rotate the token if it is lost.</p>
      <div class="field">
        <label for={fieldId}>Token</label>
        {/* A textarea, so that the whole token wraps into view at any width instead of scrolling inside one line. */}
        <textarea
          ref={fieldRef}
          id={fieldId}
          class="token-field"
          readOnly
          rows={2}
          value={token}
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          onFocus={(event) => event.currentTarget.select()}
        />
      </div>
      <p role="status" class="field__hint">
        {copy?.outcome === 'copied' && <span key={copy.press}>Token copied.</span>}
      </p>
      {copy?.outcome === 'failed' && (
        <p key={copy.press} role="alert" class="alert tone-danger">
          Could not copy the token. Select the field and copy it by hand.
        </p>
      )}
      <div class="dialog__actions">
        <button type="button" onClick={() => void copyToken()}>
          Copy token
        </button>
        <button type="button" class="button--primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Dialog>
  );
}
