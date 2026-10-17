// Exploratory pass (docs/runbooks/exploratory-pass.md, finding 10). Guards the fix: it failed on the code before it.
// A send answers 201 `{ id, pushed, warnings, mentioned_members, delivery }` (SPEC section 5). `warnings` carries
// Chatter's own notice when a mention reaches nobody ("mention @x matches no agent in this repo — not pushed"), and
// `delivery` says "queued" when an agent was addressed but no pane was live. The client parsed both (api/guards.ts)
// and dropped them: the store's send() resolved a bare boolean, so a member who mistyped an agent's name saw a
// normal, successful send and believed the agent was told. Now the composer shows each warning as the bridge gave
// it, as a status beside the message box (send-notice.spec.ts guards the rest of the notice: the queued wording, the
// dismissal, focus, axe and the first screen). The locator is scoped to the composer because the same words are also
// in the visually hidden Announcements region, and a page-wide getByText would find both. Runs against its own bridge.
import { loadBridgeHelpers, type BridgeEnv } from './harness/bridge';
import { expect, openChat, send, signIn, test } from './harness/fixtures';
import { ui } from './harness/ui';
import { POLL_MS, type World } from './harness/world';

async function privateBridge(world: World): Promise<BridgeEnv> {
  const { makeEnv } = await loadBridgeHelpers();
  return makeEnv({ staticDir: world.staticDir, pollMs: POLL_MS });
}

test('explore 10: a mention that reaches nobody is reported to the sender, not only accepted', async ({ open, world }) => {
  const env = await privateBridge(world);
  try {
    const token = env.addMember('ann', { kind: 'human', display_name: 'Ann' });
    // The bridge's own answer, so that this spec cannot pass for the wrong reason: the warning exists.
    const probe = await env.post('ann', '#chat', '@nobodyhere probe through the API');
    expect(probe.status).toBe(201);
    expect(JSON.stringify(probe.body)).toContain('matches no agent');

    const { page } = await open({ baseURL: env.base });
    await signIn(page, token);
    await openChat(page, env.repoInfo.label);
    await send(page, '@nobodyhere is anybody there?');
    await expect(ui.feed(page).getByText('@nobodyhere is anybody there?')).toBeVisible();
    await expect(
      ui.composer(page).getByText(/matches no agent/i),
      'the bridge warned that nobody was notified; the page showed nothing',
    ).toBeVisible({ timeout: 3_000 });
  } finally {
    await env.stop();
  }
});
