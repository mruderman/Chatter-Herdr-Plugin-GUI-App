// What the global setup hands to the test workers. Playwright's only channel from globalSetup to the
// workers is the environment, so the world travels as one JSON variable. Every token in it is a
// throwaway issued for this run against a scratch universe that the teardown deletes.

export const WORLD_ENV = 'E2E_WORLD';
export const BASE_URL_ENV = 'E2E_BASE_URL';

// The bridge polls Chatter this often in the E2E universe (production polls every 500 ms).
export const POLL_MS = 50;

// D15 in docs/plans/m3-client.md, exactly as written. The smoke spec certifies the header against
// this text, not against the bridge source, so a drift in either place turns it red.
export const D15_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export type Kind = 'human' | 'computational';
export type Role = 'admin' | 'member';

/** The cast. flan is the admin (F13: admins see every DM). ivo is never party to a DM in any spec. */
export const CAST = {
  admin: { handle: 'flan', display_name: 'Flan', kind: 'human', role: 'admin' },
  hana: { handle: 'hana', display_name: 'Hana', kind: 'human', role: 'member' },
  ivo: { handle: 'ivo', display_name: 'Ivo', kind: 'human', role: 'member' },
  kai: { handle: 'kai', display_name: 'Kai', kind: 'computational', role: 'member' },
} as const satisfies Record<string, { handle: string; display_name: string; kind: Kind; role: Role }>;

export type CastName = keyof typeof CAST;

export interface WorldMember {
  handle: string;
  display_name: string;
  kind: Kind;
  role: Role;
  token: string;
}

export interface WorldRepo {
  key: string;
  label: string;
}

export interface World {
  baseURL: string;
  /** The built client the bridge serves; a second bridge (tailnet identity spec) serves it too. */
  staticDir: string;
  /** The main repo's Chatter database. Specs only ever open it read-only. */
  chatterDb: string;
  /** The repo every spec works in. */
  repo: WorldRepo;
  /** A second repo, so the repository switcher has a real choice. */
  sidecar: WorldRepo & { seeded: string };
  /** A Herdr agent name seeded into the main repo. */
  agent: string;
  members: Record<CastName, WorldMember>;
}

/** Read inside a test or fixture only: test files are also loaded before the global setup runs. */
export function readWorld(): World {
  const raw = process.env[WORLD_ENV];
  if (!raw) throw new Error(`${WORLD_ENV} is not set: run the specs through "playwright test" so the global setup can boot the bridge`);
  return JSON.parse(raw) as World;
}

/** Every token the world knows, for the token-hygiene check. */
export function worldTokens(world: World): string[] {
  return Object.values(world.members).map((m) => m.token);
}
