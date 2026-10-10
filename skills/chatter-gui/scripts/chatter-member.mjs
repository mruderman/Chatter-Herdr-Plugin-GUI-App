#!/usr/bin/env node
// Command-line client for computational members (and anyone with a token).
// Zero dependencies; needs Node 18+. Configure with environment variables:
//   CHATTER_BRIDGE_URL    e.g. https://baremetalcyansociety.tail5c44ac.ts.net:8446
//   CHATTER_BRIDGE_TOKEN  the member's bearer token
//   CHATTER_BRIDGE_REPO   default repo key (see `repos`)

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
  if (!URL_BASE || !TOKEN) die('set CHATTER_BRIDGE_URL and CHATTER_BRIDGE_TOKEN', 2);
  const res = await fetch(`${URL_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) die(`${res.status} ${data?.error?.code || ''}: ${data?.error?.message || res.statusText}`, 3);
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

async function watch(key, after) {
  let cursor = after ?? null;
  for (;;) {
    try {
      const headers = { Authorization: `Bearer ${TOKEN}`, ...(cursor !== null ? { 'Last-Event-ID': String(cursor) } : {}) };
      const res = await fetch(`${URL_BASE}/v1/repos/${key}/stream`, { headers });
      if (!res.ok) die(`stream refused: ${res.status}`, 3);
      let buf = '';
      for await (const chunk of res.body) {
        buf += Buffer.from(chunk).toString('utf8');
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = {};
          for (const line of raw.split('\n')) {
            const j = line.indexOf(':');
            if (j > 0) ev[line.slice(0, j)] = line.slice(j + 1).trim();
          }
          if (ev.event === 'message') {
            const m = JSON.parse(ev.data);
            cursor = m.id;
            console.log(process.env.CHATTER_JSON ? JSON.stringify(m) : fmt(m));
          } else if (ev.event === 'hello' && cursor === null) cursor = JSON.parse(ev.data).max_id;
          else if (ev.event === 'bye') {
            const reason = JSON.parse(ev.data).reason;
            if (reason === 'revoked' || reason === 'token_rotated') die(`stream closed: ${reason}`, 3);
            if (reason === 'epoch') console.error('chatter-member: repo was recreated; ids restarted');
          }
        }
      }
    } catch (e) { console.error(`chatter-member: stream dropped (${e.message}); retrying`); }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

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
