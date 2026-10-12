// The Admin view, unchanged, over createApi and Node's real fetch, against a real bridge and the real
// Chatter CLI (bridge/test/helpers.js makeEnv, in this process): an admin adds a computational member
// through the form, rotates and revokes it, and every claim about the token is checked against the
// bridge that issued it. Needs CHATTER_JS, like the bridge's contract tests; skipped without it, and
// skipped is not passing. The tests share one bridge and run in order: each step starts from what the
// one before it left.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { configure, screen, waitFor, within } from '@testing-library/dom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { render } from '../../../test/render';
import { createApi, type FetchLike } from '../../api/client';
import { setupUser } from '../shell/test-utils';
import { AdminView } from './admin-view';
import { MAYBE_DONE } from './failure';
import { auditTable, cells, memberRow, membersTable, placesHolding, settle, status } from './test-support';

const CHATTER_JS = process.env.CHATTER_JS ?? '';
const HAVE_CHATTER = CHATTER_JS !== '' && existsSync(CHATTER_JS);
const SLOW = 30_000;
// A variable, not a literal: Vite takes `new URL('./x', import.meta.url)` for an asset import and rewrites it.
const HELPERS = '../../../../bridge/test/helpers.js';

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

/** The part of makeEnv's result this test uses (bridge/test/helpers.js is plain JavaScript). */
interface Env {
  readonly base: string;
  readonly tokens: Record<string, string>;
  addMember(handle: string, options?: { kind?: string; role?: string }): string;
  seedAgent(name: string): void;
  /** Asks the bridge directly, as `who`: a handle that has a token here, or a raw token. */
  api(who: string, method: string, path: string, body?: unknown): Promise<Reply>;
  stop(): Promise<void>;
}

// The ES module is loaded by Node itself. Inside the jsdom environment Vite's module runner refuses a
// file outside the client's root ("Cannot find module"), and `import()` of a file URL goes through it too.
function loadMakeEnv(): () => Promise<Env> {
  const path = fileURLToPath(new URL(HELPERS, import.meta.url));
  return (createRequire(path)(path) as { makeEnv: () => Promise<Env> }).makeEnv;
}

const errorOf = (reply: Reply): { code?: string; message?: string } => (reply.body as { error?: { code?: string; message?: string } } | null)?.error ?? {};

