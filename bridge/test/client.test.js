// The member CLI against a live bridge (real Chatter CLI underneath), and against small fake bridges for the
// failures a real one does not produce on demand (a proxy page, a split character, a stream that drops).
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { haveChatter, makeEnv } from './helpers.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'clients', 'chatter-member.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The client's own settings must never leak in from the developer's shell, or a real token would be sent to a fake. */
const cleanEnv = (extra = {}) => {
  const base = { ...process.env };
  for (const k of ['CHATTER_BRIDGE_URL', 'CHATTER_BRIDGE_TOKEN', 'CHATTER_BRIDGE_REPO', 'CHATTER_JSON']) delete base[k];
  return { ...base, ...extra };
};

/**
 * Runs the client to the end. The timeout kills a client that retries for ever, so that it fails its test
 * instead of hanging the suite. Nothing here puts the captured output into an assertion message: on the
 * untouched script that output can hold the token under test.
 */
const runCli = (env, args, timeout = 10000) => new Promise((resolve) => {
  execFile(process.execPath, [CLI, ...args], { env: cleanEnv(env), timeout }, (err, stdout, stderr) => {
    resolve({ code: err ? (err.killed ? 'timeout' : err.code) : 0, stdout, stderr });
  });
});

/** A client that never ends by itself (watch): collects what it prints until stopped. */
function startCli(env, args) {
  const child = spawn(process.execPath, [CLI, ...args], { env: cleanEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
  const seen = { out: '', err: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { seen.out += d; });
  child.stderr.on('data', (d) => { seen.err += d; });
  const exited = new Promise((r) => child.once('exit', r));
  return { seen, async stop() { child.kill(); await exited; } };
}

async function waitFor(what, pred, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** True if any six characters in a row of the token show up in the text. */
const leaks = (text, token) => {
  for (let i = 0; i + 6 <= token.length; i++) if (text.includes(token.slice(i, i + 6))) return true;
  return false;
};

/** A fake bridge on a random port. `requests` records the path and Last-Event-ID, never a credential. */
async function fakeBridge(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, lastEventId: req.headers['last-event-id'] });
    handler(req, res, requests.length);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); }),
  };
}

async function withBridge(handler, fn) {
  const b = await fakeBridge(handler);
  try { return await fn(b); } finally { await b.close(); }
}

const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const startSse = (res) => {
  res.socket.setNoDelay(true);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  res.flushHeaders();
};
const helloEvent = (epoch, maxId) => `event: hello\ndata: ${JSON.stringify({ epoch, max_id: maxId })}\n\n`;
const messageEvent = (id, body) => `id: ${id}\nevent: message\ndata: ${JSON.stringify({
  id, from: 'ada', to: '#chat', body, kind: 'message', ref_id: null, created_at: '2026-10-12T10:00:00.000Z', mentions: [], everyone: false,
})}\n\n`;

// Throwaway values that belong to no one. Both halves are distinctive so that a leak of either half is seen.
const LEFT = 'cb_TESTONLYleftqzvk';
const RIGHT = 'TESTONLYrightwxyj';
const GOOD_TOKEN = 'cb_TESTONLYgoodtokenhfdsa';

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

  // G2 round 6, finding 5. The bridge's stream keeps its own cursor from Last-Event-ID, so a watcher that
  // reconnects with the old, higher id hears nothing from the new database until it passes that id.
  test('watch carries on after the repo\'s database was recreated', async () => {
    const x = await makeEnv();
    let w;
    try {
      x.addMember('ezra');
      w = startCli({ CHATTER_BRIDGE_URL: x.base, CHATTER_BRIDGE_TOKEN: x.tokens.ezra, CHATTER_BRIDGE_REPO: x.key }, ['watch']);
      const streaming = () => x.app.bridge.watchers.get(x.key)?.subs.size === 1;
      await waitFor('the first stream', streaming);
      // Posted by the admin through the CLI, which has no rate limit, so that the old ids stay above every id
      // that the new database will hand out before the assertion.
      for (let i = 0; i < 8; i++) {
        const r = await x.host.run({ handle: 'flan', cwd: x.repo, args: ['post', `old ${i}`] });
        assert.equal(r.code, 0);
      }
      await waitFor('the old messages', () => w.seen.out.includes('old 7'));
      const oldCursor = Number(/#(\d+) [^\n]*old 7/.exec(w.seen.out)[1]);

      const purge = await x.host.run({ handle: 'flan', cwd: x.repo, args: ['purge', x.key, '--yes'] });
      assert.equal(purge.code, 0, purge.stderr);
      const again = await x.host.run({ handle: 'flan', cwd: x.repo, args: ['post', 'fresh start'] });
      assert.equal(again.code, 0, again.stderr);
      await x.host.repos({ fresh: true });

      // The bridge ends the old stream with `bye epoch` and the client reconnects 2 s later. A message posted
      // before the new hello is at or below its max_id and skipped by design, so post only once the second
      // stream is open.
      await waitFor('the first stream to end', () => !streaming(), 10000);
      await waitFor('the second stream', streaming, 10000);
      const posted = await x.post('flan', '#chat', 'after the rebuild');
      assert.equal(posted.status, 201);
      await waitFor('the message from the new database', () => w.seen.out.includes('after the rebuild'), 6000);
      const id = Number(/#(\d+) [^\n]*after the rebuild/.exec(w.seen.out)[1]);
      assert.ok(id < oldCursor, 'the new id must be below the old cursor, or this test proves nothing');
      assert.ok(/may have been missed/.test(w.seen.err), 'the reader should be told that messages may have been missed');
      assert.ok(/read --limit/.test(w.seen.err), 'the reader should be told how to catch up');
    } finally {
      await w?.stop();
      await x.stop();
    }
  });
});

