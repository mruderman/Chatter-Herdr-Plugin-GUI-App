import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

const mode = (p) => fs.statSync(p).mode & 0o777;

// Runs fn under a permissive umask (the usual 0002 that makes 0775/0664) with a fresh temp root, then restores both.
function withTemp(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-perms-'));
  const oldUmask = process.umask(0o002);
  try { return fn(root); } finally {
    process.umask(oldUmask);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// The warning goes to stderr; capture it for the duration of fn.
function captureStderr(fn) {
  const lines = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
  try { fn(); } finally { process.stderr.write = orig; }
  return lines.join('');
}

test('a fresh nested state directory is created 0700 all the way down, bridge.db 0600', () => {
  withTemp((root) => {
    const a = path.join(root, 'a');
    const b = path.join(a, 'b');
    const dir = path.join(b, 'state');
    const store = new Store(path.join(dir, 'bridge.db'));
    store.close();
    for (const d of [a, b, dir]) assert.equal(mode(d).toString(8), '700', d);
    assert.equal(mode(path.join(dir, 'bridge.db')).toString(8), '600');
  });
});

test('-wal and -shm files are 0600 after a write', () => {
  withTemp((root) => {
    const file = path.join(root, 'state', 'bridge.db');
    const store = new Store(file);
    try {
      store.addMember({ handle: 'zed', kind: 'human' });
      assert.ok(fs.existsSync(`${file}-wal`), 'wal exists while the db is open');
      assert.ok(fs.existsSync(`${file}-shm`), 'shm exists while the db is open');
      assert.equal(mode(`${file}-wal`).toString(8), '600');
      assert.equal(mode(`${file}-shm`).toString(8), '600');
    } finally { store.close(); }
  });
});

test('an existing 0755 directory is left alone, warned about, and bridge.db is still 0600', () => {
  withTemp((root) => {
    const dir = path.join(root, 'shared');
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o755);
    let store;
    const err = captureStderr(() => { store = new Store(path.join(dir, 'bridge.db')); });
    store.close();
    assert.equal(mode(dir).toString(8), '755');
    assert.match(err, /readable by other accounts/);
    assert.match(err, /chmod 700/);
    assert.equal(mode(path.join(dir, 'bridge.db')).toString(8), '600');
  });
});

test('an existing 0700 directory gives no warning', () => {
  withTemp((root) => {
    const dir = path.join(root, 'private');
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o700);
    let store;
    const err = captureStderr(() => { store = new Store(path.join(dir, 'bridge.db')); });
    store.close();
    assert.equal(err, '');
    assert.equal(mode(dir).toString(8), '700');
  });
});

test('an existing bridge.db at 0644 becomes 0600', () => {
  withTemp((root) => {
    const dir = path.join(root, 'state');
    fs.mkdirSync(dir, { mode: 0o700 });
    const file = path.join(dir, 'bridge.db');
    new Store(file).close();
    fs.chmodSync(file, 0o644);
    new Store(file).close();
    assert.equal(mode(file).toString(8), '600');
  });
});

test(':memory: touches no files', () => {
  const store = new Store(':memory:');
  store.close();
});
