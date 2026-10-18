// T21: a compact composer, so that what appears under Send is in view. Before, the "To" select had a row of its own
// above the message box and Send a row below it: at 1280 x 720 the composer was 287 px tall, which left the log
// about 200 px (V5 finding 7 gave the log what the window leaves), and the "Send error" alert (`Not sent: ...`) and the
// "Send notice" status, which sit under Send, started below the fold: the alert was clipped, and only the notice
// had a reveal (`revealNotice`, now `revealBelowSend`) to scroll the page to it.
// Now, from 48rem up, "To", the message box and Send are one row (the hint and the character count under it), and
// the alert is brought into view the way the notice is (the one function); below 48rem the layout stacks as it did.
// Seen RED on the untouched code (10 of the 20): (a) the height and the row, at 1280 x 720, at 1024 x 768, at the
// breakpoint and at 200% text; (b) the alert in the window at 1280 x 720 and at 1280 x 560 (twice: the second is the
// repeated failure); (e) the click on Send with the suggestions open, at 1280 x 720 and at 375 x 667.
// GREEN before and after, guards for what must not change: (b) at 1024 x 768, where the old composer's alert already
// fitted; (c) the notice in the window; (d) a phone's stacked layout and reach, 375 and 320 wide; (f) the suggestions
// list, wide and stacked; (g) the tab order; (h) axe with the alert and with the suggestions, three themes.
// The click on Send is a finding of T18's executor: while the suggestions for text ending in "@codex" were open under
// the caret, a mouse click on Send collapsed the list on mousedown (the box lost focus), the log grew back into the
// room the list had taken, Send moved away from under the pointer, and the click was lost.
// Every spec runs against its own bridge, so that the rows it writes do not touch the shared world; the feed is
// written straight into the scratch Chatter database (as explore-7 does), because the log must be long to be
// filled and a few thousand pixels of it need no 60 Chatter processes.
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { HTTP, ROUTES, nonce, type ApiError } from './harness/api';
import { seriousViolations } from './harness/axe';
import { loadBridgeHelpers, type BridgeEnv } from './harness/bridge';
import { expect, openChat, signIn, test, type OpenFn } from './harness/fixtures';
import { UI, ui } from './harness/ui';
import { POLL_MS, type World } from './harness/world';

interface Size {
  readonly width: number;
  readonly height: number;
}

interface Rect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

const LAPTOP: Size = { width: 1280, height: 720 };
const WIDE: readonly Size[] = [LAPTOP, { width: 1024, height: 768 }];
const PHONES: readonly Size[] = [
  { width: 375, height: 667 },
  { width: 320, height: 568 },
];
const LONG_FEED = 60;
/** What the composer measured at 1280 x 720 before this task (the number in the brief), and the bound it must now meet. */
const COMPOSER_BEFORE_PX = 287;
const COMPOSER_MAX_PX = 200;
const LOG_MIN_PX = 300;
/** The breakpoint, 48rem, in CSS px: where the conversation list also moves beside the feed (ChatView.css). */
const BREAKPOINT_PX = 768;
const EVERYONE_ADMIN_ONLY = 'everyone_admin_only'; // bridge/src/policy.js
const AGENT = 'codex';
const HINT = 'Enter sends. Shift+Enter starts a new line. Type @ to mention someone.';
const NO_AGENT = /matches no agent in this repo/;
// A pixel of rounding in a measured position.
const ROUND_PX = 1.5;

async function privateBridge(world: World): Promise<BridgeEnv> {
  const { makeEnv } = await loadBridgeHelpers();
  return makeEnv({ staticDir: world.staticDir, pollMs: POLL_MS });
}

