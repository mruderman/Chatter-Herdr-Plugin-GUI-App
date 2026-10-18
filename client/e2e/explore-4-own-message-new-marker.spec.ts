// Exploratory pass (docs/runbooks/exploratory-pass.md, finding 4), fixed: a member sends the first message of a new
// direct message conversation, the conversation appears and is selected, and no "New messages" separator is drawn
// above the member's OWN message. It used to be: the marker was "the first message of the conversation past the read
// pointer" and nothing excluded the member's own, which are by construction newer than the pointer, although nobody
// else had written and there was nothing new for this member to read. The marker now skips the member's own
// messages (state/store.ts, fixMarker; the fake store does the same, and the conformance suite holds them equal).
// Runs against its own bridge.
import { loadBridgeHelpers, type BridgeEnv } from './harness/bridge';
import { chooseRecipient, expect, openChat, send, signIn, test } from './harness/fixtures';
import { UI, dmWith, ui } from './harness/ui';
import { POLL_MS, type World } from './harness/world';

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
