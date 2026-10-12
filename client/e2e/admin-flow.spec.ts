// The admin panel against the real bridge and real Chatter, in a real browser. It is the one place a
// member's token is on screen (ui-contract sections 4 and 7), so this follows a token from the bridge
// that issued it to the moment the dialog closes: each token shown is proven against the bridge, and
// after each way the "New token" dialog closes no token is left in the page, its storage, its address
// or its console. Written after T7 from the contract and the harness, not from the panel's source.
import { call, HTTP, nonce, ROUTES, type ApiError } from './harness/api';
import { seriousViolations } from './harness/axe';
import { enterChat, expect, signIn, test } from './harness/fixtures';
import { tokenLeaks, TOKEN_SHAPE } from './harness/guard';
import { UI, ui } from './harness/ui';

// Chromium asks for these to read the clipboard back; writing needs only the click that precedes it.
const CLIPBOARD = ['clipboard-read', 'clipboard-write'];
// The panel's own status; the shell's "Connection" and the chat's "Announcements" are other regions.
const ANNOUNCEMENTS = 'Admin announcements';
const THEMES = [
  { theme: UI.theme.light, media: { colorScheme: 'light', contrast: 'no-preference' } },
  { theme: UI.theme.dark, media: { colorScheme: 'dark', contrast: 'no-preference' } },
  { theme: UI.theme.hc, media: { colorScheme: 'light', contrast: 'more' } },
] as const;

