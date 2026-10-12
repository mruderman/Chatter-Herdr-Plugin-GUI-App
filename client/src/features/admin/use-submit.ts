// The state every dialog that sends something shares: is a call running, and what did the bridge
// refuse with. One call at a time, so Enter pressed twice cannot add (or revoke) twice.
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { describeChangeFailure } from './failure';
import type { Outcome } from './outcome';

export interface Submit {
  readonly busy: boolean;
  /** The refusal to show as an alert; null when there is none. */
  readonly message: string | null;
  readonly run: (action: () => Promise<Outcome>) => Promise<void>;
  readonly refuse: (message: string) => void;
}

export function useSubmit(): Submit {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const busyRef = useRef(false);
  // The dialog can be dismissed while its call is still out; the call goes on and the view acts on
  // the answer, so the dialog has nothing left to update.
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(async (action: () => Promise<Outcome>): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setMessage(null);
    let outcome: Outcome;
    try {
      outcome = await action();
    } catch (failure) {
      outcome = { ok: false, message: describeChangeFailure(failure) };
    }
    busyRef.current = false;
    if (!alive.current) return;
    setBusy(false);
    if (!outcome.ok) setMessage(outcome.message);
  }, []);

  return { busy, message, run, refuse: setMessage };
}
