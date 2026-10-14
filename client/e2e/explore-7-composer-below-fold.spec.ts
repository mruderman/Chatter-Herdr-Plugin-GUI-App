// Exploratory pass (docs/runbooks/exploratory-pass.md, finding 7). Guards the fix: the specs for the three ordinary
// window sizes failed on the code before it. The Messages log was `clamp(12rem, 60vh, 48rem)` high and sat under the
// header, the navigation and the conversation list, so on an ordinary window the message box started below the fold:
// to write, the member scrolled the page first, and while they wrote they could not see the newest message and the
// box together.
// Now the Chat view's chain of ancestors, from `.app` down to the log, is a column of flex boxes (styles/layout.css,
// features/chat/ChatView.css, feed.css) and the log takes the height that is left in the window, with a floor of 12rem. So:
//  - on windows that are big enough, the first screen holds the newest message and the message box together;
//  - on a phone, or at 200% text, the floor wins: the page scrolls as before, nothing clips, nothing scrolls sideways;
//  - a long list of conversations beside the feed (an admin sees every pair's DMs) is a scroll box of its own and
//    does not set the height of the row the feed fills;
//  - the log is a flexible box now, so the composer growing (more lines, the mention list) or the window getting
//    shorter takes height from it; a reader who was at the newest message has to stay there (reading-position.ts),
//    which the last specs check in a real browser: the unit tests fake a log of fixed height.
// Every spec runs against its own bridge. The rows are written straight into that scratch Chatter database, as
// bridge/test/helpers.js does for agents: a few thousand pixels of feed need no 60 Chatter processes.
import path from 'node:path';
import type { Page } from '@playwright/test';
import { loadBridgeHelpers, type BridgeEnv } from './harness/bridge';
import { expect, openChat, signIn, test, type OpenFn } from './harness/fixtures';
import { ui } from './harness/ui';
import { POLL_MS, type World } from './harness/world';

interface Size {
  readonly width: number;
  readonly height: number;
}

/** Windows on which the whole first screen can hold the newest message and the message box. */
const FITTING: readonly Size[] = [
  { width: 1280, height: 720 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
];
/** Phones, where the floor of the log wins and the page scrolls: the fix must not break them. */
const PHONES: readonly Size[] = [
  { width: 375, height: 667 },
  { width: 320, height: 568 },
];
/** The log's floor, 12rem at the browser's default 16 px (features/chat/feed/feed.css); a pixel of rounding is allowed. */
const FLOOR_PX = 192;
const TOLERANCE_PX = 1;
const LONG_FEED = 60;

async function privateBridge(world: World): Promise<BridgeEnv> {
  const { makeEnv } = await loadBridgeHelpers();
  return makeEnv({ staticDir: world.staticDir, pollMs: POLL_MS });
}

/** Short messages from two senders in bursts: groups start and continue, and each fits in the log's floor. */
async function insertFeed(env: BridgeEnv, count: number): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(env.repoInfo.dir, 'chatter.db'));
  try {
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const insert = db.prepare('INSERT INTO messages (from_agent, to_agent, body, kind, created_at) VALUES (?, ?, ?, ?, ?)');
    db.exec('BEGIN');
    for (let i = 0; i < count; i += 1) {
      const from = Math.floor(i / 5) % 2 === 0 ? 'talker' : 'reader';
      insert.run(from, '#chat', i % 3 === 0 ? `Message ${i + 1}\na second line` : `Message ${i + 1}`, 'post', stamp);
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

interface ChatOptions {
  readonly size: Size;
  /** How many messages to add to the feed; 0 leaves the one setup message every scratch universe starts with. */
  readonly messages: number;
  /** The root font size as a percentage, a test-only emulation of a member's text setting. */
  readonly textPercent?: number;
}

async function withChat(open: OpenFn, world: World, options: ChatOptions, body: (page: Page) => Promise<void>): Promise<void> {
  const env = await privateBridge(world);
  try {
    const reader = env.addMember('reader', { kind: 'human', display_name: 'Reader' });
    env.addMember('talker', { kind: 'human', display_name: 'Talker' });
    if (options.messages > 0) await insertFeed(env, options.messages);
    const { page } = await open({ baseURL: env.base, context: { viewport: options.size } });
    await signIn(page, reader);
    await openChat(page, env.repoInfo.label);
    if (options.textPercent !== undefined) {
      await page.evaluate((percent) => {
        document.documentElement.style.fontSize = `${percent}%`;
      }, options.textPercent);
    }
    await body(page);
  } finally {
    await env.stop();
  }
}

/** Puts the log at its own end, where a reader following the conversation is. */
async function readToTheEnd(page: Page): Promise<void> {
  await ui.feed(page).evaluate((log) => {
    log.scrollTop = log.scrollHeight;
  });
  await expect.poll(() => ui.feed(page).evaluate((log) => log.scrollHeight - log.scrollTop - log.clientHeight)).toBeLessThanOrEqual(4);
}

const newestMessage = (page: Page) => ui.feed(page).getByRole('article').last();

const logHeight = (page: Page): Promise<number> => ui.feed(page).evaluate((log) => log.getBoundingClientRect().height);

const sideways = (page: Page): Promise<{ scrollWidth: number; innerWidth: number }> =>
  page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));

