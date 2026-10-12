import { describe, expect, it } from 'vitest';
import { ApiError, CLIENT_ERROR_CODES, ERROR_CODES, NetworkError, ProtocolError } from '../../api/errors';
import { MAYBE_DONE, UNEXPECTED_FAILURE, describeChangeFailure } from './failure';

// What an admin is told when an add, an edit, a revoke or a rotation failed. The bridge commits a change
// before it writes the audit entry (bridge/src/server.js), so an audit insert that fails answers 500
// after the member exists or the old token is dead; and whatever sits in front of the bridge may answer
// with a page of its own after it forwarded the request. Only a refusal that the bridge itself makes
// proves that nothing changed. The hint is a sentence of its own: the message before it ends with a
// full stop, so that on screen and read aloud the two do not run together.
describe('describeChangeFailure', () => {
  it.each<[string, ApiError, string]>([
    ['a 500 internal, which the bridge also answers when it cannot audit a change it has made', new ApiError(500, ERROR_CODES.internal, 'internal error'), 'internal error.'],
    ['a 502 that is not the bridge\'s own answer, such as a proxy\'s', new ApiError(502, CLIENT_ERROR_CODES.unexpectedStatus, 'the bridge answered HTTP 502'), 'the bridge answered HTTP 502.'],
    ['a status below 500 that is not the bridge\'s own answer either', new ApiError(404, CLIENT_ERROR_CODES.unexpectedStatus, 'the bridge answered HTTP 404'), 'the bridge answered HTTP 404.'],
  ])('ends with the hint to check the members list after %s', (_what, error, said) => {
    expect(describeChangeFailure(error)).toBe(`${said} ${MAYBE_DONE}`);
  });

  it.each<[string, unknown, string]>([
    ['an answer that was lost on the way', new NetworkError('the connection to the bridge broke during an answer'), 'the connection to the bridge broke during an answer.'],
    ['an answer in a shape this page does not know', new ProtocolError('token', 'is not a string'), 'The bridge answered in a way this page does not understand (token is not a string).'],
    ['something that is not one of the API errors', new Error('boom'), UNEXPECTED_FAILURE],
  ])('still ends with the hint after %s', (_what, error, said) => {
    expect(describeChangeFailure(error)).toBe(`${said} ${MAYBE_DONE}`);
  });

  it.each<[string, string]>([
    ['a full stop', 'the bridge could not finish.'],
    ['an exclamation mark', 'the bridge could not finish!'],
    ['a question mark', 'could the bridge finish?'],
  ])('does not add a full stop to a message that already ends with %s', (_mark, message) => {
    expect(describeChangeFailure(new ApiError(500, ERROR_CODES.internal, message))).toBe(`${message} ${MAYBE_DONE}`);
  });

  it.each<[number, string, string]>([
    [400, ERROR_CODES.badHandle, '"everyone" is reserved'],
    [403, ERROR_CODES.adminOnly, 'admin only'],
    [404, ERROR_CODES.noSuchMember, 'no active member "mira"'],
    [409, ERROR_CODES.handleTaken, 'member "thom" already exists'],
    [409, ERROR_CODES.lastAdmin, 'cannot demote the last admin'],
  ])('says only what the bridge said after its own %i %s refusal, because nothing changed', (status, code, message) => {
    expect(describeChangeFailure(new ApiError(status, code, message))).toBe(message);
  });
});