// G2 round 6, finding 4: nothing the script prints may hold the token, or a URL with credentials.
describe('chatter-member CLI refuses a token it cannot send safely', () => {
  const BAD_TOKENS = [
    ['a line break inside', `${LEFT}\n${RIGHT}`],
    ['a line break then a single X', `${LEFT}\nX`],
    ['a space inside', `${LEFT} ${RIGHT}`],
    ['a tab inside', `${LEFT}\t${RIGHT}`],
    ['a control character inside', `${LEFT}\u0007${RIGHT}`],
    ['a line break at the end', `${LEFT}${RIGHT}\n`],
    ['a non-ASCII character inside', `${LEFT}é${RIGHT}`],
    ['more than 512 characters', `${LEFT}${'a'.repeat(600)}${RIGHT}`],
  ];
  let bridge;
  before(async () => { bridge = await fakeBridge((req, res) => json(res, 200, { handle: 'ada', kind: 'human', role: 'member' })); });
  after(async () => { await bridge.close(); });

  for (const [label, token] of BAD_TOKENS) {
    for (const cmd of ['whoami', 'watch']) {
      test(`${cmd} with ${label}: exit 2, nothing of it printed, no request`, async () => {
        const seenBefore = bridge.requests.length;
        const r = await runCli({ CHATTER_BRIDGE_URL: bridge.base, CHATTER_BRIDGE_TOKEN: token, CHATTER_BRIDGE_REPO: 'k' }, [cmd], 3000);
        assert.equal(r.code, 2);
        assert.ok(!leaks(r.stdout + r.stderr, token), 'the output repeated part of the token');
        assert.equal(bridge.requests.length, seenBefore, 'a request was made');
      });
    }
  }

  test('the refusal names the variable', async () => {
    const r = await runCli({ CHATTER_BRIDGE_URL: bridge.base, CHATTER_BRIDGE_TOKEN: `${LEFT}\n${RIGHT}` }, ['whoami'], 3000);
    assert.ok(/CHATTER_BRIDGE_TOKEN/.test(r.stderr), 'the message should name CHATTER_BRIDGE_TOKEN');
  });

  test('a missing token or address is still a configuration error, and usage needs no configuration', async () => {
    const noToken = await runCli({ CHATTER_BRIDGE_URL: bridge.base }, ['whoami'], 3000);
    assert.equal(noToken.code, 2);
    assert.match(noToken.stderr, /set CHATTER_BRIDGE_URL and CHATTER_BRIDGE_TOKEN/);
    const noUrl = await runCli({ CHATTER_BRIDGE_TOKEN: GOOD_TOKEN }, ['whoami'], 3000);
    assert.equal(noUrl.code, 2);
    const usage = await runCli({}, [], 3000);
    assert.equal(usage.code, 0);
    assert.match(usage.stdout, /chatter-member <command>/);
  });

  test('a good token is sent, as a bearer header', async () => {
    let auth = null;
    await withBridge((req, res) => { auth = req.headers.authorization; json(res, 200, { handle: 'ada', kind: 'human', role: 'member' }); }, async (b) => {
      const r = await runCli({ CHATTER_BRIDGE_URL: b.base, CHATTER_BRIDGE_TOKEN: GOOD_TOKEN }, ['whoami'], 5000);
      assert.equal(r.code, 0);
      assert.equal(auth === `Bearer ${GOOD_TOKEN}`, true);
    });
  });

  test('an address with a user name and password is refused before any request, and not printed', async () => {
    const password = 'TESTONLYpwqzvkd';
    await withBridge((req, res) => json(res, 200, {}), async (b) => {
      const url = b.base.replace('http://', `http://user:${password}@`);
      for (const cmd of ['whoami', 'watch']) {
        const r = await runCli({ CHATTER_BRIDGE_URL: url, CHATTER_BRIDGE_TOKEN: GOOD_TOKEN, CHATTER_BRIDGE_REPO: 'k' }, [cmd], 3000);
        assert.equal(r.code, 2);
        assert.ok(!(r.stdout + r.stderr).includes(password), 'the output repeated the password');
        assert.ok(/CHATTER_BRIDGE_URL/.test(r.stderr), 'the message should name CHATTER_BRIDGE_URL');
      }
      assert.equal(b.requests.length, 0);
    });
  });

  test('an address that is not a URL is a configuration error', async () => {
    const r = await runCli({ CHATTER_BRIDGE_URL: 'not a url', CHATTER_BRIDGE_TOKEN: GOOD_TOKEN }, ['whoami'], 3000);
    assert.equal(r.code, 2);
    assert.ok(/CHATTER_BRIDGE_URL/.test(r.stderr), 'the message should name CHATTER_BRIDGE_URL');
  });
});