/** Rows written straight into the scratch Chatter database (see explore-7): a feed long enough to fill the log. */
async function insertFeed(env: BridgeEnv, count: number): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(env.repoInfo.dir, 'chatter.db'));
  try {
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const insert = db.prepare('INSERT INTO messages (from_agent, to_agent, body, kind, created_at) VALUES (?, ?, ?, ?, ?)');
    db.exec('BEGIN');
    for (let i = 0; i < count; i += 1) insert.run(i % 2 === 0 ? 'talker' : 'ann', '#chat', `Message ${i + 1}`, 'post', stamp);
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

interface ChatOptions {
  readonly size: Size;
  /** Browser colour preferences, for the three themes (UI-contract section 6). */
  readonly media?: { readonly colorScheme: 'light' | 'dark'; readonly contrast: 'no-preference' | 'more' };
  /** The root font size as a percentage, a test-only emulation of a member's text setting. */
  readonly textPercent?: number;
}

/** A bridge with a non-admin human "ann" (who may not use @everyone), a talker, an agent and a long feed; ann signed in on #chat. */
async function withChat(open: OpenFn, world: World, options: ChatOptions, body: (page: Page, env: BridgeEnv) => Promise<void>): Promise<void> {
  const env = await privateBridge(world);
  try {
    const token = env.addMember('ann', { kind: 'human', display_name: 'Ann' });
    env.addMember('talker', { kind: 'human', display_name: 'Talker' });
    env.seedAgent(AGENT);
    await insertFeed(env, LONG_FEED);
    const { page } = await open({ baseURL: env.base, context: { viewport: options.size, ...options.media } });
    await signIn(page, token);
    await openChat(page, env.repoInfo.label);
    if (options.textPercent !== undefined) {
      await page.evaluate((percent) => {
        document.documentElement.style.fontSize = `${percent}%`;
      }, options.textPercent);
    }
    await body(page, env);
  } finally {
    await env.stop();
  }
}

async function rect(locator: Locator): Promise<Rect> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('the element has no box: it is not on the page or not rendered');
  return { left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height, width: box.width, height: box.height };
}

const hint = (page: Page): Locator => ui.composer(page).getByText(HINT, { exact: true });
const notice = (page: Page): Locator => ui.composer(page).getByRole('status', { name: 'Send notice', exact: true });
const dismiss = (page: Page): Locator => ui.composer(page).getByRole('button', { name: 'Dismiss notice', exact: true });
const logHeight = (page: Page): Promise<number> => ui.feed(page).evaluate((log) => log.getBoundingClientRect().height);
const sideways = (page: Page): Promise<{ scrollWidth: number; innerWidth: number }> =>
  page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));

/** A send that the bridge refuses: a member may not use @everyone, so it answers 403 and the "Send error" alert shows. */
async function refusedSend(page: Page, env: BridgeEnv): Promise<void> {
  const posted = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === ROUTES.messages(env.key));
  await ui.messageBox(page).fill(`@everyone t21 check ${nonce()}`);
  // The key, not the button: focus stays in the box, which the alert must not take it from.
  await ui.messageBox(page).press('Enter');
  const reply = await posted;
  expect(reply.status(), 'the bridge refused the send').toBe(HTTP.forbidden);
  expect(((await reply.json()) as ApiError).error.code).toBe(EVERYONE_ADMIN_ONLY);
  await expect(ui.sendError(page)).toBeVisible();
}

/** The three controls on one row, in reading order, Send level with the bottom of the box, the hint under the row. */
async function expectOneRow(page: Page, where: string): Promise<void> {
  const to = await rect(ui.recipient(page));
  const box = await rect(ui.messageBox(page));
  const send = await rect(ui.sendButton(page));
  const under = await rect(hint(page));
  expect(to.right, `${where}: "To" is left of the message box`).toBeLessThanOrEqual(box.left + ROUND_PX);
  expect(box.right, `${where}: the message box is left of Send`).toBeLessThanOrEqual(send.left + ROUND_PX);
  const toMiddle = (to.top + to.bottom) / 2;
  expect(toMiddle, `${where}: "To" is level with the message box`).toBeGreaterThan(box.top);
  expect(toMiddle).toBeLessThan(box.bottom);
  expect(Math.abs(send.bottom - box.bottom), `${where}: Send is level with the bottom of the message box`).toBeLessThanOrEqual(ROUND_PX);
  expect(under.top, `${where}: the hint is under the row, not beside it`).toBeGreaterThanOrEqual(Math.max(box.bottom, send.bottom, to.bottom) - ROUND_PX);
}

/** The layout as it was: "To" above the message box, both the width of the composer's column; Send under them. */
async function expectStacked(page: Page, where: string): Promise<void> {
  const to = await rect(ui.recipient(page));
  const box = await rect(ui.messageBox(page));
  const send = await rect(ui.sendButton(page));
  expect(to.bottom, `${where}: "To" is above the message box`).toBeLessThanOrEqual(box.top + ROUND_PX);
  expect(Math.abs(to.left - box.left), `${where}: "To" and the message box start at the same edge`).toBeLessThanOrEqual(ROUND_PX);
  expect(send.top, `${where}: Send is under the message box`).toBeGreaterThanOrEqual(box.bottom - ROUND_PX);
}

