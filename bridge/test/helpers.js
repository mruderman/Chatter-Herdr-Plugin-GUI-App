import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ChatterHost } from '../src/chatter.js';
import { createBridge } from '../src/server.js';
import { Store } from '../src/store.js';

export const CHATTER_JS = process.env.CHATTER_JS || '/home/claude/chatter/dist/bin/chatter.js';
export const haveChatter = fs.existsSync(CHATTER_JS);

/** A scratch Chatter universe plus a running bridge, all in a temp dir. */
export async function makeEnv({ trustTailscale = false, whois, limits, pollMs = 50, staticDir, log } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-'));
  const state = path.join(root, 'chatter-state');
  const adminCfg = path.join(root, 'admin-cfg');
  const repo = path.join(root, 'repo');
  for (const d of [state, adminCfg, repo]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(adminCfg, 'name'), 'flan\n');
  const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, stdio: 'ignore' });
  git('init', '-q');
  git('commit', '--allow-empty', '-q', '-m', 'init');

  const env = { ...process.env, HERDR_PLUGIN_STATE_DIR: state, HERDR_PLUGIN_CONFIG_DIR: adminCfg, HERDR_BIN_PATH: '/nonexistent-herdr' };
  delete env.HERDR_PANE_ID;
  const host = new ChatterHost({
    cmd: [process.execPath, '--no-warnings', CHATTER_JS],
    memberConfigRoot: path.join(root, 'members'), adminConfigDir: adminCfg, stateDir: state, env, log,
  });
  const store = new Store(path.join(root, 'bridge.db'));
  store.addMember({ handle: 'flan', kind: 'human', role: 'admin', tailscale_login: 'flan@example.com' });
  const app = createBridge({ store, host, trustTailscale, whois, limits, pollMs, staticDir, log });
  const addr = await app.listen(0);
  const base = `http://127.0.0.1:${addr.port}`;

  // First post creates the repo universe.
  const first = await host.run({ handle: 'flan', cwd: repo, args: ['post', 'setup message'] });
  if (first.code !== 0) throw new Error(`setup post failed: ${first.stderr}`);
  const repoInfo = (await host.repos({ fresh: true }))[0];

  const tokens = { flan: store.issueToken('flan') };
  const addMember = (handle, o = {}) => {
    store.addMember({ handle, kind: 'computational', ...o });
    host.ensureMemberConfig(handle);
    tokens[handle] = store.issueToken(handle);
    return tokens[handle];
  };

  const api = (who, method, p, body, headers = {}) => fetch(`${base}${p}`, {
    method,
    headers: { ...(who ? { Authorization: `Bearer ${tokens[who] ?? who}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null), headers: r.headers }));

  const key = repoInfo.key;
  const post = (who, to, body) => api(who, 'POST', `/v1/repos/${key}/messages`, { to, body });
  const messages = (who, q = '') => api(who, 'GET', `/v1/repos/${key}/messages${q}`);
  const count = () => new DatabaseSync(path.join(repoInfo.dir, 'chatter.db'), { readOnly: true }).prepare('SELECT COUNT(*) AS n FROM messages').get().n;
  const seedAgent = (name) => {
    const db = new DatabaseSync(path.join(repoInfo.dir, 'chatter.db'));
    db.prepare('INSERT INTO agents (name, kind, repo_root, registered_at, last_seen_at) VALUES (?,?,?,?,?)')
      .run(name, 'codex', repo, '2026-10-09 00:00:00', '2026-10-09 00:00:00');
    db.close();
  };

  return {
    root, repo, repoInfo, key, base, store, host, app, tokens, addMember, api, post, messages, count, seedAgent,
    async stop() { await app.close(); host.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

/** Minimal SSE client over fetch. */
export async function openSse(url, headers = {}) {
  const ctrl = new AbortController();
  const res = await fetch(url, { headers, signal: ctrl.signal });
  const events = [];
  let buf = '';
  const parse = (raw) => {
    const ev = {};
    for (const line of raw.split('\n')) {
      if (line.startsWith(':') || !line) continue;
      const i = line.indexOf(':');
      const k = line.slice(0, i);
      const v = line.slice(i + 1).trim();
      if (k === 'data') { try { ev.data = JSON.parse(v); } catch { ev.data = v; } } else ev[k] = v;
    }
    return ev.event || ev.data !== undefined ? ev : null;
  };
  if (res.status === 200) {
    (async () => {
      for await (const chunk of res.body) {
        buf += Buffer.from(chunk).toString('utf8');
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const ev = parse(buf.slice(0, i));
          buf = buf.slice(i + 2);
          if (ev) events.push(ev);
        }
      }
    })().catch(() => {});
  }
  return {
    status: res.status,
    events,
    async waitFor(pred, ms = 4000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const f = events.find(pred);
        if (f) return f;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`timed out; saw ${JSON.stringify(events.map((e) => `${e.event}:${e.id ?? ''}`))}`);
    },
    async quiet(ms = 400) { await new Promise((r) => setTimeout(r, ms)); },
    close() { ctrl.abort(); },
  };
}
