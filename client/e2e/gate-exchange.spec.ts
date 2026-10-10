// Gate line 1 (CLAUDE.md, M3; SPEC section 11): two Playwright clients exchange messages end to end
// against a real bridge and real Chatter. The delivery time is logged, not asserted: the 2 s target in
// SPEC section 1 is "proposed, not agreed", so it only shapes a generous timeout.
import { nonce } from './harness/api';
import { enterChat, expect, test, type Opened } from './harness/fixtures';
import { ui } from './harness/ui';

const DELIVERY_TIMEOUT = 15_000;

/** Sends `text` from one browser and returns how long the other took to show it. */
async function deliver(from: Opened, to: Opened, text: string): Promise<number> {
  await ui.messageBox(from.page).fill(text);
  const started = Date.now();
  await ui.sendButton(from.page).click();
  await expect(ui.feed(to.page).getByText(text)).toBeVisible({ timeout: DELIVERY_TIMEOUT });
  const elapsed = Date.now() - started;
  // The sender sees its own message, and the composer cleared because the bridge accepted it.
  await expect(ui.feed(from.page).getByText(text)).toBeVisible();
  await expect(ui.messageBox(from.page)).toHaveValue('');
  return elapsed;
}

test('M3 gate (CLAUDE.md), line 1: two members in separate browsers exchange messages through the real bridge and Chatter', async ({ open, world }, testInfo) => {
  const { hana, kai } = world.members;
  const first = await enterChat(open, world, hana);
  const second = await enterChat(open, world, kai);
  const tag = nonce();

  const there = await deliver(first, second, `Exchange ${tag}: ping`);
  const back = await deliver(second, first, `Exchange ${tag}: pong`);

  for (const [route, ms] of [[`${hana.handle} to ${kai.handle}`, there], [`${kai.handle} to ${hana.handle}`, back]] as const) {
    testInfo.annotations.push({ type: 'delivery', description: `${route}: ${ms} ms` });
    console.log(`delivery ${route}: ${ms} ms (SPEC section 1 proposes 2000 ms; not asserted)`);
  }
});
