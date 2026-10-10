// Serving the built web client (T1, D15): path safety, the SPA fallback, headers, and proof that
// /healthz and /v1 answer exactly as they do without static serving.
// Requests go through http.request, which sends the path as written; fetch would normalise it first
// and the guards under test would never see the raw or dot-segment cases.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBridge } from '../src/server.js';
import { Store } from '../src/store.js';
import { haveChatter, makeEnv, openSse } from './helpers.js';

// D15, copied rather than imported so that editing static.js cannot move the expectation with it.
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const NAVIGATION = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'; // a browser's Accept on page loads
const SECRET = 'SENTINEL-must-never-be-served';
const INDEX = '<!doctype html><html lang="en"><title>Chatter</title><div id="app"></div></html>\n';
const NO_SUCH_ROUTE = '{"error":{"code":"not_found","message":"no such route"}}';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'chatter-bridge.js');

/** A static root, plus files outside it (and hidden inside it) that must never be served. */
function makeSite() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-static-'));
  const root = path.join(tmp, 'site');
  const put = (rel, body) => {
    const f = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  };
  put('site/index.html', INDEX);
  put('site/assets/app-3f2a.js', 'console.log("app");\n');
  put('site/assets/app-3f2a.css', 'body{margin:0}\n');
  put('site/assets/font-9c1d.woff2', Buffer.from([0x77, 0x4f, 0x46, 0x32]));
  put('site/app.mjs', 'export {};\n');
  put('site/data.json', '{"ok":true}\n');
  put('site/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
  put('site/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  put('site/favicon.ico', Buffer.from([0, 0, 1, 0]));
  put('site/manifest.webmanifest', '{"name":"Chatter"}\n');
  put('site/robots.txt', 'User-agent: *\n');
  put('site/blob.bin', Buffer.from([1, 2, 3]));
  put('site/LOUD.JS', 'void 0;\n');
  put('site/my file.txt', 'spaced\n');
  put('site/sub/index.html', 'SUBDIRECTORY-INDEX\n');
  put('site/.env', SECRET);
  put('site/.well-known/security.txt', SECRET);
  put('site/assets/.hidden.js', SECRET);
  put('site/v1/me', SECRET); // a file where the API lives
  put('secret.txt', SECRET); // the root's parent
  put('outside/secret.txt', SECRET);
  put('outside/inner/secret.txt', SECRET);
  put('site-evil/secret.txt', SECRET); // a sibling whose name starts with the root's name
  fs.symlinkSync(path.join(root, 'assets', 'app-3f2a.js'), path.join(root, 'linked.js'));
  fs.symlinkSync(path.join(tmp, 'outside', 'secret.txt'), path.join(root, 'escape.txt'));
  fs.symlinkSync(path.join(tmp, 'outside'), path.join(root, 'escape-dir'));
  fs.symlinkSync(path.join(tmp, 'outside', 'secret.txt'), path.join(root, 'escape-route'));
  fs.symlinkSync(path.join(tmp, 'site-evil', 'secret.txt'), path.join(root, 'sibling.txt'));
  return { tmp, root, bytes: (rel) => fs.readFileSync(path.join(root, rel)) };
}

/** One request with the path sent exactly as written. */
function hit(base, rawPath, { method = 'GET', headers = {} } = {}) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path: rawPath, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body, text: body.toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function assertSecurityHeaders(r, label = '') {
  assert.equal(r.headers['content-security-policy'], CSP, `${label} CSP`);
  assert.equal(r.headers['x-content-type-options'], 'nosniff', label);
  assert.equal(r.headers['referrer-policy'], 'no-referrer', label);
  assert.equal(r.headers['x-frame-options'], 'DENY', label);
}

function assertServed(r, body, type, cache, label = '') {
  assert.equal(r.status, 200, `${label} ${r.text}`);
  assert.deepEqual(r.body, Buffer.from(body), label);
  assert.equal(r.headers['content-type'], type, label);
  assert.equal(r.headers['cache-control'], cache, label);
  assert.equal(r.headers['content-length'], String(r.body.length), label);
  assertSecurityHeaders(r, label);
}

/** A refusal from the static handler: exact status, JSON error, static headers, nothing leaked. */
function assertRefused(r, status, label = '') {
  assert.equal(r.status, status, `${label} -> ${r.status} ${r.text}`);
  assert.ok(!r.text.includes(SECRET), `${label} leaked a file it must not serve`);
  assert.equal(r.headers['content-type'], 'application/json; charset=utf-8', label);
  assert.equal(JSON.parse(r.text).error.code, status === 400 ? 'bad_request' : 'not_found', label);
  assert.equal(r.headers['cache-control'], 'no-store', label);
  assert.equal(r.headers['content-length'], String(r.body.length), label);
  assertSecurityHeaders(r, label);
}

/** The same request against a bridge with and without static serving must give the same answer. */
async function assertUnchanged(withStatic, without, rawPath, opts = {}) {
  const label = `${opts.method ?? 'GET'} ${rawPath}`;
  const a = await hit(withStatic, rawPath, opts);
  const b = await hit(without, rawPath, opts);
  assert.equal(a.status, b.status, label);
  assert.equal(a.headers['content-type'], b.headers['content-type'], label);
  assert.equal(a.headers['cache-control'], b.headers['cache-control'], label);
  assert.equal(a.text, b.text, label);
  assert.equal(a.headers['content-security-policy'], undefined, `${label}: API answers carry no static headers`);
  return a;
}

describe('static web client', () => {
  let site;
  let store;
  let token;
  let app;
  let plain;
  let base;
  let plainBase;
  const host = { repos: async () => [], agentNames: async () => new Set() }; // enough for /healthz, /v1/me, /v1/directory
  const auth = (headers = {}) => ({ headers: { authorization: `Bearer ${token}`, ...headers } });

  before(async () => {
    site = makeSite();
    store = new Store(path.join(site.tmp, 'bridge.db'));
    store.addMember({ handle: 'flan', kind: 'human', role: 'admin' });
    token = store.issueToken('flan');
    app = createBridge({ store, host, staticDir: site.root });
    plain = createBridge({ store, host });
    base = `http://127.0.0.1:${(await app.listen(0)).port}`;
    plainBase = `http://127.0.0.1:${(await plain.listen(0)).port}`;
  });
  after(async () => {
    await app.close();
    await plain.close();
    store.close();
    fs.rmSync(site.tmp, { recursive: true, force: true });
  });

  test('/ and /index.html serve the app shell with the D15 CSP and security headers', async () => {
    assertServed(await hit(base, '/'), INDEX, 'text/html; charset=utf-8', 'no-cache', '/');
    assertServed(await hit(base, '/index.html'), INDEX, 'text/html; charset=utf-8', 'no-cache', '/index.html');
  });

  test('Content-Type follows the extension; anything unknown is application/octet-stream', async () => {
    const types = {
      '/assets/app-3f2a.js': 'text/javascript; charset=utf-8',
      '/app.mjs': 'text/javascript; charset=utf-8',
      '/LOUD.JS': 'text/javascript; charset=utf-8',
      '/assets/app-3f2a.css': 'text/css; charset=utf-8',
      '/data.json': 'application/json; charset=utf-8',
      '/icon.svg': 'image/svg+xml',
      '/logo.png': 'image/png',
      '/favicon.ico': 'image/x-icon',
      '/manifest.webmanifest': 'application/manifest+json',
      '/assets/font-9c1d.woff2': 'font/woff2',
      '/robots.txt': 'text/plain; charset=utf-8',
      '/blob.bin': 'application/octet-stream',
    };
    for (const [p, type] of Object.entries(types)) {
      const r = await hit(base, p);
      assert.equal(r.status, 200, p);
      assert.equal(r.headers['content-type'], type, p);
      assert.deepEqual(r.body, site.bytes(p.slice(1)), p);
      assertSecurityHeaders(r, p);
    }
  });

  test('cache: no-cache for the shell and plain files, immutable only for real files under /assets/', async () => {
    assertServed(await hit(base, '/assets/app-3f2a.js'), site.bytes('assets/app-3f2a.js'), 'text/javascript; charset=utf-8', IMMUTABLE);
    assertServed(await hit(base, '/robots.txt'), site.bytes('robots.txt'), 'text/plain; charset=utf-8', 'no-cache');
    assertServed(await hit(base, '/chat/general', { headers: { accept: NAVIGATION } }), INDEX, 'text/html; charset=utf-8', 'no-cache');
    assertServed(await hit(base, '/assets/', { headers: { accept: NAVIGATION } }), INDEX, 'text/html; charset=utf-8', 'no-cache');
    // A cached-forever 404 would outlive the next deploy.
    assertRefused(await hit(base, '/assets/missing-0000.js'), 404, '/assets/missing-0000.js');
  });

  test('HEAD answers with the headers GET would send and no body', async () => {
    const cases = [['/', {}], ['/assets/app-3f2a.js', {}], ['/robots.txt', {}], ['/chat/general', { accept: NAVIGATION }], ['/missing.js', {}], ['/%ZZ', {}]];
    for (const [p, headers] of cases) {
      const get = await hit(base, p, { headers });
      const head = await hit(base, p, { method: 'HEAD', headers });
      assert.equal(head.status, get.status, p);
      assert.equal(head.body.length, 0, p);
      for (const h of ['content-type', 'content-length', 'cache-control', 'content-security-policy', 'x-content-type-options', 'referrer-policy', 'x-frame-options']) {
        assert.equal(head.headers[h], get.headers[h], `${p} ${h}`);
      }
      assertSecurityHeaders(head, `HEAD ${p}`);
    }
  });

  test('the SPA fallback serves index.html only to HTML requests for extensionless paths', async () => {
    assertServed(await hit(base, '/chat/general', { headers: { accept: NAVIGATION } }), INDEX, 'text/html; charset=utf-8', 'no-cache');
    assertServed(await hit(base, '/chat/general', { headers: { accept: 'TEXT/HTML' } }), INDEX, 'text/html; charset=utf-8', 'no-cache');
    assertRefused(await hit(base, '/chat/general'), 404, 'no Accept');
    assertRefused(await hit(base, '/chat/general', { headers: { accept: '*/*' } }), 404, 'Accept */*');
    assertRefused(await hit(base, '/chat/general', { headers: { accept: 'application/json' } }), 404, 'Accept json');
    // A missing file with an extension is a 404, never the shell.
    assertRefused(await hit(base, '/assets/missing-0000.js', { headers: { accept: NAVIGATION } }), 404, 'missing .js');
    assertRefused(await hit(base, '/missing.html', { headers: { accept: NAVIGATION } }), 404, 'missing .html');
  });

  test('directories are never listed, and only / maps to an index.html', async () => {
    for (const p of ['/sub', '/sub/', '/assets', '/assets/']) {
      const r = await hit(base, p);
      assertRefused(r, 404, p);
      assert.ok(!r.text.includes('SUBDIRECTORY-INDEX') && !r.text.includes('app-3f2a'), `${p} listed or served a directory`);
    }
    assertServed(await hit(base, '/sub/', { headers: { accept: NAVIGATION } }), INDEX, 'text/html; charset=utf-8', 'no-cache', '/sub/ is the shell');
  });

  test('the path is percent-decoded once; a bad encoding is a 400', async () => {
    assertServed(await hit(base, '/my%20file.txt'), 'spaced\n', 'text/plain; charset=utf-8', 'no-cache');
    assertServed(await hit(base, '/assets/app%2D3f2a.js'), site.bytes('assets/app-3f2a.js'), 'text/javascript; charset=utf-8', IMMUTABLE);
    for (const p of ['/%ZZ', '/%E0%A4%A', '/%C0%AF', '/assets/%ff.js', '/%']) {
      assertRefused(await hit(base, p, { headers: { accept: NAVIGATION } }), 400, p);
    }
  });

  test('NUL and backslash are a 400, encoded or raw', async () => {
    for (const p of ['/%00', '/index.html%00.txt', '/%5c', '/%5C', '/assets%5capp-3f2a.js', '/..%5csecret.txt', '/assets\\app-3f2a.js', '/..\\secret.txt', '/..\\..\\secret.txt']) {
      assertRefused(await hit(base, p, { headers: { accept: NAVIGATION } }), 400, p);
    }
  });

  test('traversal cannot leave the root, whether encoded, double-encoded or raw', async () => {
    // An encoded slash hides ".." from the URL parser; after decoding it is a ".." segment.
    for (const p of ['/..%2fsecret.txt', '/..%2Fsecret.txt', '/assets/..%2f..%2fsecret.txt', '/%2e%2e%2fsecret.txt', '/..%2foutside%2fsecret.txt', '/x/..%2f..%2f..%2fsecret.txt']) {
      assertRefused(await hit(base, p), 400, p);
    }
    // Decoded once, a double-encoded ".." is just an odd file name that does not exist.
    for (const p of ['/%252e%252e/secret.txt', '/%252e%252e%252fsecret.txt', '/%252e%252e%252f%252e%252e%252fsecret.txt']) {
      assertRefused(await hit(base, p), 404, p);
    }
    // The URL parser resolves literal and %2e dot segments against the root before the bridge sees them.
    for (const p of ['/../secret.txt', '/../../secret.txt', '/%2e%2e/secret.txt', '/assets/../../secret.txt', '/../outside/secret.txt']) {
      assertRefused(await hit(base, p), 404, p);
    }
  });

  test('dotfiles and dot directories are a 404, even for HTML requests', async () => {
    assertServed(await hit(base, '/robots.txt'), site.bytes('robots.txt'), 'text/plain; charset=utf-8', 'no-cache');
    for (const p of ['/.env', '/%2eenv', '/.well-known/security.txt', '/assets/.hidden.js', '/.well-known']) {
      assertRefused(await hit(base, p), 404, p);
      assertRefused(await hit(base, p, { headers: { accept: NAVIGATION } }), 404, `${p} as HTML`);
    }
  });

  test('symlinks are followed only while they stay inside the root', async () => {
    assertServed(await hit(base, '/linked.js'), site.bytes('assets/app-3f2a.js'), 'text/javascript; charset=utf-8', 'no-cache');
    for (const p of ['/escape.txt', '/escape-dir/secret.txt', '/escape-dir/inner/secret.txt', '/sibling.txt']) {
      assertRefused(await hit(base, p), 404, p);
    }
    // An escape is a 404 even where the fallback would otherwise apply.
    assertRefused(await hit(base, '/escape-route', { headers: { accept: NAVIGATION } }), 404, '/escape-route');
    assertRefused(await hit(base, '/escape-dir', { headers: { accept: NAVIGATION } }), 404, '/escape-dir');
  });

  test('paths the API owns are never served from files or the fallback, even behind an encoded slash', async () => {
    assertRefused(await hit(base, '/v1%2fnope', { headers: { accept: NAVIGATION } }), 404, '/v1%2fnope');
    assertRefused(await hit(base, '/v1%2fme'), 404, '/v1%2fme');
    assertRefused(await hit(base, '/v1%2F', { headers: { accept: NAVIGATION } }), 404, '/v1%2F');
    assertRefused(await hit(base, '/healthz%2fx', { headers: { accept: NAVIGATION } }), 404, '/healthz%2fx');
  });

  test('/healthz and /v1 answer exactly as they do without static serving', async () => {
    const html = { accept: NAVIGATION };
    assert.equal((await assertUnchanged(base, plainBase, '/healthz')).status, 200);
    await assertUnchanged(base, plainBase, '/healthz', { method: 'HEAD' });
    await assertUnchanged(base, plainBase, '/healthz/', { headers: html });
    assert.equal((await assertUnchanged(base, plainBase, '/v1/me', { headers: html })).status, 401);
    assert.equal(JSON.parse((await assertUnchanged(base, plainBase, '/v1/me', auth(html))).text).handle, 'flan');
    await assertUnchanged(base, plainBase, '/v1/directory', auth(html));
    await assertUnchanged(base, plainBase, '/v1/me', { method: 'HEAD', ...auth() });
    await assertUnchanged(base, plainBase, '/%76%31/me', auth(html)); // route() decodes the first segment too
    await assertUnchanged(base, plainBase, '/v1/%ZZ', auth(html));
    for (const p of ['/v1/nope', '/v1', '/v1/', '/v1/repos/nope/nope']) {
      const r = await assertUnchanged(base, plainBase, p, auth(html));
      assert.equal(r.status, 404, p);
      assert.equal(r.text, NO_SUCH_ROUTE, p);
    }
  });

  test('other methods on non-API paths keep the JSON 404 they get today', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const p of ['/', '/index.html', '/assets/app-3f2a.js']) {
        const r = await assertUnchanged(base, plainBase, p, { method, headers: { accept: NAVIGATION } });
        assert.equal(r.status, 404, `${method} ${p}`);
        assert.equal(r.text, NO_SUCH_ROUTE, `${method} ${p}`);
      }
    }
    assert.equal((await assertUnchanged(base, plainBase, '/', { method: 'OPTIONS' })).status, 204);
  });

  test('without staticDir no file is served and / is the JSON 404 it is today', async () => {
    for (const p of ['/', '/index.html', '/assets/app-3f2a.js', '/chat/general']) {
      const r = await hit(plainBase, p, { headers: { accept: NAVIGATION } });
      assert.equal(r.status, 404, p);
      assert.equal(r.text, NO_SUCH_ROUTE, p);
      assert.equal(r.headers['content-type'], 'application/json; charset=utf-8', p);
      assert.equal(r.headers['cache-control'], 'no-store', p);
      assert.equal(r.headers['content-security-policy'], undefined, p);
    }
  });

  test('a client that disconnects mid-download is not a server error', async () => {
    const size = 32 * 1024 * 1024; // larger than loopback socket buffers, so the abort lands mid-stream
    const big = path.join(site.root, 'assets', 'big-0001.bin');
    fs.writeFileSync(big, Buffer.alloc(size, 1));
    const logs = [];
    const watched = createBridge({ store, host, staticDir: site.root, log: (l) => logs.push(l) });
    const watchedBase = `http://127.0.0.1:${(await watched.listen(0)).port}`;
    try {
      const { hostname, port } = new URL(watchedBase);
      const started = await new Promise((resolve, reject) => {
        const req = http.request({ hostname, port, path: '/assets/big-0001.bin', agent: false }, (res) => {
          res.on('error', () => {}); // the abort below is deliberate
          res.once('data', () => {
            req.destroy();
            resolve({ status: res.statusCode, length: res.headers['content-length'] });
          });
        });
        req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
        req.end();
      });
      assert.deepEqual(started, { status: 200, length: String(size) });
      await new Promise((r) => setTimeout(r, 300));
      assertServed(await hit(watchedBase, '/robots.txt'), site.bytes('robots.txt'), 'text/plain; charset=utf-8', 'no-cache');
      assert.deepEqual(logs.filter((l) => l.startsWith('500')), []);
    } finally {
      await watched.close();
      fs.rmSync(big);
    }
  });

  test('createBridge refuses a staticDir that cannot serve the app, naming the directory', () => {
    const dir = (rel) => path.join(site.tmp, rel);
    fs.mkdirSync(dir('empty'));
    fs.mkdirSync(dir('index-is-dir/index.html'), { recursive: true });
    fs.mkdirSync(dir('index-escapes'));
    fs.symlinkSync(dir('outside/secret.txt'), dir('index-escapes/index.html'));
    const refuses = (d, why) => assert.throws(() => createBridge({ store, host, staticDir: d }), (e) => why.test(e.message) && e.message.includes(d), d);
    refuses(dir('nope'), /not a directory/);
    refuses(dir('site/robots.txt'), /not a directory/);
    refuses(dir('empty'), /no index\.html/);
    refuses(dir('index-is-dir'), /no index\.html/);
    refuses(dir('index-escapes'), /no index\.html/);
  });
});

