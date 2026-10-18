// Exploratory pass (docs/runbooks/exploratory-pass.md, finding 6), fixed: a reader scrolls up in a long feed, then
// writes and sends a message, and the sent message is on screen afterwards. It used to stay thousands of pixels out of
// view, with nothing (no "jump to latest", no scroll) to show that the send worked. The reading-position rule ("only a
// reader who was at the bottom follows new messages", features/chat/feed/reading-position.ts) is right for other
// people's messages and still holds for them; the member's own message arriving in the conversation they are looking
// at now takes the feed to the newest message, as if they had been at the bottom.
// Runs against its own bridge, with the channel rows written straight into that scratch Chatter database.
import path from 'node:path';
import { loadBridgeHelpers, type BridgeEnv } from './harness/bridge';
import { expect, openChat, send, signIn, test } from './harness/fixtures';
import { ui } from './harness/ui';
import { POLL_MS, type World } from './harness/world';

async function privateBridge(world: World): Promise<BridgeEnv> {
  const { makeEnv } = await loadBridgeHelpers();
  return makeEnv({ staticDir: world.staticDir, pollMs: POLL_MS });
}

async function insertPosts(env: BridgeEnv, from: string, bodies: string[]): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(env.repoInfo.dir, 'chatter.db'));
  try {
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const insert = db.prepare('INSERT INTO messages (from_agent, to_agent, body, kind, created_at) VALUES (?, ?, ?, ?, ?)');
    db.exec('BEGIN');
    for (const body of bodies) insert.run(from, '#chat', body, 'post', stamp);
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

const REPLY = 'My reply, sent while I was reading old messages';

test('explore 6: after a member sends a message while reading old ones, the sent message is on screen', async ({ open, world }) => {
  const env = await privateBridge(world);
  try {
    const annToken = env.addMember('ann', { kind: 'human', display_name: 'Ann' });
    env.addMember('bob', { kind: 'human', display_name: 'Bob' });
    await insertPosts(env, 'bob', Array.from({ length: 80 }, (_, i) => `Old message ${i + 1}\nsecond line\nthird line`));

    const { page } = await open({ baseURL: env.base });
    await signIn(page, annToken);
    await openChat(page, env.repoInfo.label);
    await expect(ui.feed(page).getByText('Old message 80')).toBeVisible();

    // The reader scrolls back up with the wheel, as a person would.
    await ui.feed(page).hover();
    await page.mouse.wheel(0, -30_000);
    await expect.poll(() => ui.feed(page).evaluate((el) => el.scrollTop), 'the feed was scrolled to its top').toBeLessThan(100);

    await send(page, REPLY);
    await expect(ui.feed(page).getByText(REPLY), 'the sent message arrived in the feed').toHaveCount(1);
    await expect(ui.feed(page).getByText(REPLY), 'the member\'s own message is out of view: the feed stayed where it was').toBeInViewport({ ratio: 1 });
  } finally {
    await env.stop();
  }
});
