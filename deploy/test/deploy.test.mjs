// Tests of what deploy/ promises: the build script, the unit and the env example. Run with `node --test deploy/test/`;
// they are not part of the root `npm test`, which is the bridge's. The script is run by /bin/sh (dash on Debian and
// Ubuntu, so a bashism fails here), in a scratch git repository with a stand-in `npm` first on PATH, except for the
// one test that builds the real client. The stand-in is a test file, not an override in the script: the script has no
// way to skip check:dist.
import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(REPO, 'deploy', 'build-client.sh');
const UNIT = path.join(REPO, 'deploy', 'chatter-bridge.service');
const ENV_EXAMPLE = path.join(REPO, 'deploy', 'chatter-bridge.env.example');
const BRIDGE_BIN = path.join(REPO, 'bridge', 'bin', 'chatter-bridge.js');
const SKIP_REAL = process.env.DEPLOY_TEST_SKIP_REAL === '1' ? 'DEPLOY_TEST_SKIP_REAL=1 (the real build is skipped on request)' : false;

const scratchDirs = [];
const scratch = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-test-')));
  scratchDirs.push(dir);
  return dir;
};
after(() => { for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true }); });

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const field = (stdout, name) => stdout.match(new RegExp(`^${name}: (.*)$`, 'm'))?.[1];

// Only these argument lists are expected; anything else exits 99, so a changed command line fails a test loudly.
const FAKE_NPM = `#!/bin/sh
printf '%s\\n' "$*" >> "$SHIM_LOG"
prefix=$2
case "$3 $4" in
  "ci --ignore-scripts") exit 0 ;;
  "run build")
    mkdir -p "$prefix/dist/assets"
    { echo '<!doctype html><script type="module" src="/assets/app.js"></script>'; cat "$prefix/src/marker.txt"; } > "$prefix/dist/index.html"
    echo 'export default 1' > "$prefix/dist/assets/app.js"
    exit 0 ;;
  "run check:dist")
    if [ -n "\${SHIM_CHECK_DIST_FAIL:-}" ]; then echo 'check:dist: index.html: inline script (stand-in)' >&2; exit 1; fi
    exit 0 ;;
esac
echo "stand-in npm: unexpected arguments: $*" >&2
exit 99
`;

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();

/** A scratch git repository laid out like this one (the script, client/, .gitignore) and a stand-in npm. */
function makeFake({ withGit = true } = {}) {
  const root = scratch();
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'deploy'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'client', 'src'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(repo, 'deploy', 'build-client.sh'));
  fs.chmodSync(path.join(repo, 'deploy', 'build-client.sh'), 0o755);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'client/dist/\nnode_modules/\n');
  fs.writeFileSync(path.join(repo, 'client', 'package.json'), '{}\n');
  fs.writeFileSync(path.join(repo, 'client', 'src', 'marker.txt'), 'one\n');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'npm'), FAKE_NPM, { mode: 0o755 });
  const log = path.join(root, 'npm.log');
  const releases = path.join(root, 'home', 'chatter-bridge', 'releases');
  if (withGit) {
    git(repo, 'init', '-q');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'one');
  }
  const fake = {
    root, repo, releases, log,
    sha: () => git(repo, 'rev-parse', '--short=12', 'HEAD'),
    commit(marker) {
      fs.writeFileSync(path.join(repo, 'client', 'src', 'marker.txt'), `${marker}\n`);
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', marker);
      return fake.sha();
    },
    edit(marker) { fs.writeFileSync(path.join(repo, 'client', 'src', 'marker.txt'), `${marker}\n`); },
    /** Runs the copy of the script inside the scratch repo, from a directory outside it. */
    run(env = {}) {
      return spawnSync('/bin/sh', [path.join(repo, 'deploy', 'build-client.sh')], {
        cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, SHIM_LOG: log,
          GIT_CEILING_DIRECTORIES: root, RELEASES_DIR: '', SHIM_CHECK_DIST_FAIL: '', ...env,
        },
      });
    },
    npmCalls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []),
  };
  return fake;
}

const listing = (dir) => fs.readdirSync(dir).sort();
const target = (link) => fs.readlinkSync(link);

