#!/usr/bin/env node
// Command-line client for computational members (and anyone with a token).
// Zero dependencies; needs Node 18+. Configure with environment variables:
//   CHATTER_BRIDGE_URL    e.g. https://baremetalcyansociety.tail5c44ac.ts.net:8446
//   CHATTER_BRIDGE_TOKEN  the member's bearer token
//   CHATTER_BRIDGE_REPO   default repo key (see `repos`)
// Exit codes: 2 for a configuration error, 3 when the bridge refused or answered in a way this client cannot
// use, 1 for anything else. Harnesses keep what a script prints, so no text here ever repeats the token, an
// exception's message or a URL: see `checkConfig` and `describeError`.

const URL_BASE = (process.env.CHATTER_BRIDGE_URL || '').replace(/\/$/, '');
const TOKEN = process.env.CHATTER_BRIDGE_TOKEN || '';
let REPO = process.env.CHATTER_BRIDGE_REPO || '';

const USAGE = `chatter-member <command>

  whoami                         who the bridge thinks you are
  repos                          list repos (keys, labels, unread position)
  directory                      members and Herdr agents you can address
  read [--after ID] [--before ID] [--limit N] [--mark]   print messages
  post <text...>                 post to #chat
  dm <handle> <text...>          direct message a member or agent
  watch [--after ID]             stream new messages (reconnects, resumes)
  board                          tasks, open questions, notes, agents
  --repo KEY                     use a repo other than CHATTER_BRIDGE_REPO
  --json                         machine-readable output

Messages print as:  #<id> <time UTC> <from> -> <to>: <body>
`;

const die = (m, code = 1) => { console.error(`chatter-member: ${m}`); process.exit(code); };

// Only a plain word is ever printed from an error. Its message, cause and stack can quote a header value or a
// URL with credentials (fetch does both), and the name and code of the errors that matter here are short words.
const SAFE_WORD = /^[A-Za-z0-9_]{1,64}$/;
const describeError = (e) => [e?.name, e?.code].filter((v) => typeof v === 'string' && SAFE_WORD.test(v)).join(' ') || 'Error';
const fatal = (e) => die(`unexpected failure (${describeError(e)}); the bridge may be unreachable or may have answered in a form this client does not know`);

// Printable ASCII without a space: the bridge reads `Bearer \S+`, and fetch refuses anything that is not a legal
// header value by quoting the whole value in its error, so a token outside this set is refused before it gets near fetch.
const TOKEN_SHAPE = /^[\x21-\x7e]{1,512}$/;
let configChecked = false;
/** Runs before the first request, once. Its messages name the variable and never show a value. */
function checkConfig() {
  if (configChecked) return;
  if (!URL_BASE || !TOKEN) die('set CHATTER_BRIDGE_URL and CHATTER_BRIDGE_TOKEN', 2);
  if (!TOKEN_SHAPE.test(TOKEN)) die('CHATTER_BRIDGE_TOKEN must be a single token of at most 512 printable characters, with no spaces, line breaks or control characters (its value is not shown)', 2);
  let u = null;
  try { u = new URL(URL_BASE); } catch { /* refused just below, without the value */ }
  if (!u || !/^https?:$/.test(u.protocol)) die('CHATTER_BRIDGE_URL must be an http or https address', 2);
  if (u.username || u.password) die('CHATTER_BRIDGE_URL must not contain a user name or password (the token goes in CHATTER_BRIDGE_TOKEN)', 2);
  configChecked = true;
}

function flags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json' || a === '--mark') out[a.slice(2)] = true;
    else if (['--repo', '--after', '--before', '--limit'].includes(a)) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

