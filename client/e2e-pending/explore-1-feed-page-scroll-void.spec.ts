// Exploratory pass (docs/runbooks/exploratory-pass.md, finding 1). Written to FAIL on the current code.
// Every message that continues a group carries a `<time class="visually-hidden">`, which is
// `position: absolute` (styles/components.css). The Messages log is `overflow-y: auto` but not positioned,
// so those elements are not clipped or contained by it: each sits at its place in the log's own scroll
// height and stretches the PAGE's scroll height with it. With a long feed the page scrolls thousands of
// pixels past the composer into blank space (seen: 9707 px of document for 1029 px of content, 300 messages).
// Runs against its own bridge. The rows are written straight into that scratch Chatter database, as
// bridge/test/helpers.js does for agents: a few thousand pixels of feed need no 40 Chatter processes.
import path from 'node:path';
import { loadBridgeHelpers, type BridgeEnv } from '../e2e/harness/bridge';
import { expect, openChat, signIn, test } from '../e2e/harness/fixtures';
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

const MAX_BLANK_PX = 100;

test('explore 1: a long feed does not make the page scroll past its own content into blank space', async ({ open, world }) => {
  const env = await privateBridge(world);
  try {
    const reader = env.addMember('reader', { kind: 'human', display_name: 'Reader' });
    env.addMember('talker', { kind: 'human', display_name: 'Talker' });
    // One sender, one burst: every message after the first continues the group and carries a hidden time.
    await insertPosts(env, 'talker', Array.from({ length: 40 }, (_, i) => `Message ${i + 1}\n${'a line of text\n'.repeat(7)}`.trim()));

    const { page } = await open({ baseURL: env.base, context: { viewport: { width: 1280, height: 720 } } });
    await signIn(page, reader);
    await openChat(page, env.repoInfo.label);

    const blank = await page.evaluate(() => {
      const composer = document.querySelector('form[aria-label="Message composer"]');
      if (!composer) throw new Error('no message composer on the page');
      const contentBottom = composer.getBoundingClientRect().bottom + window.scrollY;
      return Math.round(document.documentElement.scrollHeight - contentBottom);
    });
    expect(blank, 'pixels the page scrolls beyond the bottom of the composer, the last thing on it').toBeLessThan(MAX_BLANK_PX);
  } finally {
    await env.stop();
  }
});