test(`T21 (a): at 1280 x 720 the composer is at most ${COMPOSER_MAX_PX} px tall (it was ${COMPOSER_BEFORE_PX}) and the log at least ${LOG_MIN_PX} px`, async ({ open, world }) => {
  await withChat(open, world, { size: LAPTOP }, async (page) => {
    const composer = await rect(ui.composer(page));
    expect(composer.height, `the composer is ${composer.height} px tall`).toBeLessThanOrEqual(COMPOSER_MAX_PX);
    const log = await logHeight(page);
    expect(log, `the log is ${log} px tall`).toBeGreaterThanOrEqual(LOG_MIN_PX);
    expect(await page.evaluate(() => window.scrollY), 'the page has not been scrolled').toBe(0);
  });
});

for (const size of WIDE) {
  test(`T21 (a): at ${size.width} x ${size.height} "To", the message box and Send are one row, with the hint under it`, async ({ open, world }) => {
    await withChat(open, world, { size }, async (page) => {
      await expectOneRow(page, `${size.width} wide`);
      const { scrollWidth, innerWidth } = await sideways(page);
      expect(scrollWidth, 'nothing scrolls sideways').toBeLessThanOrEqual(innerWidth);
      // Wide enough to write in: the select and Send take what they need, the box the rest.
      expect((await rect(ui.messageBox(page))).width, 'the message box takes the rest of the width').toBeGreaterThanOrEqual(300);
    });
  });
}

test('T21 (a): the one row starts at 48rem: one row at 768 px wide, stacked at 767, and nothing scrolls sideways at either', async ({ open, world }) => {
  for (const [width, stacked] of [
    [BREAKPOINT_PX, false],
    [BREAKPOINT_PX - 1, true],
  ] as const) {
    await withChat(open, world, { size: { width, height: 900 } }, async (page) => {
      if (stacked) await expectStacked(page, `${width} wide`);
      else await expectOneRow(page, `${width} wide`);
      const { scrollWidth, innerWidth } = await sideways(page);
      expect(scrollWidth, `nothing scrolls sideways at ${width}`).toBeLessThanOrEqual(innerWidth);
    });
  }
});

test('T21 (a): at 200% text on a 1280 x 720 window the row still has room to write in and nothing scrolls sideways', async ({ open, world }) => {
  await withChat(open, world, { size: LAPTOP, textPercent: 200 }, async (page) => {
    await expectOneRow(page, '200% text');
    const { scrollWidth, innerWidth } = await sideways(page);
    expect(scrollWidth, 'nothing scrolls sideways').toBeLessThanOrEqual(innerWidth);
    expect((await rect(ui.messageBox(page))).width, 'the message box keeps room to write').toBeGreaterThanOrEqual(200);
    await ui.sendButton(page).scrollIntoViewIfNeeded();
    await expect(ui.sendButton(page)).toBeInViewport({ ratio: 1 });
  });
});

for (const size of WIDE) {
  test(`T21 (b): at ${size.width} x ${size.height} a send the bridge refuses leaves the "Send error" alert fully in the window, with the message box and focus where they were`, async ({ open, world }) => {
    await withChat(open, world, { size }, async (page, env) => {
      await refusedSend(page, env);
      await expect(ui.sendError(page), 'the alert is clipped or below the fold').toBeInViewport({ ratio: 1 });
      await expect(ui.messageBox(page)).toBeInViewport({ ratio: 1 });
      await expect(ui.sendButton(page)).toBeInViewport({ ratio: 1 });
      await expect(ui.messageBox(page), 'the alert took no focus').toBeFocused();
    });
  });
}