for (const size of FITTING) {
  test(`explore 7: at ${size.width} x ${size.height} the newest message and the message box are on screen without scrolling the page`, async ({ open, world }) => {
    await withChat(open, world, { size, messages: LONG_FEED }, async (page) => {
      expect(await page.evaluate(() => window.scrollY), 'the page has not been scrolled').toBe(0);
      await expect(ui.messageBox(page), `the message box starts below the bottom of a ${size.height} px window`).toBeInViewport({ ratio: 1 });
      await expect(ui.sendButton(page), 'Send is on the first screen too').toBeInViewport({ ratio: 1 });
      expect(await logHeight(page), 'the log keeps at least its floor').toBeGreaterThanOrEqual(FLOOR_PX - TOLERANCE_PX);
      // What the member came for: the newest message and the box to answer it, on the same first screen.
      await readToTheEnd(page);
      await expect(newestMessage(page), 'the newest message is on screen').toBeInViewport({ ratio: 1 });
      await expect(ui.messageBox(page), 'and so is the message box').toBeInViewport({ ratio: 1 });
      expect(await page.evaluate(() => window.scrollY), 'reading to the end of the log did not scroll the page').toBe(0);
    });
  });
}

test('explore 7: at 1280 x 720 with a nearly empty feed (one message) the message box is on screen without scrolling the page', async ({ open, world }) => {
  await withChat(open, world, { size: FITTING[0]!, messages: 0 }, async (page) => {
    expect(await page.evaluate(() => window.scrollY), 'the page has not been scrolled').toBe(0);
    await expect(ui.messageBox(page)).toBeInViewport({ ratio: 1 });
    await expect(ui.sendButton(page)).toBeInViewport({ ratio: 1 });
    expect(await logHeight(page), 'the sparse log keeps at least its floor').toBeGreaterThanOrEqual(FLOOR_PX - TOLERANCE_PX);
  });
});

for (const size of PHONES) {
  test(`explore 7 guard: at ${size.width} x ${size.height} nothing scrolls sideways and the message box and Send are still reachable`, async ({ open, world }) => {
    await withChat(open, world, { size, messages: LONG_FEED }, async (page) => {
      const { scrollWidth, innerWidth } = await sideways(page);
      expect(scrollWidth, 'the page is not wider than the window').toBeLessThanOrEqual(innerWidth);
      expect(await logHeight(page), 'the floor wins on a small window: the log is not squeezed below it').toBeGreaterThanOrEqual(FLOOR_PX - TOLERANCE_PX);
      await ui.messageBox(page).scrollIntoViewIfNeeded();
      await expect(ui.messageBox(page)).toBeInViewport({ ratio: 1 });
      await ui.sendButton(page).scrollIntoViewIfNeeded();
      await expect(ui.sendButton(page)).toBeInViewport({ ratio: 1 });
      const after = await sideways(page);
      expect(after.scrollWidth, 'still not wider after scrolling to the composer').toBeLessThanOrEqual(after.innerWidth);
    });
  });
}

test('explore 7 guard: at 200% text on a 1280 x 720 window the floor wins, nothing scrolls sideways and the message box is reachable', async ({ open, world }) => {
  await withChat(open, world, { size: FITTING[0]!, messages: LONG_FEED, textPercent: 200 }, async (page) => {
    const { scrollWidth, innerWidth } = await sideways(page);
    expect(scrollWidth, 'the page is not wider than the window').toBeLessThanOrEqual(innerWidth);
    // 12rem at a root of 32 px; the log did not shrink with the window, it kept the floor and the page grew.
    expect(await logHeight(page)).toBeGreaterThanOrEqual(2 * FLOOR_PX - TOLERANCE_PX);
    await ui.messageBox(page).scrollIntoViewIfNeeded();
    await expect(ui.messageBox(page)).toBeInViewport({ ratio: 1 });
    await ui.sendButton(page).scrollIntoViewIfNeeded();
    await expect(ui.sendButton(page)).toBeInViewport({ ratio: 1 });
  });
});

// The log is a flexible box, so what the composer gains the log loses. A reader at the newest message must not be
// left with it cut off at the bottom of a shorter log (no scroll event fires when a box only changes size). It takes
// a window with room to spare: at 1280 x 720 the log is within a few pixels of its floor and has nothing to lose.
const REPLY_LINES = 8;
const ROOMY = FITTING[2]!;

