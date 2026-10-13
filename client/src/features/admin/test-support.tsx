// Shared by the admin tests; nothing in the app imports it. A stand-in for the bridge's member and
// audit routes that answers as the real bridge does to what the views can send (bridge/src/store.js,
// server.js; checked against a running bridge, see admin.integration.test.tsx): a taken handle or login,
// an agent name, the last admin, a revoked member's login, rotating a revoked member, and on an edit
// everything that updateMember refuses (a bad kind or role, an empty patch, a blank display name, a login
// that another member holds). The add does not model the checks the forms make first (handle pattern,
// "everyone", kind, role): the real bridge refuses those too (400 bad_handle, bad_kind, bad_role) and the
// views never send them. Also the checks the token tests share. Tokens here are throwaway strings that
// belong to no bridge.
import { screen, within } from '@testing-library/dom';
import type { UserEvent } from '@testing-library/user-event';
import { act } from 'preact/test-utils';
import { vi, type Mock } from 'vitest';
import { render } from '../../../test/render';
import { body } from '../../../test/fixtures/recorded';
import { ApiError, ERROR_CODES } from '../../api/errors';
import { parseAudit, parseMembers } from '../../api/guards';
import type {
  AddMemberRequest,
  AddMemberResult,
  AuditEntry,
  AuditQuery,
  AuditResponse,
  Member,
  MemberResult,
  MembersResponse,
  TokenResult,
  UpdateMemberRequest,
} from '../../api/types';
import { AdminView, type AdminApi } from './admin-view';
import { setupUser } from '../shell/test-utils';

/** Who is signed in as far as the stub's audit entries go. */
export const ADMIN = 'flan';

/** A name the bridge treats as a Herdr agent: a member may not take it as a handle. */
export const AGENT_NAME = 'codex';

/**
 * Edits that the bridge refuses whichever member they are for, with the answer it gives
 * (bridge/src/store.js updateMember). The stand-in is checked against this table in admin-view.test.tsx
 * and the real bridge in admin.integration.test.tsx, so that the two cannot drift apart unseen.
 */
export const PATCH_REFUSALS: ReadonlyArray<{ readonly name: string; readonly patch: unknown; readonly status: number; readonly code: string }> = [
  { name: 'a kind that is neither human nor computational', patch: { kind: 'robot' }, status: 400, code: ERROR_CODES.badKind },
  { name: 'a role that is neither admin nor member', patch: { role: 'owner' }, status: 400, code: ERROR_CODES.badRole },
  { name: 'an empty patch', patch: {}, status: 400, code: ERROR_CODES.badRequest },
  { name: 'a display name that is blank', patch: { display_name: '   ' }, status: 400, code: ERROR_CODES.badRequest },
];

const KINDS: readonly string[] = ['human', 'computational'];
const ROLES: readonly string[] = ['admin', 'member'];

export interface Call {
  readonly method: string;
  readonly args: readonly unknown[];
}

export interface Gate {
  /** Lets the held call through to its normal answer. */
  release: () => void;
}

const clone = <T,>(value: T): T => structuredClone(value);

// Reading the recorded answers through the guards keeps the stand-in on the shapes the real bridge sends.
// In the recording every member is active; `temp` is revoked here so that the table shows both states.
function seedMembers(): Member[] {
  return parseMembers(body('members-list')).members.map((member) => (member.handle === 'temp' ? { ...member, status: 'revoked' as const } : member));
}

// Kept outside the stub on purpose: the view receives the stub as its `api`, and the tests look for
// tokens in everything the view can reach (treeHolds), so a list of them on the stub itself would be
// found there and every such search would report the test's own bookkeeping.
const ISSUED = new WeakMap<StubBridge, string[]>();

export class StubBridge implements AdminApi {
  registry: Member[] = seedMembers();
  /** Newest first, like the bridge's answer. */
  entries: readonly AuditEntry[] = parseAudit(body('audit')).entries;
  readonly calls: Call[] = [];
  private nextAuditId = 100;
  private readonly failures = new Map<string, Error[]>();
  private readonly gates = new Map<string, Array<Promise<void>>>();

