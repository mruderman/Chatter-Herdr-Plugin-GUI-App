// @vitest-environment node
// createApi against a fetch that replays the real bridge's recorded answers. Checks what goes out
// (method, path, headers, body) and how each kind of answer comes back.
import { describe, expect, it } from 'vitest';
import { body, exchange, recordedError, type RecordedExchange } from '../../test/fixtures/recorded';
import { createApi, type Api, type FetchLike } from './client';
import { ApiError, CLIENT_ERROR_CODES, ERROR_CODES, NetworkError, ProtocolError } from './errors';
import { parseMessagesPage } from './guards';

// A throwaway credential: it opens nothing anywhere.
const TOKEN = 'test-token-0123456789';
const KEY = parseMessagesPage(body('messages-flan')).repo;

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | null;
}

/** Answers every request with one recorded exchange, and keeps what was sent. */
function replaying(name: string): { fetch: FetchLike; sent: Sent[] } {
  const sent: Sent[] = [];
  const recorded = exchange(name);
  const fetch: FetchLike = async (url, init) => {
    sent.push({
      url,
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? init.body : null,
    });
    return answer(recorded);
  };
  return { fetch, sent };
}

function answer(recorded: RecordedExchange): Response {
  return new Response(JSON.stringify(recorded.body), {
    status: recorded.status,
    headers: { 'content-type': recorded.content_type ?? 'application/json' },
  });
}

function apiFor(fetch: FetchLike, token: string | null = TOKEN): Api {
  return createApi({ getToken: () => token, fetch });
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to fail');
}

describe('createApi: what each method sends and returns', () => {
  const calls: ReadonlyArray<readonly [string, string, (api: Api) => Promise<unknown>, string, string, unknown]> = [
    ['healthz', 'health', (api) => api.health(), 'GET', '/healthz', null],
    ['me-admin', 'me', (api) => api.me(), 'GET', '/v1/me', null],
    ['directory', 'directory', (api) => api.directory(), 'GET', '/v1/directory', null],
    ['repos-admin', 'repos', (api) => api.repos(), 'GET', '/v1/repos', null],
    ['messages-flan', 'messages, newest page', (api) => api.messages(KEY), 'GET', `/v1/repos/${KEY}/messages`, null],
    ['messages-after', 'messages after an id', (api) => api.messages(KEY, { afterId: 0, limit: 4 }), 'GET', `/v1/repos/${KEY}/messages?after_id=0&limit=4`, null],
    ['messages-before', 'messages before an id', (api) => api.messages(KEY, { beforeId: 14, limit: 3 }), 'GET', `/v1/repos/${KEY}/messages?before_id=14&limit=3`, null],
    ['post-chat', 'send', (api) => api.send(KEY, { to: '#chat', body: 'hello from thom' }), 'POST', `/v1/repos/${KEY}/messages`, { to: '#chat', body: 'hello from thom' }],
    ['board', 'board', (api) => api.board(KEY), 'GET', `/v1/repos/${KEY}/board`, null],
    ['read', 'markRead', (api) => api.markRead(KEY, 5), 'POST', `/v1/repos/${KEY}/read`, { up_to_id: 5 }],
    ['members-list', 'members', (api) => api.members(), 'GET', '/v1/members', null],
    ['members-add-computational', 'addMember', (api) => api.addMember({ handle: 'thom', kind: 'computational', display_name: 'Thom' }), 'POST', '/v1/members', { handle: 'thom', kind: 'computational', display_name: 'Thom' }],
    ['members-update', 'updateMember', (api) => api.updateMember('ezra', { display_name: 'Ezra R.' }), 'PATCH', '/v1/members/ezra', { display_name: 'Ezra R.' }],
    ['members-revoke', 'revokeMember', (api) => api.revokeMember('temp'), 'DELETE', '/v1/members/temp', null],
    ['members-rotate-token', 'rotateToken', (api) => api.rotateToken('mira'), 'POST', '/v1/members/mira/token', null],
    ['audit', 'audit', (api) => api.audit({ limit: 50 }), 'GET', '/v1/audit?limit=50', null],
  ];

  it.each(calls)('replays %s through %s', async (name, _method, call, method, path, sentBody) => {
    const { fetch, sent } = replaying(name);
    const result = await call(apiFor(fetch));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe(method);
    expect(sent[0]?.url).toBe(path);
    expect(sent[0]?.headers.get('accept')).toBe('application/json');
    if (sentBody === null) {
      expect(sent[0]?.body).toBeNull();
      expect(sent[0]?.headers.get('content-type')).toBeNull();
    } else {
      expect(JSON.parse(sent[0]?.body ?? 'null')).toEqual(sentBody);
      expect(sent[0]?.headers.get('content-type')).toBe('application/json');
    }
    expect(result).toBeTypeOf('object');
  });

  it('paths the recorded requests used are the paths it builds', () => {
    expect(exchange('messages-after').request.path).toBe(`/v1/repos/${KEY}/messages?after_id=0&limit=4`);
    expect(exchange('members-update').request.path).toBe('/v1/members/ezra');
  });

  it('prefixes a base URL and encodes keys and handles as single path segments', async () => {
    const { fetch, sent } = replaying('board');
    await createApi({ baseUrl: 'http://127.0.0.1:8791', getToken: () => null, fetch }).board('a/b c');
    expect(sent[0]?.url).toBe('http://127.0.0.1:8791/v1/repos/a%2Fb%20c/board');
  });

  it('refuses a key or handle that the URL parser would resolve away, before any request', async () => {
    const { fetch, sent } = replaying('board');
    const api = apiFor(fetch);
    await expect(api.board('..')).rejects.toThrow(TypeError);
    await expect(api.revokeMember('.')).rejects.toThrow(TypeError);
    expect(sent).toHaveLength(0);
  });

  it('refuses a cursor that is not a non-negative integer, before any request', async () => {
    const { fetch, sent } = replaying('messages-flan');
    await expect(apiFor(fetch).messages(KEY, { afterId: -1 })).rejects.toThrow(TypeError);
    await expect(apiFor(fetch).markRead(KEY, 1.5)).rejects.toThrow(TypeError);
    expect(sent).toHaveLength(0);
  });
});