test('explore 7: a reader at the newest message still sees it while the message box grows to several lines', async ({ open, world }) => {
  await withChat(open, world, { size: ROOMY, messages: LONG_FEED }, async (page) => {
    await readToTheEnd(page);
    await expect(newestMessage(page)).toBeInViewport({ ratio: 1 });
    const before = await logHeight(page);
    await ui.messageBox(page).fill(Array.from({ length: REPLY_LINES }, (_, i) => `line ${i + 1}`).join('\n'));
    await expect.poll(() => logHeight(page), { message: 'the box took height from the log' }).toBeLessThan(before);
    await expect(newestMessage(page), 'the newest message was pushed out of the shrunken log').toBeInViewport({ ratio: 1 });
  });
});

test('explore 7: a reader at the newest message still sees it while the mention suggestions are open', async ({ open, world }) => {
  await withChat(open, world, { size: ROOMY, messages: LONG_FEED }, async (page) => {
    await readToTheEnd(page);
    await expect(newestMessage(page)).toBeInViewport({ ratio: 1 });
    const before = await logHeight(page);
    await ui.messageBox(page).pressSequentially('@');
    await expect(ui.suggestions(page)).toBeVisible();
    await expect.poll(() => logHeight(page), { message: 'the suggestions took height from the log' }).toBeLessThan(before);
    await expect(newestMessage(page), 'the newest message was pushed out of the shrunken log').toBeInViewport({ ratio: 1 });
  });
});

test('explore 7: a reader who scrolled up in the log is not pulled down when the message box grows', async ({ open, world }) => {
  await withChat(open, world, { size: ROOMY, messages: LONG_FEED }, async (page) => {
    await ui.feed(page).evaluate((log) => {
      log.scrollTop = Math.max(0, log.scrollHeight / 2);
    });
    const top = await ui.feed(page).evaluate((log) => log.scrollTop);
    const before = await logHeight(page);
    await ui.messageBox(page).fill(Array.from({ length: REPLY_LINES }, (_, i) => `line ${i + 1}`).join('\n'));
    await expect.poll(() => logHeight(page), { message: 'the box took height from the log' }).toBeLessThan(before);
    expect(await ui.feed(page).evaluate((log) => log.scrollTop), 'someone reading older messages keeps their place').toBe(top);
  });
});

// An admin has a button for every pair's DMs. Beside the feed that list must not set the height of the row the feed
// fills, or the log balloons (1,600 px seen with 40 buttons) and the message box ends up a page away.
test('explore 7: at 1280 x 720 a long list of conversations scrolls by itself and leaves the message box on screen', async ({ open, world }) => {
  const env = await privateBridge(world);
  try {
    const handles = ['ann', 'bob', 'cai', 'dee', 'eli', 'fay'];
    for (const handle of handles) env.addMember(handle, { kind: 'human', display_name: handle });
    for (const [i, from] of handles.entries()) {
      for (const to of handles.slice(i + 1)) expect((await env.post(from, to, `hello ${to}`)).status).toBe(201);
    }
    const { page } = await open({ baseURL: env.base, context: { viewport: FITTING[0]! } });
    await signIn(page, env.tokens.flan!);
    await openChat(page, env.repoInfo.label);
    // Fifteen pairs and #chat: more buttons than the column beside the feed has height for.
    await expect(ui.conversations(page).getByRole('button')).toHaveCount(16);
    expect(await page.evaluate(() => window.scrollY), 'the page has not been scrolled').toBe(0);
    await expect(ui.messageBox(page)).toBeInViewport({ ratio: 1 });
    await expect(ui.sendButton(page)).toBeInViewport({ ratio: 1 });
    expect(await logHeight(page), 'the log keeps at least its floor and the list did not stretch it').toBeLessThan(FLOOR_PX * 2);
    const list = ui.conversations(page).getByRole('list');
    expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight), 'the list scrolls inside its column').toBe(true);
  } finally {
    await env.stop();
  }
});

test('explore 7: a reader at the newest message still sees it when the window gets shorter', async ({ open, world }) => {
  await withChat(open, world, { size: ROOMY, messages: LONG_FEED }, async (page) => {
    await readToTheEnd(page);
    await expect(newestMessage(page)).toBeInViewport({ ratio: 1 });
    const before = await logHeight(page);
    await page.setViewportSize({ width: ROOMY.width, height: 700 });
    await expect.poll(() => logHeight(page), { message: 'the shorter window took height from the log' }).toBeLessThan(before);
    await expect(newestMessage(page), 'the newest message was pushed out of the shrunken log').toBeInViewport({ ratio: 1 });
  });
});
