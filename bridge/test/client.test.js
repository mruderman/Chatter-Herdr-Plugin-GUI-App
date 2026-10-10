// The member CLI against a live bridge (real Chatter CLI underneath).
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { haveChatter, makeEnv } from './helpers.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'clients', 'chatter-member.mjs');

describe('chatter-member CLI', { skip: !haveChatter && 'set CHATTER_JS to a built Chatter checkout' }, () => {
  let e;
  const env = (who) => ({ ...process.env, CHATTER_BRIDGE_URL: e.base, CHATTER_BRIDGE_TOKEN: e.tokens[who], CHATTER_BRIDGE_REPO: e.key });
  const run = (who, ...args) => new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: env(who) }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });

  before(async () => { e = await makeEnv(); e.addMember('grace'); e.addMember('ezra'); });
  after(async () => { await e.stop(); });

  test('whoami, post, read and dm round-trip', async () => {
    assert.match((await run('grace', 'whoami')).stdout, /grace \(computational, member\)/);
    const p = await run('grace', 'post', 'hello', 'from', 'the', 'CLI');
    assert.equal(p.code, 0, p.stderr);
    assert.match(p.stdout, /^posted #\d+/);
    const r = await run('ezra', 'read', '--limit', '5');
    assert.match(r.stdout, /grace -> #chat: hello from the CLI/);
    const dm = await run('grace', 'dm', 'ezra', 'just', 'for', 'you');
    assert.equal(dm.code, 0, dm.stderr);
    assert.match((await run('ezra', 'read', '--limit', '5')).stdout, /grace -> ezra: just for you/);
    const json = JSON.parse((await run('ezra', 'read', '--json', '--limit', '2')).stdout);
    assert.ok(Array.isArray(json.messages));
  });

  test('errors exit non-zero with the bridge\'s reason', async () => {
    const r = await run('grace', 'post', '@everyone', 'hi');
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /everyone_admin_only/);
    assert.notEqual((await run('grace', 'dm', 'nobody', 'x')).code, 0);
  });

  test('--mark moves the read pointer', async () => {
    const r = await run('ezra', 'read', '--mark', '--limit', '50');
    assert.equal(r.code, 0);
    const repos = JSON.parse((await run('ezra', 'repos', '--json')).stdout).repos;
    assert.ok(repos[0].last_read_id > 0);
  });

  test('watch streams new messages', async () => {
    const child = spawn(process.execPath, [CLI, 'watch'], { env: env('ezra') });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    await new Promise((r) => setTimeout(r, 600));
    await e.post('grace', '#chat', 'seen by watch');
    const t0 = Date.now();
    while (!out.includes('seen by watch') && Date.now() - t0 < 4000) await new Promise((r) => setTimeout(r, 50));
    child.kill();
    assert.match(out, /grace -> #chat: seen by watch/);
  });
});
