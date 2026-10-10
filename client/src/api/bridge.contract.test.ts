// @vitest-environment node
// createApi and connectStream over Node's real fetch against a real bridge and the real Chatter
// CLI (bridge/test/helpers.js makeEnv), so aborts, cancels and the bridge's own byes are exercised
// for real, not through a stub. Needs CHATTER_JS, like the bridge's contract tests; skipped
// without it, and skipped is not passing.
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from './client';
import { connectStream, type StreamOptions, type StreamStatus } from './stream';
import { CHANNEL, type Message } from './types';

const CHATTER_JS = process.env.CHATTER_JS ?? '';
const HAVE_CHATTER = CHATTER_JS !== '' && existsSync(CHATTER_JS);
// Fast enough for a test, slow enough that the bridge's 1.5 s pings (pollMs 50) keep it alive.
const TIMING = { baseDelayMs: 50, maxDelayMs: 200, deadAfterMs: 10_000 };
const SLOW = 30_000;

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

/** The part of makeEnv's result this test uses (bridge/test/helpers.js is plain JavaScript). */
interface Env {
  readonly base: string;
  readonly key: string;
  readonly repo: string;
  readonly tokens: Readonly<Record<string, string>>;
  readonly app: { readonly bridge: { readonly watchers: Map<string, { readonly subs: Set<unknown> }> } };
  readonly host: { run(o: { handle: string; cwd: string; args: string[] }): Promise<{ code: number }> };
  addMember(handle: string): string;
  api(who: string, method: string, path: string, body?: unknown): Promise<Reply>;
  post(who: string, to: string, body: string): Promise<Reply>;
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

describe.skipIf(!HAVE_CHATTER)('the API module against the real bridge and Chatter (needs CHATTER_JS)', () => {
  let env: Env;
  const apiAs = (handle: string): Api => createApi({ baseUrl: env.base, getToken: () => env.tokens[handle] ?? null });

  function watch(handle: string, options: Partial<StreamOptions> = {}) {
    const api = apiAs(handle);
    const messages: Message[] = [];
    const statuses: StreamStatus[] = [];
    let opened = 0;
    const handleOf = connectStream({
      api: {
        openStream: (repo, request) => {
          opened += 1;
          return api.openStream(repo, request);
        },
      },
      repo: env.key,
      timing: TIMING,
      onMessage: (message) => messages.push(message),
      onStatus: (status) => statuses.push(status),
      ...options,
    });
    const reached = (state: StreamStatus['state']): StreamStatus | undefined => statuses.find((s) => s.state === state);
    return { messages, statuses, handle: handleOf, opened: () => opened, reached };
  }

  beforeAll(async () => {
    env = await (await loadMakeEnv())();
    for (const handle of ['ana', 'ben', 'cleo', 'dora']) env.addMember(handle);
  }, SLOW);

  afterAll(async () => {
    await env?.stop();
  });

  it('reads me, the directory, the repos, a page and the board through real fetch', async () => {
    const api = apiAs('ana');
    expect((await api.me()).handle).toBe('ana');
    expect((await api.directory()).members.map((m) => m.handle)).toContain('ben');
    expect((await api.repos()).repos[0]?.key).toBe(env.key);
    const page = await api.messages(env.key);
    expect(page.messages.map((m) => m.body)).toContain('setup message');
    expect((await api.board(env.key)).agents_error).toBeNull();
  }, SLOW);

  it('streams from a page\'s max_id, once each and only what the member may see; a rotated token ends it as unauthorized', async () => {
    const page = await apiAs('ana').messages(env.key);
    const ana = watch('ana', { lastEventId: page.max_id, epoch: page.epoch });
    await until(() => ana.reached('open'), 'open');
    const toAll = await apiAs('ben').send(env.key, { to: CHANNEL, body: 'hello ana' });
    const elsewhere = await apiAs('ben').send(env.key, { to: 'cleo', body: 'not for ana' });
    const toAna = await apiAs('ben').send(env.key, { to: 'ana', body: 'for ana only' });
    await until(() => ana.messages.find((m) => m.id === toAna.id), 'the DM to ana');
    await pause(300);
    expect(ana.messages.map((m) => m.id)).toEqual([toAll.id, toAna.id]);
    expect(ana.messages.map((m) => m.id)).not.toContain(elsewhere.id);

    expect((await env.api('flan', 'POST', '/v1/members/ana/token')).status).toBe(201);
    const closed = await until(() => ana.reached('closed'), 'closed');
    expect(ana.statuses.find((s) => s.state === 'reconnecting')).toMatchObject({ cause: 'bye', byeReason: 'token_rotated' });
    expect(closed).toMatchObject({ reason: 'unauthorized', error: { status: 401, code: 'bad_token' } });
    const opened = ana.opened();
    await pause(500);
    expect(ana.opened()).toBe(opened);
  }, SLOW);

  it('stops for good when the member is revoked', async () => {
    const cleo = watch('cleo');
    await until(() => cleo.reached('open'), 'open');
    expect((await env.api('flan', 'DELETE', '/v1/members/cleo')).status).toBe(200);
    await until(() => cleo.reached('revoked'), 'revoked');
    await pause(500);
    expect(cleo.opened()).toBe(1);
    expect(cleo.statuses.map((s) => s.state)).toEqual(['connecting', 'open', 'revoked']);
  }, SLOW);

  it('close() ends a live stream on both sides, without hanging', async () => {
    const dora = watch('dora');
    await until(() => dora.reached('open'), 'open');
    expect(env.app.bridge.watchers.get(env.key)?.subs.size).toBeGreaterThan(0);
    dora.handle.close();
    expect(dora.statuses.at(-1)).toEqual({ state: 'closed', reason: 'aborted', error: null });
    // The abort reaches the bridge: its request closes and it drops the subscriber.
    await until(() => ((env.app.bridge.watchers.get(env.key)?.subs.size ?? 0) === 0 ? true : undefined), 'the bridge to drop the stream');
    await apiAs('ben').send(env.key, { to: CHANNEL, body: 'after dora left' });
    await pause(300);
    expect(dora.messages).toEqual([]);
    expect(dora.opened()).toBe(1);
  }, SLOW);

  it('closes with resync when the repo is purged', async () => {
    const ben = watch('ben');
    await until(() => ben.reached('open'), 'open');
    expect((await env.host.run({ handle: 'flan', cwd: env.repo, args: ['purge', env.key, '--yes'] })).code).toBe(0);
    expect(await until(() => ben.reached('closed'), 'closed')).toEqual({ state: 'closed', reason: 'resync', error: null });
    await pause(300);
    expect(ben.opened()).toBe(1);
  }, SLOW);
});
