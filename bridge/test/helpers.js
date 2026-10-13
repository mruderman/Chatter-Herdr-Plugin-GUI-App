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

// The stand-in for herdr. CommonJS, pinned by the package.json beside it, and run by this Node, not by
// whatever `node` is first on PATH. It never opens a socket.
const FAKE_HERDR = `#!${process.execPath}
'use strict';
// Answers \`agent list\` as agent-list.json says, exits 0 for every other command, and logs each call with
// its parent's pid (the bridge's own runs have the test process as parent; Chatter's have Chatter) and the
// Herdr variables it was given, which decide the socket it would reach.
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const env = {};
for (const k of ['HERDR_SOCKET_PATH', 'HERDR_SESSION', 'HERDR_PANE_ID']) env[k] = process.env[k] ?? null;
fs.appendFileSync(path.join(__dirname, 'calls.log'), JSON.stringify({ ppid: process.ppid, args, env }) + '\\n');
if (args[0] === 'agent' && args[1] === 'list') {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'agent-list.json'), 'utf8'));
  const answer = () => {
    if (cfg.stdout) process.stdout.write(cfg.stdout);
    if (cfg.stderr) process.stderr.write(cfg.stderr);
    process.exitCode = cfg.code ?? 0;
  };
  if (cfg.hangMs && (!cfg.hangParent || cfg.hangParent === process.ppid)) setTimeout(answer, cfg.hangMs);
  else answer();
}
`;

/** What `herdr agent list` answers when these agents are live: Herdr's JSON shape (`result.agents`). */
export const agentListJson = (agents) => JSON.stringify({ result: { agents } });

/**
 * A fake `herdr` executable in `dir`. `answer({ stdout, stderr, code, hangMs, hangParent })` sets what
 * `agent list` answers (by default: no live agents); `calls()` is every call made so far, oldest first.
 */
export function makeFakeHerdr(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, 'herdr');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs"}\n');
  fs.writeFileSync(bin, FAKE_HERDR, { mode: 0o755 });
  const log = path.join(dir, 'calls.log');
  const answer = (cfg) => fs.writeFileSync(path.join(dir, 'agent-list.json'), JSON.stringify(cfg));
  answer({ stdout: agentListJson([]) });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const isList = (c) => c.args[0] === 'agent' && c.args[1] === 'list';
  return {
    dir,
    bin,
    answer,
    calls,
    /** The `agent list` runs this process made itself (the bridge in a test runs in the test's process). */
    ownListRuns: () => calls().filter((c) => c.ppid === process.pid && isList(c)),
    /** The `agent list` runs made by someone else: the Chatter processes the bridge starts. */
    otherListRuns: () => calls().filter((c) => c.ppid !== process.pid && isList(c)),
    /** What was typed into an agent's terminal: Chatter's `herdr agent prompt <pane> <text>`. */
    prompts: () => calls().filter((c) => c.args[0] === 'agent' && c.args[1] === 'prompt').map((c) => ({ pane: c.args[2], text: c.args[3] })),
  };
}

/**
 * A scratch Chatter universe plus a running bridge, all in a temp dir. Herdr is a path that does not exist,
 * unless `fakeHerdr` is set: then it is a fake in the temp dir (`x.herdr`), for Chatter and the bridge alike.
 */
export async function makeEnv({ trustTailscale = false, whois, limits, pollMs = 50, staticDir, log, fakeHerdr = false, hostOptions = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-'));
  const state = path.join(root, 'chatter-state');
  const adminCfg = path.join(root, 'admin-cfg');
  const repo = path.join(root, 'repo');
  for (const d of [state, adminCfg, repo]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(adminCfg, 'name'), 'flan\n');
  const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, stdio: 'ignore' });
  git('init', '-q');
  git('commit', '--allow-empty', '-q', '-m', 'init');

  const herdr = fakeHerdr ? makeFakeHerdr(path.join(root, 'fake-herdr')) : null;
  const env = { ...process.env, HERDR_PLUGIN_STATE_DIR: state, HERDR_PLUGIN_CONFIG_DIR: adminCfg, HERDR_BIN_PATH: herdr ? herdr.bin : '/nonexistent-herdr' };
  delete env.HERDR_PANE_ID;
  const host = new ChatterHost({
    cmd: [process.execPath, '--no-warnings', CHATTER_JS],
    memberConfigRoot: path.join(root, 'members'), adminConfigDir: adminCfg, stateDir: state, env, log, ...hostOptions,
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
    root, repo, repoInfo, key, base, store, host, app, tokens, addMember, api, post, messages, count, seedAgent, herdr,
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