describe('chatter-member CLI failures print fixed text', () => {
  const cfg = (b) => ({ CHATTER_BRIDGE_URL: b.base, CHATTER_BRIDGE_TOKEN: GOOD_TOKEN, CHATTER_BRIDGE_REPO: 'k' });

  test('an unexpected failure prints the error\'s name only, no message, cause or stack', async () => {
    await withBridge((req) => req.socket.destroy(), async (b) => {
      const r = await runCli(cfg(b), ['whoami']);
      assert.equal(r.code, 1);
      assert.ok(/unexpected failure \(TypeError\)/.test(r.stderr), 'expected the fixed text with the error name');
      assert.ok(!/fetch failed|cause|\n\s+at /.test(r.stderr), 'the message, the cause or a stack was printed');
    });
  });

  test('an answer of the wrong shape does not print the exception text', async () => {
    await withBridge((req, res) => json(res, 200, { repo: 'k', messages: [{ id: 1 }] }), async (b) => {
      const r = await runCli(cfg(b), ['read']);
      assert.equal(r.code, 1);
      assert.ok(/unexpected failure \(TypeError\)/.test(r.stderr), 'expected the fixed text with the error name');
      assert.ok(!/Cannot read|\n\s+at /.test(r.stderr), 'the exception text or a stack was printed');
    });
  });

  // Node's JSON.parse error quotes the text it could not parse, which is data from the bridge.
  test('the watch retry line prints the error\'s name, not its message', async () => {
    await withBridge((req, res) => {
      startSse(res);
      res.write('event: message\ndata: {"x": TESTONLYmarkerqzv\n\n');
    }, async (b) => {
      const w = startCli(cfg(b), ['watch']);
      try {
        await waitFor('the retry line', () => /stream dropped/.test(w.seen.err));
        assert.ok(/stream dropped \(SyntaxError\); retrying/.test(w.seen.err), 'expected the fixed text with the error name');
        assert.ok(!w.seen.err.includes('TESTONLYmarkerqzv'), 'the retry line repeated the message');
      } finally { await w.stop(); }
    });
  });

  for (const [label, body] of [['an HTML page', '<html>a proxy page</html>'], ['an empty body', ''], ['a JSON null', 'null']]) {
    for (const cmd of ['whoami', 'repos']) {
      test(`${cmd}: a successful answer that is ${label} is a fixed error`, async () => {
        await withBridge((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(body); }, async (b) => {
          const r = await runCli(cfg(b), [cmd]);
          assert.equal(r.code, 3);
          assert.ok(/not JSON/.test(r.stderr), 'expected the fixed text');
          assert.equal(r.stdout, '');
        });
      });
    }
  }

  test('an error answer that is not JSON still reports its status', async () => {
    await withBridge((req, res) => { res.writeHead(502, 'Bad Gateway', { 'Content-Type': 'text/html' }); res.end('<html>nginx</html>'); }, async (b) => {
      const r = await runCli(cfg(b), ['whoami']);
      assert.equal(r.code, 3);
      assert.match(r.stderr, /502/);
    });
  });
});

