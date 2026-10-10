import { spawn } from 'node:child_process';
import { HttpError } from './util.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Default whois: ask the local Tailscale daemon who owns an address. */
export function tailscaleWhois(ip, cmd = ['tailscale', 'whois', '--json']) {
  return new Promise((resolve) => {
    const child = spawn(cmd[0], [...cmd.slice(1), ip], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out)?.UserProfile?.LoginName ?? null); } catch { resolve(null); }
    });
  });
}

/**
 * Works out who is calling.
 *  1. Bearer token (computational members; also usable by humans).
 *  2. Tailscale identity header, trusted only when the request arrives from
 *     loopback (i.e. through `tailscale serve`) AND `tailscale whois` on the
 *     forwarded address agrees with the header.
 */
export function makeAuthenticator({ store, trustTailscale = false, whois = tailscaleWhois }) {
  const cache = new Map(); // ip -> { login, at }
  const whoisCached = async (ip) => {
    const hit = cache.get(ip);
    if (hit && Date.now() - hit.at < 60_000) return hit.login;
    const login = await whois(ip);
    cache.set(ip, { login, at: Date.now() });
    return login;
  };

  return async function identify(req) {
    const auth = req.headers.authorization || '';
    const m = /^Bearer\s+(\S+)$/i.exec(auth);
    if (m) {
      const member = store.memberByToken(m[1]);
      if (!member) throw new HttpError(401, 'bad_token', 'token is invalid or revoked');
      store.touch(member.handle);
      return member;
    }
    const header = req.headers['tailscale-user-login'];
    if (trustTailscale && header && LOOPBACK.has(req.socket.remoteAddress || '')) {
      const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (forwarded) {
        const verified = await whoisCached(forwarded);
        if (verified && verified.toLowerCase() === String(header).toLowerCase()) {
          const member = store.memberByLogin(verified);
          if (member) { store.touch(member.handle); return member; }
          throw new HttpError(403, 'not_registered', 'your Tailscale login is not registered as a member');
        }
      }
    }
    throw new HttpError(401, 'unauthenticated', 'send a bearer token, or connect through the tailnet as a registered member');
  };
}
