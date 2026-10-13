// Tests of the smoke's interlocks against sockets, directories and processes this test makes itself; nothing
// here starts or talks to a Herdr. Run: node --test deploy/smoke/
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  Abort, SendGate, childEnv, countHerdr, dirsHash, envProblems, parseEnviron, pidsWithHome, preflight, readEnviron,
  realDirs, realSocket, socketState,
} from './interlocks.mjs';

// A Unix socket path must stay short, so the scratch directory lives in the runtime directory when there is one.
const base = process.env.XDG_RUNTIME_DIR && fs.existsSync(process.env.XDG_RUNTIME_DIR) ? process.env.XDG_RUNTIME_DIR : os.tmpdir();
let dir;
let server;
let sock;

before(async () => {
  dir = fs.mkdtempSync(path.join(base, 'hv-ilk-'));
  fs.mkdirSync(path.join(dir, 'tree', 'a'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tree', 'a', 'f'), 'x');
  sock = path.join(dir, 'guard.sock');
  server = net.createServer((c) => c.end());
  await new Promise((r) => server.listen(sock, r));
});

after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

const spawnWithEnv = (env) => {
  const child = spawn('sleep', ['30'], { env, stdio: 'ignore' });
  return child;
};
const waitEnviron = async (pid) => {
  // The child execs sleep after spawn returns; until then /proc shows node's own environment.
  for (let i = 0; i < 50; i++) {
    try { if (fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim() === 'sleep') return readEnviron(pid); } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 20));
  }
  return readEnviron(pid);
};

describe('the real socket check', () => {
  test('a socket something listens on is reported as accepting', async () => {
    assert.equal(await socketState(sock), 'accepts');
  });

  test('a missing path and a file that is not a listening socket count as nobody listening', async () => {
    assert.equal(await socketState(path.join(dir, 'nope.sock')), 'absent');
    const file = path.join(dir, 'plain-file');
    fs.writeFileSync(file, '');
    assert.equal(await socketState(file), 'refused');
  });

  test('the real socket and directories come from the password database, not from $HOME', () => {
    const saved = process.env.HOME;
    process.env.HOME = dir;
    try {
      const home = os.userInfo().homedir;
      assert.equal(realSocket(), path.join(home, '.config', 'herdr', 'herdr.sock'));
      assert.deepEqual(realDirs(), [path.join(home, '.config', 'herdr'), path.join(home, '.local', 'state', 'herdr')]);
      assert.ok(!realSocket().startsWith(dir));
    } finally { process.env.HOME = saved; }
  });
});

describe('preflight aborts before any send', () => {
  test('when a guarded socket accepts a connection: Abort, and a gated send is never made', async () => {
    const startHash = dirsHash([path.join(dir, 'tree')]).hash;
    const gate = new SendGate();
    let sent = 0;
    const run = async () => {
      await preflight({ sockets: [path.join(dir, 'nope.sock'), sock], dirs: [path.join(dir, 'tree')], startHash });
      gate.pass();
      gate.assertOpen('send');
      sent += 1;
    };
    await assert.rejects(run, (e) => e instanceof Abort && e.message.includes(`${sock} accepts a connection`));
    assert.equal(sent, 0);
    assert.throws(() => gate.assertOpen('send'), Abort);
  });

  test('when the hashed directories changed since the start: Abort', async () => {
    const tree = path.join(dir, 'tree');
    const startHash = dirsHash([tree]).hash;
    fs.writeFileSync(path.join(tree, 'a', 'new'), 'y');
    try {
      await assert.rejects(preflight({ sockets: [], dirs: [tree], startHash }), (e) => e instanceof Abort && /changed since the start/.test(e.message));
    } finally { fs.rmSync(path.join(tree, 'a', 'new')); }
  });

  test('with nobody listening and nothing changed it passes and reports what it saw', async () => {
    const tree = path.join(dir, 'tree');
    const r = await preflight({ sockets: [path.join(dir, 'nope.sock')], dirs: [tree], startHash: dirsHash([tree]).hash });
    assert.deepEqual(r.states, [`${path.join(dir, 'nope.sock')}: absent`]);
  });

  test('the hash is the one `find -printf | sort | sha256sum` gives', () => {
    const tree = path.join(dir, 'tree');
    const sh = spawnSync('sh', ['-c', 'find "$1" -printf \'%p %T@ %s\\n\' | sort | sha256sum', 'sh', tree], { encoding: 'utf8' });
    assert.equal(dirsHash([tree]).hash, sh.stdout.split(/\s+/)[0]);
  });
});

