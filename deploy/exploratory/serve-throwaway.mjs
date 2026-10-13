#!/usr/bin/env node
// A THROWAWAY bridge with a seeded world, for the exploratory pass (docs/runbooks/exploratory-pass.md).
// Everything here is test data in a scratch universe: no Herdr (HERDR_BIN_PATH is a path that does not exist and
// every HERDR_* variable of the caller is dropped), no real token, no real host. It serves a COPY of client/dist,
// so rebuilding the client while exploring cannot change the page under the browser.
//
//   CHATTER_JS=<chatter clone>/dist/bin/chatter.js TMPDIR=<scratch>/universe \
//     node deploy/exploratory/serve-throwaway.mjs --out <scratch>/run
//
// Prints one line with the URL. The throwaway tokens go only to <out>/tokens.json (mode 600, never to the
// terminal). It runs until SIGTERM or SIGINT, then deletes the universe and the token file.
//
// Driving a running bridge: append lines to <out>/control.txt (the script polls it and empties it):
//   stop                         close the bridge gracefully ("bye shutdown" on every stream), as a restart does
//   drop                         cut every connection with no goodbye (a crash or a network loss)
//   start                        listen again on the same port, over the same state
//   post <handle> <to> <text>    write a message through Chatter as that member (bypasses the policy; refuses
//                                an @everyone from anyone but the admin). <to> is #chat or a handle.
//   status                       write the bridge state to <out>/control.log
// Answers go to <out>/control.log and never contain a token.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const BRIDGE_TEST = path.join(ROOT, 'bridge', 'test', 'helpers.js');
const SERVER = path.join(ROOT, 'bridge', 'src', 'server.js');
const DIST = path.join(ROOT, 'client', 'dist');
const CHANNEL = '#chat';
const POLL_CONTROL_MS = 250;

// A failure while seeding leaves no universe and no token file behind.
let universeRoot = null;
let leftovers = [];
const fail = (m) => {
  console.error(`serve-throwaway: ${m}`);
  for (const f of leftovers) fs.rmSync(f, { recursive: true, force: true });
  if (universeRoot) fs.rmSync(universeRoot, { recursive: true, force: true });
  process.exit(1);
};
process.on('uncaughtException', (e) => fail(String(e?.stack ?? e).split('\n').slice(0, 4).join(' | ')));
process.on('unhandledRejection', (e) => fail(String(e?.stack ?? e).split('\n').slice(0, 4).join(' | ')));

// ---------------------------------------------------------------- arguments and safety
const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
if (outIdx < 0 || !argv[outIdx + 1]) fail('usage: node serve-throwaway.mjs --out <directory for the token file, the control file and the log>');
const OUT = path.resolve(argv[outIdx + 1]);
if (!process.env.CHATTER_JS || !fs.existsSync(process.env.CHATTER_JS)) fail('set CHATTER_JS to <chatter clone>/dist/bin/chatter.js');
if (!fs.existsSync(path.join(DIST, 'index.html'))) fail(`no built client at ${DIST}: run deploy/build-client.sh first`);
if (!process.env.TMPDIR) fail('set TMPDIR to a scratch directory, so the universe is created there and nowhere shared');

// No Herdr of any kind: the bridge's own env (makeEnv) names a binary that does not exist, and a pane of the caller's
// Herdr must not leak in either.
for (const k of Object.keys(process.env)) if (k.toUpperCase().startsWith('HERDR')) delete process.env[k];

fs.mkdirSync(OUT, { recursive: true, mode: 0o700 });
const BRIDGE_LOG = path.join(OUT, 'bridge.log');
const CONTROL = path.join(OUT, 'control.txt');
const CONTROL_LOG = path.join(OUT, 'control.log');
const TOKENS = path.join(OUT, 'tokens.json');
const INFO = path.join(OUT, 'info.json');
for (const f of [TOKENS, INFO, CONTROL, CONTROL_LOG, BRIDGE_LOG]) fs.rmSync(f, { force: true });

const log = (line) => fs.appendFileSync(BRIDGE_LOG, `${new Date().toISOString()} ${line}\n`);
const say = (line) => fs.appendFileSync(CONTROL_LOG, `${new Date().toISOString()} ${line}\n`);

