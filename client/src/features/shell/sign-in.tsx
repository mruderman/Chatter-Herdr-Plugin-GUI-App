import { useId, useLayoutEffect, useRef, useState } from 'preact/hooks';

export interface SignInViewProps {
  /**
   * The bridge's message for why there is no session yet, shown as the alert: a failed attempt, or on
   * first load a 403 (not registered). Absent when nothing has failed, which is the case on first load
   * after a plain 401. The token form is shown either way.
   */
  error?: string;
  /**
   * Called with the typed token. Success is the parent removing this view, failure is the parent
   * passing `error`. A returned promise keeps the form busy until it settles; if it rejects, the
   * rejection's message is shown as the failure.
   */
  onSubmit: (token: string) => void | Promise<void>;
}

const FAILURE_PREFIX = 'Sign-in failed: ';

// The token is read straight from the field when the form is submitted. It is never put in component
// state or an attribute, never logged, and never stored; the field is blanked when this view is
// removed. After a failure the text stays (it is masked) so a typo can be corrected, and focus goes
// back to the field.
export function SignInView({ error, onSubmit }: SignInViewProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const submittingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [attempted, setAttempted] = useState(false);
  // An attempt whose call threw or rejected without the parent saying why.
  const [rejection, setRejection] = useState<string | null>(null);
  // Counts attempts that have ended. Two failures can carry the same message, so the message alone
  // cannot say "an attempt just ended".
  const [ended, setEnded] = useState(0);
  const hintId = useId();
  const fieldId = useId();
  const alertId = useId();

  const message = rejection ?? error;

  // Signing in is the only thing this page is for, so the field is ready as soon as it appears.
  useLayoutEffect(() => {
    mountedRef.current = true;
    const input = inputRef.current;
    input?.focus();
    return () => {
      mountedRef.current = false;
      // "Cleared and removed after success": the view going away is the success signal.
      if (input) input.value = '';
    };
  }, []);

  useLayoutEffect(() => {
    if (ended > 0 && !pending && message !== undefined) inputRef.current?.focus();
  }, [ended, message]);

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const input = inputRef.current;
    // Whitespace around a pasted token is never part of it.
    const token = input?.value.trim() ?? '';
    if (token === '' || submittingRef.current) return;

    submittingRef.current = true;
    setPending(true);
    setAttempted(true);
    setRejection(null);
    try {
      await onSubmit(token);
    } catch (failure) {
      if (mountedRef.current) setRejection(failure instanceof Error ? failure.message : 'Unexpected error');
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) {
        setPending(false);
        setEnded((count) => count + 1);
      }
    }
  }

  return (
    <div class="sign-in stack">
      <h1>Sign in</h1>
      {message !== undefined && (
        <p id={alertId} role="alert" class="alert tone-danger">
          {`${FAILURE_PREFIX}${message}`}
        </p>
      )}
      <form class="stack" onSubmit={(event) => void submit(event)}>
        <div class="field">
          <label for={fieldId}>Access token</label>
          <input
            ref={inputRef}
            id={fieldId}
            type="password"
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
            required
            aria-describedby={message === undefined ? hintId : `${hintId} ${alertId}`}
            aria-invalid={attempted && message !== undefined ? 'true' : undefined}
          />
          <p id={hintId} class="field__hint">
            Enter the access token you were given.
          </p>
        </div>
        <div class="cluster">
          <button type="submit" class="button--primary" aria-disabled={pending ? 'true' : undefined}>
            Sign in
          </button>
        </div>
      </form>
    </div>
  );
}