test('V1: runs ci (scripts off), build and check:dist in that order, then prints the dist path and the SHA-256 of index.html', () => {
  const fake = makeFake();
  const r = fake.run();
  assert.equal(r.status, 0, r.stderr);
  const client = path.join(fake.repo, 'client');
  assert.deepEqual(fake.npmCalls(), [
    `--prefix ${client} ci --ignore-scripts`,
    `--prefix ${client} run build`,
    `--prefix ${client} run check:dist`,
  ]);
  assert.equal(field(r.stdout, 'dist'), path.join(client, 'dist'));
  assert.equal(field(r.stdout, 'index.html sha256'), sha256(path.join(client, 'dist', 'index.html')));
  assert.equal(field(r.stdout, 'revision'), fake.sha());
  assert.match(r.stdout, /^build-client: OK$/m);
  // Without RELEASES_DIR nothing is placed and no note about restarting is needed.
  assert.equal(field(r.stdout, 'release'), undefined);
});

test('V1: the same commit built twice prints the same hash and revision (scratch repo)', () => {
  const fake = makeFake();
  const a = fake.run();
  const b = fake.run();
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, 0, b.stderr);
  assert.equal(field(a.stdout, 'index.html sha256'), field(b.stdout, 'index.html sha256'));
  assert.equal(field(a.stdout, 'revision'), field(b.stdout, 'revision'));
  assert.equal(a.stdout, b.stdout);
});

test('V1: a failing check:dist fails the script and prints nothing that looks like success', () => {
  const fake = makeFake();
  const r = fake.run({ SHIM_CHECK_DIST_FAIL: '1', RELEASES_DIR: fake.releases });
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /build-client: OK|sha256|^dist:|^release:|^current:/m);
  assert.match(r.stderr, /FAILED while: npm run check:dist/);
  assert.equal(fs.existsSync(fake.releases), false, 'a build that failed its check must not create the releases directory');
});

test('V1: a failing check:dist leaves a release that is already placed, and the current symlink, as they were', () => {
  const fake = makeFake();
  const first = fake.sha();
  assert.equal(fake.run({ RELEASES_DIR: fake.releases }).status, 0);
  const before = sha256(path.join(fake.releases, first, 'dist', 'index.html'));
  fake.commit('two');
  const r = fake.run({ SHIM_CHECK_DIST_FAIL: '1', RELEASES_DIR: fake.releases });
  assert.notEqual(r.status, 0);
  assert.equal(target(path.join(fake.releases, 'current')), first);
  assert.deepEqual(listing(fake.releases), ['current', first].sort(), 'no new release and no leftover temporary entry');
  assert.equal(sha256(path.join(fake.releases, first, 'dist', 'index.html')), before);
});

test('V1: a dirty tree shows as -dirty in the output, a clean one does not; untracked files count', () => {
  const fake = makeFake();
  const sha = fake.sha();
  assert.equal(field(fake.run().stdout, 'revision'), sha);

  fake.edit('edited but not committed');
  assert.equal(field(fake.run().stdout, 'revision'), `${sha}-dirty`);
  git(fake.repo, 'checkout', '--', 'client/src/marker.txt');
  assert.equal(field(fake.run().stdout, 'revision'), sha);

  fs.writeFileSync(path.join(fake.repo, 'client', 'src', 'new-file.txt'), 'new\n');
  assert.equal(field(fake.run().stdout, 'revision'), `${sha}-dirty`);
});

test('V1: a dirty build gets its own release name, and a second dirty build does not touch the first', () => {
  const fake = makeFake();
  const sha = fake.sha();
  fake.edit('first edit');
  const a = fake.run({ RELEASES_DIR: fake.releases });
  assert.equal(a.status, 0, a.stderr);
  fake.edit('second edit');
  const b = fake.run({ RELEASES_DIR: fake.releases });
  assert.equal(b.status, 0, b.stderr);
  const names = listing(fake.releases).filter((n) => n !== 'current');
  assert.equal(names.length, 2);
  for (const n of names) assert.match(n, new RegExp(`^${sha}-dirty-[0-9a-f]{8}$`));
  assert.equal(path.basename(path.dirname(field(b.stdout, 'release'))), target(path.join(fake.releases, 'current')));
});

