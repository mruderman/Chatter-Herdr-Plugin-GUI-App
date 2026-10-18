// V5 finding 2 (docs/runbooks/exploratory-pass.md), end to end: an admin who signed in with a token and rotates
// their OWN token stays signed in on the new one. Before the fix the bridge ended the old token's stream at once
// (`bye token_rotated`), the next requests answered 401 and the page swapped the whole app for the Sign in
// view 57 ms after the "New token" dialog opened, so the one-time token was lost and the admin was locked out.
// This follows the new token from the dialog to the bridge: the dialog stays, the page goes on in the Admin
// view and changes things with the new token, a page opened with the new token signs in and one opened with
// the old token is refused, and neither token is anywhere it must not be. Runs against its own bridge, so
// the cast of the shared world keeps its tokens. The token is never printed, passed into the page or asserted
// in a form a failure would echo: it is compared as a boolean and scanned for by the guards.
import { call, HTTP, ROUTES } from './harness/api';
import { loadBridgeHelpers, type BridgeEnv } from './harness/bridge';
import { expect, signIn, test } from './harness/fixtures';
import { tokenLeaks, TOKEN_SHAPE } from './harness/guard';
import { UI, ui } from './harness/ui';
import { POLL_MS, type World } from './harness/world';

const HANDLE = 'selfadmin';
const OTHER = 'kai';
// Longer than the stream's reconnect backoff (up to a second after a bye): a session that was going to end would have.
const LONGER_THAN_A_RECONNECT_MS = 2_500;

async function privateBridge(world: World): Promise<BridgeEnv> {
  const { makeEnv } = await loadBridgeHelpers();
  return makeEnv({ staticDir: world.staticDir, pollMs: POLL_MS });
}

test('own token rotation: the admin keeps the session on the new token, which a fresh page accepts and the old token no longer does', async ({ open, world }) => {
  const env = await privateBridge(world);
  try {
    const first = env.addMember(HANDLE, { kind: 'human', role: 'admin', display_name: 'Self Admin' });
    env.addMember(OTHER, { kind: 'computational', display_name: 'Kai' });
    const { page, guard } = await open({ baseURL: env.base });
    await signIn(page, first);
    await ui.viewButton(page, UI.views.admin).click();
    await expect(ui.viewHeading(page, UI.views.admin)).toBeVisible();
    const membersTable = page.getByRole('table', { name: UI.admin.membersTable, exact: true });
    const auditTable = page.getByRole('table', { name: UI.admin.auditTable, exact: true });
    const rowOf = (handle: string) => membersTable.getByRole('row').filter({ has: page.getByRole('rowheader', { name: handle, exact: true }) });
    await expect(rowOf(OTHER)).toBeVisible();

    // The question names what happens to this session, as well as to the token.
    await page.getByRole('button', { name: `Rotate token for ${HANDLE}`, exact: true }).click();
    const asking = ui.dialog(page, `Rotate token for ${HANDLE}?`);
    await expect(asking).toContainText('This is your own account');
    await expect(asking).toContainText('This session stays signed in');
    await asking.getByRole('button', { name: 'Rotate', exact: true }).click();

    // The dialog is the only place the new token exists. It stays until the person closes it, however long that takes.
    const issued = ui.dialog(page, `${UI.admin.newTokenPrefix}${HANDLE}`);
    await expect(issued).toBeVisible();
    await page.waitForTimeout(LONGER_THAN_A_RECONNECT_MS);
    await expect(issued, 'the "New token" dialog is still there').toBeVisible();
    await expect(ui.signInHeading(page), 'the page did not swap itself for the Sign in view').toHaveCount(0);
    const second = await issued.getByLabel('Token', { exact: true }).inputValue();
    expect(TOKEN_SHAPE.test(second) && second !== first, 'the field holds a new token').toBe(true);
    // The new token is in the dialog and, as everywhere, nowhere else: not in a URL, the console, storage or the page around it.
    expect(await tokenLeaks(page, guard, [first, second]), 'while the dialog is open').toEqual([]);

    await issued.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(issued).toBeHidden();
    expect(await tokenLeaks(page, guard, [first, second]), 'after Done').toEqual([]);

    // Still the same session in the same view: the connection is back (the stream reopened with the new token),
    // and both lists were reloaded with it, the audit log showing the rotation that was just made.
    await expect(ui.connection(page)).toHaveText(UI.status.online);
    await expect(ui.viewHeading(page, UI.views.admin)).toBeVisible();
    await expect(rowOf(HANDLE)).toBeVisible();
    await expect(auditTable.getByRole('row').filter({ hasText: 'token_rotate' }).first()).toBeVisible();

    // And the session can change things as the admin it is: an edit goes to the bridge with the new token, and
    // both lists are loaded again after it.
    await rowOf(OTHER).getByRole('button', { name: `Edit ${OTHER}`, exact: true }).click();
    const edit = ui.dialog(page, `Edit ${OTHER}`);
    await edit.getByLabel('Display name', { exact: true }).fill('Kai Renamed');
    await edit.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(edit).toBeHidden();
    await expect(rowOf(OTHER)).toContainText('Kai Renamed');
    await expect(page.getByRole('status', { name: 'Admin announcements', exact: true })).toHaveText('Member changed');
    await expect(auditTable.getByRole('row').filter({ hasText: 'member_update' }).first()).toBeVisible();

    // The bridge agrees: the new token works, the old one does not.
    expect((await call(env.base, second, 'GET', ROUTES.me)).status, 'the new token works').toBe(HTTP.ok);
    expect((await call(env.base, first, 'GET', ROUTES.me)).status, 'the old token stops working').toBe(HTTP.unauthorized);

    // A page opened with the new token signs in; one opened with the old token is told so.
    const fresh = await open({ baseURL: env.base });
    await signIn(fresh.page, second);
    await expect(ui.viewButton(fresh.page, UI.views.admin)).toBeVisible();
    const stale = await open({ baseURL: env.base });
    await stale.page.goto('/');
    await ui.tokenField(stale.page).fill(first);
    await ui.signInButton(stale.page).click();
    await expect(ui.signInError(stale.page)).toHaveText(`${UI.signIn.failurePrefix}token is invalid or revoked`);
    await expect(ui.signInHeading(stale.page)).toBeVisible();

    expect(await tokenLeaks(page, guard, [first, second]), 'at the end, the admin\'s page').toEqual([]);
    expect(await tokenLeaks(fresh.page, fresh.guard, [first, second]), 'at the end, the page opened with the new token').toEqual([]);
    expect(await tokenLeaks(stale.page, stale.guard, [first, second]), 'at the end, the page that was refused').toEqual([]);
  } finally {
    await env.stop();
  }
});
