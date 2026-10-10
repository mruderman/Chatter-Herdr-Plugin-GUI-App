// Serves the built web client from one directory (D15). route() in server.js hands over only GET and
// HEAD requests on paths apiArea() does not claim, so nothing here can shadow or change the API.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

// D15 in docs/plans/m3-client.md, exactly as written. Loosening it is a security decision for Flan.
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const API_AREAS = new Set(['v1', 'healthz']);
const INDEX = 'index.html';
const ASSETS = 'assets';
const HTML = 'text/html; charset=utf-8';
const JSON_TYPE = 'application/json; charset=utf-8';
const OCTETS = 'application/octet-stream';
const TYPES = new Map([
  ['.html', HTML],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', JSON_TYPE],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.webmanifest', 'application/manifest+json'],
  ['.woff2', 'font/woff2'],
  ['.txt', 'text/plain; charset=utf-8'],
]);
const NO_CACHE = 'no-cache';
// Vite gives every file under /assets/ a content-hashed name, so its bytes never change.
const IMMUTABLE = 'public, max-age=31536000, immutable';
// An error must not outlive the next deploy in any cache.
const NO_STORE = 'no-store';
const REFUSALS = {
  400: { code: 'bad_request', message: 'bad path' },
  404: { code: 'not_found', message: 'no such file' },
};
const MISSING = 'missing';
const OUTSIDE = 'outside';

/**
 * The API area ('v1' or 'healthz') a URL path belongs to, or null: the first non-empty segment,
 * percent-decoded. route() dispatches on this same function, so the API and the static handler
 * cannot disagree about which paths are the API's.
 */
export function apiArea(pathname) {
  const first = pathname.split('/').find(Boolean);
  if (first === undefined) return null;
  let name;
  try { name = decodeURIComponent(first); } catch { return null; }
  return API_AREAS.has(name) ? name : null;
}

// The separator matters: /srv/site-evil starts with /srv/site.
const isInside = (root, p) => p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** Resolved once, at startup, so a directory that cannot serve the app stops `serve` instead of the first page load. */
function resolveRoot(dir) {
  const refusal = (why) => new Error(`cannot serve the web client from "${dir}": ${why}`);
  let root;
  try { root = fs.realpathSync(dir); } catch { throw refusal('not a directory'); }
  if (!fs.statSync(root).isDirectory()) throw refusal('not a directory');
  let index = null;
  try { index = fs.realpathSync(path.join(root, INDEX)); } catch { /* reported just below */ }
  if (!index || !isInside(root, index) || !fs.statSync(index).isFile()) throw refusal('no index.html in it');
  return root;
}

function headers(type, length, cache) {
  return {
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Type': type,
    'Content-Length': length,
    'Cache-Control': cache,
  };
}

/** The bridge's JSON error shape, carrying the same security headers as a file. */
function refuse(req, res, status) {
  const body = JSON.stringify({ error: REFUSALS[status] });
  res.writeHead(status, headers(JSON_TYPE, Buffer.byteLength(body), NO_STORE));
  if (req.method === 'HEAD') res.end(); else res.end(body);
}

/**
 * Opens the regular file at `candidate`, following symlinks only to targets inside `root`.
 * Returns { handle, size }, MISSING or OUTSIDE. The handle is opened on the resolved path, so the
 * file streamed is the file that was checked.
 */
async function openInside(root, candidate) {
  let real;
  try { real = await fsp.realpath(candidate); } catch { return MISSING; }
  if (!isInside(root, real)) return OUTSIDE;
  let handle;
  try {
    handle = await fsp.open(real, 'r');
    const stat = await handle.stat();
    if (stat.isFile()) return { handle, size: stat.size };
  } catch { /* gone or unreadable since realpath: the same as missing */ }
  await handle?.close();
  return MISSING;
}

async function sendFile(req, res, { handle, size }, type, cache) {
  try {
    res.writeHead(200, headers(type, size, cache));
    if (req.method === 'HEAD') {
      res.end();
    } else {
      // A client that leaves early, or a read that fails once the headers are out, rejects here.
      // pipeline has already destroyed the response, so there is nothing left to answer.
      await pipeline(handle.createReadStream({ autoClose: false }), res).catch(() => {});
    }
  } finally {
    await handle.close();
  }
}

/** @param {string} dir the built client (client/dist); must contain index.html */
export function createStatic(dir) {
  const root = resolveRoot(dir);
  const index = path.join(root, INDEX);
  const acceptsHtml = (req) => (req.headers.accept ?? '').toLowerCase().includes('text/html');

  async function serve(req, res, pathname) {
    // The URL parser turns a raw backslash into '/', so only the request line still shows it.
    if (req.url.split('?', 1)[0].includes('\\')) return refuse(req, res, 400);
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { return refuse(req, res, 400); }
    if (decoded.includes('\0') || decoded.includes('\\')) return refuse(req, res, 400);
    const segments = decoded.split('/').filter(Boolean);
    // The URL parser has resolved literal and %2e dot segments; a '..' left now came in behind an encoded slash.
    if (segments.includes('..')) return refuse(req, res, 400);
    if (segments.some((s) => s.startsWith('.'))) return refuse(req, res, 404);
    // An encoded slash can hide an API path from apiArea(); such a path still gets no file and no shell.
    if (API_AREAS.has(segments[0])) return refuse(req, res, 404);

    const found = await openInside(root, segments.length ? path.join(root, ...segments) : index);
    if (found === OUTSIDE) return refuse(req, res, 404);
    if (found !== MISSING) {
      const name = segments.at(-1) ?? INDEX;
      const cache = segments[0] === ASSETS && segments.length > 1 ? IMMUTABLE : NO_CACHE;
      return sendFile(req, res, found, TYPES.get(path.extname(name).toLowerCase()) ?? OCTETS, cache);
    }
    // SPA fallback: loading a client-side route gets the shell; a missing file never does.
    if (path.extname(segments.at(-1) ?? '') || !acceptsHtml(req)) return refuse(req, res, 404);
    const shell = await openInside(root, index);
    if (shell === MISSING || shell === OUTSIDE) return refuse(req, res, 404);
    return sendFile(req, res, shell, HTML, NO_CACHE);
  }

  return { serve };
}
