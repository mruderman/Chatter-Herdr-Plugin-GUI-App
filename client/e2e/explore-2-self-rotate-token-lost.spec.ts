// Exploratory pass (docs/runbooks/exploratory-pass.md, finding 2), fixed: an admin who signed in with a token and
// rotates their OWN token is shown the "New token for {handle}" dialog and it STAYS until they close it. The bridge
// ends the old token's stream at once (`bye token_rotated`) and refuses the old token from then on, which used to
// swap the whole app for the Sign in view about 60 ms after the dialog opened and take the one-time token with it
// (the admin was then locked out until a token was rotated from the CLI). The store now takes the new token over in
// the moment the answer arrives (state/store.ts, followRotation), so this guards the dialog itself: it is still
// there well after the stream's reconnect, with the token in it. own-token-rotation.spec.ts follows the session
// on the new token after that. Runs against its own bridge so that no cast member is touched.
import { loadBridgeHelpers, type BridgeEnv } from './harness/bridge';
import { expect, signIn, test } from './harness/fixtures';
import { UI, ui } from './harness/ui';
import { POLL_MS, type World } from './harness/world';

const HANDLE = 'selfadmin';

async function privateBridge(world: World): Promise<BridgeEnv> {
  const { makeEnv } = await loadBridgeHelpers();
  return makeEnv({ staticDir: world.staticDir, pollMs: POLL_MS });
}

test('explore 2: an admin who rotates their own token can still read the new token in the "New token" dialog', async ({ open, world }) => {
  const env = await privateBridge(world);
  try {
    const token = env.addMember(HANDLE, { kind: 'human', role: 'admin', display_name: 'Self Admin' });
    const { page } = await open({ baseURL: env.base });
    await signIn(page, token);
    await ui.viewButton(page, UI.views.admin).click();
    await expect(ui.viewHeading(page, UI.views.admin)).toBeVisible();

    await page.getByRole('button', { name: `Rotate token for ${HANDLE}`, exact: true }).click();
    const asking = ui.dialog(page, `Rotate token for ${HANDLE}?`);
    await expect(asking).toContainText('This is your own account');
    const rotated = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/v1/members/${HANDLE}/token`));
    await asking.getByRole('button', { name: 'Rotate', exact: true }).click();
    expect((await rotated).status()).toBe(201);

    // The dialog is the only place the new token exists. A person needs more than a flash to copy it.
    await page.waitForTimeout(1_500);
    const issued = ui.dialog(page, `${UI.admin.newTokenPrefix}${HANDLE}`);
    await expect(issued, 'the "New token" dialog was replaced by the Sign in view; the one-time token is lost').toBeVisible({ timeout: 2_000 });
    await expect(issued.getByLabel('Token', { exact: true })).not.toHaveValue('');
  } finally {
    await env.stop();
  }
});
