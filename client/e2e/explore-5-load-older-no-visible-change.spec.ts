// Exploratory pass (docs/runbooks/exploratory-pass.md, finding 5), fixed: this guards the fix.
// "Load older messages" pages the whole repository (`before_id`, 100 rows of every conversation the member
// may see), but the feed shows one conversation. In a direct message conversation whose messages are further
// back than a page, one press used to fetch 100 messages that all belonged to other conversations: nothing
// changed on screen, the button stayed, and nothing said that anything was loaded, so the member pressed it
// again and again, blind. A press in a DM now keeps asking for older pages until a message of that DM was
// added, the history ends, or 10 pages (1,000 messages) were loaded. The first test is the finding itself: one
// press shows the DM's old message. The second is the bound: a DM further back than one press can look says how
// far it looked and leaves the button, and the next press finds the message.
// Runs against its own bridge. The channel rows are written straight into that scratch Chatter database
// (as bridge/test/helpers.js does for agents), because 1,000 Chatter processes would take minutes.
import path from 'node:path';
import type { Page } from '@playwright/test';
import { seriousViolations } from './harness/axe';
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

/** For whoever reviews the change by eye: a 1280 x 720 picture of the page, under test-results/visual (emptied by every run, so look after it). Not an assertion. */
async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join('test-results', 'visual', `${name}.png`) });
}

const OLD_DM = 'The one old private message';
const LOAD_OLDER = 'Load older messages';
// Written out as the feed says it, not read from the component.
const LOOKED_BACK_1000 = 'Looked back 1000 messages and found none of this conversation. Press Load older messages to look further.';

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

    const older = page.getByRole('button', { name: LOAD_OLDER, exact: true });
    const fetched = page.waitForResponse((r) => r.url().includes('before_id='));
    await older.click();
    expect((await fetched).status()).toBe(200);

    // After one press the member has something to show for it: here, the DM's own older message (the press
    // keeps paging until the conversation gains a message or the history ends).
    await expect(
      ui.feed(page).getByText(OLD_DM),
      'one press of "Load older messages" in a DM fetched a page of other conversations; the view did not change',
    ).toBeVisible({ timeout: 2_000 });
    await shot(page, 'explore-5-dm-after-one-press');
  } finally {
    await env.stop();
  }
});

test('explore 5, the bound: a DM further back than one press can look says how far it looked and keeps the button; the next press finds it', async ({ open, world }) => {
  const env = await privateBridge(world);
  try {
    const annToken = env.addMember('ann', { kind: 'human', display_name: 'Ann' });
    env.addMember('bob', { kind: 'human', display_name: 'Bob' });
    expect((await env.post('bob', 'ann', OLD_DM)).status).toBe(201);
    // 1,150 newer channel messages: the newest page holds 100, one press looks through 10 pages of 100 more, and
    // the DM, the oldest row of all, is 51 rows past that: 12 pages back, out of one press's reach.
    await insertPosts(env, 'bob', Array.from({ length: 1_150 }, (_, i) => `Channel message ${i + 1}`));

    const { page } = await open({ baseURL: env.base });
    const olderPages: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('before_id=')) olderPages.push(request.url());
    });
    await signIn(page, annToken);
    await openChat(page, env.repoInfo.label);
    await ui.conversation(page, dmWith('bob')).click();
    await expect(ui.conversation(page, dmWith('bob'))).toHaveAttribute('aria-current', 'true');
    await expect(ui.feed(page).getByText(OLD_DM)).toHaveCount(0);

    const older = page.getByRole('button', { name: LOAD_OLDER, exact: true });
    const logBefore = await ui.feed(page).boundingBox();
    await older.click();
    // The press gave up: it says how far it looked, in words, and the button is there for the next try.
    await expect(page.getByText(LOOKED_BACK_1000, { exact: true })).toBeVisible();
    // Measured, not asserted: the sentence is longer than the row beside the button at this width, so it sits under
    // the button and the log (whose content did not change) moves down by that line, once.
    const logAfter = await ui.feed(page).boundingBox();
    console.log(`the log, before the press and with the sentence showing: top ${logBefore?.y} -> ${logAfter?.y}, height ${logBefore?.height} -> ${logAfter?.height}`);
    expect(olderPages, 'one press asks for at most 10 pages').toHaveLength(10);
    await expect(ui.feed(page).getByText(OLD_DM)).toHaveCount(0);
    await expect(older).toBeVisible();
    await expect(older).not.toHaveAttribute('aria-disabled', 'true');
    expect(await seriousViolations(page), 'axe, with the looked-back status on screen').toEqual([]);
    await shot(page, 'explore-5-looked-back-status');

    await older.click();
    await expect(ui.feed(page).getByText(OLD_DM)).toBeVisible();
    await expect(page.getByText('Looked back')).toHaveCount(0);
    // The second press needed one page: the DM was 51 rows into the next one, and that page was the last.
    expect(olderPages).toHaveLength(11);
    await expect(older).toHaveCount(0);
  } finally {
    await env.stop();
  }
});
