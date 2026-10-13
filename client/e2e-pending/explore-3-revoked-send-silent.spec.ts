// Exploratory pass (docs/runbooks/exploratory-pass.md, finding 3). Written to FAIL on the current code.
// After the bridge revokes a member the Connection status says "Access revoked", but the composer stays
// enabled and a send does nothing at all: no request, no "Send error" alert, the draft stays. The contract
// (ui-contract section 3) says a send that does not go through is shown as the "Send error" alert. The
// store returns early for a revoked session (client/src/state/store.ts, send()) without setting sendError.
// Runs against its own bridge so that it changes nothing in the shared world.
import { call, HTTP, ROUTES } from '../e2e/harness/api';
import { loadBridgeHelpers, type BridgeEnv } from '../e2e/harness/bridge';
import { expect, openChat, signIn, test } from '../e2e/harness/fixtures';
import { UI, ui } from '../e2e/harness/ui';
import { POLL_MS, type World } from '../e2e/harness/world';

async function privateBridge(world: World): Promise<BridgeEnv> {
  const { makeEnv } = await loadBridgeHelpers();
  return makeEnv({ staticDir: world.staticDir, pollMs: POLL_MS });
}

test('explore 3: a revoked member who presses Send is told that nothing was sent (the "Send error" alert)', async ({ open, world }) => {
  const env = await privateBridge(world);
  try {
    const token = env.addMember('rev', { kind: 'computational', display_name: 'Rev' });
    const adminToken = env.tokens['flan'];
    if (!adminToken) throw new Error('the private bridge has no admin token');
    const { page } = await open({ baseURL: env.base });
    await signIn(page, token);
    await openChat(page, env.repoInfo.label);

    const revoked = await call(env.base, adminToken, 'DELETE', ROUTES.member('rev'));
    expect(revoked.status).toBe(HTTP.ok);
    await expect(ui.connection(page)).toHaveText(UI.status.revoked);

    // Everything above is the intended behaviour. The next line is the finding.
    await ui.messageBox(page).fill('Does anybody hear me?');
    await ui.sendButton(page).click();
    await expect(ui.sendError(page), 'a send that goes nowhere must say so: no "Send error" alert appeared').toBeVisible({ timeout: 3_000 });
  } finally {
    await env.stop();
  }
});
