import crypto from 'node:crypto';

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const newToken = () => 'cb_' + crypto.randomBytes(32).toString('base64url');
export const nowIso = () => new Date().toISOString();

// Chatter stores UTC as "YYYY-MM-DD HH:MM:SS" with no zone marker.
export const chatterTime = (s) => (s ? `${s.replace(' ', 'T')}Z` : null);

// Every mention is read twice and both readings are kept. First as Chatter's `postToChat` reads it,
// `/@([a-z0-9_-]+)/g` and case-sensitive, so a capital letter ends the token: "@codX" is "@cod" and
// "@everyoneX" is "@everyone" to Chatter. Then whole and case-insensitive, lower-cased, as a person reads it.
// Neither pattern takes a character outside ASCII (no `u` flag) or an "@", so every token Chatter reads
// is in the list, and `everyone` is set when either reading gives exactly "everyone".
export function mentionsOf(body) {
  const handles = new Set();
  let everyone = false;
  const take = (t) => {
    if (t === 'everyone') everyone = true;
    else handles.add(t);
  };
  for (const m of body.matchAll(/@([a-z0-9_-]+)/g)) take(m[1]);
  for (const m of body.matchAll(/@([a-z0-9_-]+)/gi)) take(m[1].toLowerCase());
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