  /** Makes the next call of `method` fail with `error`. */
  failNext(method: string, error: Error): void {
    this.failures.set(method, [...(this.failures.get(method) ?? []), error]);
  }

  /** Holds the next call of `method` until released; its normal answer then goes out. */
  hold(method: string): Gate {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.gates.set(method, [...(this.gates.get(method) ?? []), held]);
    return { release };
  }

  callsTo(method: string): Call[] {
    return this.calls.filter((call) => call.method === method);
  }

  private async enter(method: string, ...args: unknown[]): Promise<void> {
    this.calls.push({ method, args });
    const gate = this.gates.get(method)?.shift();
    if (gate) await gate;
    const failure = this.failures.get(method)?.shift();
    if (failure) throw failure;
  }

  /** Every token handed out, in order, so that a test can look for one that the code under test is not holding. */
  get issued(): readonly string[] {
    return ISSUED.get(this) ?? [];
  }

  private newToken(): string {
    const all = ISSUED.get(this) ?? [];
    const token = `cb_throwaway${all.length + 1}_${'abcdefghij'.repeat(4)}`;
    ISSUED.set(this, [...all, token]);
    return token;
  }

  private log(actor: string, action: string, target: string | null, detail: Record<string, unknown> | null): void {
    this.nextAuditId += 1;
    this.entries = [{ id: this.nextAuditId, at: '2026-10-11T09:30:00.000Z', actor, action, target, repo: null, message_id: null, detail }, ...this.entries];
  }

  private find(handle: string): Member {
    const member = this.registry.find((candidate) => candidate.handle === handle);
    if (!member) throw new ApiError(404, ERROR_CODES.noSuchMember, `no member "${handle}"`);
    return member;
  }

  private activeAdmins(): number {
    return this.registry.filter((member) => member.role === 'admin' && member.status === 'active').length;
  }

  // Both lists are read when the request arrives, as a server would, so that a held call answers with
  // what was true when it was made.
  async members(): Promise<MembersResponse> {
    const answer = { members: clone(this.registry) };
    await this.enter('members');
    return answer;
  }

  async audit(query: AuditQuery = {}): Promise<AuditResponse> {
    const answer = { entries: clone(this.entries.slice(0, query.limit ?? 100)) };
    await this.enter('audit', query);
    return answer;
  }

  async addMember(request: AddMemberRequest): Promise<AddMemberResult> {
    await this.enter('addMember', request);
    if (request.handle === AGENT_NAME) throw new ApiError(409, ERROR_CODES.handleIsAgent, `"${request.handle}" is already a Herdr agent name`);
    if (this.registry.some((member) => member.handle === request.handle)) {
      throw new ApiError(409, ERROR_CODES.handleTaken, `member "${request.handle}" already exists`);
    }
    const holder = request.tailscale_login ? this.registry.find((member) => member.tailscale_login === request.tailscale_login) : undefined;
    if (holder?.status === 'active') throw new ApiError(409, ERROR_CODES.loginTaken, 'that Tailscale login is already mapped to a member');
    // A revoked member keeps its login. The bridge's own check looks only at active members, so it is the
    // database's uniqueness that refuses the new one, and what comes back is a bare 500 (observed).
    if (holder) throw new ApiError(500, ERROR_CODES.internal, 'internal error');
    const member: Member = {
      handle: request.handle,
      display_name: request.display_name || request.handle,
      kind: request.kind,
      role: request.role ?? 'member',
      can_address_agents: request.can_address_agents !== false,
      tailscale_login: request.tailscale_login || null,
      status: 'active',
      created_at: '2026-10-11T09:30:00.000Z',
      last_seen_at: null,
    };
    this.registry = [...this.registry, member];
    const token = request.kind === 'computational' || request.issue_token ? this.newToken() : null;
    this.log(ADMIN, 'member_add', member.handle, { kind: member.kind, role: member.role, can_address_agents: member.can_address_agents });
    return { member: clone(member), token };
  }