// GET /v1/repos/{key}/conversations has no recording (the recorder is not part of T19b), so the answer is made here.
describe('createApi: conversations', () => {
  const PAIRS = { repo: KEY, conversations: [{ a: 'codex', b: 'thom', last_id: 8, last_at: '2026-10-10T14:06:56Z' }] };

  function answering(status: number, json: unknown): { fetch: FetchLike; sent: Sent[] } {
    const sent: Sent[] = [];
    const fetch: FetchLike = async (url, init) => {
      sent.push({ url, method: init.method ?? 'GET', headers: new Headers(init.headers), body: typeof init.body === 'string' ? init.body : null });
      return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
    };
    return { fetch, sent };
  }

  it('asks GET /v1/repos/{key}/conversations with the bearer token and no body, and returns the parsed answer', async () => {
    const { fetch, sent } = answering(200, PAIRS);
    const result = await apiFor(fetch).conversations(KEY);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe('GET');
    expect(sent[0]?.url).toBe(`/v1/repos/${KEY}/conversations`);
    expect(sent[0]?.headers.get('accept')).toBe('application/json');
    expect(sent[0]?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(sent[0]?.body).toBeNull();
    expect(result).toEqual(PAIRS);
  });

  it('sends no Authorization without a token, so the tailnet identity can apply, and keeps the key out of the query', async () => {
    const { fetch, sent } = answering(200, PAIRS);
    await apiFor(fetch, null).conversations(KEY);
    expect(sent[0]?.headers.get('authorization')).toBeNull();
    expect(sent[0]?.url).not.toContain('?');
  });

  it('encodes the key as one path segment and refuses one the URL parser would resolve away, before any request', async () => {
    const { fetch, sent } = answering(200, PAIRS);
    await createApi({ baseUrl: 'http://127.0.0.1:8791', getToken: () => null, fetch }).conversations('a/b c');
    expect(sent[0]?.url).toBe('http://127.0.0.1:8791/v1/repos/a%2Fb%20c/conversations');
    await expect(apiFor(fetch).conversations('..')).rejects.toThrow(TypeError);
    expect(sent).toHaveLength(1);
  });

  it('turns a refusal into an ApiError with the bridge\'s code, and a 401 into one with status 401', async () => {
    const { status, code, message } = recordedError('me-bad-token');
    const { fetch } = answering(status, { error: { code, message } });
    const error = await failure(apiFor(fetch).conversations(KEY));
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, code: ERROR_CODES.badToken, message });
  });

  it('reports a 2xx answer in the wrong shape as a ProtocolError naming the field', async () => {
    const { fetch } = answering(200, { repo: KEY, conversations: [{ a: 'codex', b: 'thom', last_id: '8', last_at: '2026-10-10T14:06:56Z' }] });
    const error = await failure(apiFor(fetch).conversations(KEY));
    expect(error).toBeInstanceOf(ProtocolError);
    expect(error).toMatchObject({ field: 'conversations[0].last_id' });
  });

  it('passes the caller\'s own abort through as an abort', async () => {
    const controller = new AbortController();
    const fetch: FetchLike = (_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    const pending = failure(apiFor(fetch).conversations(KEY, { signal: controller.signal }));
    controller.abort();
    expect(await pending).toMatchObject({ name: 'AbortError' });
  });
});

