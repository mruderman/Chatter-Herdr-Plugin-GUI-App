// Finding 9 of the exploratory pass, beyond the button itself (explore-9-old-dm-not-listed.spec.ts): what the
// member is told when they open a DM none of whose messages is loaded, and who is shown a pair at all.
// The conversation list asks the bridge for the pairs the member may see (GET /v1/repos/{key}/conversations),
// and the bridge answers with the visibility of /messages: a member only the pairs they are in, the admin every
// pair. DM privacy is a hard boundary, so the third member's view is checked on the wire and on the page.
// Each test runs against its own bridge, with the channel rows written straight into that scratch Chatter
// database (as bridge/test/helpers.js does for agents): 150 posts push the one DM past the newest page of 100.
import path from 'node:path';
import type { Page, Response } from '@playwright/test';
import { loadBridgeHelpers, type BridgeEnv } from './harness/bridge';
import { expect, openChat, signIn, test } from './harness/fixtures';
import { adminDm, dmWith, ui } from './harness/ui';
import { POLL_MS, type World } from './harness/world';

// Written out as the feed shows it, not read from the component.
const OLDER_HINT = 'Its messages are older than the ones loaded. Press Load older messages to bring them in.';
const LOAD_OLDER = 'Load older messages';
const PRIVATE_WORD = 'Ann, the only private message we ever exchanged';
const POSTS = 150;

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

/** Resolves with the bridge's answer to the conversation list, so that a page is only judged once it has been asked. */
function conversationAnswer(page: Page): Promise<Response> {
  return page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/conversations'));
}

/** A bridge with bob's one DM to ann, older than `POSTS` posts that `poster` wrote in the channel. */
async function withOlderDm(world: World, poster: string): Promise<BridgeEnv> {
  const env = await privateBridge(world);
  env.addMember('ann', { kind: 'human', display_name: 'Ann' });
  env.addMember('bob', { kind: 'human', display_name: 'Bob' });
  env.addMember('cara', { kind: 'human', display_name: 'Cara' });
  expect((await env.post('bob', 'ann', PRIVATE_WORD)).status).toBe(201);
  await insertPosts(env, poster, Array.from({ length: POSTS }, (_, i) => `Channel message ${i + 1}`));
  return env;
}

test('explore 9: opening a DM none of whose messages is loaded says what to press, and pressing it brings the messages in', async ({ open, world }) => {
  const env = await withOlderDm(world, 'bob');
  try {
    const { page } = await open({ baseURL: env.base });
    await signIn(page, env.tokens.ann ?? '');
    await openChat(page, env.repoInfo.label);
    await expect(ui.feed(page).getByText(`Channel message ${POSTS}`)).toBeVisible();
    await ui.conversation(page, dmWith('bob')).click();
    await expect(ui.conversation(page, dmWith('bob'))).toHaveAttribute('aria-current', 'true');
    await expect(ui.feed(page)).toHaveText(OLDER_HINT);
    // The hint names the button, and the button is there.
    const older = page.getByRole('button', { name: LOAD_OLDER, exact: true });
    await expect(older).toBeVisible();
    await older.click();
    await expect(ui.feed(page).getByText(PRIVATE_WORD)).toBeVisible();
    await expect(ui.feed(page)).not.toContainText('older than the ones loaded');
  } finally {
    await env.stop();
  }
});

test('explore 9, privacy: an admin sees the older pair two others share; a third ordinary member sees neither of them', async ({ open, world }) => {
  const env = await withOlderDm(world, 'cara');
  try {
    // The admin: the pair is listed as an observed conversation, labelled by its two handles in alphabetical order.
    const admin = await open({ baseURL: env.base });
    const asked = conversationAnswer(admin.page);
    await signIn(admin.page, env.tokens.flan ?? '');
    await openChat(admin.page, env.repoInfo.label);
    const adminAnswer = await asked;
    expect(adminAnswer.status()).toBe(200);
    const adminPairs = ((await adminAnswer.json()) as { conversations: Array<{ a: string; b: string }> }).conversations;
    expect(adminPairs.map((pair) => [pair.a, pair.b])).toEqual([['ann', 'bob']]);
    await expect(ui.feed(admin.page).getByText(`Channel message ${POSTS}`)).toBeVisible();
    await expect(ui.conversation(admin.page, adminDm('ann', 'bob'))).toBeVisible();
    await ui.conversation(admin.page, adminDm('ann', 'bob')).click();
    await expect(ui.feed(admin.page)).toHaveText(OLDER_HINT);

    // The third member, in the same repo, with the same older DM between two others: nothing of it, anywhere.
    const third = await open({ baseURL: env.base });
    const thirdAsked = conversationAnswer(third.page);
    await signIn(third.page, env.tokens.cara ?? '');
    await openChat(third.page, env.repoInfo.label);
    const thirdAnswer = await thirdAsked;
    expect(thirdAnswer.status()).toBe(200);
    expect(((await thirdAnswer.json()) as { conversations: unknown[] }).conversations).toEqual([]);
    await expect(ui.feed(third.page).getByText(`Channel message ${POSTS}`)).toBeVisible();
    // Judged after the answer came and the feed loaded: a pair listed late would be on the page by now.
    await expect(ui.conversations(third.page).getByRole('button')).toHaveCount(1);
    await expect(ui.conversation(third.page, '#chat')).toBeVisible();
    const listed = await ui.conversations(third.page).innerText();
    expect(listed.toLowerCase()).not.toContain('ann');
    expect(listed.toLowerCase()).not.toContain('bob');
    await expect(ui.conversation(third.page, dmWith('ann'))).toHaveCount(0);
    await expect(ui.conversation(third.page, dmWith('bob'))).toHaveCount(0);
    await expect(ui.conversation(third.page, adminDm('ann', 'bob'))).toHaveCount(0);
  } finally {
    await env.stop();
  }
});