test('V1: the release layout creates the directory and the symlink, and moves the symlink on a second sha', () => {
  const fake = makeFake();
  const one = fake.sha();
  const a = fake.run({ RELEASES_DIR: fake.releases });
  assert.equal(a.status, 0, a.stderr);
  const current = path.join(fake.releases, 'current');
  assert.equal(fs.lstatSync(current).isSymbolicLink(), true);
  assert.equal(target(current), one, 'relative, so the releases directory can move');
  assert.equal(fs.readFileSync(path.join(current, 'dist', 'index.html'), 'utf8').includes('one'), true);
  assert.equal(sha256(path.join(current, 'dist', 'index.html')), field(a.stdout, 'index.html sha256'));
  assert.match(a.stdout, /resolves the static root's realpath once, at start/);
  assert.match(a.stdout, /systemctl --user restart chatter-bridge/);

  const two = fake.commit('two');
  const b = fake.run({ RELEASES_DIR: fake.releases });
  assert.equal(b.status, 0, b.stderr);
  assert.notEqual(one, two);
  assert.equal(target(current), two, 'current moved to the new release');
  assert.equal(fs.readFileSync(path.join(current, 'dist', 'index.html'), 'utf8').includes('two'), true);
  assert.equal(fs.readFileSync(path.join(fake.releases, one, 'dist', 'index.html'), 'utf8').includes('one'), true, 'the old release is kept for a rollback');
  // Only the two releases and the symlink: a symlink moved with a plain `mv` would have been put inside the old release.
  assert.deepEqual(listing(fake.releases), ['current', one, two].sort());
  assert.deepEqual(listing(path.join(fake.releases, one)), ['dist']);
});

test('V1: building the same commit again reuses its release, and a release is never changed in place', () => {
  const fake = makeFake();
  const one = fake.sha();
  assert.equal(fake.run({ RELEASES_DIR: fake.releases }).status, 0);
  const again = fake.run({ RELEASES_DIR: fake.releases });
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(listing(fake.releases), ['current', one].sort());

  // The same commit that now builds to other bytes is something to look into, not something to overwrite: a
  // running bridge may be serving this directory.
  const placed = path.join(fake.releases, one, 'dist', 'index.html');
  const marker = path.join(fake.repo, 'client', 'src', 'marker.txt');
  fs.writeFileSync(placed, 'tampered\n');
  const before = fs.readFileSync(placed, 'utf8');
  const r = fake.run({ RELEASES_DIR: fake.releases });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /exists and differs from this build/);
  assert.equal(fs.readFileSync(placed, 'utf8'), before);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'one\n');
  assert.equal(target(path.join(fake.releases, 'current')), one);
});

test('V1: RELEASES_DIR outside a git checkout is refused before anything is built; without it the revision is "unknown"', () => {
  const fake = makeFake({ withGit: false });
  const refused = fake.run({ RELEASES_DIR: fake.releases });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /needs a git checkout/);
  assert.deepEqual(fake.npmCalls(), [], 'nothing was built');
  assert.equal(fs.existsSync(fake.releases), false);

  const plain = fake.run();
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(field(plain.stdout, 'revision'), 'unknown');
});

test('V1: the real client builds from the lockfile, twice, to the same index.html hash and the same release', { skip: SKIP_REAL, timeout: 20 * 60_000 }, () => {
  const releases = path.join(scratch(), 'releases');
  const runReal = () => spawnSync('/bin/sh', [SCRIPT], {
    cwd: os.tmpdir(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, RELEASES_DIR: releases },
  });
  const a = runReal();
  assert.equal(a.status, 0, a.stderr);
  const b = runReal();
  assert.equal(b.status, 0, b.stderr);
  const built = path.join(REPO, 'client', 'dist', 'index.html');
  assert.equal(field(a.stdout, 'dist'), path.join(REPO, 'client', 'dist'));
  assert.equal(field(a.stdout, 'index.html sha256'), sha256(built));
  assert.equal(field(a.stdout, 'index.html sha256'), field(b.stdout, 'index.html sha256'));
  assert.equal(field(a.stdout, 'revision'), field(b.stdout, 'revision'));
  assert.equal(field(a.stdout, 'release'), field(b.stdout, 'release'));
  const name = path.basename(path.dirname(field(a.stdout, 'release')));
  assert.deepEqual(listing(releases), ['current', name].sort());
  assert.equal(sha256(path.join(releases, 'current', 'dist', 'index.html')), sha256(built));
});

