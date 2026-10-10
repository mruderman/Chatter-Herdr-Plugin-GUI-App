// @vitest-environment node
// The real store over createApi and Node's fetch, against a real bridge and the real Chatter CLI
// (bridge/test/helpers.js makeEnv). Needs CHATTER_JS, like the bridge's contract tests; skipped
// without it, and skipped is not passing.
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type FetchLike } from '../api/client';
import { ERROR_CODES } from '../api/errors';
import { CHANNEL } from '../api/types';
import { createStore } from './store';
import type { IncomingMessage, Store, StoreSnapshot } from './types';

const CHATTER_JS = process.env.CHATTER_JS ?? '';
const HAVE_CHATTER = CHATTER_JS !== '' && existsSync(CHATTER_JS);
const SLOW = 30_000;
// Quick reconnects for a test; the bridge pings every 1.5 s at pollMs 50, far inside the silence limit.
const TIMING = { baseDelayMs: 50, maxDelayMs: 200, deadAfterMs: 10_000 };

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

/** The part of makeEnv's result this test uses (bridge/test/helpers.js is plain JavaScript). */
interface Env {
  readonly base: string;
  readonly tokens: Readonly<Record<string, string>>;
  addMember(handle: string): string;
  api(who: string, method: string, path: string, body?: unknown): Promise<Reply>;
  /** Rows in Chatter's messages table, read straight from its database. */
  count(): number;
  stop(): Promise<void>;
}

async function loadMakeEnv(): Promise<() => Promise<Env>> {
  // Loaded by URL so the type checker does not look for types the JavaScript helper does not have.
  const url = new URL('../../../bridge/test/helpers.js', import.meta.url).href;
  const helpers = (await import(/* @vite-ignore */ url)) as { makeEnv: () => Promise<Env> };
  return helpers.makeEnv;
}

async function until<T>(read: () => T | undefined, what: string, ms = 8_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const when = (condition: boolean): true | undefined => (condition ? true : undefined);

describe.skipIf(!HAVE_CHATTER)('the store against the real bridge and Chatter (needs CHATTER_JS)', () => {
  let env: Env;
  const stores: Store[] = [];
  const urls: string[] = [];

  function open() {
    const requests: string[] = [];
    const counting: FetchLike = (url, init) => {
      requests.push(`${init.method ?? 'GET'} ${url}`);
      urls.push(url);
      return fetch(url, init);
    };
    const store = createStore({ api: (getToken) => createApi({ baseUrl: env.base, getToken, fetch: counting }), streamTiming: TIMING });
    stores.push(store);
    const incoming: IncomingMessage[] = [];
    store.onIncoming((message) => incoming.push(message));
    return { store, requests, incoming, now: (): StoreSnapshot => store.getSnapshot() };
  }

  async function signedIn(handle: string) {
    const member = open();
    await until(() => when(member.now().session.status !== 'unknown'), 'the first /v1/me');
    expect(member.now().session).toEqual({ status: 'signed-out', error: null });
    const token = env.tokens[handle];
    if (!token) throw new Error(`no token for ${handle}`);
    expect(await member.store.signIn(token)).toBe(true);
    await until(() => when(member.now().connection === 'online'), `${handle} online`);
    return member;
  }

  beforeAll(async () => {
    env = await (await loadMakeEnv())();
    for (const handle of ['ana', 'ben', 'cleo', 'dora', 'eve']) env.addMember(handle);
  }, SLOW);

  afterAll(async () => {
    // Before the bridge goes: its shutdown byes would start reconnects on real timers.
    for (const store of stores) store.dispose();
    await env?.stop();
  });

  it('two members exchange messages, and each passes the other\'s on', async () => {
    const ana = await signedIn('ana');
    const ben = await signedIn('ben');
    expect(await ana.store.send({ to: CHANNEL, body: 'hello ben' })).toBe(true);
    expect(ana.now().messages.at(-1)?.body).toBe('hello ben');
    await until(() => ben.now().messages.find((m) => m.body === 'hello ben'), 'ben to see it');
    expect(ben.incoming.map((i) => i.message.body)).toEqual(['hello ben']);
    expect(await ben.store.send({ to: CHANNEL, body: 'hello ana' })).toBe(true);
    await until(() => ana.now().messages.find((m) => m.body === 'hello ana'), 'ana to see it');
    expect(ana.incoming.map((i) => i.message.body)).toEqual(['hello ana']);
    expect(ana.now().announcement?.text).toBe('ben: hello ana');
  }, SLOW);

  it('a DM shows to its two members and stays invisible to a third, who is not an admin', async () => {
    const ana = await signedIn('ana');
    const ben = await signedIn('ben');
    const cleo = await signedIn('cleo');
    expect(await ana.store.send({ to: 'ben', body: 'just for ben' })).toBe(true);
    expect(ana.now().conversations.map((c) => c.label)).toContain('DM with ben');
    const dm = await until(() => ben.now().conversations.find((c) => c.label === 'DM with ana'), 'ben\'s DM with ana');
    ben.store.selectConversation(dm.id);
    expect(ben.now().messages.map((m) => m.body)).toEqual(['just for ben']);
    expect(ben.incoming.map((i) => i.message.body)).toContain('just for ben');
    expect(await ben.store.send({ to: CHANNEL, body: 'a public one after it' })).toBe(true);
    await until(() => cleo.now().messages.find((m) => m.body === 'a public one after it'), 'cleo to see the public one');
    expect(cleo.now().conversations.map((c) => c.label)).toEqual(['#chat']);
    expect(cleo.incoming.map((i) => i.message.body)).not.toContain('just for ben');
  }, SLOW);

  it('a member\'s @everyone ends in the bridge\'s refusal, and nothing is written', async () => {
    const cleo = await signedIn('cleo');
    const rows = env.count();
    expect(await cleo.store.send({ to: CHANNEL, body: '@everyone wake up' })).toBe(false);
    expect(cleo.now().sendError).toEqual({ code: ERROR_CODES.everyoneAdminOnly, message: '@everyone is reserved for the admin; nothing was posted' });
    expect(cleo.now().messages.map((m) => m.body)).not.toContain('@everyone wake up');
    await pause(300);
    expect(env.count()).toBe(rows);
  }, SLOW);

  it('a revoked member ends revoked, and the store asks the bridge nothing more', async () => {
    const dora = await signedIn('dora');
    expect((await env.api('flan', 'DELETE', '/v1/members/dora')).status).toBe(200);
    await until(() => when(dora.now().connection === 'revoked'), 'Access revoked');
    const asked = dora.requests.length;
    await pause(1_500);
    expect(dora.requests.length).toBe(asked);
    expect(dora.now().session.status).toBe('signed-in');
  }, SLOW);

  it('a rotated token ends the session, signed out with the bridge\'s error', async () => {
    const eve = await signedIn('eve');
    expect((await env.api('flan', 'POST', '/v1/members/eve/token')).status).toBe(201);
    await until(() => when(eve.now().session.status === 'signed-out'), 'signed out');
    expect(eve.now().session).toEqual({ status: 'signed-out', error: { code: ERROR_CODES.badToken, message: 'token is invalid or revoked' } });
    expect(eve.now().messages).toEqual([]);
  }, SLOW);

  it('never put a token in a URL', () => {
    expect(urls.length).toBeGreaterThan(0);
    for (const token of Object.values(env.tokens)) expect(urls.filter((url) => url.includes(token))).toEqual([]);
  });
});
