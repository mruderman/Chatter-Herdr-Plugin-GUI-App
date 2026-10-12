import { screen, waitFor, within } from '@testing-library/dom';
import { describe, expect, it } from 'vitest';
import { cleanup } from '../../../test/render';
import { ApiError, ERROR_CODES, NetworkError } from '../../api/errors';
import type { AuditEntry } from '../../api/types';
import { expectNoAxeViolations } from '../shell/test-utils';
import { AUDIT_LIMIT } from './admin-view';
import { MAYBE_DONE } from './failure';
import { HANDLE_RULE } from './validation';
import { StubBridge, auditTable, cells, loaded, memberRow, membersTable, renderAdmin, settle, status, type Rendered } from './test-support';

type User = Rendered['user'];

describe('Admin view: the two lists', () => {
  it('has the heading Admin, the sections Members and Audit log, and a table named for each', async () => {
    renderAdmin();
    await loaded();
    expect(screen.getByRole('heading', { level: 1, name: 'Admin' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Members' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Audit log' })).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('shows the Members columns in the contract order, with the row buttons in an Actions column after them', async () => {
    renderAdmin();
    await loaded();
    expect(within(membersTable()).getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'Handle',
      'Name',
      'Kind',
      'Role',
      'Agents',
      'Status',
      'Actions',
    ]);
  });

  it('describes each member in words: kind badge, role, agent permission and status', async () => {
    renderAdmin();
    await loaded();
    expect(cells(memberRow('flan')).slice(0, 6)).toEqual(['flan', 'flan', 'Human', 'Admin', 'Yes', 'Active']);
    expect(cells(memberRow('thom')).slice(0, 6)).toEqual(['thom', 'Thom', 'Computational', 'Member', 'Yes', 'Active']);
    expect(cells(memberRow('kieran')).slice(0, 6)).toEqual(['kieran', 'Kieran', 'Computational', 'Member', 'No', 'Active']);
    expect(cells(memberRow('temp')).slice(0, 6)).toEqual(['temp', 'Temporary', 'Computational', 'Member', 'Yes', 'Revoked']);
    expect(within(memberRow('thom')).getByText('Computational').className).toContain('badge');
  });

  it('gives every active member the buttons Edit, Revoke and Rotate token, named for the handle', async () => {
    renderAdmin();
    await loaded();
    for (const handle of ['flan', 'thom', 'mira', 'ezra']) {
      const row = within(memberRow(handle));
      expect(row.getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
        `Edit ${handle}`,
        `Revoke ${handle}`,
        `Rotate token for ${handle}`,
      ]);
    }
  });

  it('gives a revoked member only Edit, because the bridge has no second revoke, no rotation and no way back', async () => {
    renderAdmin();
    await loaded();
    const row = within(memberRow('temp'));
    expect(row.getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Edit temp']);
    expect(row.queryByRole('button', { name: 'Revoke temp' })).toBeNull();
    expect(row.queryByRole('button', { name: 'Rotate token for temp' })).toBeNull();
    expect(cells(memberRow('temp'))[5]).toBe('Revoked');
  });

  it('lists the audit log in the order the bridge sent it, newest first, with local times and plain-text details', async () => {
    const bridge = new StubBridge();
    renderAdmin(bridge);
    await loaded();
    const table = within(auditTable());
    expect(table.getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['Time', 'Actor', 'Action', 'Detail']);
    const rows = table.getAllByRole('row').slice(1) as HTMLTableRowElement[];
    expect(rows.map((row) => row.cells[2]?.textContent)).toEqual(bridge.entries.map((entry) => entry.action));
    expect(rows).toHaveLength(bridge.entries.length);

    const newest = rows[0];
    expect(newest?.cells[0]?.textContent).toBe('2026-10-10 14:06:57');
    expect(newest?.cells[0]?.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-10T14:06:57.115Z');
    expect(cells(newest as HTMLTableRowElement).slice(1)).toEqual(['flan', 'member_revoke', 'target: temp']);
    const everyone = rows.find((row) => row.cells[2]?.textContent === 'everyone');
    expect(everyone?.cells[3]?.textContent).toBe('repo: repo-c522d9cf, message: 7, pushed: []');
    const kieran = rows.find((row) => row.cells[3]?.textContent?.startsWith('target: kieran'));
    expect(kieran?.cells[3]?.textContent).toBe('target: kieran, kind: computational, role: member, can_address_agents: false');
  });

  it('shows each time in the zone the page is in, and says so above the table', async () => {
    renderAdmin(new StubBridge(), { timeZone: 'Asia/Tokyo' });
    await loaded();
    const newest = within(auditTable()).getAllByRole('row')[1] as HTMLTableRowElement;
    // 14:06:57 UTC is 23:06:57 in Tokyo; the machine-readable value stays in UTC.
    expect(newest.cells[0]?.textContent).toBe('2026-10-10 23:06:57');
    expect(newest.cells[0]?.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-10T14:06:57.115Z');
    expect(screen.getByText('Newest first, in your time zone.')).toBeTruthy();
  });

  it('asks for the newest AUDIT_LIMIT entries, and says that older ones are not listed when the answer is that long', async () => {
    const bridge = new StubBridge();
    const template = bridge.entries[0] as AuditEntry;
    bridge.entries = Array.from({ length: AUDIT_LIMIT + 20 }, (_, index) => ({ ...template, id: 1000 - index }));
    renderAdmin(bridge);
    await loaded();
    expect(bridge.callsTo('audit')[0]?.args).toEqual([{ limit: AUDIT_LIMIT }]);
    expect(within(auditTable()).getAllByRole('row')).toHaveLength(AUDIT_LIMIT + 1);
    expect(screen.getByText(`Newest first, in your time zone. Showing the newest ${AUDIT_LIMIT}; older entries are not listed.`)).toBeTruthy();
  });

  it('says the same when the answer is exactly as long as was asked for, since there may be more, and not when it is shorter', async () => {
    const template = new StubBridge().entries[0] as AuditEntry;
    const exact = new StubBridge();
    exact.entries = Array.from({ length: AUDIT_LIMIT }, (_, index) => ({ ...template, id: 1000 - index }));
    renderAdmin(exact);
    await loaded();
    expect(screen.queryByText(/older entries are not listed/)).not.toBeNull();
    cleanup();
    const shorter = new StubBridge();
    shorter.entries = Array.from({ length: AUDIT_LIMIT - 1 }, (_, index) => ({ ...template, id: 1000 - index }));
    renderAdmin(shorter);
    await loaded();
    expect(screen.queryByText(/older entries are not listed/)).toBeNull();
    expect(screen.getByText('Newest first, in your time zone.')).toBeTruthy();
  });

  it('makes the audit table a focusable region, so that its columns can be reached by keyboard on a narrow screen', async () => {
    renderAdmin();
    await loaded();
    const region = screen.getByRole('region', { name: 'Audit log, scrollable' });
    expect(region.tabIndex).toBe(0);
    expect(region.contains(auditTable())).toBe(true);
  });

  it('renders every name, detail and action as text, never as markup', async () => {
    const bridge = new StubBridge();
    bridge.registry = bridge.registry.map((member) =>
      member.handle === 'thom' ? { ...member, display_name: '<img src=x onerror="window.__admin_pwn = 1">' } : member,
    );
    bridge.entries = [
      { id: 500, at: '2026-10-11T08:00:00.000Z', actor: 'flan', action: '<b>member_add</b>', target: '<script>window.__admin_pwn = 2</script>', repo: null, message_id: null, detail: { note: '<a href="https://example.invalid">x</a>' } },
      ...bridge.entries,
    ];
    renderAdmin(bridge);
    await loaded();
    expect(cells(memberRow('thom'))[1]).toBe('<img src=x onerror="window.__admin_pwn = 1">');
    const first = (within(auditTable()).getAllByRole('row')[1] as HTMLTableRowElement).cells;
    expect(first[2]?.textContent).toBe('<b>member_add</b>');
    expect(first[3]?.textContent).toBe('target: <script>window.__admin_pwn = 2</script>, note: <a href="https://example.invalid">x</a>');
    expect(document.querySelectorAll('img, script, a, b').length).toBe(0);
    expect(Reflect.get(window, '__admin_pwn')).toBeUndefined();
  });
});

describe('Admin view: loading, empty, failed and not allowed, always in words', () => {
  it('says that it is loading until each list answers', async () => {
    const bridge = new StubBridge();
    const members = bridge.hold('members');
    const audit = bridge.hold('audit');
    renderAdmin(bridge);
    expect(screen.getByText('Loading members…')).toBeTruthy();
    expect(screen.getByText('Loading the audit log…')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    members.release();
    await screen.findByRole('table', { name: 'Members' });
    expect(screen.getByText('Loading the audit log…')).toBeTruthy();
    audit.release();
    await screen.findByRole('table', { name: 'Audit log' });
    expect(screen.queryByText(/Loading/)).toBeNull();
  });

  it('says so when there is nothing to list', async () => {
    const bridge = new StubBridge();
    bridge.registry = [];
    bridge.entries = [];
    renderAdmin(bridge);
    expect(await screen.findByText('There are no members yet.')).toBeTruthy();
    expect(await screen.findByText('The audit log is empty.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it("shows the bridge's message when a list fails, and loads it again on request", async () => {
    const bridge = new StubBridge();
    bridge.failNext('members', new ApiError(500, ERROR_CODES.internal, 'internal error'));
    const { user } = renderAdmin(bridge);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Could not load the members: internal error');
    expect(screen.queryByRole('table', { name: 'Members' })).toBeNull();
    await screen.findByRole('table', { name: 'Audit log' });
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('table', { name: 'Members' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says that it is loading again while a retry is out, instead of leaving the old failure on screen', async () => {
    const bridge = new StubBridge();
    bridge.failNext('members', new NetworkError('could not reach the bridge'));
    const { user } = renderAdmin(bridge);
    await screen.findByText('Could not load the members: could not reach the bridge');
    const retry = bridge.hold('members');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('Loading members…')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    retry.release();
    await screen.findByRole('table', { name: 'Members' });
  });

  it('says plainly when the bridge cannot be reached', async () => {
    const bridge = new StubBridge();
    bridge.failNext('audit', new NetworkError('could not reach the bridge'));
    renderAdmin(bridge);
    expect((await screen.findByRole('alert')).textContent).toBe('Could not load the audit log: could not reach the bridge');
    expect(await screen.findByRole('table', { name: 'Members' })).toBeTruthy();
  });

  it('says that the page is for admins when the bridge answers 403 admin_only, and offers no way to add', async () => {
    const bridge = new StubBridge();
    const refusal = () => new ApiError(403, ERROR_CODES.adminOnly, 'admin only');
    bridge.failNext('members', refusal());
    bridge.failNext('audit', refusal());
    renderAdmin(bridge);
    expect(await screen.findByText('Only admins can see and change the members.')).toBeTruthy();
    expect(await screen.findByText('Only admins can read the audit log.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add member' })).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('does not call a 403 with another code a matter of admin rights, and keeps Add member', async () => {
    const bridge = new StubBridge();
    bridge.failNext('members', new ApiError(403, ERROR_CODES.notRegistered, 'your Tailscale login is not registered as a member'));
    renderAdmin(bridge);
    expect((await screen.findByRole('alert')).textContent).toBe('Could not load the members: your Tailscale login is not registered as a member');
    expect(screen.queryByText('Only admins can see and change the members.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add member' })).toBeTruthy();
  });

  it('keeps the rows on screen and says so when a reload fails', async () => {
    const bridge = new StubBridge();
    const { user } = renderAdmin(bridge);
    await loaded();
    bridge.failNext('members', new NetworkError('could not reach the bridge'));
    await user.click(screen.getByRole('button', { name: 'Edit ezra' }));
    await user.clear(screen.getByLabelText('Display name'));
    await user.type(screen.getByLabelText('Display name'), 'Ezra R.');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Could not load the members: could not reach the bridge');
    expect(membersTable()).toBeTruthy();
  });

  it('says in fixed words that something went wrong when the api throws instead of rejecting, and does not repeat what it threw', async () => {
    const bridge = new StubBridge();
    bridge.members = () => {
      throw new Error('threw cb_not_a_real_token');
    };
    renderAdmin(bridge);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Could not load the members: Something went wrong.');
    expect(await screen.findByRole('table', { name: 'Audit log' })).toBeTruthy();
  });

  it('does not let a late failure replace a newer answer', async () => {
    const bridge = new StubBridge();
    const slow = bridge.hold('members');
    const { user } = renderAdmin(bridge);
    await screen.findByRole('table', { name: 'Audit log' });
    await user.click(screen.getByRole('button', { name: 'Add member' }));
    await user.type(screen.getByLabelText('Handle'), 'newest');
    await user.type(screen.getByLabelText('Display name'), 'Newest');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await screen.findByRole('table', { name: 'Members' });
    // Queued only now, so that the held first load is the one that takes it, when it is let go.
    bridge.failNext('members', new NetworkError('too late'));
    slow.release();
    await settle();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(within(membersTable()).getByText('newest')).toBeTruthy();
  });

  it('shows only the newest answer when two loads overlap', async () => {
    const bridge = new StubBridge();
    const slow = bridge.hold('members');
    const { user } = renderAdmin(bridge);
    await screen.findByRole('table', { name: 'Audit log' });
    // A change made while the first load is still out starts a second one that finishes first.
    await user.click(screen.getByRole('button', { name: 'Add member' }));
    await user.type(screen.getByLabelText('Handle'), 'newest');
    await user.type(screen.getByLabelText('Display name'), 'Newest');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await screen.findByRole('table', { name: 'Members' });
    expect(within(membersTable()).getByText('newest')).toBeTruthy();
    slow.release();
    await waitFor(() => expect(bridge.callsTo('members')).toHaveLength(2));
    await settle();
    // The first load was answered with the registry as it was before the add; it must not win.
    expect(within(membersTable()).getByText('newest')).toBeTruthy();
  });
});

describe('Admin view: add member', () => {
  const openAdd = async (user: User): Promise<HTMLElement> => {
    await user.click(screen.getByRole('button', { name: 'Add member' }));
    return screen.getByRole('dialog', { name: 'Add member' });
  };

  it('opens a dialog with the labelled fields and the defaults the contract gives', async () => {
    const { user } = renderAdmin();
    await loaded();
    const dialog = within(await openAdd(user));
    expect((dialog.getByLabelText('Handle') as HTMLInputElement).value).toBe('');
    expect((dialog.getByLabelText('Display name') as HTMLInputElement).value).toBe('');
    const kind = dialog.getByLabelText('Kind') as HTMLSelectElement;
    expect(Array.from(kind.options, (option) => option.textContent)).toEqual(['Human', 'Computational']);
    expect(kind.value).toBe('human');
    const role = dialog.getByLabelText('Role') as HTMLSelectElement;
    expect(Array.from(role.options, (option) => option.textContent)).toEqual(['Member', 'Admin']);
    expect(role.value).toBe('member');
    expect((dialog.getByLabelText('Tailscale login (optional)') as HTMLInputElement).value).toBe('');
    expect((dialog.getByLabelText('Can address agents') as HTMLInputElement).checked).toBe(true);
    expect(document.activeElement).toBe(dialog.getByLabelText('Handle'));
    // What the choice of Kind means is said next to it, and the field is described by it.
    const hint = dialog.getByText('A computational member gets an access token, shown once.');
    expect(kind.getAttribute('aria-describedby')).toBe(hint.id);
  });

  it('closes on Cancel without sending anything, and focus goes back to Add member', async () => {
    const { user, bridge, refreshDirectory } = renderAdmin();
    await loaded();
    const dialog = within(await openAdd(user));
    await user.type(dialog.getByLabelText('Handle'), 'maybe');
    await user.click(dialog.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(bridge.callsTo('addMember')).toHaveLength(0);
    expect(refreshDirectory).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add member' }));
  });

  it('names the rule for a bad handle next to the field and sends nothing', async () => {
    const { user, bridge } = renderAdmin();
    await loaded();
    const dialog = within(await openAdd(user));
    await user.type(dialog.getByLabelText('Display name'), 'Somebody');
    const handle = dialog.getByLabelText('Handle');
    await user.type(handle, 'Bad Handle');
    await user.click(dialog.getByRole('button', { name: 'Add' }));
    expect(handle.getAttribute('aria-invalid')).toBe('true');
    const described = (handle.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent);
    expect(described).toContain(HANDLE_RULE);
    expect(document.activeElement).toBe(handle);
    expect(bridge.callsTo('addMember')).toHaveLength(0);
    // Fixing the handle clears the message without another press.
    await user.clear(handle);
    await user.type(handle, 'somebody');
    expect(handle.hasAttribute('aria-invalid')).toBe(false);
    expect(document.getElementById(`${handle.id}-error`)).toBeNull();
  });

  it('refuses the handle "everyone" before anything is sent', async () => {
    const { user, bridge } = renderAdmin();
    await loaded();
    const dialog = within(await openAdd(user));
    await user.type(dialog.getByLabelText('Handle'), 'everyone');
    await user.type(dialog.getByLabelText('Display name'), 'Everyone');
    await user.click(dialog.getByRole('button', { name: 'Add' }));
    expect(dialog.getByLabelText('Handle').getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(`${dialog.getByLabelText('Handle').id}-error`)?.textContent).toMatch(/everyone/);
    expect(bridge.callsTo('addMember')).toHaveLength(0);
    expect(screen.getByRole('dialog', { name: 'Add member' })).toBeTruthy();
  });

  it('asks for a display name and puts focus there, once the handle is fine', async () => {
    const { user, bridge } = renderAdmin();
    await loaded();
    const dialog = within(await openAdd(user));
    await user.type(dialog.getByLabelText('Handle'), 'fine');
    await user.click(dialog.getByRole('button', { name: 'Add' }));
    const name = dialog.getByLabelText('Display name');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(`${name.id}-error`)?.textContent).toBe('Enter a display name.');
    // The message is tied to the field, so that a screen reader reads it when focus arrives.
    expect((name.getAttribute('aria-describedby') ?? '').split(' ')).toContain(`${name.id}-error`);
    expect(document.activeElement).toBe(name);
    expect(dialog.getByLabelText('Handle').hasAttribute('aria-invalid')).toBe(false);
    expect(bridge.callsTo('addMember')).toHaveLength(0);
  });

  it('adds a human: sends the typed fields, closes, refreshes the directory once and the lists, and announces it', async () => {
    const { user, bridge, refreshDirectory } = renderAdmin();
    await loaded();
    const dialog = within(await openAdd(user));
    await user.type(dialog.getByLabelText('Handle'), '  ivy  ');
    await user.type(dialog.getByLabelText('Display name'), 'Ivy');
    await user.selectOptions(dialog.getByLabelText('Role'), 'Admin');
    await user.type(dialog.getByLabelText('Tailscale login (optional)'), 'ivy@example.com');
    await user.click(dialog.getByLabelText('Can address agents'));
    await user.click(dialog.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(bridge.callsTo('addMember').map((call) => call.args)).toEqual([
      [{ handle: 'ivy', kind: 'human', display_name: 'Ivy', role: 'admin', can_address_agents: false, tailscale_login: 'ivy@example.com' }],
    ]);
    expect(refreshDirectory).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(within(membersTable()).getByText('ivy')).toBeTruthy());
    expect(cells(memberRow('ivy')).slice(0, 6)).toEqual(['ivy', 'Ivy', 'Human', 'Admin', 'No', 'Active']);
    expect(bridge.callsTo('members')).toHaveLength(2);
    expect(bridge.callsTo('audit')).toHaveLength(2);
    expect(status().textContent).toBe('Member added');
    // A human has no token to show, and focus is back on the button that opened the form.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add member' }));
    await waitFor(() => expect(within(auditTable()).getAllByRole('row')[1]?.textContent).toContain('member_add'));
  });

  it('adds a computational member and opens the token dialog in place of the form', async () => {
    const { user, bridge, refreshDirectory } = renderAdmin();
    await loaded();
    const dialog = within(await openAdd(user));
    await user.type(dialog.getByLabelText('Handle'), 'kestrel');
    await user.type(dialog.getByLabelText('Display name'), 'Kestrel');
    await user.selectOptions(dialog.getByLabelText('Kind'), 'Computational');
    await user.click(dialog.getByRole('button', { name: 'Add' }));
    await screen.findByRole('dialog', { name: 'New token for kestrel' });
    expect(screen.queryByRole('dialog', { name: 'Add member' })).toBeNull();
    expect(bridge.callsTo('addMember')[0]?.args).toEqual([
      { handle: 'kestrel', kind: 'computational', display_name: 'Kestrel', role: 'member', can_address_agents: true, tailscale_login: null },
    ]);
    expect(refreshDirectory).toHaveBeenCalledTimes(1);
    expect(status().textContent).toBe('Member added');
    // A count, never the list: a failing comparison would print the tokens in it.
    expect(bridge.issued.length).toBe(1);
  });

  it.each([
    ['handle_taken', 'thom', '', 'member "thom" already exists'],
    ['handle_is_agent', 'codex', '', '"codex" is already a Herdr agent name'],
    ['login_taken', 'newcomer', 'mira@example.com', 'that Tailscale login is already mapped to a member'],
  ])("shows the bridge's refusal %s as an alert in the dialog, keeps what was typed, and changes nothing", async (_code, handle, login, message) => {
    const { user, bridge, refreshDirectory } = renderAdmin();
    await loaded();
    const dialog = within(await openAdd(user));
    await user.type(dialog.getByLabelText('Handle'), handle);
    await user.type(dialog.getByLabelText('Display name'), 'Somebody');
    if (login) await user.type(dialog.getByLabelText('Tailscale login (optional)'), login);
    await user.click(dialog.getByRole('button', { name: 'Add' }));
    const alert = await dialog.findByRole('alert');
    expect(alert.textContent).toBe(message);
    expect((dialog.getByLabelText('Handle') as HTMLInputElement).value).toBe(handle);
    expect(screen.getByRole('dialog', { name: 'Add member' })).toBeTruthy();
    expect(refreshDirectory).not.toHaveBeenCalled();
    expect(bridge.callsTo('members')).toHaveLength(1);
    expect(bridge.callsTo('audit')).toHaveLength(1);
    expect(status().textContent).toBe('');
    expect(bridge.issued.length).toBe(0);
    // The alert goes when the next attempt starts, and a corrected entry then succeeds.
    await user.clear(dialog.getByLabelText('Handle'));
    await user.type(dialog.getByLabelText('Handle'), 'somebody');
    await user.clear(dialog.getByLabelText('Tailscale login (optional)'));
    await user.click(dialog.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(refreshDirectory).toHaveBeenCalledTimes(1);
  });

  it('takes the refusal off the screen while the next attempt is out, and the busy button says so', async () => {
    const bridge = new StubBridge();
    const { user } = renderAdmin(bridge);
    await loaded();
    const dialog = within(await openAdd(user));
    await user.type(dialog.getByLabelText('Handle'), 'thom');
    await user.type(dialog.getByLabelText('Display name'), 'Thom');
    await user.click(dialog.getByRole('button', { name: 'Add' }));
    expect((await dialog.findByRole('alert')).textContent).toBe('member "thom" already exists');
    const retry = bridge.hold('addMember');
    await user.clear(dialog.getByLabelText('Handle'));
    await user.type(dialog.getByLabelText('Handle'), 'thomas');
    await user.click(dialog.getByRole('button', { name: 'Add' }));
    expect(dialog.queryByRole('alert')).toBeNull();
    expect(dialog.getByRole('button', { name: 'Add' }).getAttribute('aria-disabled')).toBe('true');
    retry.release();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('says that a change whose answer never came may have gone through, so that nobody adds the member twice', async () => {
    const bridge = new StubBridge();
    bridge.failNext('addMember', new NetworkError('the connection to the bridge broke during an answer'));
    const { user, refreshDirectory } = renderAdmin(bridge);
    await loaded();
    const dialog = within(await openAdd(user));
    await user.type(dialog.getByLabelText('Handle'), 'maybe');
    await user.type(dialog.getByLabelText('Display name'), 'Maybe');
    await user.click(dialog.getByRole('button', { name: 'Add' }));
    expect((await dialog.findByRole('alert')).textContent).toBe(`the connection to the bridge broke during an answer ${MAYBE_DONE}`);
    expect(refreshDirectory).not.toHaveBeenCalled();
  });

  it('sends once when Add is pressed twice while the first call is out, and marks the button busy', async () => {
    const bridge = new StubBridge();
    const gate = bridge.hold('addMember');
    const { user } = renderAdmin(bridge);
    await loaded();
    const dialog = within(await openAdd(user));
    await user.type(dialog.getByLabelText('Handle'), 'once');
    await user.type(dialog.getByLabelText('Display name'), 'Once');
    const add = dialog.getByRole('button', { name: 'Add' });
    await user.click(add);
    await user.click(add);
    await user.type(dialog.getByLabelText('Display name'), '{Enter}');
    expect(bridge.callsTo('addMember')).toHaveLength(1);
    expect(add.getAttribute('aria-disabled')).toBe('true');
    gate.release();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(bridge.callsTo('addMember')).toHaveLength(1);
  });

  it('still shows the token of a computational member when the form was dismissed while the call was out', async () => {
    const bridge = new StubBridge();
    const gate = bridge.hold('addMember');
    const { user, refreshDirectory } = renderAdmin(bridge);
    await loaded();
    const dialog = within(await openAdd(user));
    await user.type(dialog.getByLabelText('Handle'), 'late');
    await user.type(dialog.getByLabelText('Display name'), 'Late');
    await user.selectOptions(dialog.getByLabelText('Kind'), 'Computational');
    await user.click(dialog.getByRole('button', { name: 'Add' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    gate.release();
    // The member exists and its token exists nowhere else, so it has to be shown.
    await screen.findByRole('dialog', { name: 'New token for late' });
    expect(refreshDirectory).toHaveBeenCalledTimes(1);
  });

  it('closes quietly when a human was added after the form was dismissed, and does not close another dialog', async () => {
    const bridge = new StubBridge();
    const gate = bridge.hold('addMember');
    const { user } = renderAdmin(bridge);
    await loaded();
    const dialog = within(await openAdd(user));
    await user.type(dialog.getByLabelText('Handle'), 'quiet');
    await user.type(dialog.getByLabelText('Display name'), 'Quiet');
    await user.click(dialog.getByRole('button', { name: 'Add' }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Edit ezra' }));
    gate.release();
    await waitFor(() => expect(within(membersTable()).getByText('quiet')).toBeTruthy());
    expect(screen.getByRole('dialog', { name: 'Edit ezra' })).toBeTruthy();
    expect(status().textContent).toBe('Member added');
  });
});

describe('Admin view: edit member', () => {
  const openEdit = async (user: User, handle: string): Promise<HTMLElement> => {
    await user.click(within(memberRow(handle)).getByRole('button', { name: `Edit ${handle}` }));
    return screen.getByRole('dialog', { name: `Edit ${handle}` });
  };

  it('starts from the member as it is and has no handle field', async () => {
    const { user } = renderAdmin();
    await loaded();
    const dialog = within(await openEdit(user, 'mira'));
    expect((dialog.getByLabelText('Display name') as HTMLInputElement).value).toBe('Mira');
    expect((dialog.getByLabelText('Kind') as HTMLSelectElement).value).toBe('human');
    expect((dialog.getByLabelText('Role') as HTMLSelectElement).value).toBe('member');
    expect((dialog.getByLabelText('Tailscale login (optional)') as HTMLInputElement).value).toBe('mira@example.com');
    expect((dialog.getByLabelText('Can address agents') as HTMLInputElement).checked).toBe(true);
    expect(dialog.queryByLabelText('Handle')).toBeNull();
  });

  it('closes on Cancel without sending anything, and focus goes back to the Edit button', async () => {
    const { user, bridge } = renderAdmin();
    await loaded();
    const dialog = within(await openEdit(user, 'ezra'));
    await user.type(dialog.getByLabelText('Display name'), '!');
    await user.click(dialog.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(bridge.callsTo('updateMember')).toHaveLength(0);
    expect(document.activeElement).toBe(within(memberRow('ezra')).getByRole('button', { name: 'Edit ezra' }));
    expect(cells(memberRow('ezra'))[1]).toBe('Ezra');
  });

  it('shows a member who may not address agents with the box unchecked', async () => {
    const { user } = renderAdmin();
    await loaded();
    const dialog = within(await openEdit(user, 'kieran'));
    expect((dialog.getByLabelText('Can address agents') as HTMLInputElement).checked).toBe(false);
  });

  it('patches only what changed, closes, refreshes the directory once and the lists, announces it and keeps focus on the button', async () => {
    const { user, bridge, refreshDirectory } = renderAdmin();
    await loaded();
    const dialog = within(await openEdit(user, 'ezra'));
    await user.clear(dialog.getByLabelText('Display name'));
    await user.type(dialog.getByLabelText('Display name'), 'Ezra R.');
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(bridge.callsTo('updateMember').map((call) => call.args)).toEqual([['ezra', { display_name: 'Ezra R.' }]]);
    expect(refreshDirectory).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(cells(memberRow('ezra'))[1]).toBe('Ezra R.'));
    expect(status().textContent).toBe('Member changed');
    expect(bridge.callsTo('members')).toHaveLength(2);
    expect(bridge.callsTo('audit')).toHaveLength(2);
    // The rows were updated in place, not rebuilt: the button that opened the form is the one with focus.
    expect(document.activeElement).toBe(within(memberRow('ezra')).getByRole('button', { name: 'Edit ezra' }));
  });

  it('changes kind, role, agent permission and login together, and clears a login with null', async () => {
    const { user, bridge } = renderAdmin();
    await loaded();
    const dialog = within(await openEdit(user, 'mira'));
    await user.selectOptions(dialog.getByLabelText('Kind'), 'Computational');
    await user.selectOptions(dialog.getByLabelText('Role'), 'Admin');
    await user.click(dialog.getByLabelText('Can address agents'));
    await user.clear(dialog.getByLabelText('Tailscale login (optional)'));
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(bridge.callsTo('updateMember')[0]?.args).toEqual([
      'mira',
      { kind: 'computational', role: 'admin', can_address_agents: false, tailscale_login: null },
    ]);
    await waitFor(() => expect(cells(memberRow('mira')).slice(2, 6)).toEqual(['Computational', 'Admin', 'No', 'Active']));
  });

  it('lets a revoked member be edited, which is how its Tailscale login is freed for someone else', async () => {
    const bridge = new StubBridge();
    bridge.registry = bridge.registry.map((member) => (member.handle === 'temp' ? { ...member, tailscale_login: 'temp@example.com' } : member));
    const { user } = renderAdmin(bridge);
    await loaded();
    const dialog = within(await openEdit(user, 'temp'));
    expect((dialog.getByLabelText('Tailscale login (optional)') as HTMLInputElement).value).toBe('temp@example.com');
    await user.clear(dialog.getByLabelText('Tailscale login (optional)'));
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(bridge.callsTo('updateMember')[0]?.args).toEqual(['temp', { tailscale_login: null }]);
    expect(cells(memberRow('temp'))[5]).toBe('Revoked');
  });

  it("keeps a revoked member's login taken until Edit clears it: the add is refused with the bridge's bare error, then goes through", async () => {
    const bridge = new StubBridge();
    bridge.registry = bridge.registry.map((member) => (member.handle === 'temp' ? { ...member, tailscale_login: 'temp@example.com' } : member));
    const { user, refreshDirectory } = renderAdmin(bridge);
    await loaded();
    const add = async (): Promise<void> => {
      await user.click(screen.getByRole('button', { name: 'Add member' }));
      await user.type(screen.getByLabelText('Handle'), 'newcomer');
      await user.type(screen.getByLabelText('Display name'), 'Newcomer');
      await user.type(screen.getByLabelText('Tailscale login (optional)'), 'temp@example.com');
      await user.click(screen.getByRole('button', { name: 'Add' }));
    };
    await add();
    expect((await screen.findByRole('alert')).textContent).toBe('internal error');
    expect(refreshDirectory).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    const dialog = within(await openEdit(user, 'temp'));
    await user.clear(dialog.getByLabelText('Tailscale login (optional)'));
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await add();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(within(membersTable()).getByText('newcomer')).toBeTruthy());
  });

  it('says so and sends nothing when nothing was changed', async () => {
    const { user, bridge, refreshDirectory } = renderAdmin();
    await loaded();
    const dialog = within(await openEdit(user, 'ezra'));
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    expect((await dialog.findByRole('alert')).textContent).toBe('Nothing was changed. Edit a field, or choose Cancel.');
    expect(bridge.callsTo('updateMember')).toHaveLength(0);
    expect(refreshDirectory).not.toHaveBeenCalled();
  });

  it('will not save an empty display name', async () => {
    const { user, bridge } = renderAdmin();
    await loaded();
    const dialog = within(await openEdit(user, 'ezra'));
    await user.clear(dialog.getByLabelText('Display name'));
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    expect(dialog.getByLabelText('Display name').getAttribute('aria-invalid')).toBe('true');
    expect(bridge.callsTo('updateMember')).toHaveLength(0);
  });

  it('shows the last-admin refusal as an alert in the dialog, and changes nothing', async () => {
    const { user, bridge, refreshDirectory } = renderAdmin();
    await loaded();
    const dialog = within(await openEdit(user, 'flan'));
    await user.selectOptions(dialog.getByLabelText('Role'), 'Member');
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    expect((await dialog.findByRole('alert')).textContent).toBe('cannot demote the last admin');
    expect(screen.getByRole('dialog', { name: 'Edit flan' })).toBeTruthy();
    expect(refreshDirectory).not.toHaveBeenCalled();
    expect(bridge.registry.find((member) => member.handle === 'flan')?.role).toBe('admin');
    expect(cells(memberRow('flan'))[3]).toBe('Admin');
    expect(status().textContent).toBe('');
    expect(bridge.callsTo('members')).toHaveLength(1);
  });

  it('shows a bare "internal error" as it is, keeps the dialog and what was typed, and changes nothing else', async () => {
    // The real bridge answers a Tailscale login that another member holds with exactly this (observed).
    const { user, bridge, refreshDirectory } = renderAdmin();
    await loaded();
    const dialog = within(await openEdit(user, 'ezra'));
    await user.type(dialog.getByLabelText('Tailscale login (optional)'), 'mira@example.com');
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    expect((await dialog.findByRole('alert')).textContent).toBe('internal error');
    expect((dialog.getByLabelText('Tailscale login (optional)') as HTMLInputElement).value).toBe('mira@example.com');
    expect(screen.getByRole('dialog', { name: 'Edit ezra' })).toBeTruthy();
    expect(refreshDirectory).not.toHaveBeenCalled();
    expect(status().textContent).toBe('');
    expect(bridge.callsTo('members')).toHaveLength(1);
    expect(bridge.callsTo('audit')).toHaveLength(1);
    expect(bridge.registry.find((member) => member.handle === 'ezra')?.tailscale_login).toBeNull();
  });
});

describe('Admin view: revoke', () => {
  const openRevoke = async (user: User, handle: string): Promise<HTMLElement> => {
    await user.click(within(memberRow(handle)).getByRole('button', { name: `Revoke ${handle}` }));
    return screen.getByRole('dialog', { name: `Revoke ${handle}?` });
  };
  const OWN_REVOKE = 'This is your own account, so your access ends at once.';

  it('asks first, in words, and sends nothing until Revoke is chosen', async () => {
    const { user, bridge, refreshDirectory } = renderAdmin();
    await loaded();
    const dialog = within(await openRevoke(user, 'thom'));
    expect(dialog.getByText(/Thom \(thom\) loses access at once/)).toBeTruthy();
    expect(dialog.getByText(/cannot be restored from this page/)).toBeTruthy();
    // The one answer that cannot be taken back is drawn as a danger button, and no other question has one.
    expect(dialog.getByRole('button', { name: 'Revoke' }).className).toContain('button--danger');
    expect(bridge.callsTo('revokeMember')).toHaveLength(0);
    expect(refreshDirectory).not.toHaveBeenCalled();
    // Focus starts on the safe answer.
    expect(document.activeElement).toBe(dialog.getByRole('button', { name: 'Cancel' }));
  });

  it('does nothing when the question is cancelled or dismissed, and focus goes back to the button that asked', async () => {
    const { user, bridge } = renderAdmin();
    await loaded();
    const opener = within(memberRow('thom')).getByRole('button', { name: 'Revoke thom' });
    await openRevoke(user, 'thom');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    await openRevoke(user, 'thom');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(bridge.callsTo('revokeMember')).toHaveLength(0);
    expect(cells(memberRow('thom'))[5]).toBe('Active');
  });

  it('revokes on confirmation: one call, the row turns Revoked and keeps only Edit, the directory and lists refresh, and it is announced', async () => {
    const { user, bridge, refreshDirectory } = renderAdmin();
    await loaded();
    await openRevoke(user, 'thom');
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(bridge.callsTo('revokeMember').map((call) => call.args)).toEqual([['thom']]);
    expect(refreshDirectory).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(cells(memberRow('thom'))[5]).toBe('Revoked'));
    expect(status().textContent).toBe('Member revoked');
    expect(within(memberRow('thom')).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Edit thom']);
    await waitFor(() => expect(within(auditTable()).getAllByRole('row')[1]?.textContent).toContain('member_revoke'));
  });

  it('puts focus on the revoked member\'s Edit button once the Revoke button it came from is gone', async () => {
    const { user } = renderAdmin();
    await loaded();
    await openRevoke(user, 'thom');
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(cells(memberRow('thom'))[5]).toBe('Revoked'));
    await waitFor(() => expect(document.activeElement).toBe(within(memberRow('thom')).getByRole('button', { name: 'Edit thom' })));
  });

  it('moves focus in the same tick that the Revoke button goes away, so that it is never on the page itself in between', async () => {
    const { user } = renderAdmin();
    await loaded();
    await openRevoke(user, 'thom');
    // A callback for each change to the table runs right after the render that made it, and notes where focus is then.
    const whereFocusWas: Array<Element | null> = [];
    const watcher = new MutationObserver(() => whereFocusWas.push(document.activeElement));
    watcher.observe(membersTable(), { childList: true, subtree: true });
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(cells(memberRow('thom'))[5]).toBe('Revoked'));
    watcher.disconnect();
    expect(whereFocusWas.length).toBeGreaterThan(0);
    expect(whereFocusWas.includes(document.body)).toBe(false);
  });

  it('does not take focus back from where the person has put it while the list was reloading', async () => {
    const bridge = new StubBridge();
    const { user } = renderAdmin(bridge);
    await loaded();
    await openRevoke(user, 'thom');
    const reload = bridge.hold('members');
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const elsewhere = screen.getByRole('button', { name: 'Add member' });
    elsewhere.focus();
    reload.release();
    await waitFor(() => expect(cells(memberRow('thom'))[5]).toBe('Revoked'));
    await settle();
    expect(document.activeElement).toBe(elsewhere);
  });

  it('shows the last-admin refusal in the dialog and leaves the member active', async () => {
    const { user, refreshDirectory } = renderAdmin();
    await loaded();
    await openRevoke(user, 'flan');
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    expect((await screen.findByRole('alert')).textContent).toBe('cannot revoke the last admin');
    expect(screen.getByRole('dialog', { name: 'Revoke flan?' })).toBeTruthy();
    expect(cells(memberRow('flan'))[5]).toBe('Active');
    expect(refreshDirectory).not.toHaveBeenCalled();
    expect(status().textContent).toBe('');
  });

  it('adds one sentence about your own account when the question is about it, and only then', async () => {
    const { user } = renderAdmin(new StubBridge(), { selfHandle: 'flan' });
    await loaded();
    await openRevoke(user, 'flan');
    expect(screen.getByText(OWN_REVOKE)).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Revoke flan?' }).getAttribute('aria-describedby')).toBe(screen.getByText(OWN_REVOKE).parentElement?.id);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await openRevoke(user, 'thom');
    expect(screen.queryByText(OWN_REVOKE)).toBeNull();
  });

  it('says nothing about an own account when it is not told who is signed in', async () => {
    const { user } = renderAdmin();
    await loaded();
    await openRevoke(user, 'flan');
    expect(screen.queryByText(OWN_REVOKE)).toBeNull();
  });

  it('sends the confirmation once, whatever the number of presses', async () => {
    const bridge = new StubBridge();
    const gate = bridge.hold('revokeMember');
    const { user } = renderAdmin(bridge);
    await loaded();
    await openRevoke(user, 'thom');
    const confirm = screen.getByRole('button', { name: 'Revoke' });
    await user.click(confirm);
    await user.click(confirm);
    expect(bridge.callsTo('revokeMember')).toHaveLength(1);
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    gate.release();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(bridge.callsTo('revokeMember')).toHaveLength(1);
  });
});

describe('Admin view: rotate token', () => {
  const openRotate = async (user: User, handle: string): Promise<HTMLElement> => {
    await user.click(within(memberRow(handle)).getByRole('button', { name: `Rotate token for ${handle}` }));
    return screen.getByRole('dialog', { name: `Rotate token for ${handle}?` });
  };
  const OWN_ROTATE = 'This is your own account, so your current token stops working at once.';

  it('asks first, says that the old token stops working, and sends nothing until Rotate is chosen', async () => {
    const { user, bridge, refreshDirectory } = renderAdmin();
    await loaded();
    const dialog = within(await openRotate(user, 'mira'));
    expect(dialog.getByText(/current token for mira stops working at once/)).toBeTruthy();
    expect(dialog.getByRole('button', { name: 'Rotate' }).className).not.toContain('button--danger');
    expect(bridge.callsTo('rotateToken')).toHaveLength(0);
    expect(refreshDirectory).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(dialog.getByRole('button', { name: 'Cancel' }));
  });

  it('does nothing when the question is cancelled or dismissed', async () => {
    const { user, bridge } = renderAdmin();
    await loaded();
    await openRotate(user, 'mira');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await openRotate(user, 'mira');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(bridge.callsTo('rotateToken')).toHaveLength(0);
  });

  it('rotates on confirmation and opens the new token in place of the question', async () => {
    const { user, bridge, refreshDirectory } = renderAdmin();
    await loaded();
    await openRotate(user, 'mira');
    await user.click(screen.getByRole('button', { name: 'Rotate' }));
    await screen.findByRole('dialog', { name: 'New token for mira' });
    expect(screen.queryByRole('dialog', { name: 'Rotate token for mira?' })).toBeNull();
    expect(bridge.callsTo('rotateToken').map((call) => call.args)).toEqual([['mira']]);
    expect(refreshDirectory).toHaveBeenCalledTimes(1);
    expect(status().textContent).toBe('Token rotated');
    await waitFor(() => expect(within(auditTable()).getAllByRole('row')[1]?.textContent).toContain('token_rotate'));
  });

  it("shows the bridge's refusal in the dialog", async () => {
    const bridge = new StubBridge();
    bridge.failNext('rotateToken', new ApiError(404, ERROR_CODES.noSuchMember, 'no active member "mira"'));
    const { user, refreshDirectory } = renderAdmin(bridge);
    await loaded();
    await openRotate(user, 'mira');
    await user.click(screen.getByRole('button', { name: 'Rotate' }));
    expect((await screen.findByRole('alert')).textContent).toBe('no active member "mira"');
    expect(screen.getByRole('dialog', { name: 'Rotate token for mira?' })).toBeTruthy();
    expect(refreshDirectory).not.toHaveBeenCalled();
    expect(bridge.issued.length).toBe(0);
  });

  it('adds one sentence about your own account when the question is about it, and only then', async () => {
    const { user } = renderAdmin(new StubBridge(), { selfHandle: 'flan' });
    await loaded();
    await openRotate(user, 'flan');
    expect(screen.getByText(OWN_ROTATE)).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Rotate token for flan?' }).getAttribute('aria-describedby')).toBe(screen.getByText(OWN_ROTATE).parentElement?.id);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await openRotate(user, 'mira');
    expect(screen.queryByText(OWN_ROTATE)).toBeNull();
  });

  it('says nothing about an own account when it is not told who is signed in', async () => {
    const { user } = renderAdmin();
    await loaded();
    await openRotate(user, 'flan');
    expect(screen.queryByText(OWN_ROTATE)).toBeNull();
  });
});

describe('Admin view: after a change', () => {
  it('puts a fresh node in the status for each success, so that a repeated text is read again', async () => {
    const { user } = renderAdmin();
    await loaded();
    const seen: Element[] = [];
    for (const name of ['Ezra R.', 'Ezra Q.']) {
      await user.click(within(memberRow('ezra')).getByRole('button', { name: 'Edit ezra' }));
      await user.clear(screen.getByLabelText('Display name'));
      await user.type(screen.getByLabelText('Display name'), name);
      await user.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(cells(memberRow('ezra'))[1]).toBe(name));
      const node = status().firstElementChild;
      if (node) seen.push(node);
    }
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[0]?.isConnected).toBe(false);
  });

  const CHANGES: Array<[string, (user: User) => Promise<void>]> = [
    [
      'adding a member',
      async (user) => {
        await user.click(screen.getByRole('button', { name: 'Add member' }));
        await user.type(screen.getByLabelText('Handle'), 'fresh');
        await user.type(screen.getByLabelText('Display name'), 'Fresh');
        await user.click(screen.getByRole('button', { name: 'Add' }));
      },
    ],
    [
      'editing a member',
      async (user) => {
        await user.click(screen.getByRole('button', { name: 'Edit ezra' }));
        await user.type(screen.getByLabelText('Display name'), '!');
        await user.click(screen.getByRole('button', { name: 'Save' }));
      },
    ],
    [
      'revoking a member',
      async (user) => {
        await user.click(screen.getByRole('button', { name: 'Revoke ezra' }));
        await user.click(screen.getByRole('button', { name: 'Revoke' }));
      },
    ],
    [
      'rotating a token',
      async (user) => {
        await user.click(screen.getByRole('button', { name: 'Rotate token for ezra' }));
        await user.click(screen.getByRole('button', { name: 'Rotate' }));
      },
    ],
  ];

  it.each(CHANGES)('refreshes the directory once after %s', async (_name, change) => {
    const { user, refreshDirectory, bridge } = renderAdmin();
    await loaded();
    await change(user);
    await waitFor(() => expect(bridge.callsTo('members')).toHaveLength(2));
    expect(refreshDirectory).toHaveBeenCalledTimes(1);
  });

  it.each(CHANGES)('does not refresh the directory when the bridge refuses %s', async (_name, change) => {
    const bridge = new StubBridge();
    for (const method of ['addMember', 'updateMember', 'revokeMember', 'rotateToken']) {
      bridge.failNext(method, new ApiError(409, ERROR_CODES.badRequest, 'refused'));
    }
    const { user, refreshDirectory } = renderAdmin(bridge);
    await loaded();
    await change(user);
    expect((await screen.findByRole('alert')).textContent).toBe('refused');
    expect(refreshDirectory).not.toHaveBeenCalled();
    expect(bridge.callsTo('members')).toHaveLength(1);
    expect(bridge.callsTo('audit')).toHaveLength(1);
  });

  it('survives a refresh that rejects', async () => {
    const { user, refreshDirectory } = renderAdmin();
    await loaded();
    refreshDirectory.mockRejectedValue(new Error('directory unavailable'));
    await user.click(within(memberRow('ezra')).getByRole('button', { name: 'Revoke ezra' }));
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(cells(memberRow('ezra'))[5]).toBe('Revoked'));
    expect(refreshDirectory).toHaveBeenCalledTimes(1);
    expect(status().textContent).toBe('Member revoked');
  });

  it('survives a refresh that throws at once', async () => {
    const { user, refreshDirectory } = renderAdmin();
    await loaded();
    refreshDirectory.mockImplementation(() => {
      throw new Error('not even a promise');
    });
    await user.click(within(memberRow('ezra')).getByRole('button', { name: 'Edit ezra' }));
    await user.clear(screen.getByLabelText('Display name'));
    await user.type(screen.getByLabelText('Display name'), 'Ezra R.');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(cells(memberRow('ezra'))[1]).toBe('Ezra R.'));
    expect(status().textContent).toBe('Member changed');
  });

  it('does not touch the page when its answer arrives after the view is gone, but still refreshes the directory', async () => {
    const bridge = new StubBridge();
    const gate = bridge.hold('updateMember');
    const { user, refreshDirectory } = renderAdmin(bridge);
    await loaded();
    await user.click(within(memberRow('ezra')).getByRole('button', { name: 'Edit ezra' }));
    await user.clear(screen.getByLabelText('Display name'));
    await user.type(screen.getByLabelText('Display name'), 'Ezra R.');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    cleanup();
    gate.release();
    await waitFor(() => expect(refreshDirectory).toHaveBeenCalledTimes(1));
    await settle();
    expect(bridge.callsTo('members')).toHaveLength(1);
  });
});

describe('Admin view: the keyboard', () => {
  it('reaches Add member by Tab, opens it with Enter, adds with Enter and lands back on Add member', async () => {
    const { user, bridge } = renderAdmin();
    await loaded();
    const add = screen.getByRole('button', { name: 'Add member' });
    for (let presses = 0; presses < 20 && document.activeElement !== add; presses += 1) await user.tab();
    expect(document.activeElement).toBe(add);
    await user.keyboard('{Enter}');
    const dialog = screen.getByRole('dialog', { name: 'Add member' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard('keys');
    await user.tab();
    await user.keyboard('Keys{Enter}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(bridge.callsTo('addMember')[0]?.args).toEqual([
      { handle: 'keys', kind: 'human', display_name: 'Keys', role: 'member', can_address_agents: true, tailscale_login: null },
    ]);
    expect(document.activeElement).toBe(add);
  });

  it('returns focus to the button that opened each dialog when Escape closes it', async () => {
    const { user } = renderAdmin();
    await loaded();
    const openers: Array<[string, HTMLElement]> = [
      ['Add member', screen.getByRole('button', { name: 'Add member' })],
      ['Edit ezra', within(memberRow('ezra')).getByRole('button', { name: 'Edit ezra' })],
      ['Revoke ezra?', within(memberRow('ezra')).getByRole('button', { name: 'Revoke ezra' })],
      ['Rotate token for ezra?', within(memberRow('ezra')).getByRole('button', { name: 'Rotate token for ezra' })],
    ];
    for (const [name, opener] of openers) {
      opener.focus();
      await user.keyboard('{Enter}');
      expect(screen.getByRole('dialog', { name })).toBeTruthy();
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement, name).toBe(opener);
    }
  });

  it('keeps Tab and Shift+Tab inside an open dialog', async () => {
    const { user } = renderAdmin();
    await loaded();
    await user.click(screen.getByRole('button', { name: 'Add member' }));
    const dialog = screen.getByRole('dialog', { name: 'Add member' });
    for (let press = 0; press < 12; press += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    for (let press = 0; press < 12; press += 1) {
      await user.tab({ shift: true });
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('confirms a revoke by keyboard alone: Tab from Cancel to Revoke, Enter', async () => {
    const { user, bridge } = renderAdmin();
    await loaded();
    within(memberRow('ezra')).getByRole('button', { name: 'Revoke ezra' }).focus();
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Revoke' }));
    await user.keyboard('{Enter}');
    await waitFor(() => expect(bridge.callsTo('revokeMember').map((call) => call.args)).toEqual([['ezra']]));
  });
});

describe('Admin view: accessibility (axe structural rules)', () => {
  it('reports nothing on the page itself', async () => {
    renderAdmin();
    await loaded();
    await expectNoAxeViolations();
  });

  it('reports nothing on the page for a failed list or a member who is not an admin', async () => {
    const bridge = new StubBridge();
    bridge.failNext('members', new ApiError(403, ERROR_CODES.adminOnly, 'admin only'));
    bridge.failNext('audit', new NetworkError('could not reach the bridge'));
    renderAdmin(bridge);
    await screen.findByText('Only admins can see and change the members.');
    await screen.findByText('Could not load the audit log: could not reach the bridge');
    await expectNoAxeViolations();
  });

  it('reports nothing with Add member open, with its field messages showing, and with a refusal showing', async () => {
    const { user } = renderAdmin();
    await loaded();
    await user.click(screen.getByRole('button', { name: 'Add member' }));
    await expectNoAxeViolations();
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByLabelText('Handle').getAttribute('aria-invalid')).toBe('true');
    await expectNoAxeViolations();
    await user.type(screen.getByLabelText('Handle'), 'thom');
    await user.type(screen.getByLabelText('Display name'), 'Thom');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await screen.findByRole('alert');
    await expectNoAxeViolations();
  });

  it('reports nothing with Edit, Revoke, Rotate and the new token open', async () => {
    const { user } = renderAdmin(new StubBridge(), { selfHandle: 'mira' });
    await loaded();
    await user.click(within(memberRow('mira')).getByRole('button', { name: 'Edit mira' }));
    await expectNoAxeViolations();
    await user.keyboard('{Escape}');
    await user.click(within(memberRow('mira')).getByRole('button', { name: 'Revoke mira' }));
    await expectNoAxeViolations();
    await user.keyboard('{Escape}');
    await user.click(within(memberRow('mira')).getByRole('button', { name: 'Rotate token for mira' }));
    await expectNoAxeViolations();
    await user.click(screen.getByRole('button', { name: 'Rotate' }));
    await screen.findByRole('dialog', { name: 'New token for mira' });
    await expectNoAxeViolations();
  });
});
