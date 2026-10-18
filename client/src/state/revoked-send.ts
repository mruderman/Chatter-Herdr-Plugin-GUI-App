// What a send says in a session the bridge revoked (V5 finding 3). The Connection status reads "Access revoked"
// and everything stays readable, but a send used to go nowhere without a word: the store returned false and
// the composer had nothing to show. Both stores answer with this error and make no request, and the composer
// shows it as the "Send error" alert, "Not sent: " plus the message, with the draft left in the box.
//
// The words of the fact are the Connection status's own, read from the one constant that has them
// (features/shell/types.ts, a file of plain data with no imports), so that the two cannot drift apart; a
// second spelling of "Access revoked" would be a second place to forget. The store reaches into the shell's
// types for them, which is not how the layers otherwise point (the wiring maps the store onto the shell);
// moving the label somewhere both can import is a change to the shell's types, left to the coordinator.
import { CLIENT_ERROR_CODES } from '../api/errors';
import { CONNECTION_LABEL } from '../features/shell/types';
import type { ErrorInfo } from './types';

export const REVOKED_SEND: ErrorInfo = Object.freeze({
  code: CLIENT_ERROR_CODES.accessRevoked,
  message: `${CONNECTION_LABEL.revoked}, so nothing was sent.`,
});