describe('chatter-bridge serve and CHATTER_BRIDGE_STATIC_DIR', () => {
  let site;
  let state;
  const cliEnv = (extra = {}) => {
    const env = { ...process.env, CHATTER_BRIDGE_STATE_DIR: state, ...extra };
    if (!('CHATTER_BRIDGE_STATIC_DIR' in extra)) delete env.CHATTER_BRIDGE_STATIC_DIR;
    return env;
  };

  /** Starts `serve`; resolves with `base` once it listens, or with `code` if it exits first. */
  const serve = (env) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', CLI, 'serve', '--host', '127.0.0.1', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const stop = () => new Promise((r) => {
      if (child.exitCode !== null || child.signalCode !== null) return r();
      child.once('close', () => r());
      child.kill('SIGTERM');
    });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`serve neither listened nor exited: ${out}${err}`)); }, 10_000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = /listening on (http:\/\/\S+)/.exec(out);
      if (m) { clearTimeout(timer); resolve({ base: m[1], stop }); }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr: err, stop }); });
  });

  before(() => {
    site = makeSite();
    state = path.join(site.tmp, 'state');
    execFileSync(process.execPath, ['--no-warnings', CLI, 'init', '--login', 'flan@example.com', '--handle', 'flan'], { env: cliEnv(), stdio: 'ignore' });
  });
  after(() => fs.rmSync(site.tmp, { recursive: true, force: true }));

  test('the help text documents CHATTER_BRIDGE_STATIC_DIR', () => {
    const help = execFileSync(process.execPath, ['--no-warnings', CLI], { env: cliEnv(), encoding: 'utf8' });
    assert.match(help, /CHATTER_BRIDGE_STATIC_DIR\s+\S/);
  });

  test('serve refuses to start when CHATTER_BRIDGE_STATIC_DIR cannot serve the app', async () => {
    const empty = path.join(site.tmp, 'empty');
    fs.mkdirSync(empty);
    for (const [dir, why] of [[path.join(site.tmp, 'nope'), /not a directory/], [empty, /no index\.html/]]) {
      const r = await serve(cliEnv({ CHATTER_BRIDGE_STATIC_DIR: dir }));
      await r.stop();
      assert.equal(r.code, 1, `expected exit 1 for ${dir}; it listened at ${r.base}`);
      assert.match(r.stderr, /^error: /);
      assert.match(r.stderr, why);
      assert.ok(r.stderr.includes(dir), r.stderr);
    }
  });

  test('serve serves the web client from CHATTER_BRIDGE_STATIC_DIR', async () => {
    const r = await serve(cliEnv({ CHATTER_BRIDGE_STATIC_DIR: site.root }));
    try {
      assert.ok(r.base, `serve exited: ${r.stderr}`);
      assertServed(await hit(r.base, '/'), INDEX, 'text/html; charset=utf-8', 'no-cache');
      assert.equal((await hit(r.base, '/v1/me', { headers: { accept: NAVIGATION } })).status, 401);
    } finally { await r.stop(); }
  });

  test('without CHATTER_BRIDGE_STATIC_DIR serve answers / as it does today', async () => {
    const r = await serve(cliEnv());
    try {
      assert.ok(r.base, `serve exited: ${r.stderr}`);
      const res = await hit(r.base, '/', { headers: { accept: NAVIGATION } });
      assert.equal(res.status, 404);
      assert.equal(res.text, NO_SUCH_ROUTE);
      assert.equal(res.headers['content-security-policy'], undefined);
    } finally { await r.stop(); }
  });
});

