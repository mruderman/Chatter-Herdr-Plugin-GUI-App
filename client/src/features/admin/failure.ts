// How a failed call is put to the admin. Only the three error classes of src/api are read, and only
// their messages: those never hold a token or a request body. Anything else is not echoed, because
// an unknown error object could carry whatever its thrower put in it.
import { ApiError, CLIENT_ERROR_CODES, ERROR_CODES, NetworkError, ProtocolError } from '../../api/errors';

export const UNEXPECTED_FAILURE = 'Something went wrong.';
// A change whose answer never arrived (or arrived unreadable) may still have happened, and a token
// that was issued in that answer is then lost for good, so the admin is sent to look.
export const MAYBE_DONE = 'Check the members list to see whether it went through.';
// From here up a status proves nothing: the bridge answers 500 for anything it did not foresee, and it
// writes the audit entry after it has committed the change (bridge/src/server.js), so a failing audit
// insert answers 500 once the member exists or the old token is dead.
const FIRST_SERVER_ERROR = 500;

export function describeFailure(error: unknown): string {
  if (error instanceof ApiError || error instanceof NetworkError) return error.message;
  if (error instanceof ProtocolError) return `The bridge answered in a way this page does not understand (${error.message}).`;
  return UNEXPECTED_FAILURE;
}

/**
 * Only a refusal the bridge itself makes is its word that nothing happened: a status below 500 with one
 * of its own codes. An answer that is not its error shape (a proxy's 502, or any other page) carries the
 * client's `unexpected_status`, and the proxy may have forwarded the request before it failed.
 */
function isRefusal(error: unknown): boolean {
  return error instanceof ApiError && error.status < FIRST_SERVER_ERROR && error.code !== CLIENT_ERROR_CODES.unexpectedStatus;
}

/** Every failure that is not such a refusal leaves open whether the change was made. */
export function describeChangeFailure(error: unknown): string {
  const message = describeFailure(error);
  return isRefusal(error) ? message : `${message} ${MAYBE_DONE}`;
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
