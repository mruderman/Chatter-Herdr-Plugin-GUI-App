#!/usr/bin/env node
// V4a of docs/plans/deploy-verify.md: a scripted session of each standard agent (Claude Code, Codex CLI) with the
// `chatter-gui` skill against a THROWAWAY bridge, recording what a real agent does with the skill and what the
// harness keeps of the token. Usage and findings: docs/runbooks/agent-run.md.
//
// Safety, in the order it matters:
//  - The bridge is `makeEnv` from the bridge tests: a scratch Chatter universe in a temp directory, no Herdr
//    (HERDR_BIN_PATH is /nonexistent-herdr). The script refuses to start when any HERDR_* or CHATTER_* variable
//    (other than CHATTER_JS) is set, because they could point a child at a real state directory.
//  - The skill is copied into a throwaway project directory, never into a global skills directory.
//  - Each agent gets an environment built from an allowlist: the three CHATTER_BRIDGE_* variables and nothing of
//    this shell's own (it may carry a harness's session variables). Its PATH lacks ~/.local/bin, where the real
//    `chatter` and `herdr` live.
//  - Tokens exist only in this process's memory and in the agents' environments. Everything printed or written is
//    passed through the redactor, which also knows the 12-character prefix of every token. Token searches run here,
//    never through a shell command, so a token never lands in `ps` or in another transcript.
//  - Teardown is in a `finally` and the signal handlers: processes, bridge, harness records this run created,
//    scratch directory; then it checks that nothing is left.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const SKILL_NAME = 'chatter-gui';
const SKILL_SRC = path.join(REPO_ROOT, 'skills', SKILL_NAME);
const USER = os.userInfo();
const REAL_HOME = USER.homedir;

export const PROMPTS = {
  main: 'Check the group chat for new messages, reply in the channel to the one from ada that asks you a question, and send ada a direct message saying you did.',
  rotation: 'Please check the group chat once more for anything new since you last looked, deal with anything addressed to you, and then post one short message in the channel saying you are done for the day.',
};

const TOKEN_RE = /cb_[A-Za-z0-9_-]{16,}/g;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
// Directories no agent session writes to; skipping them keeps the before and after listings quick.
const SKIP_TOP = new Set(['plugins', 'cache', 'downloads', 'skills', '.tmp', 'vendor_imports', 'packages', 'node_repl', 'generated_images', 'browser', 'chrome', 'ide']);

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers (exported for the unit test)

/** Replaces every known secret, its 12-character prefix and its SHA-256, and anything shaped like a bridge token. */
export class Redactor {
  #needles = new Set();
  add(secret) {
    if (typeof secret !== 'string' || secret.length < 12) return;
    this.#needles.add(secret);
    this.#needles.add(secret.slice(0, 12));
    this.#needles.add(crypto.createHash('sha256').update(secret).digest('hex'));
  }
  redact(text) {
    let out = String(text ?? '');
    for (const n of [...this.#needles].sort((a, b) => b.length - a.length)) out = out.split(n).join('[redacted]');
    return out.replace(TOKEN_RE, '[redacted]');
  }
}

export function countOccurrences(buf, needle) {
  const n = Buffer.from(needle, 'utf8');
  if (!n.length) return 0;
  let c = 0;
  let i = 0;
  while ((i = buf.indexOf(n, i)) !== -1) { c += 1; i += n.length; }
  return c;
}

/** Counts every needle ({label, text}) in every file; unreadable and oversized files are listed, not guessed at. */
export function scanFiles(files, needles) {
  const hits = [];
  const skipped = [];
  let scanned = 0;
  let bytes = 0;
  for (const file of files) {
    let buf;
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) { skipped.push({ file, why: 'larger than the size cap' }); continue; }
      buf = fs.readFileSync(file);
    } catch (e) { skipped.push({ file, why: e.code || 'unreadable' }); continue; }
    scanned += 1;
    bytes += buf.length;
    const counts = {};
    let any = false;
    for (const n of needles) { counts[n.label] = countOccurrences(buf, n.text); if (counts[n.label]) any = true; }
    if (any) hits.push({ file, size: buf.length, counts });
  }
  return { hits, skipped, scanned, bytes };
}

export function snapshotTree(root, skipTop = SKIP_TOP) {
  const out = new Map();
  const walk = (dir, depth) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth === 0 && skipTop.has(e.name)) continue; walk(p, depth + 1); } else if (e.isFile()) {
        try { const st = fs.statSync(p); out.set(p, `${st.mtimeMs}:${st.size}`); } catch { /* vanished */ }
      }
    }
  };
  walk(root, 0);
  return out;
}

export function changedPaths(before, after) {
  const out = [];
  for (const [p, sig] of after) if (before.get(p) !== sig) out.push(p);
  return out;
}

/**
 * The paths this run may delete: for every NEW path, the shortest prefix whose last component names a session
 * (a fresh UUID) or the throwaway project (a random stamp). Nothing else is ever a candidate, so a coordinator's
 * or a user's own session records cannot be matched by construction.
 */
export function ownedPrefixes(root, before, after, needles) {
  const owned = new Set();
  for (const p of after.keys()) {
    // A path outside this root would make `relative` start with `..` and be matched, then rebuilt, under the wrong root.
    if (before.has(p) || !p.startsWith(root + path.sep)) continue;
    const parts = path.relative(root, p).split(path.sep);
    const i = parts.findIndex((c) => needles.some((n) => n && c.includes(n)));
    if (i >= 0) owned.add(path.join(root, ...parts.slice(0, i + 1)));
  }
  return [...owned];
}

