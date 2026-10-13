// Every failure the API layer reports is one of the three classes below, so callers branch on a
// class and a code and never inspect a Response. None of them carries a token: requests are
// described by path only, and the fetch failure kept as `cause` holds no request headers.

/**
 * Codes the bridge sends in `{"error":{"code","message"}}`. error-codes.test.ts reads bridge/src and
 * fails when this list and the bridge's differ, so a new bridge code cannot be forgotten.
 */
export const ERROR_CODES = {
  unauthenticated: 'unauthenticated',
  badToken: 'bad_token',
  notRegistered: 'not_registered',
  adminOnly: 'admin_only',
  everyoneAdminOnly: 'everyone_admin_only',
  agentsNotAllowed: 'agents_not_allowed',
  agentsUnverifiable: 'agents_unverifiable',
  badRequest: 'bad_request',
  badJson: 'bad_json',
  emptyBody: 'empty_body',
  invalidBody: 'invalid_body',
  bodyTooLong: 'body_too_long',
  bodyTooLarge: 'body_too_large',
  selfDm: 'self_dm',
  unknownRecipient: 'unknown_recipient',
  /** A direct message refused because the handle begins an agent's name or the sender's own handle (409). */
  ambiguousRecipient: 'ambiguous_recipient',
  rateLimited: 'rate_limited',
  notFound: 'not_found',
  badRepo: 'bad_repo',
  noSuchRepo: 'no_such_repo',
  repoUnwritable: 'repo_unwritable',
  chatterRefused: 'chatter_refused',
  chatterError: 'chatter_error',
  schemaMismatch: 'schema_mismatch',
  badHandle: 'bad_handle',
  badKind: 'bad_kind',
  badRole: 'bad_role',
  handleTaken: 'handle_taken',
  handleIsAgent: 'handle_is_agent',
  loginTaken: 'login_taken',
  noSuchMember: 'no_such_member',
  lastAdmin: 'last_admin',
  internal: 'internal',
} as const;

/** Codes this client assigns to failures that never produced a bridge error body. */
export const CLIENT_ERROR_CODES = {
  /** A non-2xx answer without the bridge's error shape, e.g. a proxy's 502 page. */
  unexpectedStatus: 'unexpected_status',
  /** A token that cannot be sent, because it has spaces or control characters inside. */
  unusableToken: 'unusable_token',
  network: 'network',
  protocol: 'protocol',
} as const;

/** The bridge refused the request; `code` and `message` are the bridge's own. */
export class ApiError extends Error {
  override name = 'ApiError';
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** The bridge could not be reached, or the connection failed before a whole answer arrived. */
export class NetworkError extends Error {
  override name = 'NetworkError';
  readonly code = CLIENT_ERROR_CODES.network;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** The bridge answered, but not in the shape this client was built against. */
export class ProtocolError extends Error {
  override name = 'ProtocolError';
  readonly code = CLIENT_ERROR_CODES.protocol;
  /** Where the mismatch is, e.g. `messages[3].created_at`. */
  readonly field: string;

  constructor(field: string, problem: string) {
    super(`${field} ${problem}`);
    this.field = field;
  }
}
