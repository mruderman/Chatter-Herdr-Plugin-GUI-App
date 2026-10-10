#!/usr/bin/env -S node --no-warnings
import os from 'node:os';
import path from 'node:path';
import { ChatterHost } from '../src/chatter.js';
import { createBridge, VERSION } from '../src/server.js';
import { Store } from '../src/store.js';

const USAGE = `chatter-bridge ${VERSION}

  chatter-bridge init --login <tailscale-login> [--handle <name>] [--name "Display Name"]
  chatter-bridge serve [--host 127.0.0.1] [--port 8791]
  chatter-bridge member add <handle> --kind human|computational [--name "Display"] [--login <ts-login>]
                            [--role member|admin] [--no-agents]
  chatter-bridge member list
  chatter-bridge member set <handle> [--agents on|off] [--name "Display"] [--login <ts-login>]
  chatter-bridge member revoke <handle>
  chatter-bridge token rotate <handle>
  chatter-bridge audit [--limit 50]

Environment:
  CHATTER_BRIDGE_STATE_DIR   bridge data (default ~/.local/state/chatter-bridge)
  CHATTER_CMD                how to run Chatter: a command, or a JSON array (default "chatter")
  CHATTER_ADMIN_CONFIG_DIR   Chatter config dir of the human admin (default: Chatter's own)
  CHATTER_STATE_DIR          HERDR_PLUGIN_STATE_DIR passthrough for Chatter
  CHATTER_BRIDGE_TRUST_TAILSCALE=1   trust Tailscale identity headers (verified with tailscale whois)
  CHATTER_BRIDGE_ORIGINS     comma-separated CORS origins (default none)
`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (['no-agents', 'allow-non-loopback'].includes(k)) out[k] = true;
      else out[k] = argv[++i];
    } else out._.push(a);
  }
  return out;
}

const parseCmd = (s) => (s.trim().startsWith('[') ? JSON.parse(s) : s.trim().split(/\s+/));
const fail = (msg) => { console.error(`error: ${msg}`); process.exit(1); };

const stateDir = process.env.CHATTER_BRIDGE_STATE_DIR || path.join(os.homedir(), '.local', 'state', 'chatter-bridge');
const store = new Store(path.join(stateDir, 'bridge.db'));
const host = new ChatterHost({
  cmd: parseCmd(process.env.CHATTER_CMD || 'chatter'),
  memberConfigRoot: path.join(stateDir, 'members'),
  adminConfigDir: process.env.CHATTER_ADMIN_CONFIG_DIR || null,
  stateDir: process.env.CHATTER_STATE_DIR || null,
});

const table = (rows, cols) => {
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  console.log(cols.map((c, i) => c.padEnd(w[i])).join('  '));
  for (const r of rows) console.log(cols.map((c, i) => String(r[c] ?? '').padEnd(w[i])).join('  '));
};

async function main() {
  const [cmd, sub, ...rest] = process.argv.slice(2);
  const args = parseArgs(cmd === 'serve' || cmd === 'init' || cmd === 'audit' ? [sub, ...rest].filter((x) => x !== undefined) : rest);

  if (cmd === 'init') {
    const handle = args.handle || host.adminHandle();
    if (!handle) fail('no handle: pass --handle, or set your Chatter name first with `chatter iam <name>`');
    if (!args.login) fail('--login <tailscale-login> is required (the admin signs in through the tailnet)');
    if (store.countAdmins() > 0) fail('an admin already exists; use `member add --role admin` for more');
    const m = store.addMember({ handle, display_name: args.name || handle, kind: 'human', role: 'admin', tailscale_login: args.login });
    host.ensureMemberConfig(m.handle);
    store.audit({ actor: 'cli', action: 'init', target: m.handle });
    console.log(`admin "${m.handle}" created, mapped to Tailscale login ${args.login}`);
    return;
  }

  if (cmd === 'serve') {
    const hostName = args.host || process.env.CHATTER_BRIDGE_HOST || '127.0.0.1';
    const port = Number(args.port || process.env.CHATTER_BRIDGE_PORT || 8791);
    if (!['127.0.0.1', '::1', 'localhost'].includes(hostName) && !args['allow-non-loopback']) {
      fail(`refusing to listen on ${hostName}: bind loopback and publish with \`tailscale serve\` (or pass --allow-non-loopback)`);
    }
    if (store.countAdmins() === 0) fail('no admin yet: run `chatter-bridge init` first');
    const app = createBridge({
      store, host,
      trustTailscale: process.env.CHATTER_BRIDGE_TRUST_TAILSCALE === '1',
      origins: (process.env.CHATTER_BRIDGE_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
      log: (l) => console.log(`${new Date().toISOString()} ${l}`),
    });
    const addr = await app.listen(port, hostName);
    console.log(`chatter-bridge ${VERSION} listening on http://${addr.address}:${addr.port}`);
    const stop = async () => { await app.close(); host.close(); store.close(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }

  if (cmd === 'member') {
    if (sub === 'list') {
      table(store.listMembers().map((m) => ({ ...m, agents: m.can_address_agents ? 'yes' : 'no', login: m.tailscale_login || '' })),
        ['handle', 'kind', 'role', 'status', 'agents', 'login', 'last_seen_at']);
      return;
    }
    const handle = args._[0];
    if (!handle) fail('member handle required');
    if (sub === 'add') {
      if (!args.kind) fail('--kind human|computational is required');
      if ((await host.agentNames()).has(handle)) fail(`"${handle}" is already a Herdr agent name`);
      const m = store.addMember({
        handle, display_name: args.name || handle, kind: args.kind, role: args.role || 'member',
        can_address_agents: !args['no-agents'], tailscale_login: args.login || null,
      });
      host.ensureMemberConfig(m.handle);
      store.audit({ actor: 'cli', action: 'member_add', target: handle, detail: { kind: m.kind, role: m.role } });
      console.log(`member "${handle}" added (${m.kind}, ${m.role})`);
      if (m.kind === 'computational') {
        console.log(`token (shown once, store it in the member's secret store):\n${store.issueToken(handle)}`);
      }
      return;
    }
    if (sub === 'set') {
      const patch = {};
      if (args.agents) patch.can_address_agents = args.agents === 'on';
      if (args.name) patch.display_name = args.name;
      if (args.login) patch.tailscale_login = args.login;
      store.updateMember(handle, patch);
      store.audit({ actor: 'cli', action: 'member_update', target: handle, detail: patch });
      console.log(`member "${handle}" updated`);
      return;
    }
    if (sub === 'revoke') {
      store.revokeMember(handle);
      store.audit({ actor: 'cli', action: 'member_revoke', target: handle });
      console.log(`member "${handle}" revoked (open streams close within seconds)`);
      return;
    }
  }

  if (cmd === 'token' && sub === 'rotate') {
    const handle = rest[0];
    if (!handle) fail('member handle required');
    const t = store.issueToken(handle);
    store.audit({ actor: 'cli', action: 'token_rotate', target: handle });
    console.log(`new token for "${handle}" (shown once; the old one stopped working):\n${t}`);
    return;
  }

  if (cmd === 'audit') {
    table(store.listAudit({ limit: args.limit || 50 }).map((e) => ({ ...e, detail: e.detail ? JSON.stringify(e.detail) : '' })),
      ['id', 'at', 'actor', 'action', 'target', 'repo', 'message_id', 'detail']);
    return;
  }

  console.log(USAGE);
  process.exit(cmd ? 1 : 0);
}

main().catch((e) => fail(e.message || String(e)));
