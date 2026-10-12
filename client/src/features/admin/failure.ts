// How a failed call is put to the admin. Only the three error classes of src/api are read, and only
// their messages: those never hold a token or a request body. Anything else is not echoed, because
// an unknown error object could carry whatever its thrower put in it.
import { ApiError, ERROR_CODES, NetworkError, ProtocolError } from '../../api/errors';

export const UNEXPECTED_FAILURE = 'Something went wrong.';
// A change whose answer never arrived (or arrived unreadable) may still have happened, and a token
// that was issued in that answer is then lost for good, so the admin is sent to look.
export const MAYBE_DONE = 'Check the members list to see whether it went through.';

export function describeFailure(error: unknown): string {
  if (error instanceof ApiError || error instanceof NetworkError) return error.message;
  if (error instanceof ProtocolError) return `The bridge answered in a way this page does not understand (${error.message}).`;
  return UNEXPECTED_FAILURE;
}

/** A refusal is the bridge's own word that nothing happened; every other failure leaves that open. */
export function describeChangeFailure(error: unknown): string {
  const message = describeFailure(error);
  return error instanceof ApiError ? message : `${message} ${MAYBE_DONE}`;
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