const flatten = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join('\n') : JSON.stringify(c ?? ''));
const jsonLines = (text) => String(text).split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{')).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });

/** Claude Code `--output-format stream-json --verbose`. */
export function parseClaudeStream(text) {
  const out = { events: 0, init: null, steps: [], texts: [], result: null };
  const byId = new Map();
  for (const ev of jsonLines(text)) {
    out.events += 1;
    if (ev.type === 'system' && ev.subtype === 'init') {
      out.init = { sessionId: ev.session_id, model: ev.model, tools: ev.tools ?? [], skills: ev.skills ?? [], permissionMode: ev.permissionMode };
    } else if (ev.type === 'assistant') {
      for (const b of ev.message?.content ?? []) {
        if (b.type === 'tool_use') {
          const command = b.input?.command ?? b.input?.file_path ?? b.input?.skill ?? JSON.stringify(b.input ?? {});
          const step = { tool: b.name, command: String(command), output: '', exit: null, isError: false };
          byId.set(b.id, step);
          out.steps.push(step);
        } else if (b.type === 'text' && b.text) out.texts.push(b.text);
      }
    } else if (ev.type === 'user') {
      for (const b of ev.message?.content ?? []) {
        if (b.type !== 'tool_result') continue;
        const step = byId.get(b.tool_use_id);
        if (!step) continue;
        step.output = flatten(b.content);
        step.isError = Boolean(b.is_error);
        const m = /^Exit code (\d+)/.exec(step.output);
        step.exit = m ? Number(m[1]) : (step.isError ? 1 : 0);
      }
    } else if (ev.type === 'result') {
      out.result = { subtype: ev.subtype, isError: ev.is_error, turns: ev.num_turns, costUsd: ev.total_cost_usd, durationMs: ev.duration_ms, text: ev.result, sessionId: ev.session_id, denials: ev.permission_denials ?? [] };
    }
  }
  return out;
}

/** Codex CLI `exec --json`; tolerant of the item type being written snake_case or camelCase. */
export function parseCodexStream(text) {
  const out = { events: 0, threadId: null, steps: [], texts: [], usage: null, errors: [] };
  for (const ev of jsonLines(text)) {
    out.events += 1;
    const type = ev.type ?? ev.msg?.type;
    if (type === 'thread.started') out.threadId = ev.thread_id ?? out.threadId;
    if (type === 'turn.completed') out.usage = ev.usage ?? out.usage;
    if (type === 'error' || type === 'turn.failed') out.errors.push(String(ev.message ?? ev.error?.message ?? JSON.stringify(ev)).slice(0, 300));
    if (type !== 'item.completed' || !ev.item) continue;
    const item = ev.item;
    const kind = String(item.type ?? '').toLowerCase().replace(/[_-]/g, '');
    if (kind === 'commandexecution') {
      const cmd = Array.isArray(item.command) ? item.command.join(' ') : String(item.command ?? '');
      const exit = item.exit_code ?? item.exitCode ?? null;
      out.steps.push({ tool: 'shell', command: cmd, output: String(item.aggregated_output ?? item.output ?? ''), exit, isError: exit !== null && exit !== 0, status: item.status });
    } else if (kind === 'agentmessage') {
      if (item.text) out.texts.push(item.text);
    } else if (kind !== 'reasoning') {
      out.steps.push({ tool: kind || 'other', command: JSON.stringify(item).slice(0, 200), output: '', exit: null, isError: false });
    }
  }
  return out;
}

export function memberCalls(command) {
  const calls = [];
  const re = /chatter-member\.mjs\b([^;&|\n]*)/g;
  let m;
  while ((m = re.exec(command))) {
    const rest = m[1].trim();
    calls.push({ sub: (rest.split(/\s+/)[0] ?? '').replace(/["']/g, ''), after: /--after[ =](\d+)/.exec(rest)?.[1] ?? null, mark: /--mark\b/.test(rest) });
  }
  return calls;
}

export function pathForm(command) {
  const i = command.indexOf('chatter-member.mjs');
  if (i < 0) return null;
  const head = command.slice(0, i);
  if (/(^|[\s"'])\/[^\s"']*$/.test(head)) return 'absolute path';
  if (/\.(claude|agents)\/skills\/[^\s"']*$/.test(head)) return 'path from the project root';
  if (/\bcd\s/.test(head)) return 'cd to the skill directory, then scripts/';
  return 'scripts/... from the working directory';
}

const firstLine = (s) => String(s).split('\n').find((l) => l.trim()) ?? '';
const clip = (s, n = 110) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}...` : t; };

/** What the agent did, from its steps; the same for both harnesses. */
export function analyse(steps, texts) {
  const calls = [];
  const forms = new Set();
  const other = [];
  const failures = [];
  let loadedVia = null;
  let wrongSkill = false;
  let maxRead = 0;
  let maxOwn = 0;
  for (const s of steps) {
    if (/SKILL\.md/.test(s.command) && !/skills\/chatter\/SKILL/.test(s.command)) loadedVia ??= s.tool === 'shell' || s.tool === 'Bash' ? 'reads SKILL.md with a shell command' : `${s.tool} tool on SKILL.md`;
    if (s.tool === 'Skill' && s.command.trim() === SKILL_NAME) loadedVia ??= 'Skill tool';
    if ((s.tool === 'Skill' && s.command.trim() === 'chatter') || /skills\/chatter\/SKILL\.md/.test(s.command)) wrongSkill = true;
    const mc = memberCalls(s.command);
    if (mc.length) {
      forms.add(pathForm(s.command));
      for (const c of mc) calls.push({ ...c, exit: s.exit });
      // `read` prints `#<id> ...` lines, or `"id": N` with --json; `post` and `dm` print the id they were given.
      if (mc.some((c) => c.sub === 'read')) for (const m of s.output.matchAll(/^#(\d+) |"id":\s*(\d+)/gm)) maxRead = Math.max(maxRead, Number(m[1] ?? m[2]));
      for (const m of s.output.matchAll(/(?:posted|sent) #(\d+)/g)) maxOwn = Math.max(maxOwn, Number(m[1]));
      if (mc.some((c) => c.sub === 'post' || c.sub === 'dm')) for (const m of s.output.matchAll(/"id":\s*(\d+)/g)) maxOwn = Math.max(maxOwn, Number(m[1]));
      if (s.isError || (s.exit ?? 0) !== 0) failures.push(`${memberCalls(s.command)[0].sub} exit ${s.exit}: ${clip(firstLine(s.output.replace(/^Exit code \d+\n?/, '')), 120)}`);
    } else if (!/SKILL\.md/.test(s.command) && s.tool !== 'Skill') {
      other.push(`${s.tool}: ${clip(s.command, 70)}${s.isError ? ` -> ${clip(firstLine(s.output), 70)}` : ''}`);
    }
  }
  return { calls, forms: [...forms], other, failures, loadedVia, wrongSkill, maxRead, maxOwn, finalText: texts.at(-1) ?? '' };
}

export const callSummary = (calls) => calls.map((c) => `${c.sub}${c.after ? ` --after ${c.after}` : ''}${c.mark ? ' --mark' : ''}${c.exit ? ` (exit ${c.exit})` : ''}`).join(', ') || 'none';

const escCell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
export function mdTable(headers, rows) {
  const line = (cells) => `| ${cells.map(escCell).join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}

export const which = (name, pathVar) => pathVar.split(':').filter(Boolean).map((d) => path.join(d, name)).find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } }) ?? null;

export function parseArgs(argv) {
  const o = { agents: ['claude', 'codex'], scratch: os.tmpdir(), keepLogs: null, dryRun: false, claudeModel: 'sonnet', codexModel: 'gpt-6-luna', timeoutS: 300 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--agents') o.agents = String(argv[++i] ?? '').split(',').filter(Boolean);
    else if (a === '--scratch') o.scratch = path.resolve(String(argv[++i] ?? ''));
    else if (a === '--keep-logs') o.keepLogs = path.resolve(String(argv[++i] ?? ''));
    else if (a === '--claude-model') o.claudeModel = String(argv[++i] ?? '');
    else if (a === '--codex-model') o.codexModel = String(argv[++i] ?? '');
    else if (a === '--timeout') o.timeoutS = Number(argv[++i]);
    else if (a === '--dry-run') o.dryRun = true;
    else throw Object.assign(new Error(`unknown argument ${a}`), { exitCode: 2 });
  }
  for (const a of o.agents) if (!['claude', 'codex'].includes(a)) throw Object.assign(new Error(`unknown agent ${a}`), { exitCode: 2 });
  if (!Number.isFinite(o.timeoutS) || o.timeoutS < 10) throw Object.assign(new Error('--timeout needs seconds, at least 10'), { exitCode: 2 });
  return o;
}

// ---------------------------------------------------------------------------------------------------------------
// Process and file plumbing

const killGroup = (pid, sig) => { if (!pid) return; try { process.kill(-pid, sig); } catch { /* group already gone */ } };

/** Runs a program in its own process group (so `watch`, which never exits, dies with its agent) with a wall-clock limit. */
function runProcess(state, { cmd, args, env, cwd, timeoutMs, input = null }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let out = '';
    let err = '';
    let timedOut = false;
    let done = false;
    const cap = 32 * 1024 * 1024;
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    if (child.pid) state.pids.add(child.pid);
    // Only a child that is still running is ever signalled again at teardown: a finished one's pid may have been reused.
    const finish = (extra) => { if (done) return; done = true; clearTimeout(timer); state.pids.delete(child.pid); resolve({ stdout: out, stderr: err, timedOut, ms: Date.now() - started, ...extra }); };
    child.stdout.on('data', (d) => { if (out.length < cap) out += d; });
    child.stderr.on('data', (d) => { if (err.length < cap) err += d; });
    if (input !== null) child.stdin.end(input);
    const timer = setTimeout(() => { timedOut = true; killGroup(child.pid, 'SIGTERM'); setTimeout(() => killGroup(child.pid, 'SIGKILL'), 5000).unref(); }, timeoutMs);
    child.on('error', (e) => finish({ code: null, error: e.code || 'spawn_error' }));
    child.on('close', (code, signal) => { killGroup(child.pid, 'SIGKILL'); finish({ code, signal }); });
  });
}

function herdrCount() {
  try { return execFileSync('ps', ['-eo', 'comm'], { encoding: 'utf8' }).split('\n').filter((l) => l.trim() === 'herdr').length; } catch { return -1; }
}

/** Pids (other than ours) whose environment still names a throwaway bridge, found by environment, never by a name pattern. */
function processesNaming(needle) {
  const found = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d) || Number(d) === process.pid) continue;
    try { if (fs.readFileSync(`/proc/${d}/environ`, 'latin1').includes(needle)) found.push(Number(d)); } catch { /* not ours or gone */ }
  }
  return found;
}

const portOpen = (port) => new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port });
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});

const tilde = (p) => (p.startsWith(REAL_HOME + path.sep) ? `~${p.slice(REAL_HOME.length)}` : p);
// Claude Code names a project directory after the whole working-directory path, which here is long and says nothing.
const display = (p) => tilde(p).replace(/\/-tmp-[^/]*?(agent-run-[A-Za-z0-9_]+-(?:claude|codex)-project)/, '/-tmp-...$1').replace(/^\/tmp\/claude-\d+\/[^/]+\/[0-9a-f-]{36}\/scratchpad/, '<scratchpad>');
const harnessRoots = () => [path.join(REAL_HOME, '.claude'), path.join(REAL_HOME, '.codex'), `/tmp/claude-${USER.uid}`];
// The scratch directory sits under /tmp/claude-<uid> when the caller's own scratch space does, and it is named after the
// run's stamp: leaving it in would make it an "owned" path of the cleanup, which must never delete its own working files.
const snapshotAll = (excludeUnder) => { const m = new Map(); for (const r of harnessRoots()) for (const [p, s] of snapshotTree(r)) if (!excludeUnder || !p.startsWith(excludeUnder + path.sep)) m.set(p, s); return m; };

function agentEnv(extra) {
  // PATH without ~/.local/bin: the real `chatter` and `herdr` live there, and a skill about "the group chat" invites the wrong one.
  const base = { PATH: `${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, HOME: REAL_HOME, USER: USER.username, LOGNAME: USER.username, SHELL: '/bin/bash', LANG: 'C.UTF-8', TERM: 'dumb' };
  return { ...base, ...extra };
}

// ---------------------------------------------------------------------------------------------------------------
// The scenario

const AGENT_HANDLE = { claude: 'claude-test', codex: 'codex-test' };

async function seed(env, agent, nonce) {
  const post = async (who, to, body) => {
    const r = await env.post(who, to, body);
    if (r.status !== 201) throw new Error(`seed post by ${who} answered ${r.status}`);
    return r.body.id;
  };
  await post('ada', '#chat', `Meeting notes from Tuesday are in the shared folder. (ref ${nonce}a)`);
  await post('flan', '#chat', `@ada did the budget numbers come through? (ref ${nonce}b)`);
  const qid = await post('ada', '#chat', `@${agent} quick question: what is 17 plus 25? Please answer in the channel. (ref ${nonce}c)`);
  return { qid };
}

async function verify(env, agent, afterId) {
  const r = await env.api('flan', 'GET', `/v1/repos/${env.key}/messages?limit=500`);
  const mine = r.body.messages.filter((m) => m.from === agent && m.id > afterId);
  const channel = mine.filter((m) => m.to === '#chat');
  const dms = mine.filter((m) => m.to === 'ada');
  return { channel, dms, other: mine.length - channel.length - dms.length, replyOk: channel.some((m) => /\b42\b/.test(m.body)) };
}

function bridgeSummary(lines) {
  const counts = new Map();
  for (const l of lines) {
    const m = /^(GET|POST|PATCH|DELETE) (\S+) (\d{3}) \d+ms$/.exec(l);
    if (!m) continue;
    const key = `${m[1]} ${m[2].replace(/\/v1\/repos\/[^/]+/, '/v1/repos/{repo}')} ${m[3]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([k, n]) => `${k}${n > 1 ? ` x${n}` : ''}`).join('; ') || 'no requests';
}

// ---------------------------------------------------------------------------------------------------------------
// One agent

function buildCommand(kind, opts, { prompt, projectDir, resumeId, sessionId }) {
  if (kind === 'claude') {
    const allowed = ['Skill', 'Read', 'Bash(node *chatter-member.mjs*)', 'Bash(cd *)'].join(',');
    const args = ['-p', prompt, '--model', opts.claudeModel, '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
      // Project settings only: the user's plugins, hooks and global skills (a `chatter` skill among them) stay out.
      '--setting-sources', 'project', '--strict-mcp-config', '--tools', 'Bash,Read,Skill', '--allowedTools', allowed,
      '--max-turns', '14', '--max-budget-usd', '0.75'];
    args.push(...(resumeId ? ['--resume', resumeId] : ['--session-id', sessionId]));
    return { cmd: which('claude', process.env.PATH), args, cwd: projectDir };
  }
  // A custom profile (read-only files, network on): Codex's built-in profiles block even a loopback connect, and the
  // narrowest thing that reaches 127.0.0.1 is network on, which is all egress, not loopback only.
  const profile = ['-c', 'default_permissions="v4a"', '-c', 'permissions.v4a.extends=":read-only"', '-c', 'permissions.v4a.network.enabled=true'];
  const common = ['--json', '--ignore-user-config', '-m', opts.codexModel, '-c', 'approval_policy="never"', '-c', 'web_search="disabled"', ...profile];
  const args = resumeId ? ['exec', 'resume', ...common, resumeId, prompt] : ['exec', ...common, '-C', projectDir, prompt];
  return { cmd: which('codex', process.env.PATH), args, cwd: projectDir };
}

/** Checked under the allowlisted environment, before a run is spent. Codex prints its answer on stderr. */
function loggedIn(kind, env) {
  const r = spawnSync(which(kind, process.env.PATH), kind === 'claude' ? ['auth', 'status'] : ['login', 'status'], { env, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
  const text = `${r.stdout}\n${r.stderr}`;
  if (kind === 'claude') { try { return JSON.parse(r.stdout).loggedIn === true; } catch { return false; } }
  return /logged in/i.test(text) && !/not logged in/i.test(text);
}

async function runAgent(ctx, kind) {
  const { opts, redactor, state, log } = ctx;
  const handle = AGENT_HANDLE[kind];
  const res = { kind, handle, blocked: null, runs: {}, scan: null, cleanup: null };
  const authEnv = agentEnv({});
  if (!which(kind, process.env.PATH)) { res.blocked = `${kind} is not on PATH`; return res; }
  if (!loggedIn(kind, authEnv)) { res.blocked = `${kind} is not logged in under the allowlisted environment`; return res; }

  const { makeEnv } = await import('../../bridge/test/helpers.js');
  const bridgeLog = [];
  const env = await makeEnv({ log: (l) => bridgeLog.push(String(l)) });
  state.bridges.push(env);
  const nonce = crypto.randomBytes(3).toString('hex');
  const token = env.addMember(handle);
  env.addMember('ada');
  redactor.add(token);
  for (const t of Object.values(env.tokens)) redactor.add(t);
  const { qid } = await seed(env, handle, `nonce-${nonce}`);
  res.control = `nonce-${nonce}`;
  res.url = env.base;

  const projectDir = path.join(state.scratch, `${kind}-project`);
  const skillDest = kind === 'claude' ? path.join(projectDir, '.claude', 'skills', SKILL_NAME) : path.join(projectDir, '.agents', 'skills', SKILL_NAME);
  fs.mkdirSync(path.dirname(skillDest), { recursive: true });
  fs.cpSync(SKILL_SRC, skillDest, { recursive: true });
  if (kind === 'codex') execFileSync('git', ['init', '-q'], { cwd: projectDir, env: authEnv });

  const rec = { kind, stamp: path.basename(state.scratch), ids: [], before: snapshotAll(state.scratch), cleaned: false, threadId: null };
  state.records.push(rec);
  const sessionId = crypto.randomUUID();
  rec.ids.push(sessionId);

  const env1 = agentEnv({ CHATTER_BRIDGE_URL: env.base, CHATTER_BRIDGE_TOKEN: token, CHATTER_BRIDGE_REPO: env.key, ...(kind === 'claude' ? { DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } : {}) });
  const exec = async (phase, prompt, resumeId) => {
    const idx = bridgeLog.length;
    const c = buildCommand(kind, opts, { prompt, projectDir, resumeId, sessionId });
    log(`${kind} ${phase}: running (limit ${opts.timeoutS}s)`);
    let p;
    if (opts.dryRun) p = { stdout: '', stderr: '', code: 0, ms: 0, timedOut: false, dry: true };
    else p = await runProcess(state, { cmd: c.cmd, args: c.args, env: env1, cwd: c.cwd, timeoutMs: opts.timeoutS * 1000 });
    const parsed = kind === 'claude' ? parseClaudeStream(p.stdout) : parseCodexStream(p.stdout);
    if (opts.keepLogs) {
      fs.mkdirSync(opts.keepLogs, { recursive: true });
      fs.writeFileSync(path.join(opts.keepLogs, `${kind}-${phase}.stdout.jsonl`), redactor.redact(p.stdout));
      fs.writeFileSync(path.join(opts.keepLogs, `${kind}-${phase}.stderr.txt`), redactor.redact(p.stderr));
    }
    const own = [...p.stdout.matchAll(TOKEN_RE)].length + [...p.stderr.matchAll(TOKEN_RE)].length;
    return { p, parsed, own, bridge: bridgeSummary(bridgeLog.slice(idx)), analysis: analyse(parsed.steps, parsed.texts) };
  };

  try {
    const main = await exec('main', PROMPTS.main, null);
    res.runs.main = main;
    res.runs.main.outcome = await verify(env, handle, qid);
    if (kind === 'codex') { rec.threadId = main.parsed.threadId; if (rec.threadId) rec.ids.push(rec.threadId); }
    const resumeId = kind === 'claude' ? sessionId : rec.threadId;

    // The admin rotates the token; the agent's environment still holds the old one, as a long-lived harness's would.
    const before = (await verify(env, handle, 0)).channel.length;
    await env.post('ada', '#chat', `@${handle} thanks. When you are done for the day, please say so here. (ref nonce-${nonce}d)`);
    const rot = await env.api('flan', 'POST', `/v1/members/${handle}/token`);
    if (rot.status !== 201 || !rot.body?.token) throw new Error(`rotation answered ${rot.status}`);
    const newToken = rot.body.token;
    redactor.add(newToken);
    const oldStatus = (await env.api(token, 'GET', '/v1/me')).status;
    const newStatus = (await env.api(newToken, 'GET', '/v1/me')).status;
    res.rotation = { oldStatus, newStatus };
    if (!resumeId && !opts.dryRun) {
      res.runs.rotation = { skipped: 'the first run gave no session id to resume' };
    } else {
      const rotation = await exec('rotation', PROMPTS.rotation, resumeId);
      res.runs.rotation = rotation;
      const after = (await verify(env, handle, 0)).channel.length;
      rotation.newPosts = after - before;
    }

    // What the harness kept: search every file that changed during this agent's runs, from this process's memory.
    const after = snapshotAll(state.scratch);
    const changed = changedPaths(rec.before, after);
    const needles = [
      { label: 'token', text: token }, { label: 'first12', text: token.slice(0, 12) },
      { label: 'rotated', text: newToken }, { label: 'rotated12', text: newToken.slice(0, 12) },
      { label: 'control', text: res.control },
    ];
    const extras = [path.join(REAL_HOME, '.claude.json')].filter((f) => fs.existsSync(f));
    const files = [...new Set([...changed, ...extras])];
    res.scan = { before: scanFiles(files, needles), files: files.length, changed: changed.length };
    res.needles = needles;
    res.cleanup = await cleanupRecords(ctx, rec, env1);
    const rest = [...new Set([...files.filter((f) => fs.existsSync(f))])];
    res.scan.afterCleanup = scanFiles(rest, [...needles, ...rec.ids.map((id, i) => ({ label: `sessionid${i}`, text: id }))]);
  } finally {
    res.bridgeLogTail = bridgeLog.length;
  }
  return res;
}

/** Deletes the session records THIS run created (new paths named after its stamp or session ids), by its own ids only. */
async function cleanupRecords(ctx, rec, env) {
  if (rec.cleaned) return rec.cleanup;
  rec.cleaned = true;
  const { state } = ctx;
  const removed = [];
  const notes = [];
  if (rec.kind === 'codex' && rec.threadId) {
    // `delete` refuses to ask for confirmation without a terminal; --force with an exact UUID is its documented form.
    const r = await runProcess(state, { cmd: which('codex', process.env.PATH), args: ['delete', '--force', rec.threadId], env, cwd: REAL_HOME, timeoutMs: 60000 });
    notes.push(`codex delete --force exit ${r.code}${r.error ? ` (${r.error})` : ''}: ${clip(`${r.stdout} ${r.stderr}`.replaceAll(rec.threadId, `${rec.threadId.slice(0, 8)}...`), 100)}`);
  }
  const after = snapshotAll(state.scratch);
  for (const root of harnessRoots()) {
    for (const p of ownedPrefixes(root, rec.before, after, [rec.stamp, ...rec.ids])) {
      try { fs.rmSync(p, { recursive: true, force: true }); removed.push(display(p)); } catch (e) { notes.push(`could not remove ${display(p)} (${e.code})`); }
    }
  }
  // Other sessions on this machine (the caller's own among them) create files meanwhile, so this is a list to read, not a verdict.
  const keep = ctx.opts.keepLogs;
  const leftover = [...after.keys()].filter((p) => !rec.before.has(p) && fs.existsSync(p) && !(keep && p.startsWith(keep + path.sep))).map(display);
  const brief = [...new Set(leftover.map((p) => p.split('/').slice(0, 4).join('/')))].slice(0, 8);
  rec.cleanup = { removed: [...new Set(removed)], notes, leftoverNew: leftover.length, leftoverWhere: brief };
  return rec.cleanup;
}

// ---------------------------------------------------------------------------------------------------------------
// Report

function column(r, phase) {
  const run = r.runs?.[phase];
  if (r.blocked) return { blocked: r.blocked };
  if (!run) return { blocked: 'not run' };
  if (run.skipped) return { blocked: run.skipped };
  return run;
}

function renderReport(results, meta) {
  const heads = ['observation'];
  const cols = [];
  for (const r of results) for (const phase of ['main', 'rotation']) { heads.push(`${r.kind} ${phase}`); cols.push([r, phase, column(r, phase)]); }
  const row = (label, f) => [label, ...cols.map(([r, phase, c]) => (c.blocked ? (label === 'status' ? `blocked: ${c.blocked}` : '-') : (() => { try { return f(c, r, phase) ?? '-'; } catch (e) { return `(${e.message})`; } })()))];
  const rows = [
    row('status', (c) => (c.p.dry ? 'dry run (agent not started)' : c.p.timedOut ? 'timed out' : c.p.error ? `could not start (${c.p.error})` : `exit ${c.p.code}, ${Math.round(c.p.ms / 1000)} s`)),
    row('model, session', (c, r) => (r.kind === 'claude' ? `${c.parsed.init?.model ?? '?'}, ${clip(c.parsed.init?.sessionId ?? '?', 8)}` : `${meta.codexModel}, ${clip(c.parsed.threadId ?? '?', 8)}`)),
    row('skills the agent could see', (c, r) => (r.kind === 'claude' ? `${c.parsed.init?.skills?.length ?? '?'} (${SKILL_NAME}: ${c.parsed.init?.skills?.includes(SKILL_NAME) ? 'yes' : 'NO'}; user's chatter: ${c.parsed.init?.skills?.includes('chatter') ? 'yes' : 'no'})` : 'see runbook (not in the event stream)')),
    row('how it loaded the skill', (c) => c.analysis.loadedVia ?? 'never read SKILL.md'),
    row('used the other (global) chatter skill', (c) => (c.analysis.wrongSkill ? 'YES' : 'no')),
    row('script path form', (c) => c.analysis.forms.join('; ') || '-'),
    row('member commands, in order', (c) => callSummary(c.analysis.calls)),
    row('--after used / highest id read, highest id of its own posts (both runs so far)', (c, r, phase) => {
      const a = c.analysis.calls.filter((x) => x.after).map((x) => x.after);
      const prior = phase === 'rotation' ? r.runs.main.analysis : { maxRead: 0, maxOwn: 0 };
      return `${a.length ? a.join(', ') : 'not used'} / ${Math.max(prior.maxRead, c.analysis.maxRead) || 'none'}, ${Math.max(prior.maxOwn, c.analysis.maxOwn) || 'none'}`;
    }),
    row('watch', (c) => (c.analysis.calls.some((x) => x.sub === 'watch') ? 'RAN (never exits)' : 'not run')),
    row('failed commands', (c) => c.analysis.failures.join(' || ') || 'none'),
    row('other tool calls', (c) => c.analysis.other.slice(0, 6).join(' || ') || 'none'),
    row('permission denials', (c) => String(c.parsed.result?.denials?.length ?? 'n/a')),
    row('bridge saw (status)', (c) => c.bridge),
    row('posts in #chat / DMs to ada', (c, r, phase) => (phase === 'main' ? `${c.outcome.channel.length} / ${c.outcome.dms.length}; reply has 42: ${c.outcome.replyOk ? 'yes' : 'NO'}` : `${c.newPosts} new post(s) after rotation`)),
    row('token in the agent\'s own output', (c) => (c.own ? `${c.own} bridge-token-shaped string(s)` : '0')),
    row('agent\'s last message', (c) => clip(c.analysis.finalText, 200)),
    row('cost / turns', (c, r) => (r.kind === 'claude' ? `${c.parsed.result?.costUsd != null ? `$${Number(c.parsed.result.costUsd).toFixed(3)}` : '?'} / ${c.parsed.result?.turns ?? '?'}` : `${c.parsed.usage ? `in ${c.parsed.usage.input_tokens}, cached ${c.parsed.usage.cached_input_tokens ?? 0}, out ${c.parsed.usage.output_tokens}` : 'tokens ?'} / ${c.parsed.steps.length} steps`)),
  ];
  const out = [`standard-agent run, ${meta.when}: node ${process.version}, claude ${meta.claudeVersion}, codex ${meta.codexVersion}`, '', mdTable(heads, rows), ''];
  for (const r of results) {
    if (r.blocked || !r.scan) continue;
    out.push(`Rotation: old token ${r.rotation.oldStatus} (expected 401), new token ${r.rotation.newStatus} (expected 200).`);
    out.push(`What ${r.kind}'s harness kept (counts only; ${r.scan.files} files that changed during its runs, ${r.scan.before.scanned} readable, ${r.scan.before.skipped.length} skipped; "control" is a string from a message the agent read, proving the file holds transcripts in a searchable form; "rotated" is a token the agent never held):`);
    const rowsScan = r.scan.before.hits.map((h) => {
      const after = r.scan.afterCleanup.hits.find((x) => x.file === h.file);
      const fmt = (c) => `${c.token}/${c.first12}/${c.rotated}+${c.rotated12}/${c.control}`;
      return [display(h.file), `${(h.size / 1024).toFixed(0)} KB`, fmt(h.counts), after ? fmt(after.counts) : (fs.existsSync(h.file) ? '0/0/0+0/0' : 'deleted')];
    });
    out.push(rowsScan.length ? mdTable(['file', 'size', 'before cleanup: token/first12/rotated+rotated12/control', 'after cleanup'], rowsScan) : '(no file matched)');
    // This script's own --keep-logs files name the session ids too; they are not the harness's records.
    const idLeft = r.scan.afterCleanup.hits.filter((h) => !(meta.keepLogs && h.file.startsWith(meta.keepLogs + path.sep)) && Object.entries(h.counts).some(([k, v]) => k.startsWith('sessionid') && v)).map((h) => display(h.file));
    out.push(`Cleanup: removed ${r.cleanup.removed.length} path(s) [${r.cleanup.removed.map((p) => p.replace(/^(~\/\.claude\/projects\/).*(agent-run-\w+-\w+)/, '$1...$2...')).join(', ') || 'none'}]; ${r.cleanup.notes.join('; ') || 'no notes'}; other new paths since the run began: ${r.cleanup.leftoverNew}${r.cleanup.leftoverWhere?.length ? ` (under ${r.cleanup.leftoverWhere.join(', ')})` : ''}; session id still referenced in: ${idLeft.join(', ') || 'nowhere'}.`, '');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Teardown and main

async function doTeardown(ctx) {
  const { state, redactor } = ctx;
  const rows = [];
  for (const pid of state.pids) killGroup(pid, 'SIGKILL');
  const urls = [];
  const ports = [];
  for (const env of state.bridges) {
    urls.push(env.base);
    ports.push(Number(new URL(env.base).port));
    try { await Promise.race([env.stop(), new Promise((_, rej) => setTimeout(() => rej(new Error('stop timed out')), 10000))]); } catch (e) { rows.push(`bridge stop: ${e.message}`); }
  }
  const envIn = agentEnv({});
  for (const rec of state.records) { try { await cleanupRecords(ctx, rec, envIn); } catch (e) { rows.push(`cleanup: ${e.message}`); } }
  if (state.scratch) fs.rmSync(state.scratch, { recursive: true, force: true });
  await new Promise((r) => setTimeout(r, 300));
  const leftoverProcs = urls.flatMap((u) => processesNaming(`CHATTER_BRIDGE_URL=${u}`));
  const openPorts = [];
  for (const p of ports) if (await portOpen(p)) openPorts.push(p);
  const herdrAfter = herdrCount();
  let remainingRecords = 0;
  const nowAll = snapshotAll(state.scratch);
  for (const rec of state.records) for (const root of harnessRoots()) remainingRecords += ownedPrefixes(root, rec.before, nowAll, [rec.stamp, ...rec.ids]).length;
  const check = {
    'processes with a throwaway bridge URL in their environment': leftoverProcs.length,
    'throwaway bridge ports still open': openPorts.length,
    'scratch directory removed': state.scratch ? !fs.existsSync(state.scratch) : true,
    'herdr processes (before / after)': `${state.herdrBefore} / ${herdrAfter}`,
    'HERDR_* variables in this process': Object.keys(process.env).filter((k) => k.startsWith('HERDR_')).length,
    'session records of this run still on disk (new, named after its stamp or session ids)': remainingRecords,
  };
  const ok = leftoverProcs.length === 0 && openPorts.length === 0 && (!state.scratch || !fs.existsSync(state.scratch)) && state.herdrBefore === herdrAfter && remainingRecords === 0 && rows.length === 0;
  return { ok, rows, check: Object.entries(check).map(([k, v]) => [k, String(v)]), redactor };
}

export async function main(argv) {
  const opts = parseArgs(argv);
  const redactor = new Redactor();
  const state = { scratch: null, bridges: [], pids: new Set(), records: [], herdrBefore: -1 };
  const ctx = { opts, redactor, state, log: (m) => process.stderr.write(`${redactor.redact(m)}\n`) };
  let teardown = null;
  const teardownOnce = () => (teardown ??= doTeardown(ctx));
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { teardownOnce().finally(() => process.exit(130)); });

  let exitCode = 0;
  const results = [];
  const meta = { when: new Date().toISOString(), codexModel: opts.codexModel, keepLogs: opts.keepLogs, claudeVersion: '?', codexVersion: '?' };
  try {
    const bad = Object.keys(process.env).filter((k) => k.startsWith('HERDR_') || (k.startsWith('CHATTER_') && k !== 'CHATTER_JS'));
    if (bad.length) throw Object.assign(new Error(`refusing to start with ${bad.join(', ')} set: they could point a child at a real state directory; unset them`), { exitCode: 2 });
    if (!process.env.CHATTER_JS || !fs.existsSync(process.env.CHATTER_JS)) throw Object.assign(new Error('set CHATTER_JS to a Chatter checkout\'s dist/bin/chatter.js (as for npm test)'), { exitCode: 2 });
    if (!fs.existsSync(path.join(SKILL_SRC, 'SKILL.md'))) throw Object.assign(new Error('skills/chatter-gui/SKILL.md not found'), { exitCode: 2 });
    const probe = agentEnv({});
    for (const forbidden of ['chatter', 'herdr']) if (which(forbidden, probe.PATH)) throw Object.assign(new Error(`${forbidden} is on the agent PATH (${which(forbidden, probe.PATH)})`), { exitCode: 2 });
    state.herdrBefore = herdrCount();
    fs.mkdirSync(opts.scratch, { recursive: true });
    state.scratch = fs.mkdtempSync(path.join(opts.scratch, 'agent-run-'));
    process.env.TMPDIR = state.scratch; // makeEnv's mkdtemp then lands in the scratch directory too
    for (const k of ['claude', 'codex']) { const b = which(k, process.env.PATH); try { meta[`${k}Version`] = b ? execFileSync(b, ['--version'], { env: probe, encoding: 'utf8', timeout: 20000 }).trim().split('\n')[0] : 'missing'; } catch { meta[`${k}Version`] = '?'; } }
    for (const kind of opts.agents) {
      try { results.push(await runAgent(ctx, kind)); } catch (e) { results.push({ kind, blocked: `harness error: ${e.message}`, runs: {} }); exitCode = 1; }
    }
  } catch (e) {
    process.stderr.write(`${redactor.redact(e.message)}\n`);
    exitCode = e.exitCode ?? 1;
  } finally {
    const t = await teardownOnce();
    if (!t.ok) exitCode = exitCode || 1;
    const text = results.length ? renderReport(results, meta) : '(no agent ran)';
    process.stdout.write(`${redactor.redact(text)}\n\nTeardown ${t.ok ? 'passed' : 'FAILED'}:\n${redactor.redact(mdTable(['check', 'result'], t.check))}\n${t.rows.length ? `${redactor.redact(t.rows.join('\n'))}\n` : ''}`);
  }
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { process.stderr.write(`unexpected failure: ${e?.name ?? 'Error'}\n`); process.exit(1); });
}