async function call(method, path, body) {
  checkConfig();
  const res = await fetch(`${URL_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = undefined; }
  if (!res.ok) die(`${res.status} ${data?.error?.code || ''}: ${data?.error?.message || res.statusText}`, 3);
  // A proxy's HTML page or an empty body with a 200 must not become `{}` and a crash on the first property.
  if (data === null || typeof data !== 'object') die('the bridge answered with something that is not JSON; check that CHATTER_BRIDGE_URL points at the bridge', 3);
  return data;
}

const fmt = (m) => `#${m.id} ${m.created_at.slice(0, 19).replace('T', ' ')} ${m.from} -> ${m.to}: ${m.body.replace(/\n/g, '\n    ')}`;

async function repoKey(f) {
  if (f.repo) return f.repo;
  if (REPO) return REPO;
  const { repos } = await call('GET', '/v1/repos');
  if (repos.length === 1) return repos[0].key;
  die(`several repos; pass --repo or set CHATTER_BRIDGE_REPO. Keys: ${repos.map((r) => r.key).join(', ')}`, 2);
}

const RETRY_MS = 2000;
const RESYNC_NOTICE = 'chatter-member: the repo\'s database was recreated, so message ids restarted. Messages written before this reconnect may have been missed; run `read --limit 30` to see the latest.';

function parseEvent(raw) {
  const ev = {};
  for (const line of raw.split('\n')) {
    const j = line.indexOf(':');
    if (j > 0) ev[line.slice(0, j)] = line.slice(j + 1).trim();
  }
  return ev;
}

async function watch(key, after) {
  checkConfig();
  let cursor = after ?? null;
  // The epoch that `cursor` belongs to. The bridge keeps its own copy of the cursor for each connection, so a
  // cursor from another epoch cannot be mended on a connection that carries it: it is dropped and the stream is
  // opened again without it, and the next hello sets it.
  let epoch = null;
  for (;;) {
    let reconnectNow = false;
    const ctrl = new AbortController();
    try {
      const headers = { Authorization: `Bearer ${TOKEN}`, ...(cursor !== null ? { 'Last-Event-ID': String(cursor) } : {}) };
      const res = await fetch(`${URL_BASE}/v1/repos/${key}/stream`, { headers, signal: ctrl.signal });
      if (!res.ok) die(`stream refused: ${res.status}`, 3);

      /** Returns true when this connection must be given up at once. */
      const onEvent = (ev) => {
        if (ev.event === 'message') {
          const m = JSON.parse(ev.data);
          cursor = m.id;
          console.log(process.env.CHATTER_JSON ? JSON.stringify(m) : fmt(m));
        } else if (ev.event === 'hello') {
          const hello = JSON.parse(ev.data);
          if (epoch !== null && hello.epoch !== epoch) {
            cursor = null;
            epoch = null;
            console.error(RESYNC_NOTICE);
            return true;
          }
          epoch = hello.epoch;
          if (cursor === null) cursor = hello.max_id;
        } else if (ev.event === 'bye') {
          const reason = JSON.parse(ev.data).reason;
          if (reason === 'revoked' || reason === 'token_rotated') die(`stream closed: ${reason}`, 3);
          if (reason === 'epoch') {
            cursor = null;
            epoch = null;
            console.error(RESYNC_NOTICE);
          }
        }
        return false;
      };

      // One decoder for the whole response: a network chunk can end in the middle of a multi-byte character.
      const decoder = new TextDecoder('utf-8');
      let buf = '';
      const pump = (text) => {
        buf += text;
        let i;
        while (!reconnectNow && (i = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, i);
          buf = buf.slice(i + 2);
          reconnectNow = onEvent(parseEvent(raw));
        }
      };
      for await (const chunk of res.body) {
        pump(decoder.decode(chunk, { stream: true }));
        if (reconnectNow) break;
      }
      if (!reconnectNow) pump(decoder.decode());
    } catch (e) { console.error(`chatter-member: stream dropped (${describeError(e)}); retrying`); } finally { ctrl.abort(); }
    if (!reconnectNow) await new Promise((r) => setTimeout(r, RETRY_MS));
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const f = flags(rest);
  if (f.json) process.env.CHATTER_JSON = '1';
  const out = (data, human) => console.log(process.env.CHATTER_JSON ? JSON.stringify(data, null, 2) : human());

  switch (cmd) {
    case 'whoami': { const d = await call('GET', '/v1/me'); out(d, () => `${d.handle} (${d.kind}, ${d.role})`); break; }
    case 'repos': { const d = await call('GET', '/v1/repos'); out(d, () => d.repos.map((r) => `${r.key}  ${r.label}  ${r.messages} messages  read to #${r.last_read_id}`).join('\n')); break; }
    case 'directory': { const d = await call('GET', '/v1/directory'); out(d, () => `members: ${d.members.map((m) => `${m.handle} (${m.kind})`).join(', ')}\nagents: ${d.agents.join(', ')}`); break; }
    case 'read': {
      const key = await repoKey(f);
      const q = new URLSearchParams();
      for (const k of ['after', 'before', 'limit']) if (f[k]) q.set(k === 'limit' ? 'limit' : `${k}_id`, f[k]);
      const d = await call('GET', `/v1/repos/${key}/messages?${q}`);
      out(d, () => d.messages.map(fmt).join('\n') || '(no messages)');
      if (f.mark && d.messages.length) await call('POST', `/v1/repos/${key}/read`, { up_to_id: d.messages.at(-1).id });
      break;
    }
    case 'post': {
      if (!f._.length) die('post needs text');
      const d = await call('POST', `/v1/repos/${await repoKey(f)}/messages`, { to: '#chat', body: f._.join(' ') });
      out(d, () => `posted #${d.id}${d.pushed.length ? `, pushed to ${d.pushed.join(', ')}` : ''}${d.warnings.map((w) => `\nwarning: ${w}`).join('')}`);
      break;
    }
    case 'dm': {
      if (f._.length < 2) die('dm needs a handle and text');
      const d = await call('POST', `/v1/repos/${await repoKey(f)}/messages`, { to: f._[0], body: f._.slice(1).join(' ') });
      out(d, () => `sent #${d.id}${d.delivery ? ` (${d.delivery})` : ''}`);
      break;
    }
    case 'watch': await watch(await repoKey(f), f.after ? Number(f.after) : null); break;
    case 'board': {
      const d = await call('GET', `/v1/repos/${await repoKey(f)}/board`);
      out(d, () => [
        `agents: ${d.agents.map((a) => a.name).join(', ') || '-'}`,
        `open questions:\n${d.questions.map((q) => `  #${q.id} ${q.author}: ${q.text}`).join('\n') || '  -'}`,
        `tasks:\n${d.tasks.map((t) => `  ${t.id} [${t.status}] ${t.title}${t.assignee ? ` (${t.assignee})` : ''}`).join('\n') || '  -'}`,
      ].join('\n'));
      break;
    }
    default: console.log(USAGE); process.exit(cmd ? 1 : 0);
  }
}

main().catch(fatal);