describe.skipIf(!HAVE_CHATTER)('the Admin view against the real bridge and Chatter (needs CHATTER_JS)', () => {
  let env: Env;
  // What the page asked the bridge for, as text; searched for tokens at the end.
  const asked: string[] = [];
  // Held across the steps below, never printed: every check on them is a status code or a yes/no.
  const seen: { first: string; second: string } = { first: '', second: '' };

  const recording: FetchLike = (url, init) => {
    asked.push(`${init.method ?? 'GET'} ${url} ${typeof init.body === 'string' ? init.body : ''}`);
    return fetch(url, init);
  };

  /** A fresh view of the admin panel, signed in as `who`, with its own count of directory refreshes. */
  function open(who = 'flan', selfHandle?: string) {
    const user = setupUser();
    const refreshDirectory = vi.fn<() => Promise<void>>(async () => undefined);
    const api = createApi({ baseUrl: env.base, getToken: () => env.tokens[who] ?? null, fetch: recording });
    render(
      <main id="main-content" tabIndex={-1}>
        <AdminView api={api} refreshDirectory={refreshDirectory} timeZone="UTC" {...(selfHandle ? { selfHandle } : {})} />
      </main>,
    );
    return { user, refreshDirectory };
  }

  // The audit log is a table, or the sentence that it is empty.
  const loaded = async (): Promise<void> => {
    await screen.findByRole('table', { name: 'Members' });
    await waitFor(() => expect(screen.queryByRole('table', { name: 'Audit log' }) ?? screen.queryByText('The audit log is empty.')).not.toBeNull());
  };

  const tokenShown = (handle: string): string => {
    const field = within(screen.getByRole('dialog', { name: `New token for ${handle}` })).getByLabelText('Token');
    return (field as HTMLTextAreaElement).value;
  };

  const buttonsOf = (handle: string): Array<string | null> => within(memberRow(handle)).getAllByRole('button').map((button) => button.getAttribute('aria-label'));

  beforeAll(async () => {
    configure({ asyncUtilTimeout: 10_000 });
    env = await loadMakeEnv()();
    // A Herdr agent name, so that a member cannot take it as a handle (handle_is_agent).
    env.seedAgent('codex');
  }, SLOW);

  afterAll(async () => {
    await env?.stop();
  });

  it('starts from the real registry, which holds only the admin, and an empty audit log', async () => {
    open();
    await screen.findByRole('table', { name: 'Members' });
    expect(cells(memberRow('flan')).slice(0, 6)).toEqual(['flan', 'flan', 'Human', 'Admin', 'Yes', 'Active']);
    expect(await screen.findByText('The audit log is empty.')).toBeTruthy();
  }, SLOW);

  it('adds a computational member through the form, shows its token once, and the token works', async () => {
    const { user, refreshDirectory } = open();
    await loaded();
    await user.click(screen.getByRole('button', { name: 'Add member' }));
    await user.type(screen.getByLabelText('Handle'), 'kestrel');
    await user.type(screen.getByLabelText('Display name'), 'Kestrel');
    await user.selectOptions(screen.getByLabelText('Kind'), 'Computational');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await screen.findByRole('dialog', { name: 'New token for kestrel' });
    seen.first = tokenShown('kestrel');
    expect(seen.first.startsWith('cb_')).toBe(true);
    expect(placesHolding(seen.first)).toBe(1);

    // The bridge accepts what the page showed.
    const me = await env.api(seen.first, 'GET', '/v1/me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ handle: 'kestrel', display_name: 'Kestrel', kind: 'computational', role: 'member' });

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(placesHolding(seen.first)).toBe(0);
    await waitFor(() => expect(cells(memberRow('kestrel')).slice(0, 6)).toEqual(['kestrel', 'Kestrel', 'Computational', 'Member', 'Yes', 'Active']));
    expect(status().textContent).toBe('Member added');
    expect(refreshDirectory).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(within(auditTable()).getAllByRole('row')[1]?.textContent).toContain('member_add'));
    const newest = within(auditTable()).getAllByRole('row')[1] as HTMLTableRowElement;
    expect(newest.cells[1]?.textContent).toBe('flan');
    expect(newest.cells[3]?.textContent).toBe('target: kestrel, kind: computational, role: member, can_address_agents: true');
  }, SLOW);

  it('rotates the token after asking: the old one is refused with 401 and the new one is accepted', async () => {
    const { user, refreshDirectory } = open();
    await loaded();
    await user.click(within(memberRow('kestrel')).getByRole('button', { name: 'Rotate token for kestrel' }));
    const asking = screen.getByRole('dialog', { name: 'Rotate token for kestrel?' });
    // Nothing has happened yet: the old token still works.
    expect((await env.api(seen.first, 'GET', '/v1/me')).status).toBe(200);
    await user.click(within(asking).getByRole('button', { name: 'Rotate' }));
    await screen.findByRole('dialog', { name: 'New token for kestrel' });
    seen.second = tokenShown('kestrel');
    expect(seen.second === seen.first).toBe(false);

    const refused = await env.api(seen.first, 'GET', '/v1/me');
    expect(refused.status).toBe(401);
    expect(refused.body).toEqual({ error: { code: 'bad_token', message: 'token is invalid or revoked' } });
    const accepted = await env.api(seen.second, 'GET', '/v1/me');
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ handle: 'kestrel' });

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(placesHolding(seen.second) + placesHolding(seen.first)).toBe(0);
    expect(status().textContent).toBe('Token rotated');
    await waitFor(() => expect(within(auditTable()).getAllByRole('row')[1]?.textContent).toContain('token_rotate'));
    expect(refreshDirectory).toHaveBeenCalledTimes(1);
  }, SLOW);

  it('revokes the member after asking: its token is refused with 401, and the row says Revoked and offers only Edit', async () => {
    const { user, refreshDirectory } = open();
    await loaded();
    await user.click(within(memberRow('kestrel')).getByRole('button', { name: 'Revoke kestrel' }));
    const asking = screen.getByRole('dialog', { name: 'Revoke kestrel?' });
    expect((await env.api(seen.second, 'GET', '/v1/me')).status).toBe(200);
    await user.click(within(asking).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const refused = await env.api(seen.second, 'GET', '/v1/me');
    expect(refused.status).toBe(401);
    expect(refused.body).toEqual({ error: { code: 'bad_token', message: 'token is invalid or revoked' } });
    await waitFor(() => expect(cells(memberRow('kestrel'))[5]).toBe('Revoked'));
    expect(status().textContent).toBe('Member revoked');
    expect(buttonsOf('kestrel')).toEqual(['Edit kestrel']);
    await waitFor(() => expect(document.activeElement).toBe(within(memberRow('kestrel')).getByRole('button', { name: 'Edit kestrel' })));
    expect(refreshDirectory).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(within(auditTable()).getAllByRole('row')[1]?.textContent).toContain('member_revoke'));
  }, SLOW);

  it('lists what the steps above did, newest first, as the bridge recorded it', async () => {
    open();
    await loaded();
    const rows = within(auditTable()).getAllByRole('row').slice(1) as HTMLTableRowElement[];
    expect(rows.map((row) => row.cells[2]?.textContent)).toEqual(['member_revoke', 'token_rotate', 'member_add']);
    expect(rows.map((row) => row.cells[3]?.textContent?.startsWith('target: kestrel'))).toEqual([true, true, true]);
    // Newest first is the bridge's order, not a sort of ours: its own answer says the same.
    const answer = await env.api('flan', 'GET', '/v1/audit');
    const actions = (answer.body as { entries: Array<{ action: string }> }).entries.map((entry) => entry.action);
    expect(actions).toEqual(['member_revoke', 'token_rotate', 'member_add']);
  }, SLOW);

  it("shows the bridge's own refusals in the dialog: the last admin, a taken handle, an agent name and a taken login", async () => {
    const { user, refreshDirectory } = open();
    await loaded();

    await user.click(within(memberRow('flan')).getByRole('button', { name: 'Edit flan' }));
    await user.selectOptions(screen.getByLabelText('Role'), 'Member');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toBe('cannot demote the last admin');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cells(memberRow('flan'))[3]).toBe('Admin');

    await user.click(within(memberRow('flan')).getByRole('button', { name: 'Revoke flan' }));
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    expect((await screen.findByRole('alert')).textContent).toBe('cannot revoke the last admin');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cells(memberRow('flan'))[5]).toBe('Active');

    for (const [handle, login, message] of [
      ['kestrel', '', 'member "kestrel" already exists'],
      ['codex', '', '"codex" is already a Herdr agent name'],
      ['ivy', 'flan@example.com', 'that Tailscale login is already mapped to a member'],
    ] as const) {
      await user.click(screen.getByRole('button', { name: 'Add member' }));
      await user.type(screen.getByLabelText('Handle'), handle);
      await user.type(screen.getByLabelText('Display name'), 'Someone');
      if (login) await user.type(screen.getByLabelText('Tailscale login (optional)'), login);
      await user.click(screen.getByRole('button', { name: 'Add' }));
      expect((await screen.findByRole('alert')).textContent).toBe(message);
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
    }

    // Nothing of that changed anything: the bridge still holds one active admin, and nothing new was audited.
    const members = (await env.api('flan', 'GET', '/v1/members')).body as { members: Array<{ handle: string; role: string; status: string }> };
    expect(members.members.map((m) => `${m.handle}:${m.role}:${m.status}`)).toEqual(['flan:admin:active', 'kestrel:member:revoked']);
    expect(refreshDirectory).not.toHaveBeenCalled();
    const audit = (await env.api('flan', 'GET', '/v1/audit')).body as { entries: unknown[] };
    expect(audit.entries).toHaveLength(3);
  }, SLOW);

  it('shows a failure that the bridge does not explain in the bridge\'s own words and the hint that it may have gone through, and changes nothing else', async () => {
    // Observed: PATCH with a Tailscale login that another member already holds fails inside the bridge
    // with 500 "internal error", where POST says 409 login_taken. The dialog says what the bridge says,
    // and since a 500 cannot say that nothing was changed (the bridge also answers it when only the audit
    // entry of a change that was made fails), the hint follows, though here nothing was changed.
    for (const [handle, login] of [
      ['ana', 'ana@example.com'],
      ['bo', 'bo@example.com'],
    ]) {
      expect((await env.api('flan', 'POST', '/v1/members', { handle, kind: 'human', display_name: handle, tailscale_login: login })).status).toBe(201);
    }
    const direct = await env.api('flan', 'PATCH', '/v1/members/bo', { tailscale_login: 'ana@example.com' });
    expect(direct.status).toBe(500);
    const bridgeSays = errorOf(direct).message ?? '';
    // The catch-all of bridge/src/server.js. It ends with no mark, so the page adds a full stop before the hint.
    expect(bridgeSays).toBe('internal error');

    const { user, refreshDirectory } = open();
    await loaded();
    await user.click(within(memberRow('bo')).getByRole('button', { name: 'Edit bo' }));
    await user.clear(screen.getByLabelText('Tailscale login (optional)'));
    await user.type(screen.getByLabelText('Tailscale login (optional)'), 'ana@example.com');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toBe(`${bridgeSays}. ${MAYBE_DONE}`);
    expect(screen.getByRole('dialog', { name: 'Edit bo' })).toBeTruthy();
    // A 500 cannot say that nothing was changed, so the page asks again for the directory (and the lists).
    expect(refreshDirectory).toHaveBeenCalledTimes(1);
    expect(status().textContent).toBe('');
    const bo = ((await env.api('flan', 'GET', '/v1/members')).body as { members: Array<{ handle: string; tailscale_login: string | null }> }).members.find((m) => m.handle === 'bo');
    expect(bo?.tailscale_login).toBe('bo@example.com');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
  }, SLOW);

  it('tells a member who is not an admin so, from the bridge\'s own 403, and offers nothing to change', async () => {
    env.addMember('zed', { kind: 'human' });
    open('zed');
    expect(await screen.findByText('Only admins can see and change the members.')).toBeTruthy();
    expect(await screen.findByText('Only admins can read the audit log.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add member' })).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  }, SLOW);

  it('rotating your own token shows the new one, and the old one is refused at once, which ends what the page can load', async () => {
    env.addMember('ada', { kind: 'human', role: 'admin' });
    const { user } = open('ada', 'ada');
    await loaded();
    await user.click(within(memberRow('ada')).getByRole('button', { name: 'Rotate token for ada' }));
    expect(screen.getByText('This is your own account, so your current token stops working at once.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Rotate' }));
    await screen.findByRole('dialog', { name: 'New token for ada' });
    const fresh = tokenShown('ada');
    expect((await env.api(fresh, 'GET', '/v1/me')).status).toBe(200);
    // The page still sends the token it was given, which the bridge now refuses: the reload says so in the bridge's words.
    expect((await env.api('ada', 'GET', '/v1/me')).status).toBe(401);
    expect(await screen.findByText('Could not load the members: token is invalid or revoked')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(placesHolding(fresh)).toBe(0);
    env.tokens['ada'] = fresh;
  }, SLOW);

  it('revoking your own account is accepted by the bridge, and the page then loses its access', async () => {
    const { user } = open('ada', 'ada');
    await loaded();
    await user.click(within(memberRow('ada')).getByRole('button', { name: 'Revoke ada' }));
    expect(screen.getByText('This is your own account, so your access ends at once.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('Could not load the members: token is invalid or revoked')).toBeTruthy();
    expect(status().textContent).toBe('Member revoked');
    const ada = ((await env.api('flan', 'GET', '/v1/members')).body as { members: Array<{ handle: string; status: string }> }).members.find((m) => m.handle === 'ada');
    expect(ada?.status).toBe('revoked');
    await settle();
    expect(membersTable()).toBeTruthy();
  }, SLOW);

  it("never sent a token in an address or a body: the admin's token travels only in a header", async () => {
    const adminToken = env.tokens['flan'] ?? '';
    expect(asked.length).toBeGreaterThan(10);
    for (const secret of [seen.first, seen.second, adminToken]) {
      expect(secret.length).toBeGreaterThan(20);
      // Counted, not compared as a list: a failing comparison would print the request lines that hold the token.
      expect(asked.filter((line) => line.includes(secret)).length).toBe(0);
    }
    expect(asked.filter((line) => /[?&](token|access_token|authorization)=/i.test(line)).length).toBe(0);
  }, SLOW);
});