// On the windows above the compact composer and the alert fit under the log's floor with room to spare, so the layout
// alone shows the alert. On a window this short they do not (the floor of the log wins and the page scrolls), and
// only the composer's own scroll, the one the notice has, brings the alert in.
test('T21 (b): at 1280 x 560, where composer and alert do not fit under the log\'s floor, the page scrolls just far enough to show the alert', async ({ open, world }) => {
  await withChat(open, world, { size: { width: 1280, height: 560 } }, async (page, env) => {
    expect(await page.evaluate(() => window.scrollY), 'the page starts at the top').toBe(0);
    await refusedSend(page, env);
    await expect(ui.sendError(page), 'the alert is below the fold').toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => window.scrollY), 'the page moved to show it').toBeGreaterThan(0);
    await expect(ui.messageBox(page)).toBeInViewport({ ratio: 1 });
    await expect(ui.messageBox(page)).toBeFocused();
  });
});

test('T21 (b): a failure that repeats word for word is brought into view again after the page was scrolled away', async ({ open, world }) => {
  await withChat(open, world, { size: { width: 1280, height: 560 } }, async (page, env) => {
    await refusedSend(page, env);
    await expect(ui.sendError(page)).toBeInViewport({ ratio: 1 });
    // The member scrolls the page back up, then sends again and is refused again in the same words.
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await refusedSend(page, env);
    await expect(ui.sendError(page), 'the second alert is as visible as the first').toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => window.scrollY), 'the page moved again').toBeGreaterThan(0);
  });
});

test('T21 (c): at 1280 x 720 a send that comes back with a notice leaves the notice and its button fully in the window', async ({ open, world }) => {
  await withChat(open, world, { size: LAPTOP }, async (page) => {
    await ui.messageBox(page).fill('is anybody there? @nobodyhere');
    await ui.messageBox(page).press('Enter');
    await expect(notice(page)).toContainText(NO_AGENT);
    await expect(notice(page), 'the notice is in the window').toBeInViewport({ ratio: 1 });
    await expect(dismiss(page)).toBeInViewport({ ratio: 1 });
    await expect(ui.messageBox(page)).toBeInViewport({ ratio: 1 });
    await expect(ui.sendButton(page)).toBeInViewport({ ratio: 1 });
    await expect(ui.messageBox(page)).toBeFocused();
  });
});

for (const size of PHONES) {
  test(`T21 (d): at ${size.width} x ${size.height} the layout is stacked, nothing scrolls sideways, and the message box, Send and the alert are reachable`, async ({ open, world }) => {
    await withChat(open, world, { size }, async (page, env) => {
      await expectStacked(page, `${size.width} wide`);
      const first = await sideways(page);
      expect(first.scrollWidth, 'the page is not wider than the window').toBeLessThanOrEqual(first.innerWidth);
      await ui.recipient(page).scrollIntoViewIfNeeded();
      await expect(ui.recipient(page)).toBeInViewport({ ratio: 1 });
      await ui.messageBox(page).scrollIntoViewIfNeeded();
      await expect(ui.messageBox(page)).toBeInViewport({ ratio: 1 });
      await ui.sendButton(page).scrollIntoViewIfNeeded();
      await expect(ui.sendButton(page)).toBeInViewport({ ratio: 1 });

      await refusedSend(page, env);
      // Where the composer is taller than the window the page moves only as far as keeps the focused box in it.
      await expect(ui.sendError(page), 'some of the alert is in the window').toBeInViewport();
      await expect(ui.messageBox(page), 'the message box is still in the window').toBeInViewport({ ratio: 1 });
      await expect(ui.messageBox(page)).toBeFocused();
      await ui.sendError(page).scrollIntoViewIfNeeded();
      await expect(ui.sendError(page), 'all of the alert can be read').toBeInViewport({ ratio: 1 });
      const after = await sideways(page);
      expect(after.scrollWidth, 'still not wider with the alert showing').toBeLessThanOrEqual(after.innerWidth);
    });
  });
}

// T18's executor: the click on Send was lost while the suggestions for text ending in "@codex" were open.
for (const size of [LAPTOP, PHONES[0]!]) {
  test(`T21 (e): at ${size.width} x ${size.height} a mouse click on Send is not lost while the mention suggestions are open`, async ({ open, world }) => {
    await withChat(open, world, { size }, async (page) => {
      await ui.messageBox(page).pressSequentially(`are you there @${AGENT}`);
      await expect(ui.suggestions(page), 'the list for "@codex" is open under the caret').toBeVisible();
      await ui.sendButton(page).click();
      await expect(ui.messageBox(page), 'the click on Send was lost: the draft is still in the box').toHaveValue('');
      await expect(ui.feed(page).getByText(`are you there @${AGENT}`)).toBeVisible();
      await expect(ui.suggestions(page)).toHaveCount(0);
      await expect(ui.messageBox(page), 'focus is back in the message box').toBeFocused();
    });
  });
}

