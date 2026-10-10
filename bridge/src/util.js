import crypto from 'node:crypto';

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const newToken = () => 'cb_' + crypto.randomBytes(32).toString('base64url');
export const nowIso = () => new Date().toISOString();

// Chatter stores UTC as "YYYY-MM-DD HH:MM:SS" with no zone marker.
export const chatterTime = (s) => (s ? `${s.replace(' ', 'T')}Z` : null);

// Same token grammar Chatter uses for @mentions (lowercase, digits, _ and -).
// Case-insensitive here so the policy check is a superset of Chatter's.
export function mentionsOf(body) {
  const handles = new Set();
  let everyone = false;
  for (const m of body.matchAll(/@([a-z0-9_-]+)/gi)) {
    const t = m[1].toLowerCase();
    if (t === 'everyone') everyone = true;
    else handles.add(t);
  }
  return { handles: [...handles], everyone };
}

export const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}