// --- the unit and the env example ---

const unitText = () => fs.readFileSync(UNIT, 'utf8');
const unitLines = () => unitText().split('\n').filter((l) => !l.startsWith('#'));

test('V2: the unit serves the client from where the build script puts the current release', () => {
  const home = path.join(scratch(), 'home');
  const staticDir = unitLines().find((l) => l.startsWith('Environment=CHATTER_BRIDGE_STATIC_DIR='))?.split('=').slice(2).join('=');
  assert.ok(staticDir, 'the unit sets CHATTER_BRIDGE_STATIC_DIR');
  assert.match(staticDir, /^%h\/.+\/current\/dist$/);
  // The releases directory the unit implies, and the one its own comment tells the operator to build into.
  const releasesInUnit = staticDir.slice(0, -'/current/dist'.length);
  assert.ok(unitText().includes(`RELEASES_DIR=${releasesInUnit}`), `the unit's comment names RELEASES_DIR=${releasesInUnit}`);
  const fake = makeFake();
  const r = fake.run({ RELEASES_DIR: releasesInUnit.replace('%h', home) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(staticDir.replace('%h', home), 'index.html')), true);
});

test('V2: the unit reads an optional env file, keeps its Chatter and PATH settings, and does not pass --experimental-sqlite', () => {
  const lines = unitLines();
  assert.ok(lines.includes('Environment=CHATTER_CMD=chatter'));
  assert.ok(lines.some((l) => /^Environment=PATH=.*%h\/\.local\/bin/.test(l)));
  assert.ok(lines.includes('Environment=CHATTER_BRIDGE_TRUST_TAILSCALE=1'));
  assert.ok(lines.includes('EnvironmentFile=-%h/.config/chatter-bridge/env'), 'optional: a leading "-" tolerates a missing file');
  const exec = lines.find((l) => l.startsWith('ExecStart='));
  assert.match(exec, /^ExecStart=\/usr\/bin\/node --no-warnings bridge\/bin\/chatter-bridge\.js serve --host 127\.0\.0\.1 --port 8791$/);
  assert.doesNotMatch(exec, /experimental-sqlite/);
  assert.match(unitText(), /untested on the real host/);
});

test('V2: systemd-analyze --user verify has nothing to say about the unit (a node that is not at /usr/bin/node apart)', { skip: spawnSync('systemd-analyze', ['--version']).error ? 'systemd-analyze is not installed' : false }, () => {
  const r = spawnSync('systemd-analyze', ['--user', 'verify', UNIT], { encoding: 'utf8' });
  const rest = `${r.stdout}${r.stderr}`.split('\n').filter((l) => l.trim() && !l.includes('/usr/bin/node'));
  assert.deepEqual(rest, []);
});

test('V2: the env example describes every CHATTER_ variable the bridge reads, and every line in it is commented out', () => {
  const example = fs.readFileSync(ENV_EXAMPLE, 'utf8');
  const read = [...new Set([...fs.readFileSync(BRIDGE_BIN, 'utf8').matchAll(/process\.env\.(CHATTER_[A-Z_]+)/g)].map((m) => m[1]))].sort();
  assert.ok(read.length >= 8, `expected the bridge to read at least eight CHATTER_ variables, found ${read.join(', ')}`);
  for (const name of read) assert.match(example, new RegExp(`^#${name}=`, 'm'), `${name} has no line in chatter-bridge.env.example`);
  const active = example.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  assert.deepEqual(active, [], 'a copy of the example must change nothing');
  for (const mark of ['[production]', '[unit]', '[optional]']) assert.ok(example.includes(mark), `${mark} is explained`);
  assert.doesNotMatch(example, /^#?\w*TOKEN\w*=/m, 'no token variable belongs in a file the unit reads');
});