test('T21 (f): the mention suggestions open under the message box at its full width, are not covered by Send, and work by keyboard', async ({ open, world }) => {
  await withChat(open, world, { size: LAPTOP }, async (page) => {
    await ui.messageBox(page).pressSequentially('@ta');
    await expect(ui.suggestions(page)).toBeVisible();
    const box = await rect(ui.messageBox(page));
    const list = await rect(ui.suggestions(page));
    const send = await rect(ui.sendButton(page));
    expect(list.top, 'the list is under the message box').toBeGreaterThanOrEqual(box.bottom - ROUND_PX);
    expect(list.left, 'it starts at the message box\'s edge').toBeGreaterThanOrEqual(box.left - ROUND_PX);
    expect(list.right, 'and does not run past it, under Send or off the page').toBeLessThanOrEqual(box.right + ROUND_PX);
    const overlap = list.left < send.right && list.right > send.left && list.top < send.bottom && list.bottom > send.top;
    expect(overlap, 'Send sits over the list').toBe(false);
    // The first option is what a click at its middle would reach: nothing sits over it.
    const first = ui.suggestions(page).getByRole('option').first();
    await first.scrollIntoViewIfNeeded();
    const covered = await first.evaluate((option) => {
      const middle = option.getBoundingClientRect();
      const top = document.elementFromPoint(middle.left + middle.width / 2, middle.top + middle.height / 2);
      return top === null || !option.contains(top);
    });
    expect(covered, 'something covers the first suggestion').toBe(false);
    // By keyboard: the arrows move, Enter takes the active one, the box has focus throughout.
    await expect(ui.messageBox(page)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await expect(ui.messageBox(page)).toHaveValue('@talker ');
    await expect(ui.suggestions(page)).toHaveCount(0);
  });
});

test('T21 (f): at 375 x 667 the suggestions fit the stacked column and nothing scrolls sideways', async ({ open, world }) => {
  await withChat(open, world, { size: PHONES[0]! }, async (page) => {
    await ui.messageBox(page).pressSequentially('@');
    await expect(ui.suggestions(page)).toBeVisible();
    const composer = await rect(ui.composer(page));
    const list = await rect(ui.suggestions(page));
    expect(list.left, 'inside the composer on the left').toBeGreaterThanOrEqual(composer.left - ROUND_PX);
    expect(list.right, 'and on the right').toBeLessThanOrEqual(composer.right + ROUND_PX);
    const { scrollWidth, innerWidth } = await sideways(page);
    expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
  });
});

// The layout moved the pieces of the composer around with CSS: axe sees the new row with an alert under it and with
// the suggestions open, in every theme (a11y.spec.ts scans the views with the composer idle).
for (const { theme, media } of [
  { theme: UI.theme.light, media: { colorScheme: 'light', contrast: 'no-preference' } },
  { theme: UI.theme.dark, media: { colorScheme: 'dark', contrast: 'no-preference' } },
  { theme: UI.theme.hc, media: { colorScheme: 'light', contrast: 'more' } },
] as const) {
  test(`T21 (h): axe finds no serious or critical violation with the "Send error" alert showing, and with the suggestions open, theme "${theme}"`, async ({ open, world }) => {
    await withChat(open, world, { size: LAPTOP, media }, async (page, env) => {
      await refusedSend(page, env);
      expect(await seriousViolations(page), `${theme}, alert on screen`).toEqual([]);
      await ui.messageBox(page).fill('');
      await ui.messageBox(page).pressSequentially('@');
      await expect(ui.suggestions(page)).toBeVisible();
      expect(await seriousViolations(page), `${theme}, suggestions open`).toEqual([]);
    });
  });
}

test('T21 (g): the tab order is "To", then the message box, then Send', async ({ open, world }) => {
  await withChat(open, world, { size: LAPTOP }, async (page) => {
    await ui.recipient(page).focus();
    await page.keyboard.press('Tab');
    await expect(ui.messageBox(page)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(ui.sendButton(page)).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(ui.messageBox(page)).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(ui.recipient(page)).toBeFocused();
  });
});
