// Exploratory pass (docs/runbooks/exploratory-pass.md, finding 7). Written to FAIL on the current code.
// The Messages log is `clamp(12rem, 60vh, 48rem)` high (features/chat/feed/feed.css) and sits under the header,
// the navigation and the conversation list, so on a 1280 x 720 window the message box starts below the fold:
// to write, the member scrolls the page first, and while they write they cannot see the newest message and
// the box together. The page needs about 1350 px of window height before the box fits. Runs against its own bridge.
import { loadBridgeHelpers, type BridgeEnv } from '../e2e/harness/bridge';
import { expect, openChat, signIn, test } from '../e2e/harness/fixtures';
import { ui } from '../e2e/harness/ui';
import { POLL_MS, type World } from '../e2e/harness/world';

async function privateBridge(world: World): Promise<BridgeEnv> {
  const { makeEnv } = await loadBridgeHelpers();
  return makeEnv({ staticDir: world.staticDir, pollMs: POLL_MS });
}

test('explore 7: on a 1280 x 720 window the message box is on screen without scrolling the page', async ({ open, world }) => {
  const env = await privateBridge(world);
  try {
    const token = env.addMember('ann', { kind: 'human', display_name: 'Ann' });
    const { page } = await open({ baseURL: env.base, context: { viewport: { width: 1280, height: 720 } } });
    await signIn(page, token);
    await openChat(page, env.repoInfo.label);
    expect(await page.evaluate(() => window.scrollY), 'the page has not been scrolled').toBe(0);
    await expect(ui.messageBox(page), 'the message box starts below the bottom of a 720 px window').toBeInViewport({ ratio: 1 });
  } finally {
    await env.stop();
  }
});
