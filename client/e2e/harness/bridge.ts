// Typed access to the bridge's own test kit (bridge/test/helpers.js): makeEnv boots a real bridge over
// a scratch Chatter universe driven by the real Chatter CLI; openSse is a minimal stream reader.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Kind, Role } from './world';

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const HELPERS = path.join(REPO_ROOT, 'bridge', 'test', 'helpers.js');

export interface ApiResult {
  status: number;
  body: unknown;
}

export interface ChatterRepo {
  key: string;
  label: string;
  dir: string;
  repo_root: string | null;
}

export interface BridgeEnv {
  root: string;
  repo: string;
  key: string;
  base: string;
  repoInfo: ChatterRepo;
  tokens: Record<string, string>;
  store: {
    updateMember(handle: string, patch: { display_name?: string }): unknown;
    audit(entry: { actor: string; action: string; target?: string | null; detail?: Record<string, unknown> | null }): void;
  };
  host: {
    run(o: { handle: string; cwd: string; args: string[] }): Promise<{ code: number | null; stdout: string; stderr: string }>;
    repos(o?: { fresh?: boolean }): Promise<ChatterRepo[]>;
  };
  addMember(handle: string, o?: { kind?: Kind; role?: Role; display_name?: string; tailscale_login?: string }): string;
  seedAgent(name: string): void;
  post(who: string, to: string, body: string): Promise<ApiResult>;
  stop(): Promise<void>;
}

export interface MakeEnvOptions {
  staticDir?: string;
  pollMs?: number;
  trustTailscale?: boolean;
  whois?: (ip: string) => Promise<string | null>;
}

export interface SseEvent {
  event?: string;
  id?: string;
  data?: unknown;
}

export interface SseClient {
  status: number;
  events: SseEvent[];
  waitFor(pred: (ev: SseEvent) => boolean, ms?: number): Promise<SseEvent>;
  close(): void;
}

export interface BridgeHelpers {
  makeEnv(o?: MakeEnvOptions): Promise<BridgeEnv>;
  openSse(url: string, headers?: Record<string, string>): Promise<SseClient>;
}

/**
 * The helpers are plain JavaScript outside this TypeScript project, so they are loaded through a
 * computed specifier (which tsc does not resolve) and typed by BridgeHelpers, which lists exactly
 * what the harness relies on.
 */
export async function loadBridgeHelpers(): Promise<BridgeHelpers> {
  const specifier = pathToFileURL(HELPERS).href;
  return (await import(specifier)) as BridgeHelpers;
}

/** The E2E gate needs the real Chatter CLI; without it the run must fail, not skip. */
export function requireChatter(): void {
  const js = process.env.CHATTER_JS;
  if (!js || !fs.existsSync(js)) {
    throw new Error('The E2E harness needs the real Chatter CLI: set CHATTER_JS to <chatter clone>/dist/bin/chatter.js');
  }
}