describe('createApi: credentials', () => {
  it('sends the token as a bearer header and never in the URL', async () => {
    const { fetch, sent } = replaying('me-admin');
    await apiFor(fetch).me();
    expect(sent[0]?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(sent[0]?.url).not.toContain(TOKEN);
  });

  it('sends no Authorization at all without a token, so the tailnet identity can apply', async () => {
    for (const token of [null, '', '   ']) {
      const { fetch, sent } = replaying('me-admin');
      await apiFor(fetch, token).me();
      expect(sent[0]?.headers.has('authorization')).toBe(false);
    }
  });

  it('asks for the token on every request, so a new one takes effect at once', async () => {
    let token: string | null = null;
    const { fetch, sent } = replaying('me-admin');
    const api = createApi({ getToken: () => token, fetch });
    await api.me();
    token = TOKEN;
    await api.me();
    expect(sent.map((s) => s.headers.get('authorization'))).toEqual([null, `Bearer ${TOKEN}`]);
  });

  it('trims a pasted token, and refuses one with spaces inside without sending or echoing it', async () => {
    const pasted = replaying('me-admin');
    await apiFor(pasted.fetch, `  ${TOKEN}\n`).me();
    expect(pasted.sent[0]?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);

    const broken = replaying('me-admin');
    const error = await failure(apiFor(broken.fetch, 'test token').me());
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, code: CLIENT_ERROR_CODES.unusableToken });
    expect(String((error as Error).message)).not.toContain('test token');
    expect(broken.sent).toHaveLength(0);
  });
});

describe('createApi: failures', () => {
  const refusals: ReadonlyArray<readonly [string, (api: Api) => Promise<unknown>]> = [
    ['me-unauthenticated', (api) => api.me()],
    ['me-bad-token', (api) => api.me()],
    ['post-everyone-member', (api) => api.send(KEY, { to: '#chat', body: '@everyone wake up' })],
    ['post-agents-not-allowed', (api) => api.send(KEY, { to: '#chat', body: '@codex hello' })],
    ['post-empty', (api) => api.send(KEY, { to: '#chat', body: '   ' })],
    ['post-too-long', (api) => api.send(KEY, { to: '#chat', body: 'x' })],
    ['post-unknown-recipient', (api) => api.send(KEY, { to: 'nobody', body: 'hello?' })],
    ['post-rate-limited', (api) => api.send(KEY, { to: '#chat', body: 'two' })],
    ['messages-bad-after', (api) => api.messages(KEY)],
    ['messages-no-such-repo', (api) => api.messages('nowhere-00000000')],
    ['members-forbidden', (api) => api.members()],
    ['members-add-taken', (api) => api.addMember({ handle: 'thom', kind: 'computational' })],
    ['not-found', (api) => api.health()],
  ];

  it.each(refusals)('turns the recorded refusal %s into an ApiError with the bridge code and message', async (name, call) => {
    const { fetch } = replaying(name);
    const error = await failure(call(apiFor(fetch)));
    const expected = recordedError(name);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: expected.status, code: expected.code, message: expected.message });
  });

  it('keeps the @everyone refusal word for word, since the composer shows it', async () => {
    const { fetch } = replaying('post-everyone-member');
    const error = await failure(apiFor(fetch).send(KEY, { to: '#chat', body: '@everyone wake up' }));
    expect(error).toMatchObject({ status: 403, code: ERROR_CODES.everyoneAdminOnly, message: '@everyone is reserved for the admin; nothing was posted' });
  });

  it('reports a non-2xx answer without the error shape by its status', async () => {
    const fetch: FetchLike = async () => new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } });
    const error = await failure(apiFor(fetch).me());
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 502, code: CLIENT_ERROR_CODES.unexpectedStatus });
  });

  it('reports an unreachable bridge as a NetworkError, with nothing secret in it', async () => {
    const cause = new TypeError('fetch failed');
    const fetch: FetchLike = async () => {
      throw cause;
    };
    const error = await failure(apiFor(fetch).me());
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).cause).toBe(cause);
    expect(JSON.stringify(error) + String(error)).not.toContain(TOKEN);
  });

  it('reports a body that breaks off as a NetworkError', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"handle":'));
        controller.error(new TypeError('terminated'));
      },
    });
    const fetch: FetchLike = async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    expect(await failure(apiFor(fetch).me())).toBeInstanceOf(NetworkError);
  });

  it('reports a 2xx answer that is not JSON, or not the right shape, as a ProtocolError naming the field', async () => {
    const notJson: FetchLike = async () => new Response('OK', { status: 200 });
    expect(await failure(apiFor(notJson).me())).toMatchObject({ name: 'ProtocolError', field: 'body' });
    const wrongShape: FetchLike = async () => Response.json({ ...(body('me-admin') as object), role: 'owner' });
    const error = await failure(apiFor(wrongShape).me());
    expect(error).toBeInstanceOf(ProtocolError);
    expect(error).toMatchObject({ field: 'role' });
  });

  it('passes the caller\'s own abort through as an abort, not as a network failure', async () => {
    const controller = new AbortController();
    const fetch: FetchLike = (_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });
    const pending = apiFor(fetch).me({ signal: controller.signal });
    controller.abort();
    const error = await failure(pending);
    expect(error).not.toBeInstanceOf(NetworkError);
    expect((error as Error).name).toBe('AbortError');
  });
});

