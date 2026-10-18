// Guards the fix of the exploratory pass's finding 9 (docs/runbooks/exploratory-pass.md): a direct message
// conversation whose messages are all older than the newest page (100 messages of every conversation the
// member may see) is still on the conversation list. The list used to be built from the loaded messages alone,
// so such a DM had no button until the member pressed "Load older messages" in the channel and nothing hinted
// that it would reveal one. The store now also asks the bridge for the pairs the member may see
// (GET /v1/repos/{key}/conversations) when a repo is selected, so the button is there from the start.
// Runs against its own bridge, with the channel rows written straight into that scratch Chatter database
// (as bridge/test/helpers.js does for agents). The feed's hint for such an entry, and what an admin and a
// third member see, are in explore-9-older-dm-hint-and-privacy.spec.ts.
import path from 'node:path';
import { loadBridgeHelpers, type BridgeEnv } from './harness/bridge';
import { expect, openChat, signIn, test } from './harness/fixtures';
import { dmWith, ui } from './harness/ui';
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

test('explore 9: a direct message conversation older than the newest page is still on the conversation list', async ({ open, world }) => {
  const env = await privateBridge(world);
  try {
    const annToken = env.addMember('ann', { kind: 'human', display_name: 'Ann' });
    env.addMember('bob', { kind: 'human', display_name: 'Bob' });
    expect((await env.post('bob', 'ann', 'Ann, the only private message we ever exchanged')).status).toBe(201);
    await insertPosts(env, 'bob', Array.from({ length: 150 }, (_, i) => `Channel message ${i + 1}`));

    const { page } = await open({ baseURL: env.base });
    await signIn(page, annToken);
    await openChat(page, env.repoInfo.label);
    await expect(ui.feed(page).getByText('Channel message 150')).toBeVisible();
    await expect(ui.conversation(page, dmWith('bob')), 'Ann has a private conversation with Bob, but no button for it is on the list').toBeVisible({ timeout: 3_000 });
  } finally {
    await env.stop();
  }
});
