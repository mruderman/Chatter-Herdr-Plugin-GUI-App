// Exploratory pass (docs/runbooks/exploratory-pass.md, finding 5). Written to FAIL on the current code.
// "Load older messages" pages the whole repository (`before_id`, 100 rows of every conversation the member
// may see), but the feed shows one conversation. In a direct message conversation whose newest message is
// further back than a page, the first press fetches 100 messages that all belong to other conversations:
// nothing changes on screen, the button stays, and nothing says that anything was loaded. The member has
// to press it again and again, blind, until the conversation's own messages arrive.
// Runs against its own bridge. The channel rows are written straight into that scratch Chatter database
// (as bridge/test/helpers.js does for agents), because 210 Chatter processes would take a minute.
import path from 'node:path';
import { loadBridgeHelpers, type BridgeEnv } from '../e2e/harness/bridge';
import { expect, openChat, signIn, test } from '../e2e/harness/fixtures';
import { dmWith, ui } from '../e2e/harness/ui';
import { POLL_MS, type World } from '../e2e/harness/world';

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

const OLD_DM = 'The one old private message';

test('explore 5: one press of "Load older messages" in a DM shows the member an older message of that DM', async ({ open, world }) => {
  const env = await privateBridge(world);
  try {
    const annToken = env.addMember('ann', { kind: 'human', display_name: 'Ann' });
    env.addMember('bob', { kind: 'human', display_name: 'Bob' });
    expect((await env.post('bob', 'ann', OLD_DM)).status).toBe(201);
    // 210 newer channel messages: the first DM message is two pages back. A recent DM message keeps the
    // conversation itself on the list (finding 9 is about a conversation with nothing recent).
    await insertPosts(env, 'bob', Array.from({ length: 210 }, (_, i) => `Channel message ${i + 1}`));
    expect((await env.post('bob', 'ann', 'A recent private message')).status).toBe(201);

    const { page } = await open({ baseURL: env.base });
    await signIn(page, annToken);
    await openChat(page, env.repoInfo.label);
    await ui.conversation(page, dmWith('bob')).click();
    await expect(ui.conversation(page, dmWith('bob'))).toHaveAttribute('aria-current', 'true');
    await expect(ui.feed(page).getByText(OLD_DM)).toHaveCount(0);

    const older = page.getByRole('button', { name: 'Load older messages', exact: true });
    const fetched = page.waitForResponse((r) => r.url().includes('before_id='));
    await older.click();
    expect((await fetched).status()).toBe(200);

    // After one press the member must have something to show for it: here, the DM's own older message (the
    // shortest honest fix is to keep paging until the conversation gains a message or the history ends).
    await expect(
      ui.feed(page).getByText(OLD_DM),
      'one press of "Load older messages" in a DM fetched a page of other conversations; the view did not change',
    ).toBeVisible({ timeout: 2_000 });
  } finally {
    await env.stop();
  }
});