// The copy the browser gets. A later `npm run e2e` rebuilds client/dist in place; this one stays as it was.
const STATIC_DIR = path.join(OUT, 'dist');
fs.rmSync(STATIC_DIR, { recursive: true, force: true });
fs.cpSync(DIST, STATIC_DIR, { recursive: true });

const { makeEnv } = await import(pathToFileURL(BRIDGE_TEST).href);
const { createBridge } = await import(pathToFileURL(SERVER).href);

// Default limits on purpose (20 posts a minute per member): the bridge should behave as it will in use.
const POLL_MS = 100;
const env = await makeEnv({ staticDir: STATIC_DIR, pollMs: POLL_MS, log });
const PORT = Number(new URL(env.base).port);
const URL_ = env.base;
const { host, store, key } = env;
universeRoot = env.root;
leftovers = [TOKENS, INFO, CONTROL, STATIC_DIR];

// ---------------------------------------------------------------- the cast
const tokens = {};
store.updateMember('flan', { display_name: 'Flan' });
tokens.flan = env.tokens.flan;
tokens.hana = env.addMember('hana', { kind: 'human', display_name: 'Hana' });
// Restricted: may not address Herdr agents (the refusal paths).
tokens.ivo = env.addMember('ivo', { kind: 'human', display_name: 'Ivo', can_address_agents: false });
// A token that was current and has been replaced by a rotation: it must be refused like a bad one.
tokens.kai_stale = env.addMember('kai', { kind: 'computational', display_name: 'Kai' });
tokens.kai = store.issueToken('kai');
env.tokens.kai = tokens.kai; // the API helper below signs in as kai with the current one
// A member who was revoked after the seed: the revoked-token sign-in.
tokens.gone_revoked = env.addMember('gone', { kind: 'human', display_name: 'Gone Member' });
store.revokeMember('gone');
env.seedAgent('codex');
for (const [handle, kind, role] of [['hana', 'human', 'member'], ['ivo', 'human', 'member'], ['kai', 'computational', 'member'], ['gone', 'human', 'member']]) {
  store.audit({ actor: 'flan', action: 'member_add', target: handle, detail: { kind, role, can_address_agents: handle !== 'ivo' } });
}
store.audit({ actor: 'flan', action: 'member_revoke', target: 'gone' });
store.audit({ actor: 'flan', action: 'token_rotate', target: 'kai' });

// The token file: created with mode 600 and never read back by this script.
{
  const fd = fs.openSync(TOKENS, 'wx', 0o600);
  fs.writeSync(fd, JSON.stringify(tokens, null, 2));
  fs.closeSync(fd);
}

// ---------------------------------------------------------------- the second repository
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=x@example.com', '-c', 'user.name=x', ...a], { cwd, stdio: 'ignore' });
const sidecarDir = path.join(env.root, 'sidecar');
fs.mkdirSync(sidecarDir, { recursive: true });
git(sidecarDir, 'init', '-q');
git(sidecarDir, 'commit', '--allow-empty', '-q', '-m', 'init');