  async updateMember(handle: string, patch: UpdateMemberRequest): Promise<MemberResult> {
    await this.enter('updateMember', handle, patch);
    const member = this.find(handle);
    // bridge/src/store.js updateMember, in its order and its words. A refusal writes nothing.
    if (!Object.keys(patch).length) throw new ApiError(400, ERROR_CODES.badRequest, 'nothing to change');
    if ('display_name' in patch && (typeof patch.display_name !== 'string' || !patch.display_name.trim())) {
      throw new ApiError(400, ERROR_CODES.badRequest, 'display name must not be empty');
    }
    // What is stored is what the bridge made of the patch: a name without its edges, and an empty login
    // as none at all.
    const updated: Member = {
      ...member,
      ...patch,
      ...('display_name' in patch ? { display_name: (patch.display_name ?? '').trim() } : {}),
      ...('tailscale_login' in patch ? { tailscale_login: patch.tailscale_login?.trim() || null } : {}),
    };
    if (!KINDS.includes(updated.kind)) throw new ApiError(400, ERROR_CODES.badKind, 'kind must be human or computational');
    if (!ROLES.includes(updated.role)) throw new ApiError(400, ERROR_CODES.badRole, 'role must be admin or member');
    const holders = updated.tailscale_login ? this.registry.filter((other) => other.handle !== handle && other.tailscale_login === updated.tailscale_login) : [];
    if (holders.some((other) => other.status === 'active')) {
      throw new ApiError(409, ERROR_CODES.loginTaken, 'that Tailscale login is already mapped to a member');
    }
    if (patch.role && patch.role !== member.role && member.role === 'admin' && this.activeAdmins() <= 1) {
      throw new ApiError(409, ERROR_CODES.lastAdmin, 'cannot demote the last admin');
    }
    // A revoked member keeps its login, which the check above does not look at, so what refuses it is the
    // database's uniqueness, and what comes back is a bare 500 (observed, and the same when adding).
    if (holders.length > 0) throw new ApiError(500, ERROR_CODES.internal, 'internal error');
    this.registry = this.registry.map((candidate) => (candidate.handle === handle ? updated : candidate));
    // The bridge audits what was stored, not what was sent.
    this.log(ADMIN, 'member_update', handle, Object.fromEntries(Object.keys(patch).map((key) => [key, Reflect.get(updated, key)])));
    return { member: clone(updated) };
  }

  async revokeMember(handle: string): Promise<MemberResult> {
    await this.enter('revokeMember', handle);
    const member = this.find(handle);
    if (member.role === 'admin' && member.status === 'active' && this.activeAdmins() <= 1) {
      throw new ApiError(409, ERROR_CODES.lastAdmin, 'cannot revoke the last admin');
    }
    const revoked: Member = { ...member, status: 'revoked' };
    this.registry = this.registry.map((candidate) => (candidate.handle === handle ? revoked : candidate));
    this.log(ADMIN, 'member_revoke', handle, null);
    return { member: clone(revoked) };
  }

  async rotateToken(handle: string): Promise<TokenResult> {
    await this.enter('rotateToken', handle);
    const member = this.registry.find((candidate) => candidate.handle === handle);
    if (!member || member.status !== 'active') throw new ApiError(404, ERROR_CODES.noSuchMember, `no active member "${handle}"`);
    this.log(ADMIN, 'token_rotate', handle, null);
    return { token: this.newToken() };
  }
}

export interface Rendered {
  readonly bridge: StubBridge;
  readonly refreshDirectory: Mock<() => Promise<void>>;
  readonly user: UserEvent;
  readonly container: HTMLElement;
}

/** The view inside the shell's `<main>`, which page-level axe rules and focus fallbacks expect. */
export function renderAdmin(bridge: StubBridge = new StubBridge(), props: { selfHandle?: string; timeZone?: string } = {}): Rendered {
  const refreshDirectory = vi.fn<() => Promise<void>>(async () => undefined);
  const user = setupUser();
  const container = render(
    <main id="main-content" tabIndex={-1}>
      <AdminView api={bridge} refreshDirectory={refreshDirectory} timeZone="UTC" {...props} />
    </main>,
  );
  return { bridge, refreshDirectory, user, container };
}