describe('chatter-member watch against a fake stream', () => {
  const cfg = (b) => ({ CHATTER_BRIDGE_URL: b.base, CHATTER_BRIDGE_TOKEN: GOOD_TOKEN, CHATTER_BRIDGE_REPO: 'k' });

  // G2 round 6, finding 6. The text is cut inside a two-byte character and inside a four-byte one, each time
  // with a pause long enough that the client reads the pieces as separate chunks.
  test('a character split across two network chunks arrives whole', async () => {
    const text = 'café \u{1F600} \u{1F680} end';
    const event = Buffer.from(messageEvent(1, text));
    const cuts = [];
    for (const ch of ['é', '\u{1F600}', '\u{1F680}']) {
      const at = event.indexOf(Buffer.from(ch));
      for (let k = 1; k < Buffer.byteLength(ch); k++) cuts.push(at + k);
    }
    cuts.sort((a, b) => a - b);
    assert.ok(cuts.length >= 4, 'the test must cut inside both kinds of character');

    await withBridge((req, res) => {
      startSse(res);
      res.write(helloEvent('e1', 0));
      (async () => {
        let from = 0;
        for (const cut of [...cuts, event.length]) {
          await sleep(60);
          res.write(event.subarray(from, cut));
          from = cut;
        }
      })();
    }, async (b) => {
      const w = startCli(cfg(b), ['watch']);
      try {
        await waitFor('the message', () => w.seen.out.includes('end'));
        assert.equal(w.seen.out.includes(text), true, 'the text was corrupted');
        assert.equal(w.seen.out.includes('�'), false, 'a replacement character was printed');
      } finally { await w.stop(); }
    });
  });

  // G2 round 6, finding 5, the path without a bye: the database was recreated while the watcher was away, so
  // the new stream says so in its hello. That connection keeps the old, higher id as its own cursor on the
  // server, so the client must reconnect without it, not only forget it.
  test('a hello from another epoch resets the cursor and reconnects without it', async () => {
    await withBridge((req, res, n) => {
      startSse(res);
      if (n === 1) { res.write(helloEvent('e1', 40) + messageEvent(41, 'first')); res.end(); return; }
      if (n === 2) { res.write(helloEvent('e2', 3)); return; }
      res.write(helloEvent('e2', 3) + messageEvent(4, 'after the reset'));
    }, async (b) => {
      const w = startCli(cfg(b), ['watch']);
      try {
        await waitFor('the first message', () => w.seen.out.includes('first'));
        await waitFor('the message from the new epoch', () => w.seen.out.includes('after the reset'), 10000);
        assert.equal(b.requests[1].lastEventId, '41', 'the first reconnect should resume from the last id seen');
        assert.equal(b.requests[2].lastEventId, undefined, 'the reconnect after the epoch changed must not carry the old id');
        assert.ok(/may have been missed/.test(w.seen.err), 'the reader should be told that messages may have been missed');
        assert.ok(/read --limit/.test(w.seen.err), 'the reader should be told how to catch up');
      } finally { await w.stop(); }
    });
  });

  // The hello check above would also mend a stale cursor, at the price of one more connection; the bye says
  // so first, so the reconnect after it already goes out without the old id.
  test('after a bye with reason epoch the reconnect carries no id, and the new hello sets the cursor', async () => {
    await withBridge((req, res, n) => {
      startSse(res);
      if (n === 1) { res.write(`${helloEvent('e1', 40)}${messageEvent(41, 'first')}event: bye\ndata: {"reason":"epoch"}\n\n`); res.end(); return; }
      if (n === 2) { res.write(helloEvent('e2', 3)); res.end(); return; }
      res.write(helloEvent('e2', 3));
    }, async (b) => {
      const w = startCli(cfg(b), ['watch']);
      try {
        await waitFor('the third connection', () => b.requests.length >= 3, 12000);
        assert.equal(b.requests[1].lastEventId, undefined);
        assert.equal(b.requests[2].lastEventId, '3', 'the cursor should come from the hello of the new epoch');
      } finally { await w.stop(); }
    });
  });

  test('the first hello sets the cursor, and a reconnect in the same epoch resumes from the last id', async () => {
    await withBridge((req, res, n) => {
      startSse(res);
      if (n === 1) { res.write(helloEvent('e1', 40) + messageEvent(41, 'first')); res.end(); return; }
      res.write(helloEvent('e1', 41) + messageEvent(42, 'second'));
    }, async (b) => {
      const w = startCli(cfg(b), ['watch']);
      try {
        await waitFor('the second message', () => w.seen.out.includes('second'), 10000);
        assert.equal(b.requests[0].lastEventId, undefined);
        assert.equal(b.requests[1].lastEventId, '41');
        assert.equal(/may have been missed/.test(w.seen.err), false, 'no notice without an epoch change');
      } finally { await w.stop(); }
    });
  });
});
