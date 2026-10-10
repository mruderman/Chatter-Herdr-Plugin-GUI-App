// Records real bridge responses, over the real Chatter CLI, into client/test/fixtures/.
// The client's API types, guards and SSE parser are tested against these recordings; where a
// recording and docs/SPEC.md section 5 disagree, the recording wins.
//
//   CHATTER_JS=<chatter clone>/dist/bin/chatter.js node client/scripts/record-fixtures.mjs
//
// Every run starts from an empty scratch universe, so message ids are the same from run to run;
// timestamps, epochs and repo keys (Chatter hashes the scratch path into them) are not.
// Tokens and scratch paths are replaced before anything is written, and the written files are
// read back and checked for leftovers before the script reports success. Nothing here prints a
// token: failures name the exchange and its status, never a response body.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHATTER_JS, haveChatter, makeEnv } from '../../bridge/test/helpers.js';
import { VERSION as BRIDGE_VERSION } from '../../bridge/src/server.js';

if (!haveChatter) {
  console.error('record-fixtures: set CHATTER_JS to a built Chatter checkout (dist/bin/chatter.js)');
  process.exit(2);
}

const FIXTURES = fileURLToPath(new URL('../test/fixtures/', import.meta.url));
const SSE_DIR = 'sse';
const API_FILE = 'api.json';
// Stand-ins must not look like what they replace: the leak check below greps for both.
const TOKEN_STAND_IN = 'redacted-token';
const SCRATCH_STAND_IN = '<scratch>';
const HOME_STAND_IN = '<home>';
const TOKEN_PREFIX = 'cb_';
const WAIT_MS = 6000;
// Request bodies longer than this are recorded as their length; the response is what matters.
const LONG_BODY = 200;

const exchanges = {};
const secrets = new Set();
const scratchRoots = new Set();
const sseFiles = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function remember(token) {
  if (typeof token === 'string' && token) secrets.add(token);
  return token;
}

function addScratchRoot(dir) {
  scratchRoots.add(dir);
  try { scratchRoots.add(fs.realpathSync(dir)); } catch { /* already removed */ }
}

function describeBody(body) {
  if (body === undefined) return undefined;
  if (typeof body === 'string') return body.length > LONG_BODY ? `<${body.length} characters>` : body;
  if (body && typeof body === 'object') {
    return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, describeBody(v)]));
  }
  return body;
}

/**
 * One HTTP exchange through the bridge. `as` is the member whose token is sent, or a label when
 * `token` overrides it. `keep: false` performs the exchange without recording it.
 */
