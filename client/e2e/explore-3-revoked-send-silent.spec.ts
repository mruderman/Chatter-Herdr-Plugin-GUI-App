// Exploratory pass (docs/runbooks/exploratory-pass.md, finding 3), fixed: after the bridge revokes a member the
// Connection status says "Access revoked" and everything stays readable, and a send now says so. It used to do
// nothing at all: no request, no "Send error" alert, the draft left in the box. The store answers a send in a
// revoked session without a request and sets the error (state/store.ts, send()), and the composer shows it as
// the "Send error" alert: "Not sent: " plus the Connection status's own words and the fact that nothing was sent.
// The draft stays and no message request is made. Runs against its own bridge so that it changes nothing in the
// shared world.
import { call, HTTP, ROUTES } from './harness/api';
import { loadBridgeHelpers, type BridgeEnv } from './harness/bridge';
import { expect, openChat, signIn, test } from './harness/fixtures';
import { UI, ui } from './harness/ui';
import { POLL_MS, type World } from './harness/world';

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

    // Everything above is the intended behaviour. A send now goes nowhere, and says so.
    const posted: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST') posted.push(new URL(request.url()).pathname);
    });
    const draft = 'Does anybody hear me?';
    await ui.messageBox(page).fill(draft);
    await ui.sendButton(page).click();
    await expect(ui.sendError(page), 'a send that goes nowhere must say so: no "Send error" alert appeared').toBeVisible({ timeout: 3_000 });
    await expect(ui.sendError(page)).toHaveText(`${UI.sendErrorPrefix}${UI.status.revoked}, so nothing was sent.`);
    // Nothing was asked of the bridge, the draft is still there to copy, and the page stays readable as it was.
    expect(posted, 'no request was made for the send').toEqual([]);
    await expect(ui.messageBox(page)).toHaveValue(draft);
    await expect(ui.connection(page)).toHaveText(UI.status.revoked);
    await expect(ui.feed(page)).toBeVisible();
  } finally {
    await env.stop();
  }
});
