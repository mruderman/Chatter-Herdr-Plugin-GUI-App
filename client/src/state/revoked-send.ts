// What a send says in a session the bridge revoked (V5 finding 3). The Connection status reads "Access revoked"
// and everything stays readable, but a send used to go nowhere without a word: the store returned false and
// the composer had nothing to show. Both stores answer with this error and make no request, and the composer
// shows it as the "Send error" alert, "Not sent: " plus the message, with the draft left in the box.
//
// The words of the fact are the Connection status's own, from the one module that both layers import
// (wording.ts), so that the two cannot drift apart.
import { CLIENT_ERROR_CODES } from '../api/errors';
import { ACCESS_REVOKED } from '../wording';
import type { ErrorInfo } from './types';

export const REVOKED_SEND: ErrorInfo = Object.freeze({
  code: CLIENT_ERROR_CODES.accessRevoked,
  message: `${ACCESS_REVOKED}, so nothing was sent.`,
});