async function viaChatter(handle, cwd, args) {
  const r = await host.run({ handle, cwd, args });
  if (r.code !== 0) throw new Error(`chatter ${args[0]} as ${handle} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
  return r;
}
await viaChatter('flan', sidecarDir, ['post', 'Sidecar: the second repository starts here']);
await viaChatter('hana', sidecarDir, ['post', 'Sidecar: nothing to see, three messages only']);
await viaChatter('kai', sidecarDir, ['post', 'Sidecar: a computational member was here']);
const sidecar = (await host.repos({ fresh: true })).find((r) => r.label === 'sidecar');
if (!sidecar) fail('the sidecar repository did not appear');

// ---------------------------------------------------------------- the main repository's messages
// Chatter stamps created_at itself, which would put 300 messages inside one minute. The only way to spread them over
// days is to rewrite created_at in this scratch universe's database after each write (the precedent is
// helpers.js seedAgent, which also writes a scratch Chatter database directly). Ids and bodies are untouched, the
// file's identity (the bridge's "epoch") does not change, and it all happens before any browser connects. The bridge's
// own code never does this, and the product rule (never write Chatter's SQLite) stays as it is.
const chatterDb = path.join(env.repoInfo.dir, 'chatter.db');
const rw = new DatabaseSync(chatterDb);
rw.exec('PRAGMA busy_timeout = 5000;');
const maxId = () => rw.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM messages').get().m;
const stamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20261013);
const pick = (a) => a[Math.floor(rand() * a.length)];
const MIN = 60_000;
const people = ['flan', 'hana', 'ivo', 'kai'];
const SENTENCES = [
  'Has anyone looked at the failing build this morning?',
  'I pushed the fix, please pull before you start.',
  'The board shows two open questions, I will answer the first.',
  'Lunch is at noon, bring your own chair.',
  'Reading the spec again: section 6 is clear about this.',
  'Can we move the review to tomorrow?',
  'That test is flaky, I will quarantine it and note why.',
  'Thanks, that worked.',
  'Which port did we agree on?',
  'The agent finished the handoff, the summary looks right.',
  'I disagree, but I will not block it.',
  'Short one.',
  'Rebased on main, no conflicts.',
  'We should write this down as a decision.',
  'Pausing for an hour, back after the meeting.',
  'Looks good to me, merging.',
  'Does the audit log record that?',
  'A longer message that wraps over more than one line in a narrow window, so that the layout has something to do: the quick brown fox jumps over the lazy dog, and then jumps back again for good measure.',
  'Checking in.',
  'The token dialog is clear now, thank you.',
];

// The awkward messages. Everything goes through the real API, so the bridge's policy decides each one.
const LONG_WORD = 'Pneumonoultramicroscopicsilicovolcanoconiosis'.repeat(3);
const HUGE_WORD = 'ab'.repeat(1000);
const LONG_URL = `https://example.com/${'segment/'.repeat(120)}?q=${'x'.repeat(200)}`;
const NEAR_LIMIT_EMOJI = '😀'.repeat(3990); // 7980 UTF-16 units, under the bridge's 8000
const SPECIALS = [
  { who: 'flan', to: CHANNEL, body: '<img src=x onerror=alert(1)>' },
  { who: 'flan', to: CHANNEL, body: '<img src="/probe-img.png" onerror="document.title=\'pwned\'"> image probe' },
  { who: 'hana', to: CHANNEL, body: '<script>alert(1)</script>' },
  { who: 'hana', to: CHANNEL, body: '<script src="/probe-script.js"></script> script probe' },
  { who: 'ivo', to: CHANNEL, body: '<b>bold</b> <a href="javascript:alert(1)">click me</a> <style>body{display:none}</style> &amp; &lt;tag&gt;' },
  { who: 'kai', to: CHANNEL, body: `A very long unbroken word: ${LONG_WORD}` },
  { who: 'kai', to: CHANNEL, body: `A huge unbroken run: ${HUGE_WORD}` },
  { who: 'hana', to: CHANNEL, body: `A long URL: ${LONG_URL}` },
  { who: 'ivo', to: CHANNEL, body: 'URLs: https://example.com/path?x=1&y=2#frag http://localhost:1/ www.example.com javascript:alert(1) data:text/html,<script>alert(1)</script> [click me](https://example.com) file:///etc/passwd //evil.example/' },
  { who: 'flan', to: CHANNEL, body: 'Emoji: 👍🏽 👨‍👩‍👧‍👦 🏳️‍🌈 🇯🇵 😀😀😀 and a keycap 1️⃣' },
  { who: 'kai', to: CHANNEL, body: `${'a'.repeat(139)}😀 the emoji straddles the 140th character` },
  { who: 'hana', to: CHANNEL, body: 'Arabic: مرحبا بالعالم. Hebrew: שלום עולם. Mixed: hello שלום עולם 123 and @hana at the end' },
  { who: 'ivo', to: CHANNEL, body: '‮evil text with a right-to-left override and no closing mark' },
  { who: 'kai', to: CHANNEL, body: 'The message right after the override, which must read normally' },
  { who: 'hana', to: CHANNEL, body: '**bold** _italic_ # heading\n> quote\n- item one\n- item two\n1. numbered `code` [link](x) ~~strike~~ | a | b |' },
  { who: 'flan', to: CHANNEL, body: '@hana @ivo @kai @flan @codex mentions of everyone by handle' },
  { who: 'hana', to: CHANNEL, body: '@flan please look at the board' },
  { who: 'kai', to: CHANNEL, body: '@hana @ivo ping from the computational member' },
  { who: 'hana', to: CHANNEL, body: '@codex can you review the handoff?' },
  { who: 'flan', to: CHANNEL, body: '@Hana with a capital letter, and @everyoneX and @codX which are not mentions the way Chatter reads them' },
  { who: 'flan', to: CHANNEL, body: '@everyone the maintenance window is tonight' },
  { who: 'ivo', to: CHANNEL, body: 'Mentions you' },
  { who: 'ivo', to: CHANNEL, body: 'Direct message' },
  { who: 'ivo', to: CHANNEL, body: 'Admin view' },
  { who: 'hana', to: CHANNEL, body: 'New messages' },
  { who: 'kai', to: CHANNEL, body: '   leading spaces kept?\n\n\nthree newlines above\n\ttab inside' },
  { who: 'hana', to: CHANNEL, body: 'A long message of ordinary words. '.repeat(120).trim() },
  { who: 'ivo', to: CHANNEL, body: NEAR_LIMIT_EMOJI },
  { who: 'flan', to: CHANNEL, body: 'The word @everyone inside a sentence by the admin, for the mention label' },
];
const DMS = [
  { who: 'hana', to: 'kai', body: 'DM one from hana to kai: this is private' },
  { who: 'kai', to: 'hana', body: 'DM two, the reply from kai' },
  { who: 'hana', to: 'kai', body: '@everyone in a DM is plain text, nobody is broadcast to' },
  { who: 'kai', to: 'hana', body: 'DM four with <b>markup</b>' },
  { who: 'flan', to: 'hana', body: 'DM from the admin to hana' },
  { who: 'hana', to: 'flan', body: 'DM from hana to the admin' },
  { who: 'ivo', to: 'hana', body: 'DM from ivo to hana, a second private line' },
  { who: 'kai', to: 'flan', body: 'DM from kai to the admin' },
];

// The timeline: bursts of one sender, a few minutes apart, hours between bursts, nights quiet.
const FILLER = 268;
const localHour = (ms) => new Date(ms).getHours();
const timeline = [];
let t = Date.now() - 6 * 24 * 3600_000;
let n = 0;
while (timeline.length < FILLER) {
  const who = pick(people);
  const len = 1 + Math.floor(rand() * 6);
  for (let k = 0; k < len && timeline.length < FILLER; k++) {
    n += 1;
    timeline.push({ at: t, who, to: CHANNEL, body: `#${String(n).padStart(3, '0')} ${pick(SENTENCES)}`, filler: true });
    t += Math.round((1 + rand() * 3.4) * MIN);
  }
  t += Math.round((10 + rand() * 80) * MIN);
  const h = localHour(t);
  if (h < 8) { const d = new Date(t); d.setHours(8, Math.floor(rand() * 40), 0, 0); t = d.getTime(); }
}
// Fit the timeline into [now - 5 days, now - 25 minutes], so the newest message is recent and the oldest is days old.
{
  const first = timeline[0].at;
  const last = timeline[timeline.length - 1].at;
  const end = Date.now() - 25 * MIN;
  const span = 5 * 24 * 3600_000;
  for (const it of timeline) it.at = Math.round(end - span + ((it.at - first) / (last - first)) * span);
}
const dayStart = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const nowMs = Date.now();

// Fixed shapes the pass looks for. Fillers near them are dropped so that nobody interleaves.
const fixed = [];
const reserve = (centre, items) => { fixed.push({ centre, items }); };
const midnight = dayStart(nowMs) - 2 * 24 * 3600_000; // local midnight two days ago
reserve(midnight, [
  { at: midnight - 3 * MIN, who: 'hana', to: CHANNEL, body: 'Same sender, 23:57 local, before midnight' },
  { at: midnight + 1 * MIN, who: 'hana', to: CHANNEL, body: 'Same sender, 00:01 local, three minutes later but a new day' },
]);
const utcMidnight = (() => { const d = new Date(nowMs - 3 * 24 * 3600_000); d.setUTCHours(0, 0, 0, 0); return d.getTime(); })();
reserve(utcMidnight, [
  { at: utcMidnight - 2 * MIN, who: 'kai', to: CHANNEL, body: 'Same sender just before UTC midnight' },
  { at: utcMidnight + 2 * MIN, who: 'kai', to: CHANNEL, body: 'Same sender just after UTC midnight' },
]);
const noon = dayStart(nowMs) - 24 * 3600_000 + 13 * 3600_000; // yesterday 13:00 local
reserve(noon, [
  { at: noon, who: 'flan', to: CHANNEL, body: 'Grouping: first line' },
  { at: noon + 4 * MIN, who: 'flan', to: CHANNEL, body: 'Grouping: four minutes later, same header' },
  { at: noon + 10 * MIN, who: 'flan', to: CHANNEL, body: 'Grouping: six minutes after that, a new header' },
  { at: noon + 11 * MIN, who: 'hana', to: CHANNEL, body: 'Grouping: someone else' },
]);
const inWindow = (ms) => fixed.some((f) => Math.abs(ms - f.centre) < 20 * MIN || f.items.some((i) => Math.abs(ms - i.at) < 20 * MIN));
const all = timeline.filter((it) => !inWindow(it.at)).concat(fixed.flatMap((f) => f.items));

// Awkward messages and DMs are spread through the timeline: some in the newest page, some far back. One that would
// land inside a reserved window is moved out of it.
const spread = (items, from, to) => items.map((it, i) => {
  let at = Math.round(from + ((i + 0.5) / items.length) * (to - from));
  while (inWindow(at)) at += 25 * MIN;
  return { ...it, at };
});
const newest = nowMs - 25 * MIN;
const oldest = nowMs - 5 * 24 * 3600_000;
const specialsOld = SPECIALS.slice(0, 12);
const specialsNew = SPECIALS.slice(12);
all.push(...spread(specialsOld, oldest + 3 * 3600_000, newest - 3 * 24 * 3600_000));
all.push(...spread(specialsNew, newest - 20 * 3600_000, newest - 40 * MIN));
all.push(...spread(DMS.slice(0, 1), newest - 4 * 24 * 3600_000, newest - 4 * 24 * 3600_000 + MIN));
all.push(...spread(DMS.slice(1), newest - 6 * 3600_000, newest - 45 * MIN));
all.sort((a, b) => a.at - b.at);

let ids = [];
for (const it of all) {
  const before = maxId();
  if (it.filler) await viaChatter(it.who, env.repo, ['post', it.body]);
  else {
    const r = await env.post(it.who, it.to, it.body);
    if (r.status !== 201) fail(`seeding a ${it.who} message failed with HTTP ${r.status}: ${JSON.stringify(r.body?.error ?? r.body)}`);
  }
  const after = maxId();
  rw.prepare('UPDATE messages SET created_at = ? WHERE id > ? AND id <= ?').run(stamp(it.at), before, after);
  ids.push(after);
}
// The setup message makeEnv wrote is older than everything.
rw.prepare('UPDATE messages SET created_at = ? WHERE id = 1').run(stamp(oldest - 3600_000));

// ---------------------------------------------------------------- the board
// Chatter takes only registered agents as an assignee, so a task cannot be given to a member.
await viaChatter('flan', env.repo, ['task', 'create', 'Fix the login redirect', '--assignee', 'codex']);
await viaChatter('flan', env.repo, ['task', 'create', '<b>Review</b> the "audit" table & its columns']);
await viaChatter('hana', env.repo, ['task', 'create', 'Write the deploy runbook']);
await viaChatter('hana', env.repo, ['task', 'done', 'TASK-3']);
await viaChatter('hana', env.repo, ['ask', 'codex', 'Which port should the bridge listen on?']);
await viaChatter('kai', env.repo, ['ask', 'Should the archive be encrypted at rest?']);
await viaChatter('kai', env.repo, ['note', 'Decision: message text is plain text only', '--type', 'decision']);
await viaChatter('hana', env.repo, ['note', 'Dead end: parsing markdown in the feed', '--type', 'dead-end']);
await viaChatter('hana', env.repo, ['handoff', 'TASK-2', 'codex', '--summary', 'Review the audit table columns', '--next', 'Check the narrow layout']);

// ---------------------------------------------------------------- read pointers
// One pointer per member per repository (SPEC): hana has three unread at the end, kai is mid-way, ivo has read
// nothing, flan has read everything. The pointer decides where the "New messages" marker sits on first open.
const last = ids[ids.length - 1];
store.setRead('flan', key, last);
store.setRead('hana', key, ids[ids.length - 4]);
store.setRead('kai', key, ids[Math.floor(ids.length / 2)]);

// ---------------------------------------------------------------- running
let current = env.app;
let stopped = false;
const makeApp = () => createBridge({ store, host, pollMs: POLL_MS, staticDir: STATIC_DIR, log });

fs.writeFileSync(CONTROL, '', { mode: 0o600 });
{
  const fd = fs.openSync(INFO, 'wx', 0o600);
  fs.writeSync(fd, JSON.stringify({ pid: process.pid, url: URL_, port: PORT, universe: env.root, out: OUT, mainRepoKey: key, sidecarKey: sidecar.key, seeded: ids.length }, null, 2));
  fs.closeSync(fd);
}
console.log(`throwaway bridge: ${URL_}/  (pid ${process.pid}; ${ids.length} seeded messages; tokens in ${TOKENS}; control file ${CONTROL})`);

async function control(line) {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  try {
    if (cmd === 'stop') {
      if (stopped) return say('stop: already stopped');
      await current.close();
      stopped = true;
      return say('stop: closed gracefully');
    }
    if (cmd === 'drop') {
      if (stopped) return say('drop: already stopped');
      current.server.close();
      current.server.closeAllConnections();
      stopped = true;
      return say('drop: connections cut without a goodbye');
    }
    if (cmd === 'start') {
      if (!stopped) return say('start: already running');
      current = makeApp();
      await current.listen(PORT);
      stopped = false;
      return say(`start: listening again on port ${PORT}`);
    }
    if (cmd === 'post') {
      const [handle, to] = rest;
      const body = line.trim().split(/\s+/).slice(3).join(' ');
      if (!people.includes(handle)) return say(`post: unknown handle ${handle}`);
      if (/@everyone\b/i.test(body) && handle !== 'flan') return say('post: refused, @everyone only from the admin');
      const args = to === CHANNEL ? ['post', body] : ['send', to, body, '--queue'];
      await viaChatter(handle, env.repo, args);
      return say(`post: ${handle} -> ${to} written (${body.length} characters)`);
    }
    if (cmd === 'status') return say(`status: ${stopped ? 'stopped' : 'running'} on port ${PORT}, ${maxId()} messages in the main repo`);
    return say(`unknown command: ${cmd}`);
  } catch (e) {
    say(`${cmd}: failed: ${String(e.message).slice(0, 300)}`);
  }
}

let busy = false;
const timer = setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    const text = fs.readFileSync(CONTROL, 'utf8');
    if (text.trim()) {
      fs.writeFileSync(CONTROL, '');
      for (const line of text.split('\n')) if (line.trim()) await control(line);
    }
  } catch { /* the file is being replaced */ } finally { busy = false; }
}, POLL_CONTROL_MS);

let ending = false;
async function teardown() {
  if (ending) return;
  ending = true;
  clearInterval(timer);
  try { rw.close(); } catch { /* closed */ }
  try { if (!stopped) await current.close(); } catch { /* already closed */ }
  try { await env.stop(); } catch { /* the universe is gone or going */ }
  for (const f of [TOKENS, INFO, CONTROL]) fs.rmSync(f, { force: true });
  fs.rmSync(STATIC_DIR, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGTERM', teardown);
process.on('SIGINT', teardown);
