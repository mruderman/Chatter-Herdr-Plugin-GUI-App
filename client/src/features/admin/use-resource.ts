// One list the page loads and can load again. The data already on screen stays until a newer answer
// replaces it, so the rows (and the buttons that opened a dialog) are not torn down on every reload.
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { toFailure, type Failure } from './failure';

export interface Resource<T> {
  /** The last answer, kept while a reload is running and after a reload fails; null until the first answer. */
  readonly data: T | null;
  /** Why the newest load failed; null when it succeeded or is still running. */
  readonly failure: Failure | null;
  readonly reload: () => void;
}

interface State<T> {
  data: T | null;
  failure: Failure | null;
}

export function useResource<T>(load: () => Promise<T>): Resource<T> {
  const [state, setState] = useState<State<T>>({ data: null, failure: null });
  const loadRef = useRef(load);
  loadRef.current = load;
  // Two loads can overlap (a reload after a change while the first is slow); only the newest may show.
  const newest = useRef(0);
  const alive = useRef(true);

  const reload = useCallback(() => {
    const mine = (newest.current += 1);
    // A retry is visibly a retry: the old failure goes while the new request is out.
    setState((previous) => (previous.failure ? { ...previous, failure: null } : previous));
    let pending: Promise<T>;
    try {
      pending = loadRef.current();
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      (data) => {
        if (alive.current && mine === newest.current) setState({ data, failure: null });
      },
      (error: unknown) => {
        if (alive.current && mine === newest.current) setState((previous) => ({ data: previous.data, failure: toFailure(error) }));
      },
    );
  }, []);

  useEffect(() => {
    alive.current = true;
    reload();
    return () => {
      alive.current = false;
    };
  }, [reload]);

  return { ...state, reload };
}
