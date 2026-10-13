// Exploratory pass (docs/runbooks/exploratory-pass.md, finding 4). Written to FAIL on the current code.
// A member sends the first message of a new direct message conversation. The conversation appears and is
// selected, and the "New messages" separator is drawn above the member's OWN message, because the marker is
// "the first message of the conversation past the read pointer" (state/store.ts, fixMarker) and nothing
// excludes the member's own messages, which are by construction newer than the pointer. Nobody else has
// written; there is nothing new for this member to read. (ui-contract section 3: the marker is for unread
// messages.) Runs against its own bridge.
import { loadBridgeHelpers, type BridgeEnv } from '../e2e/harness/bridge';
import { chooseRecipient, expect, openChat, send, signIn, test } from '../e2e/harness/fixtures';
import { UI, dmWith, ui } from '../e2e/harness/ui';
import { POLL_MS, type World } from '../e2e/harness/world';

async function privateBridge(world: World): Promise<BridgeEnv> {
  const { makeEnv } = await loadBridgeHelpers();
  return makeEnv({ staticDir: world.staticDir, pollMs: POLL_MS });
}

test('explore 4: the first message a member sends in a new DM is not marked "New messages"', async ({ open, world }) => {
  const env = await privateBridge(world);
  try {
    const annToken = env.addMember('ann', { kind: 'human', display_name: 'Ann' });
    env.addMember('bob', { kind: 'human', display_name: 'Bob' });
    const posted = await env.post('bob', UI.channel, 'Welcome to the channel');
    expect(posted.status).toBe(201);

    const { page } = await open({ baseURL: env.base });
    // Ann reads the channel to its end first, so her read pointer is as far on as it can be.
    const read = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/read'));
    await signIn(page, annToken);
    await openChat(page, env.repoInfo.label);
    await expect(ui.feed(page).getByText('Welcome to the channel')).toBeVisible();
    await read;

    await chooseRecipient(page, 'bob');
    await send(page, 'A first private message from Ann');
    await expect(ui.conversation(page, dmWith('bob'))).toHaveAttribute('aria-current', 'true');
    await expect(ui.feed(page).getByText('A first private message from Ann')).toBeVisible();
    await expect(page.getByRole('separator', { name: 'New messages' }), 'a "New messages" separator above Ann\'s own message').toHaveCount(0);
  } finally {
    await env.stop();
  }
});
