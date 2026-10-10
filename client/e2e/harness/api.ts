// Calls the specs make from the test worker, outside any browser: the bridge's HTTP API (SPEC section 5)
// and a read-only look at Chatter's own database.
import type { World } from './world';

export const ROUTES = {
  me: '/v1/me',
  members: '/v1/members',
  member: (handle: string) => `/v1/members/${encodeURIComponent(handle)}`,
  messages: (key: string) => `/v1/repos/${encodeURIComponent(key)}/messages`,
  stream: (key: string) => `/v1/repos/${encodeURIComponent(key)}/stream`,
  healthz: '/healthz',
} as const;

export const CHANNEL = '#chat';

export const HTTP = { ok: 200, created: 201, unauthorized: 401, forbidden: 403 } as const;

// The bridge's largest page (bridge/src/messages.js); the E2E universe stays far below it.
const PAGE_LIMIT = 500;

export interface ApiError {
  error: { code: string; message: string };
}

export interface Message {
  id: number;
  from: string;
  to: string;
  body: string;
}

export interface MessagePage {
  messages: Message[];
  has_more: boolean;
  max_id: number;
}

export interface Reply<T> {
  status: number;
  body: T;
}

/** One API call as the holder of `token`. The token goes in the Authorization header only. */
export async function call<T>(baseURL: string, token: string | null, method: string, route: string, body?: unknown): Promise<Reply<T>> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(new URL(route, baseURL), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as T };
}

/** Posts as a member and returns the new message id; anything but 201 fails the caller. */
export async function postAs(world: World, token: string, to: string, text: string): Promise<number> {
  const r = await call<{ id: number } | ApiError>(world.baseURL, token, 'POST', ROUTES.messages(world.repo.key), { to, body: text });
  if (r.status !== HTTP.created || !('id' in r.body)) throw new Error(`posting failed with HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body.id;
}

/** Every message the holder of `token` may see in the main repo, oldest first. */
export async function visibleMessages(world: World, token: string): Promise<Message[]> {
  const r = await call<MessagePage>(world.baseURL, token, 'GET', `${ROUTES.messages(world.repo.key)}?limit=${PAGE_LIMIT}`);
  if (r.status !== HTTP.ok) throw new Error(`listing messages failed with HTTP ${r.status}`);
  return r.body.messages;
}

/** Rows in Chatter's messages table, read through a read-only handle (the bridge never writes there either). */
export async function countChatterRows(world: World): Promise<number> {
  // Loaded on first use: node:sqlite is experimental and warns, and listing the specs should stay quiet.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(world.chatterDb, { readOnly: true });
  try {
    return Number(db.prepare('SELECT COUNT(*) AS n FROM messages').get()?.n);
  } finally {
    db.close();
  }
}

/** A short unique marker, so a spec can find its own messages in a shared feed. */
export function nonce(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}
