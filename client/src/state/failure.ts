// How the store reads a failed request, and when it asks again. Every request it makes on its own
// (the session check, the repo list, the directory, a repo's newest page) goes through keepTrying;
// requests a member starts (send, older messages) fail once and say so. A read acknowledgement is the
// exception: it says nothing, and the store retries one that failed in transit (store.ts, retryRead).
import { ApiError, ERROR_CODES, NetworkError, ProtocolError } from '../api/errors';
import type { ErrorInfo } from './types';

/** The bridge's answer to missing or dead credentials; a 403 not_registered is the tailnet's. */
export const UNAUTHORIZED = 401;
// Below 500, only these are worth asking again; any other refusal comes back the same.
const RETRYABLE = new Set([408, 429]);
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const ABORT = 'AbortError';

export type Failure =
  /** The store dropped the request itself (sign-out, revocation, dispose). */
  | { readonly kind: 'aborted' }
  /** The bridge does not accept the member's credentials (401), or the tailnet login is not a member (403 not_registered). */
  | { readonly kind: 'auth'; readonly status: number; readonly error: ErrorInfo }
  /** Unreachable, a server error, a rate limit or an answer in the wrong shape: worth asking again later. */
  | { readonly kind: 'transient'; readonly error: ErrorInfo }
  /** The bridge said no and will say it again. */
  | { readonly kind: 'refused'; readonly error: ErrorInfo }
  /** Not a failure of the request at all: a bug, reported rather than retried. */
  | { readonly kind: 'bug'; readonly error: unknown };

function isAbort(failure: unknown): boolean {
  return typeof failure === 'object' && failure !== null && 'name' in failure && failure.name === ABORT;
}

/** `signal` is the one the request was made with: once it is aborted, nothing about the answer matters. */
export function classify(failure: unknown, signal?: AbortSignal): Failure {
  if (signal?.aborted || isAbort(failure)) return { kind: 'aborted' };
  if (failure instanceof ApiError) {
    const error = { code: failure.code, message: failure.message };
    if (failure.status === UNAUTHORIZED || failure.code === ERROR_CODES.notRegistered) return { kind: 'auth', status: failure.status, error };
    if (failure.status >= 500 || RETRYABLE.has(failure.status)) return { kind: 'transient', error };
    return { kind: 'refused', error };
  }
  if (failure instanceof NetworkError || failure instanceof ProtocolError) {
    return { kind: 'transient', error: { code: failure.code, message: failure.message } };
  }
  return { kind: 'bug', error: failure };
}

/** Exponential: 1 s, 2 s, 4 s ... capped at 30 s, after `failures` failures in a row. */
export function retryDelay(failures: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** failures);
}

export interface KeepTrying<T> {
  readonly request: (signal: AbortSignal) => Promise<T>;
  readonly signal: AbortSignal;
  /** False once the answer no longer matters (signed out, revoked, the repo reloaded); checked before every attempt too. */
  readonly current: () => boolean;
  readonly schedule: (callback: () => void, ms: number) => () => void;
  readonly onValue: (value: T) => void;
  /** The credentials stopped working: retrying cannot help. */
  readonly onAuth: (error: ErrorInfo, status: number) => void;
  readonly report: (error: unknown) => void;
}

/** Asks until the bridge answers, backing off between failures. Never rejects. */
export function keepTrying<T>(o: KeepTrying<T>): void {
  let failures = 0;
  const attempt = async (): Promise<void> => {
    if (!o.current()) return;
    try {
      const value = await o.request(o.signal);
      if (o.current()) o.onValue(value);
    } catch (failure) {
      if (!o.current()) return;
      const read = classify(failure, o.signal);
      switch (read.kind) {
        case 'aborted':
          return;
        case 'bug':
          o.report(read.error);
          return;
        case 'auth':
          o.onAuth(read.error, read.status);
          return;
        case 'transient':
        case 'refused':
          o.schedule(() => {
            void attempt();
          }, retryDelay(failures));
          failures += 1;
          return;
      }
    }
  };
  void attempt();
}