describe('the bridge environment check', () => {
  const iso = '/run/user/0/hv-test';
  const good = {
    HOME: iso, HERDR_SOCKET_PATH: `${iso}/.config/herdr/herdr.sock`, HERDR_BIN_PATH: '/usr/bin/herdr',
    CHATTER_STATE_DIR: `${iso}/.local/state/herdr/plugins/chatter`, CHATTER_BRIDGE_STATE_DIR: `${iso}/b`, CHATTER_ADMIN_CONFIG_DIR: `${iso}/c`, PATH: '/usr/bin',
  };

  test('the intended environment has no problem', () => { assert.deepEqual(envProblems(good, iso), []); });

  test('a pane id, a session, a socket or state outside the home, or an XDG home elsewhere are each refused', () => {
    assert.deepEqual(envProblems({ ...good, HERDR_PANE_ID: 'w1:p1' }, iso), ['HERDR_PANE_ID is set']);
    assert.deepEqual(envProblems({ ...good, HERDR_SESSION: 'default' }, iso), ['HERDR_SESSION is set']);
    assert.deepEqual(envProblems({ ...good, HERDR_SOCKET_PATH: '/home/x/.config/herdr/herdr.sock' }, iso), ['HERDR_SOCKET_PATH is not under the throwaway home']);
    assert.deepEqual(envProblems({ ...good, HERDR_SOCKET_PATH: `${iso}-other/herdr.sock` }, iso), ['HERDR_SOCKET_PATH is not under the throwaway home']);
    assert.deepEqual(envProblems({ ...good, HOME: '/home/x' }, iso), ['HOME is not the throwaway home']);
    assert.deepEqual(envProblems({ ...good, CHATTER_STATE_DIR: '/home/x/.local/state/herdr/plugins/chatter' }, iso), ['CHATTER_STATE_DIR is not under the throwaway home']);
    assert.deepEqual(envProblems({ ...good, XDG_STATE_HOME: '/home/x/.local/state' }, iso), ['XDG_STATE_HOME points outside the throwaway home']);
  });

  test('read from /proc/<pid>/environ of a live process, a pane id and a foreign socket are caught', async () => {
    const child = spawnWithEnv({ PATH: process.env.PATH, HOME: dir, HERDR_SOCKET_PATH: '/elsewhere/herdr.sock', HERDR_PANE_ID: 'w9:p9' });
    try {
      const env = await waitEnviron(child.pid);
      const problems = envProblems(env, dir, { requireBridge: false });
      assert.ok(problems.includes('HERDR_PANE_ID is set'));
      assert.ok(problems.includes('HERDR_SOCKET_PATH is not under the throwaway home'));
    } finally { child.kill('SIGKILL'); }
  });

  test('a child environment inherits nothing of Herdr or XDG homes, and points at the throwaway socket', () => {
    const env = childEnv({ PATH: '/usr/bin', HERDR_SOCKET_PATH: '/real.sock', HERDR_SESSION: 'x', HERDR_PANE_ID: 'w1:p1', XDG_CONFIG_HOME: '/real', SECRET: 's' }, dir, { HERDR_BIN_PATH: '/bin/herdr' });
    assert.deepEqual(env, { PATH: '/usr/bin', HOME: dir, HERDR_SOCKET_PATH: path.join(dir, '.config', 'herdr', 'herdr.sock'), HERDR_BIN_PATH: '/bin/herdr' });
    assert.ok(Object.isFrozen(env));
    assert.deepEqual(envProblems(env, dir, { requireBridge: false }), []);
  });

  test('parseEnviron reads NUL-separated pairs and keeps "=" inside values', () => {
    assert.deepEqual(parseEnviron('A=1\0B=x=y\0\0'), { A: '1', B: 'x=y' });
  });
});

describe('the process checks', () => {
  test('herdr is counted by command name only', () => {
    assert.equal(countHerdr('herdr\nbash\nherdr-helper\n  herdr  \nsh\n'), 2);
    assert.equal(countHerdr('bash\nnode\n'), 0);
  });

  test('a process is found by its HOME, and only by an exact match', async () => {
    const child = spawnWithEnv({ PATH: process.env.PATH, HOME: dir });
    try {
      await waitEnviron(child.pid);
      assert.ok(pidsWithHome(dir).includes(child.pid));
      assert.ok(!pidsWithHome(`${dir}-x`).includes(child.pid));
    } finally { child.kill('SIGKILL'); }
  });

  test('the send gate is shut until passed and shuts again', () => {
    const g = new SendGate();
    assert.throws(() => g.assertOpen('post'), (e) => e instanceof Abort && /pre-send interlocks have not run/.test(e.message));
    g.pass();
    g.assertOpen('post');
    g.shut('teardown');
    assert.throws(() => g.assertOpen('post'), /teardown/);
  });
});