async function call(env, name, { as = null, token, method = 'GET', path: p, body, rawBody, headers = {}, expect, keep = true }) {
  const auth = token === undefined ? (as ? env.tokens[as] : null) : token;
  const init = { method, headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...headers } };
  if (rawBody !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = rawBody;
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${env.base}${p}`, init);
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error(`${name}: response is not JSON (status ${res.status})`); }
  if (res.status !== expect) throw new Error(`${name}: expected status ${expect}, got ${res.status}`);
  if (!keep) return parsed;
  const request = { method, path: p, as };
  if (Object.keys(headers).length) request.headers = headers;
  if (body !== undefined) request.body = describeBody(body);
  if (rawBody !== undefined) request.raw_body = rawBody;
  exchanges[name] = { request, status: res.status, content_type: res.headers.get('content-type'), body: parsed };
  return parsed;
}

/** Captures the raw bytes of one SSE response, exactly as they arrive. */
function openStream(env, key, token, headers = {}) {
  const controller = new AbortController();
  const chunks = [];
  const decoder = new TextDecoder();
  let text = '';
  let ended = false;
  let contentType = null;
  let status = null;
  const done = fetch(`${env.base}/v1/repos/${key}/stream`, {
    headers: { Authorization: `Bearer ${token}`, ...headers },
    signal: controller.signal,
  }).then(async (res) => {
    status = res.status;
    contentType = res.headers.get('content-type');
    if (res.status !== 200) throw new Error(`stream answered ${res.status}`);
    try {
      for await (const chunk of res.body) {
        const bytes = Buffer.from(chunk);
        chunks.push(bytes);
        text += decoder.decode(bytes, { stream: true });
      }
    } catch (err) {
      if (!controller.signal.aborted) throw err;
    }
    ended = true;
  });
  done.catch(() => {});

  return {
    async until(test, what) {
      const started = Date.now();
      while (!test(text)) {
        if (ended) throw new Error(`stream ended before ${what}`);
        if (Date.now() - started > WAIT_MS) throw new Error(`timed out waiting for ${what}`);
        await sleep(20);
      }
    },
    hasId: (id) => text.includes(`id: ${id}\n`),
    async finish() {
      await Promise.race([done, sleep(WAIT_MS).then(() => { throw new Error('stream did not end'); })]);
      return { bytes: Buffer.concat(chunks), status, contentType };
    },
    async abort() {
      controller.abort();
      await done.catch(() => {});
      return { bytes: Buffer.concat(chunks), status, contentType };
    },
  };
}

function recordStream(name, request, capture) {
  const file = `${SSE_DIR}/${name}.sse`;
  sseFiles.set(file, capture.bytes);
  exchanges[`stream-${name}`] = { request, status: capture.status, content_type: capture.contentType, file };
}

const helloSeen = (text) => text.includes('event: hello\n');

function git(cwd, ...args) {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'ignore' });
}

async function cli(env, cwd, args) {
  const r = await env.host.run({ handle: 'flan', cwd, args });
  if (r.code !== 0) throw new Error(`chatter ${args[0]} failed with exit ${r.code}`);
  return r;
}

async function addMember(env, name, input, keep = true) {
  const out = await call(env, name, { as: 'flan', method: 'POST', path: '/v1/members', body: input, expect: 201, keep });
  if (out.token) env.tokens[input.handle] = remember(out.token);
  return out;
}

async function record() {
  const e = await makeEnv();
  addScratchRoot(e.root);
  remember(e.tokens.flan);
  try {
    const key = e.key;
    const msgs = `/v1/repos/${key}/messages`;
    e.seedAgent('codex');

    // Members of both kinds. kieran may not address agents, so his refusals can be recorded.
    await addMember(e, 'members-add-computational', { handle: 'thom', kind: 'computational', display_name: 'Thom' });
    await addMember(e, 'members-add-human-with-token', {
      handle: 'mira', kind: 'human', display_name: 'Mira', tailscale_login: 'mira@example.com', issue_token: true,
    });
    await addMember(e, 'members-add-human', { handle: 'ezra', kind: 'human', display_name: 'Ezra' });
    await addMember(e, 'members-add-restricted', {
      handle: 'kieran', kind: 'computational', display_name: 'Kieran', can_address_agents: false,
    });
    await addMember(e, 'members-add-grace', { handle: 'grace', kind: 'computational', display_name: 'Grace' }, false);
    await addMember(e, 'members-add-temp', { handle: 'temp', kind: 'computational', display_name: 'Temporary' }, false);

    await call(e, 'healthz', { path: '/healthz', expect: 200 });
    await call(e, 'me-admin', { as: 'flan', path: '/v1/me', expect: 200 });
    await call(e, 'me-computational', { as: 'thom', path: '/v1/me', expect: 200 });
    await call(e, 'me-human', { as: 'mira', path: '/v1/me', expect: 200 });
    await call(e, 'me-restricted', { as: 'kieran', path: '/v1/me', expect: 200 });
    await call(e, 'me-unauthenticated', { path: '/v1/me', expect: 401 });
    await call(e, 'me-bad-token', { as: 'invalid token', token: 'not-a-real-token', path: '/v1/me', expect: 401 });

    // A second repo, so the repo switcher has a choice.
    const site = path.join(e.root, 'site');
    fs.mkdirSync(site);
    git(site, 'init', '-q');
    git(site, 'commit', '--allow-empty', '-q', '-m', 'init');
    await cli(e, site, ['post', 'site repo kickoff']);
    const siteKey = (await e.host.repos({ fresh: true })).find((r) => r.repo_root && fs.realpathSync(r.repo_root) === fs.realpathSync(site)).key;

    // Live stream as mira: what arrives, what does not (thom's DM to grace), a ping, then a bye.
    const live = openStream(e, key, e.tokens.mira);
    await live.until(helloSeen, 'hello on the live stream');
    const post = (name, as, to, body) => call(e, name, { as, method: 'POST', path: msgs, body: { to, body }, expect: 201 });
    const chat = await post('post-chat', 'thom', '#chat', 'hello from thom');
    await post('post-mention-member', 'mira', '#chat', 'morning all, @thom can you check the deploy notes?');
    await post('post-dm-member', 'thom', 'mira', 'sure, sending the details privately');
    const reply = await post('post-dm-reply', 'mira', 'thom', 'thanks!');
    await post('post-dm-other', 'thom', 'grace', 'grace, can you review TASK-1 today?');
    await post('post-everyone-admin', 'flan', '#chat', '@everyone standup in five');
    await post('post-dm-agent', 'thom', 'codex', 'please run the test suite');
    await post('post-mention-agent', 'grace', '#chat', '@codex can you summarise the open questions?');
    await post('post-unknown-mention', 'thom', '#chat', 'ping @ghost');
    // Two-, three- and four-byte UTF-8 characters, so the stream fixture can be cut inside each.
    await post('post-unicode', 'flan', '#chat', 'ünïcödé — 𝄞 multi-byte check');
    await post('post-html', 'grace', '#chat', '<b>not bold</b> <script>alert(1)</script> https://example.com/x?y=1&z=2');
    const last = await post('post-multiline', 'mira', '#chat', 'line one\nline two\n  indented');
    await live.until(() => live.hasId(last.id), 'the last message on the live stream');
    await live.until((text) => text.includes('\n: ping\n'), 'a ping');
    const rotated = await call(e, 'members-rotate-token', { as: 'flan', method: 'POST', path: '/v1/members/mira/token', expect: 201 });
    e.tokens.mira = remember(rotated.token);
    recordStream('live', { method: 'GET', path: `/v1/repos/${key}/stream`, as: 'mira' }, await live.finish());

    // Refusals. Each must leave Chatter's message count unchanged.
    const before = e.count();
    const refuse = (name, as, body, expect) => call(e, name, { as, method: 'POST', path: msgs, body, expect });
    await refuse('post-everyone-member', 'thom', { to: '#chat', body: '@everyone wake up' }, 403);
    await refuse('post-agents-not-allowed', 'kieran', { to: '#chat', body: '@codex hello' }, 403);
    await refuse('post-dm-agent-not-allowed', 'kieran', { to: 'codex', body: 'hello' }, 403);
    await refuse('post-empty', 'thom', { to: '#chat', body: '   ' }, 400);
    await refuse('post-self-dm', 'thom', { to: 'thom', body: 'note to self' }, 400);
    await refuse('post-unknown-recipient', 'thom', { to: 'nobody', body: 'hello?' }, 404);
    await refuse('post-too-long', 'thom', { to: '#chat', body: 'x'.repeat(8001) }, 413);
    await refuse('post-missing-to', 'thom', { body: 'no recipient' }, 400);
    await call(e, 'post-bad-json', { as: 'thom', method: 'POST', path: msgs, rawBody: '{"to":', expect: 400 });
    if (e.count() !== before) throw new Error('a refused post wrote a message');

    // Board content, written through the CLI as the admin.
    await cli(e, e.repo, ['task', 'create', 'Wire the web client', '--assignee', 'codex']);
    await cli(e, e.repo, ['note', 'The bridge reads Chatter state read-only', '--type', 'decision']);
    await cli(e, e.repo, ['ask', 'who owns the auth migration?']);
    await cli(e, e.repo, ['handoff', 'TASK-1', 'codex', '--summary', 'API module ready for review', '--branch', 'm3-client']);
    await call(e, 'board', { as: 'thom', path: `/v1/repos/${key}/board`, expect: 200 });

    // Read pointers only move forward.
    const readPath = `/v1/repos/${key}/read`;
    await call(e, 'read', { as: 'mira', method: 'POST', path: readPath, body: { up_to_id: reply.id }, expect: 200 });
    await call(e, 'read-backward', { as: 'mira', method: 'POST', path: readPath, body: { up_to_id: 1 }, expect: 200 });
    await call(e, 'read-missing', { as: 'mira', method: 'POST', path: readPath, body: {}, expect: 400 });

    // Pages. Each member sees #chat plus their own DMs; the admin sees every DM; kieran has none.
    for (const who of ['flan', 'thom', 'mira', 'grace', 'kieran']) {
      await call(e, `messages-${who}`, { as: who, path: msgs, expect: 200 });
    }
    const newest = await call(e, 'messages-limit', { as: 'flan', path: `${msgs}?limit=3`, expect: 200 });
    await call(e, 'messages-before', { as: 'flan', path: `${msgs}?before_id=${newest.messages[0].id}&limit=3`, expect: 200 });
    await call(e, 'messages-after', { as: 'flan', path: `${msgs}?after_id=0&limit=4`, expect: 200 });
    await call(e, 'messages-site', { as: 'thom', path: `/v1/repos/${siteKey}/messages`, expect: 200 });
    await call(e, 'messages-bad-after', { as: 'thom', path: `${msgs}?after_id=abc`, expect: 400 });
    await call(e, 'messages-no-such-repo', { as: 'thom', path: '/v1/repos/nowhere-00000000/messages', expect: 404 });
    await call(e, 'messages-bad-repo', { as: 'thom', path: '/v1/repos/bad%20key/messages', expect: 400 });

    await call(e, 'repos-admin', { as: 'flan', path: '/v1/repos', expect: 200 });
    await call(e, 'repos-member', { as: 'thom', path: '/v1/repos', expect: 200 });
    await call(e, 'repos-after-read', { as: 'mira', path: '/v1/repos', expect: 200 });
    await call(e, 'directory', { as: 'kieran', path: '/v1/directory', expect: 200 });

    // Resume: everything after thom's first post is replayed before the hello.
    const resume = openStream(e, key, e.tokens.mira, { 'Last-Event-ID': String(chat.id) });
    await resume.until(helloSeen, 'hello on the resumed stream');
    recordStream('resume', {
      method: 'GET', path: `/v1/repos/${key}/stream`, as: 'mira', headers: { 'Last-Event-ID': String(chat.id) },
    }, await resume.abort());

    const streamPath = `/v1/repos/${key}/stream`;
    await call(e, 'stream-unauthenticated', { path: streamPath, expect: 401 });
    await call(e, 'stream-bad-last-event-id', { as: 'thom', path: streamPath, headers: { 'Last-Event-ID': 'abc' }, expect: 400 });
    await call(e, 'stream-no-such-repo', { as: 'thom', path: '/v1/repos/nowhere-00000000/stream', expect: 404 });

    // Admin routes and their refusals.
    await call(e, 'members-list', { as: 'flan', path: '/v1/members', expect: 200 });
    await call(e, 'members-update', { as: 'flan', method: 'PATCH', path: '/v1/members/ezra', body: { display_name: 'Ezra R.' }, expect: 200 });
    await call(e, 'members-update-missing', { as: 'flan', method: 'PATCH', path: '/v1/members/nobody', body: { display_name: 'x' }, expect: 404 });
    await call(e, 'members-add-taken', { as: 'flan', method: 'POST', path: '/v1/members', body: { handle: 'thom', kind: 'computational' }, expect: 409 });
    await call(e, 'members-add-agent-name', { as: 'flan', method: 'POST', path: '/v1/members', body: { handle: 'codex', kind: 'computational' }, expect: 409 });
    await call(e, 'members-add-bad-handle', { as: 'flan', method: 'POST', path: '/v1/members', body: { handle: 'Bad Handle', kind: 'human' }, expect: 400 });
    await call(e, 'members-forbidden', { as: 'thom', path: '/v1/members', expect: 403 });

    // Revocation closes the member's open stream.
    const doomed = openStream(e, key, e.tokens.temp);
    await doomed.until(helloSeen, 'hello on the stream that gets revoked');
    await call(e, 'members-revoke', { as: 'flan', method: 'DELETE', path: '/v1/members/temp', expect: 200 });
    recordStream('revoked', { method: 'GET', path: streamPath, as: 'temp' }, await doomed.finish());
    await call(e, 'me-revoked', { as: 'temp', path: '/v1/me', expect: 401 });

    await call(e, 'audit', { as: 'flan', path: '/v1/audit', expect: 200 });
    await call(e, 'not-found', { as: 'thom', path: '/v1/nope', expect: 404 });

    // Last, because it destroys the universe: a purge changes the epoch and ends every stream.
    const purged = openStream(e, key, e.tokens.thom);
    await purged.until(helloSeen, 'hello on the stream that sees the purge');
    await cli(e, e.repo, ['purge', key, '--yes']);
    recordStream('epoch', { method: 'GET', path: streamPath, as: 'thom' }, await purged.finish());
  } finally {
    await e.stop();
  }

  // The rate limit needs a bridge of its own, with a limit of one post a minute.
  const small = await makeEnv({ limits: { maxBody: 8000, postsPerMinute: 1 } });
  addScratchRoot(small.root);
  try {
    remember(small.tokens.flan);
    remember(small.addMember('thom'));
    const path1 = `/v1/repos/${small.key}/messages`;
    await call(small, 'post-rate-limit-first', { as: 'thom', method: 'POST', path: path1, body: { to: '#chat', body: 'one' }, expect: 201, keep: false });
    await call(small, 'post-rate-limited', { as: 'thom', method: 'POST', path: path1, body: { to: '#chat', body: 'two' }, expect: 429 });
  } finally {
    await small.stop();
  }
}

function scrub(text) {
  let out = text;
  for (const token of secrets) out = out.split(token).join(TOKEN_STAND_IN);
  // Longest first, so a realpath that extends a symlinked path is replaced whole.
  for (const root of [...scratchRoots].sort((a, b) => b.length - a.length)) out = out.split(root).join(SCRATCH_STAND_IN);
  return out.split(os.homedir()).join(HOME_STAND_IN);
}

/** Fails if anything written still looks like a token or a path on this machine. */
function checkForLeaks(files) {
  const tmp = os.tmpdir();
  const forbidden = [TOKEN_PREFIX, tmp, fs.realpathSync(tmp), os.homedir(), 'cb-test-', ...secrets, ...scratchRoots];
  const problems = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const needle of forbidden) if (text.includes(needle)) problems.push(`${path.relative(FIXTURES, file)} contains a forbidden string`);
  }
  if (problems.length) throw new Error(`leak check failed:\n${[...new Set(problems)].join('\n')}`);
}

await record();

const chatterVersion = JSON.parse(fs.readFileSync(path.join(path.dirname(CHATTER_JS), '..', '..', 'package.json'), 'utf8')).version;
fs.rmSync(path.join(FIXTURES, SSE_DIR), { recursive: true, force: true });
fs.mkdirSync(path.join(FIXTURES, SSE_DIR), { recursive: true });
const written = [];
for (const [file, bytes] of sseFiles) {
  const target = path.join(FIXTURES, file);
  fs.writeFileSync(target, scrub(bytes.toString('utf8')));
  written.push(target);
}
const apiFile = path.join(FIXTURES, API_FILE);
const document = { bridge_version: BRIDGE_VERSION, chatter_version: chatterVersion, exchanges };
fs.writeFileSync(apiFile, `${scrub(JSON.stringify(document, null, 2))}\n`);
written.push(apiFile);
checkForLeaks(written);
console.log(`record-fixtures: ${Object.keys(exchanges).length} exchanges and ${sseFiles.size} streams written to ${path.relative(process.cwd(), FIXTURES) || '.'}; leak check passed`);
