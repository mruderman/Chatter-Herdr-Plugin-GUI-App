// Unit tests of the pure parts of run-standard-agents.mjs. No agent, no bridge, no network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { analyse, countOccurrences, memberCalls, mdTable, ownedPrefixes, parseArgs, parseClaudeStream, parseCodexStream, pathForm, Redactor, scanFiles, snapshotTree } from './run-standard-agents.mjs';

const TOKEN = `cb_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v'}`;

test('the redactor removes a token, its 12-character prefix, its SHA-256 and any token-shaped string', () => {
  const r = new Redactor();
  r.add(TOKEN);
  const text = `a ${TOKEN} b ${TOKEN.slice(0, 12)} c cb_zzzzzzzzzzzzzzzzzzzzzzzz d`;
  const out = r.redact(text);
  assert.ok(!out.includes(TOKEN.slice(0, 12)));
  assert.ok(!/cb_[A-Za-z0-9_-]{16,}/.test(out));
  assert.equal(r.redact('nothing here'), 'nothing here');
});

test('scanFiles counts occurrences in text and binary files and lists unreadable ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-test-'));
  try {
    const a = path.join(dir, 'a.jsonl');
    const b = path.join(dir, 'b.sqlite');
    const c = path.join(dir, 'c.txt');
    fs.writeFileSync(a, `x ${TOKEN} y ${TOKEN} z`);
    fs.writeFileSync(b, Buffer.concat([Buffer.from([0, 1, 2, 255]), Buffer.from(TOKEN.slice(0, 12)), Buffer.from([0])]));
    fs.writeFileSync(c, 'clean');
    const r = scanFiles([a, b, c, path.join(dir, 'missing')], [{ label: 'token', text: TOKEN }, { label: 'first12', text: TOKEN.slice(0, 12) }]);
    assert.equal(r.scanned, 3);
    assert.equal(r.skipped.length, 1);
    assert.deepEqual(r.hits.map((h) => [path.basename(h.file), h.counts.token, h.counts.first12]), [['a.jsonl', 2, 2], ['b.sqlite', 0, 1]]);
    assert.equal(countOccurrences(Buffer.from('aaaa'), 'aa'), 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('only NEW paths named after the stamp or a session id are owned, at the shortest such prefix', () => {
  const root = '/h/.claude';
  const before = new Map([[`${root}/projects/-home-me-proj/old.jsonl`, '1:1'], [`${root}/session-env/old-uuid/x`, '1:1']]);
  const after = new Map(before);
  for (const p of [`${root}/projects/-tmp-agent-run-abc123-claude-project/s1.jsonl`, `${root}/projects/-tmp-agent-run-abc123-claude-project/memory/m.md`, `${root}/session-env/sid-1/env`, `${root}/shell-snapshots/snap.sh`, `${root}/projects/-home-me-proj/new-session.jsonl`]) after.set(p, '2:2');
  const owned = ownedPrefixes(root, before, after, ['agent-run-abc123', 'sid-1']).sort();
  assert.deepEqual(owned, [`${root}/projects/-tmp-agent-run-abc123-claude-project`, `${root}/session-env/sid-1`]);
  // A path under another root is not this root's, even when its name matches.
  const otherRoot = new Map(after);
  otherRoot.set('/h/.codex/sessions/sid-1/x', '2:2');
  assert.deepEqual(ownedPrefixes(root, before, otherRoot, ['agent-run-abc123', 'sid-1']).sort(), owned);
  // A pre-existing path that happens to match is never owned.
  const before2 = new Map([[`${root}/session-env/sid-1/env`, '1:1']]);
  assert.deepEqual(ownedPrefixes(root, before2, new Map(before2), ['sid-1']), []);
});

test('snapshotTree skips the named top-level directories', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-snap-'));
  try {
    fs.mkdirSync(path.join(dir, 'plugins'));
    fs.mkdirSync(path.join(dir, 'projects'));
    fs.writeFileSync(path.join(dir, 'plugins', 'x'), '1');
    fs.writeFileSync(path.join(dir, 'projects', 'y'), '1');
    assert.deepEqual([...snapshotTree(dir, new Set(['plugins'])).keys()].map((p) => path.basename(p)), ['y']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const claudeFixture = [
  { type: 'system', subtype: 'init', session_id: 'sid-1', model: 'claude-sonnet-5-5', tools: ['Bash', 'Read', 'Skill'], skills: ['chatter-gui', 'loop'], permissionMode: 'dontAsk' },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'chatter-gui' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Launching skill' }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'cd /p/.claude/skills/chatter-gui && node scripts/chatter-member.mjs read --limit 30' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: '#7 2026-10-13 10:00:00 ada -> #chat: hi' }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'node /p/.claude/skills/chatter-gui/scripts/chatter-member.mjs post "42"' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't3', is_error: true, content: [{ type: 'text', text: 'Exit code 3\nchatter-member: 401 bad_token: unknown token' }] }] } },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'The token was refused.' }] } },
  { type: 'result', subtype: 'success', num_turns: 4, total_cost_usd: 0.05, result: 'The token was refused.', session_id: 'sid-1' },
].map((e) => JSON.stringify(e)).join('\n');

test('Claude stream: steps pair with their results, exit codes and the session are read', () => {
  const p = parseClaudeStream(claudeFixture);
  assert.equal(p.init.sessionId, 'sid-1');
  assert.deepEqual(p.steps.map((s) => [s.tool, s.exit]), [['Skill', 0], ['Bash', 0], ['Bash', 3]]);
  assert.equal(p.result.costUsd, 0.05);
  const a = analyse(p.steps, p.texts);
  assert.equal(a.loadedVia, 'Skill tool');
  assert.deepEqual(a.calls.map((c) => c.sub), ['read', 'post']);
  assert.equal(a.maxRead, 7);
  assert.equal(a.failures.length, 1);
  assert.match(a.failures[0], /post exit 3: chatter-member: 401 bad_token/);
  assert.deepEqual(a.forms.sort(), ['absolute path', 'cd to the skill directory, then scripts/']);
});

test('Codex stream: commands, the thread id, usage and the last message are read', () => {
  const text = [
    { type: 'thread.started', thread_id: 'th-1' },
    { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: '/bin/bash -lc "sed -n 1,80p .agents/skills/chatter-gui/SKILL.md"', aggregated_output: '---', exit_code: 0 } },
    { type: 'item.completed', item: { id: 'i2', type: 'command_execution', command: 'node .agents/skills/chatter-gui/scripts/chatter-member.mjs read --after 7', aggregated_output: 'set CHATTER_BRIDGE_URL and CHATTER_BRIDGE_TOKEN', exit_code: 2 } },
    { type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'could not read' } },
    { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } },
  ].map((e) => JSON.stringify(e)).join('\n');
  const p = parseCodexStream(text);
  assert.equal(p.threadId, 'th-1');
  assert.equal(p.usage.output_tokens, 5);
  const a = analyse(p.steps, p.texts);
  assert.equal(a.loadedVia, 'reads SKILL.md with a shell command');
  assert.deepEqual(a.calls.map((c) => [c.sub, c.after, c.exit]), [['read', '7', 2]]);
  assert.equal(a.finalText, 'could not read');
});

test('memberCalls and pathForm', () => {
  assert.deepEqual(memberCalls('node a/chatter-member.mjs read --after 12 --mark && node a/chatter-member.mjs post "x; y"').map((c) => [c.sub, c.after, c.mark]), [['read', '12', true], ['post', null, false]]);
  assert.equal(pathForm('node scripts/chatter-member.mjs whoami'), 'scripts/... from the working directory');
  assert.equal(pathForm('node .agents/skills/chatter-gui/scripts/chatter-member.mjs whoami'), 'path from the project root');
  assert.equal(pathForm('echo hi'), null);
});

test('parseArgs and the table writer', () => {
  assert.deepEqual(parseArgs(['--agents', 'claude']).agents, ['claude']);
  assert.throws(() => parseArgs(['--agents', 'gemini']), /unknown agent/);
  assert.throws(() => parseArgs(['--nope']), /unknown argument/);
  assert.equal(mdTable(['a'], [['x|y']]).split('\n')[2], '| x\\|y |');
});
