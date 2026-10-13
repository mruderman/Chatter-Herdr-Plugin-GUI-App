// How a failed call is put to the admin. Only the three error classes of src/api are read, and only
// their messages: those never hold a token or a request body. Anything else is not echoed, because
// an unknown error object could carry whatever its thrower put in it.
import { ApiError, ERROR_CODES, NetworkError, ProtocolError } from '../../api/errors';

export const UNEXPECTED_FAILURE = 'Something went wrong.';
// A change whose answer never arrived (or arrived unreadable) may still have happened, and a token
// that was issued in that answer is then lost for good, so the admin is sent to look.
export const MAYBE_DONE = 'Check the members list to see whether it went through.';
// From here up a status proves nothing: the bridge answers 500 for anything it did not foresee. It makes
// each change and its audit entry one transaction (bridge/src/server.js), so its own 500 means that nothing
// changed, but a 5xx can also come from whatever sits in front of it, after the request was forwarded, and
// the admin cannot tell which sent it.
const FIRST_SERVER_ERROR = 500;

export function describeFailure(error: unknown): string {
  if (error instanceof ApiError || error instanceof NetworkError) return error.message;
  if (error instanceof ProtocolError) return `The bridge answered in a way this page does not understand (${error.message}).`;
  return UNEXPECTED_FAILURE;
}

// The API client builds an ApiError from any JSON body shaped like the bridge's error, so the code is
// what tells the bridge's own answer from a proxy's: a 408 `upstream_timeout` is not in this set.
const BRIDGE_CODES: ReadonlySet<string> = new Set<string>(Object.values(ERROR_CODES));

/**
 * Only a refusal the bridge itself makes is its word that nothing happened: a status below 500 with one
 * of its own codes. Anything else may have been forwarded before it failed: a proxy's page carries the
 * client's `unexpected_status`, and a proxy's JSON error carries a code the bridge never sends.
 */
export function isRefusal(error: unknown): boolean {
  return error instanceof ApiError && error.status < FIRST_SERVER_ERROR && BRIDGE_CODES.has(error.code);
}

// The hint after a message is a sentence of its own, so the message must end with one of these marks,
// or the two run together on screen and aloud.
const SENTENCE_END = /[.!?]$/;

function endSentence(message: string): string {
  return SENTENCE_END.test(message) ? message : `${message}.`;
}

/** Every failure that is not such a refusal leaves open whether the change was made. */
export function describeChangeFailure(error: unknown): string {
  const message = describeFailure(error);
  return isRefusal(error) ? message : `${endSentence(message)} ${MAYBE_DONE}`;
}

/** The bridge says admins only (403): the member is not an admin, however they got here. */
export function isAdminOnly(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403 && error.code === ERROR_CODES.adminOnly;
}

export interface Failure {
  readonly message: string;
  readonly adminOnly: boolean;
}

export function toFailure(error: unknown): Failure {
  return { message: describeFailure(error), adminOnly: isAdminOnly(error) };
}