// ------------------------------------------------------------------------------- reading the page

export const membersTable = (): HTMLElement => screen.getByRole('table', { name: 'Members' });
export const auditTable = (): HTMLElement => screen.getByRole('table', { name: 'Audit log' });

/** The row of the Members table whose handle is `handle`. */
export function memberRow(handle: string): HTMLTableRowElement {
  const row = within(membersTable())
    .getAllByRole('row')
    .find((candidate) => candidate.querySelector('th[scope="row"]')?.textContent === handle);
  if (!row) throw new Error(`no row for ${handle}`);
  return row as HTMLTableRowElement;
}

export const cells = (row: HTMLTableRowElement): string[] => Array.from(row.cells, (cell) => cell.textContent ?? '');

export async function loaded(): Promise<void> {
  await screen.findByRole('table', { name: 'Members' });
  await screen.findByRole('table', { name: 'Audit log' });
}

/** The polite status the view announces its successes in. */
export const status = (): HTMLElement => screen.getByRole('status', { name: 'Admin announcements' });

/** Lets every promise the page started settle and its renders happen, so that a test can read the result. */
export const settle = (): Promise<void> =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

// ---------------------------------------------------------------------------- where a token might be

/**
 * How many places hold `secret`: the page's markup and attributes, the live value of every form field,
 * both web stores, the cookie string, the address, the history entry and the title. It is a count, so a
 * failing test says "1" and never prints what it guards.
 */
export function placesHolding(secret: string): number {
  const found = [
    document.documentElement.outerHTML,
    ...Array.from(document.querySelectorAll('input, textarea, select'), (field) => (field as HTMLInputElement).value),
    ...[localStorage, sessionStorage].flatMap((store) => Array.from({ length: store.length }, (_, index) => `${store.key(index) ?? ''}=${store.getItem(store.key(index) ?? '') ?? ''}`)),
    document.cookie,
    location.href,
    JSON.stringify(history.state ?? null),
    document.title,
  ];
  return found.filter((text) => text.includes(secret)).length;
}

// Reads Preact's mangled internals (`__k` for children, `__c` for a component, `__H` for its hooks),
// which the lockfile pins. A version that renames them makes `treeSize` fall to zero, and the test that
// checks it fail, instead of every search quietly finding nothing.
function walkTree(container: HTMLElement, onString: (text: string) => void): number {
  const seen = new WeakSet<object>();
  let objects = 0;
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      onString(value);
      return;
    }
    if (typeof value !== 'object' || value === null || seen.has(value)) return;
    // The page's own nodes are searched through the markup, and a closure's variables cannot be read.
    if (value instanceof Node || value instanceof Window) return;
    seen.add(value);
    objects += 1;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'string') onString(key);
      visit(Reflect.get(value, key));
    }
  };
  visit(Reflect.get(container, '__k'));
  return objects;
}

/**
 * How many strings in the rendered component tree contain `secret`: the props and the hook state of
 * every vnode, which is where a view would keep a token that it no longer shows.
 */
export function treeHolds(container: HTMLElement, secret: string): number {
  let holding = 0;
  walkTree(container, (text) => {
    if (text.includes(secret)) holding += 1;
  });
  return holding;
}

/** How many objects `treeHolds` can reach; zero means it can no longer read the tree. */
export function treeSize(container: HTMLElement): number {
  return walkTree(container, () => undefined);
}

export interface ConsoleWatch {
  /** How many console calls carried `secret` in any argument. */
  holding: (secret: string) => number;
  total: () => number;
}

export function watchConsole(): ConsoleWatch {
  const calls: unknown[][] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void calls.push(args));
  }
  return {
    holding: (secret) => calls.filter((args) => JSON.stringify(args).includes(secret)).length,
    total: () => calls.length,
  };
}