describe('createApi: openStream', () => {
  function streamFetch(response: () => Response): { fetch: FetchLike; sent: Sent[] } {
    const sent: Sent[] = [];
    const fetch: FetchLike = async (url, init) => {
      sent.push({ url, method: init.method ?? 'GET', headers: new Headers(init.headers), body: null });
      return response();
    };
    return { fetch, sent };
  }
  const eventStream = (): Response => new Response('retry: 2000\n\n', { status: 200, headers: { 'content-type': exchange('stream-live').content_type ?? '' } });

  it('asks for an event stream with the cursor in Last-Event-ID and returns the body', async () => {
    const { fetch, sent } = streamFetch(eventStream);
    const body = await apiFor(fetch).openStream(KEY, { lastEventId: 14, signal: new AbortController().signal });
    expect(sent[0]?.url).toBe(`/v1/repos/${KEY}/stream`);
    expect(sent[0]?.headers.get('accept')).toBe('text/event-stream');
    expect(sent[0]?.headers.get('last-event-id')).toBe('14');
    expect(sent[0]?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(await new Response(body).text()).toBe('retry: 2000\n\n');
  });

  it('sends no Last-Event-ID without a cursor, and never puts the cursor in the URL', async () => {
    const { fetch, sent } = streamFetch(eventStream);
    await apiFor(fetch).openStream(KEY, { lastEventId: null, signal: new AbortController().signal });
    expect(sent[0]?.headers.has('last-event-id')).toBe(false);
    expect(sent[0]?.url).not.toContain('after_id');
  });

  it('turns the recorded refusals of the stream route into ApiErrors', async () => {
    for (const name of ['stream-unauthenticated', 'stream-no-such-repo']) {
      const { fetch } = streamFetch(() => answer(exchange(name)));
      const error = await failure(apiFor(fetch).openStream(KEY, { lastEventId: null, signal: new AbortController().signal }));
      expect(error).toMatchObject({ name: 'ApiError', ...recordedError(name) });
    }
  });

  it('refuses a 200 that is not an event stream, and cancels its body', async () => {
    let cancelled = false;
    const html = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const { fetch } = streamFetch(() => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }));
    const error = await failure(apiFor(fetch).openStream(KEY, { lastEventId: null, signal: new AbortController().signal }));
    expect(error).toMatchObject({ name: 'ProtocolError', field: 'content-type' });
    expect(cancelled).toBe(true);
  });
});