describe('static web client over the real Chatter CLI', { skip: !haveChatter && 'set CHATTER_JS to a built Chatter checkout' }, () => {
  let site;
  let e;
  let plain;
  let plainBase;
  const as = (who, headers = {}) => ({ headers: { authorization: `Bearer ${e.tokens[who]}`, ...headers } });

  before(async () => {
    site = makeSite();
    e = await makeEnv({ staticDir: site.root });
    e.addMember('thom');
    plain = createBridge({ store: e.store, host: e.host, pollMs: 50 });
    plainBase = `http://127.0.0.1:${(await plain.listen(0)).port}`;
  });
  after(async () => {
    await plain.close();
    await e.stop();
    fs.rmSync(site.tmp, { recursive: true, force: true });
  });

  test('one origin serves the app shell and the API', async () => {
    assertServed(await hit(e.base, '/'), INDEX, 'text/html; charset=utf-8', 'no-cache');
    assertServed(await hit(e.base, '/chat/general', { headers: { accept: NAVIGATION } }), INDEX, 'text/html; charset=utf-8', 'no-cache');
    const r = await e.post('thom', '#chat', 'hello while the shell is served');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const page = await e.messages('flan');
    assert.ok(page.body.messages.some((m) => m.id === r.body.id && m.from === 'thom'));
  });

  test('API answers are identical with and without static serving', async () => {
    const html = { accept: NAVIGATION };
    for (const p of ['/v1/me', '/v1/directory', '/v1/repos', `/v1/repos/${e.key}/messages`, `/v1/repos/${e.key}/messages?limit=1`]) {
      assert.equal((await assertUnchanged(e.base, plainBase, p, as('thom', html))).status, 200, p);
    }
    assert.equal((await assertUnchanged(e.base, plainBase, '/healthz', { headers: html })).status, 200);
    assert.equal((await assertUnchanged(e.base, plainBase, '/v1/repos', { headers: html })).status, 401);
    assert.equal((await assertUnchanged(e.base, plainBase, '/v1/members', as('thom', html))).status, 403);
    assert.equal((await assertUnchanged(e.base, plainBase, '/v1/nope', as('thom', html))).text, NO_SUCH_ROUTE);
  });

  test('the event stream still works with static serving on', async () => {
    const sse = await openSse(`${e.base}/v1/repos/${e.key}/stream`, { Authorization: `Bearer ${e.tokens.thom}`, Accept: 'text/event-stream' });
    try {
      assert.equal(sse.status, 200);
      await sse.waitFor((ev) => ev.event === 'hello');
      const r = await e.post('flan', '#chat', 'streamed past the shell');
      await sse.waitFor((ev) => ev.event === 'message' && ev.data.id === r.body.id);
    } finally { sse.close(); }
  });
});