test('admin panel: a computational member is added, its token rotated and the member revoked; each token shown works, and is nowhere once the dialog is closed', async ({ open, world }) => {
  const { page, guard } = await open({ context: { permissions: CLIPBOARD } });
  const taken = world.members.hana.handle;
  await signIn(page, world.members.admin.token);
  await ui.viewButton(page, UI.views.admin).click();
  await expect(ui.viewHeading(page, UI.views.admin)).toBeVisible();

  const membersTable = page.getByRole('table', { name: UI.admin.membersTable, exact: true });
  const auditTable = page.getByRole('table', { name: UI.admin.auditTable, exact: true });
  const announcements = page.getByRole('status', { name: ANNOUNCEMENTS, exact: true });
  const rowOf = (handle: string) => membersTable.getByRole('row').filter({ has: page.getByRole('rowheader', { name: handle, exact: true }) });
  await expect(rowOf(world.members.admin.handle)).toBeVisible();
  await expect(auditTable.or(page.getByText('The audit log is empty.'))).toBeVisible();

  const addMember = page.getByRole('button', { name: UI.admin.addMember, exact: true });
  const add = ui.dialog(page, UI.admin.addMember);
  const fillAdd = async (handle: string, kind: 'Human' | 'Computational'): Promise<void> => {
    await add.getByLabel('Handle', { exact: true }).fill(handle);
    await add.getByLabel('Display name', { exact: true }).fill(`Name of ${handle}`);
    await add.getByLabel('Kind', { exact: true }).selectOption({ label: kind });
  };

  // A refusal is the bridge's own, in its words, and the dialog stays for another try.
  await addMember.click();
  await fillAdd(taken, 'Human');
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(add.getByRole('alert')).toHaveText(`member "${taken}" already exists`);
  await add.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(add).toBeHidden();
  await expect(addMember).toBeFocused();

  // Add: the token appears in one read-only field, and it is the bridge's.
  const handle = `adm${nonce()}`;
  await addMember.click();
  await fillAdd(handle, 'Computational');
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  const issued = ui.dialog(page, `${UI.admin.newTokenPrefix}${handle}`);
  await expect(issued).toBeVisible();
  await expect(issued.getByText('This token is shown once')).toBeVisible();
  const field = issued.getByLabel('Token', { exact: true });
  await expect(field).toHaveAttribute('readonly', '');
  await expect(field).toHaveAttribute('autocomplete', 'off');
  // jsdom has no spellcheck property, so only a real browser can say the field is not sent to a spell checker.
  await expect(field).toHaveAttribute('spellcheck', 'false');
  const first = await field.inputValue();
  expect(TOKEN_SHAPE.test(first), 'the field holds a token').toBe(true);
  const me = await call<{ handle: string; kind: string }>(world.baseURL, first, 'GET', ROUTES.me);
  expect(me.status).toBe(HTTP.ok);
  expect(me.body.handle).toBe(handle);
  expect(me.body.kind).toBe('computational');

  await issued.getByRole('button', { name: 'Copy token', exact: true }).click();
  await expect(issued.getByRole('status')).toHaveText('Token copied.');
  // Compared as a boolean: a failing comparison must not print the token.
  expect((await page.evaluate(() => navigator.clipboard.readText())) === first, 'Copy token copied exactly the field').toBe(true);

  // The dialog in each theme. The media is switched while it is open, and the backgrounds prove it took effect.
  const backgrounds: string[] = [];
  for (const { theme, media } of THEMES) {
    await page.emulateMedia(media);
    backgrounds.push(await page.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor));
    expect.soft(await seriousViolations(page), `axe, the New token dialog, theme "${theme}"`).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'light', contrast: 'no-preference' });
  expect(new Set(backgrounds).size, 'the three themes looked different').toBe(THEMES.length);

  // Done: focus goes back to what opened the form, the row and the announcement appear, the token is gone.
  await issued.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(issued).toBeHidden();
  await expect(addMember).toBeFocused();
  expect(await tokenLeaks(page, guard, [first]), 'after Done').toEqual([]);
  await expect(rowOf(handle)).toContainText('Computational');
  await expect(rowOf(handle).getByRole('cell', { name: 'Active', exact: true })).toBeVisible();
  await expect(announcements).toHaveText('Member added');

  // Rotate: asked first, nothing changes until it is confirmed, and Escape closes the new token's dialog.
  const rotate = rowOf(handle).getByRole('button', { name: `Rotate token for ${handle}`, exact: true });
  await rotate.click();
  const asking = ui.dialog(page, `Rotate token for ${handle}?`);
  await expect(asking).toBeVisible();
  expect((await call(world.baseURL, first, 'GET', ROUTES.me)).status, 'nothing happens before Rotate is chosen').toBe(HTTP.ok);
  expect.soft(await seriousViolations(page), 'axe, the Rotate question').toEqual([]);
  await asking.getByRole('button', { name: 'Rotate', exact: true }).click();
  const reissued = ui.dialog(page, `${UI.admin.newTokenPrefix}${handle}`);
  await expect(reissued).toBeVisible();
  const second = await reissued.getByLabel('Token', { exact: true }).inputValue();
  expect(TOKEN_SHAPE.test(second) && second !== first, 'a different token').toBe(true);
  const stale = await call<ApiError>(world.baseURL, first, 'GET', ROUTES.me);
  expect(stale.status, 'the old token stops working at once').toBe(HTTP.unauthorized);
  expect((await call(world.baseURL, second, 'GET', ROUTES.me)).status, 'the new token works').toBe(HTTP.ok);
  await page.keyboard.press('Escape');
  await expect(reissued).toBeHidden();
  await expect(rotate).toBeFocused();
  expect(await tokenLeaks(page, guard, [first, second]), 'after Escape').toEqual([]);
  await expect(announcements).toHaveText('Token rotated');

  // Revoke: asked first; the row says so, keeps only Edit and puts focus there; the token stops working.
  await rowOf(handle).getByRole('button', { name: `Revoke ${handle}`, exact: true }).click();
  const sure = ui.dialog(page, `Revoke ${handle}?`);
  await expect(sure).toBeVisible();
  expect.soft(await seriousViolations(page), 'axe, the Revoke question').toEqual([]);
  await sure.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(sure).toBeHidden();
  await expect(rowOf(handle).getByRole('cell', { name: 'Revoked', exact: true })).toBeVisible();
  await expect(rowOf(handle).getByRole('button')).toHaveCount(1);
  await expect(rowOf(handle).getByRole('button', { name: `Edit ${handle}`, exact: true })).toBeFocused();
  expect((await call(world.baseURL, second, 'GET', ROUTES.me)).status, 'a revoked member\'s token is refused').toBe(HTTP.unauthorized);
  await expect(announcements).toHaveText('Member revoked');

  // The audit log says what was done, newest first, as the bridge recorded it.
  const ours = auditTable.getByRole('row').filter({ hasText: `target: ${handle}` });
  await expect(ours.locator('td:nth-child(3)')).toHaveText(['member_revoke', 'token_rotate', 'member_add']);

  // The whole panel with both tables full, after a revoked row and these audit entries: what the axe spec's scan
  // of the seeded world does not reach.
  for (const { theme, media } of THEMES) {
    await page.emulateMedia(media);
    expect.soft(await seriousViolations(page), `axe, the Admin view with the audit log, theme "${theme}"`).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'light', contrast: 'no-preference' });
  expect(await tokenLeaks(page, guard, [first, second]), 'at the end').toEqual([]);
});

test('admin panel: a member who is not an admin is offered no Admin view, and the bridge refuses the member routes with 403', async ({ open, world }) => {
  const member = world.members.hana;
  const { page } = await enterChat(open, world, member);
  await expect(ui.viewButton(page, UI.views.chat)).toBeVisible();
  await expect(ui.viewButton(page, UI.views.admin)).toHaveCount(0);
  const refused = await call<ApiError>(world.baseURL, member.token, 'GET', ROUTES.members);
  expect(refused.status).toBe(HTTP.forbidden);
  expect(refused.body.error.code).toBe('admin_only');
});
