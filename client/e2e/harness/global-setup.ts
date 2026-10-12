// Builds the client, then boots one real bridge over the real Chatter CLI for the whole run. The bridge
// serves the freshly built client/dist, so every spec goes through the static route and the D15 CSP.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHANNEL, HTTP } from './api';
import { loadBridgeHelpers, requireChatter, type BridgeEnv } from './bridge';
import { BASE_URL_ENV, CAST, POLL_MS, WORLD_ENV, type CastName, type World, type WorldMember } from './world';

const CLIENT_DIR = fileURLToPath(new URL('../../', import.meta.url));
const DIST_DIR = path.join(CLIENT_DIR, 'dist');
const VITE_BIN = path.join(CLIENT_DIR, 'node_modules', 'vite', 'bin', 'vite.js');
const CHATTER_DB = 'chatter.db';
const AGENT = 'codex';
const SIDECAR = 'sidecar';

function buildClient(): void {
  const r = spawnSync(process.execPath, [VITE_BIN, 'build', '--logLevel', 'warn'], { cwd: CLIENT_DIR, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`vite build failed (exit ${r.status}):\n${r.stdout}\n${r.stderr}`);
  if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) throw new Error(`vite build left no index.html in ${DIST_DIR}`);
}

function makeGitRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=e2e@example.com', '-c', 'user.name=e2e', ...args], { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('commit', '--allow-empty', '-q', '-m', 'init');
}

async function post(env: BridgeEnv, who: string, to: string, body: string): Promise<void> {
  const r = await env.post(who, to, body);
  if (r.status !== HTTP.created) throw new Error(`seeding a message as ${who} failed with HTTP ${r.status}`);
}

function castMember(env: BridgeEnv, name: CastName): WorldMember {
  const c = CAST[name];
  // makeEnv registers the admin itself (and issues its token); everyone else is added here.
  const token = c.role === 'admin' ? env.tokens[c.handle] : env.addMember(c.handle, { kind: c.kind, display_name: c.display_name });
  if (!token) throw new Error(`no token for ${c.handle}`);
  return { ...c, token };
}

async function populate(env: BridgeEnv): Promise<World> {
  env.store.updateMember(CAST.admin.handle, { display_name: CAST.admin.display_name });
  const members: Record<CastName, WorldMember> = {
    admin: castMember(env, 'admin'),
    hana: castMember(env, 'hana'),
    ivo: castMember(env, 'ivo'),
    kai: castMember(env, 'kai'),
  };
  env.seedAgent(AGENT);

  // What the audit log of a bridge holds once its admin has added the cast through the admin API. The
  // harness adds them through the store, which writes no entry, and without these the Admin view would
  // only ever show an empty log, so no scan would reach the audit table.
  for (const name of ['hana', 'ivo', 'kai'] as const) {
    const c = CAST[name];
    env.store.audit({ actor: CAST.admin.handle, action: 'member_add', target: c.handle, detail: { kind: c.kind, role: c.role, can_address_agents: true } });
  }

  // A second repo gives the repository switcher a real choice (the keyboard spec switches to it and back).
  const sidecarDir = path.join(env.root, SIDECAR);
  makeGitRepo(sidecarDir);
  const sidecarSeed = 'Seeded: the sidecar repository';
  const r = await env.host.run({ handle: CAST.admin.handle, cwd: sidecarDir, args: ['post', sidecarSeed] });
  if (r.code !== 0) throw new Error(`seeding the sidecar repo failed: ${r.stderr}`);
  const sidecar = (await env.host.repos({ fresh: true })).find((x) => x.label === SIDECAR);
  if (!sidecar) throw new Error('the sidecar repo did not appear in "chatter data"');

  // A mention of the admin and a DM between two members (never ivo), so whichever spec runs first, the
  // axe scans included, finds a Chat view holding a mention and a DM conversation, not an empty feed.
  await post(env, CAST.kai.handle, CHANNEL, `Seeded: welcome, @${CAST.admin.handle}`);
  await post(env, CAST.hana.handle, CAST.kai.handle, 'Seeded: a direct message');

  return {
    baseURL: env.base,
    staticDir: DIST_DIR,
    chatterDb: path.join(env.repoInfo.dir, CHATTER_DB),
    repo: { key: env.key, label: env.repoInfo.label },
    sidecar: { key: sidecar.key, label: sidecar.label, seeded: sidecarSeed },
    agent: AGENT,
    members,
  };
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  requireChatter();
  buildClient();
  const { makeEnv } = await loadBridgeHelpers();
  const env = await makeEnv({ staticDir: DIST_DIR, pollMs: POLL_MS });
  try {
    const world = await populate(env);
    process.env[WORLD_ENV] = JSON.stringify(world);
    process.env[BASE_URL_ENV] = world.baseURL;
    console.log(`e2e: bridge at ${world.baseURL} serving ${DIST_DIR}`);
  } catch (e) {
    await env.stop();
    throw e;
  }
  return () => env.stop();
}
