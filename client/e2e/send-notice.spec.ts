// The send notice (docs/runbooks/exploratory-pass.md finding 10; SPEC section 5). A send answers 201 with
// `warnings` (Chatter's notice that a mention reaches nobody) and `delivery` ("queued" when no live session took
// a DM to an agent; a post's mention of one shows as " (queued)" in `pushed`). The composer says what the bridge
// reported, in plain text, as a status beside the message box, until the next send, another conversation or
// repo, or the member dismisses it; it never moves focus and never leaves on a timer.
// explore-10-send-warnings-not-shown.spec.ts guards the warning; this file guards the rest: the queued wording,
// that a plain send shows nothing, the dismissal and its focus, the axe scan with the notice on screen, and the
// screen at 1280 x 720 (the page scrolls just far enough to show the notice). Every spec runs against its own
// bridge, so that the rows it writes do not touch the shared world; its Chatter has no Herdr, so an agent never
// has a live session and a message to it is queued, deterministically. The specs about queued messages first
// ask the bridge itself (a probe through the API), so that none passes for the wrong reason.
import path from 'node:path';
import type { BrowserContextOptions, Page } from '@playwright/test';
import { seriousViolations } from './harness/axe';
import { loadBridgeHelpers, type BridgeEnv } from './harness/bridge';
import { chooseRecipient, expect, openChat, send, signIn, test, type OpenFn } from './harness/fixtures';
import { UI, dmWith, ui } from './harness/ui';
import { POLL_MS, type World } from './harness/world';

const CREATED = 201;
const AGENT = 'codex';
const NOTICE = 'Send notice';
const DISMISS = 'Dismiss notice';
const ANNOUNCEMENTS = 'Announcements';
const NO_AGENT = /matches no agent in this repo/;
const NOT_DELIVERED = new RegExp(`@${AGENT} has not received it yet: the message is saved, but no session of @${AGENT} could take it just now`);
// While the notice is on screen for this long, a timer would have taken it away (WCAG 2.2.1 is about exactly that).
const LONG_ENOUGH_MS = 6_000;

const notice = (page: Page) => ui.composer(page).getByRole('status', { name: NOTICE, exact: true });
const dismiss = (page: Page) => ui.composer(page).getByRole('button', { name: DISMISS, exact: true });
const announcements = (page: Page) => page.getByRole('status', { name: ANNOUNCEMENTS, exact: true });

async function privateBridge(world: World): Promise<BridgeEnv> {
  const { makeEnv } = await loadBridgeHelpers();
  return makeEnv({ staticDir: world.staticDir, pollMs: POLL_MS });
}

/** A bridge with one human member and one registered agent, and that member signed in, looking at #chat. */
async function withChat(open: OpenFn, world: World, context: BrowserContextOptions, body: (page: Page, env: BridgeEnv) => Promise<void>): Promise<void> {
  const env = await privateBridge(world);
  try {
    const token = env.addMember('ann', { kind: 'human', display_name: 'Ann' });
    env.seedAgent(AGENT);
    const { page } = await open({ baseURL: env.base, context });
    await signIn(page, token);
    await openChat(page, env.repoInfo.label);
    await body(page, env);
  } finally {
    await env.stop();
  }
}

test('send notice: a DM to an agent that no session took says it was saved and not delivered, and stays on the DM that was just opened', async ({ open, world }) => {
  await withChat(open, world, {}, async (page, env) => {
    const probe = await env.post('ann', AGENT, 'probe through the API');
    expect(probe.status).toBe(CREATED);
    expect((probe.body as { delivery: string | null }).delivery, 'the bridge says the message was queued').toBe('queued');

    await chooseRecipient(page, AGENT);
    await send(page, 'are you there?');
    await expect(notice(page)).toBeVisible();
    await expect(notice(page)).toContainText(NOT_DELIVERED);
    // The first DM creates its conversation and the composer opens it; the notice belongs to that conversation and stays.
    await expect(ui.conversation(page, dmWith(AGENT))).toHaveAttribute('aria-current', 'true');
    await expect(notice(page)).toBeVisible();
    // The send succeeded: nothing here is an alert, and focus is where the member left it.
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(ui.messageBox(page)).toBeFocused();
    // Said to a screen reader through the Announcements region as well, which exists before its first text.
    await expect(announcements(page)).toContainText(NOT_DELIVERED);
  });
});

test('send notice: a mention of an agent that no session took says the same, once for the agent', async ({ open, world }) => {
  await withChat(open, world, {}, async (page, env) => {
    const probe = await env.post('ann', '#chat', `hello @${AGENT}`);
    expect(probe.status).toBe(CREATED);
    expect((probe.body as { pushed: string[] }).pushed, 'the bridge says the push was queued').toEqual([`${AGENT} (queued)`]);

    // Not ending in the mention: while the suggestions for "@codex" are open under the caret, a click on Send
    // collapses the list on mousedown and the button moves away before the mouse is released.
    await send(page, `@${AGENT} are you there?`);
    await expect(notice(page)).toContainText(NOT_DELIVERED);
    await expect(notice(page).getByRole('listitem')).toHaveCount(1);
  });
});

test('send notice: a send with nothing to report shows no notice, and an old one goes with the next send', async ({ open, world }) => {
  await withChat(open, world, {}, async (page) => {
    await send(page, 'good morning');
    await expect(ui.feed(page).getByText('good morning')).toBeVisible();
    await expect(notice(page)).toHaveCount(0);

    await send(page, 'is anybody there? @nobodyhere');
    await expect(notice(page)).toContainText(NO_AGENT);
    await send(page, 'never mind');
    await expect(ui.feed(page).getByText('never mind')).toBeVisible();
    await expect(notice(page)).toHaveCount(0);
  });
});

test('send notice: it stays until it is dismissed, moves no focus, and the button returns focus to the message box', async ({ open, world }) => {
  await withChat(open, world, {}, async (page) => {
    await send(page, 'is anybody there? @nobodyhere');
    await expect(notice(page)).toContainText(NO_AGENT);
    await expect(ui.messageBox(page)).toBeFocused();

    await page.waitForTimeout(LONG_ENOUGH_MS);
    await expect(notice(page), 'a timer took the notice away').toBeVisible();

    // By keyboard: Send, then the button after it.
    await ui.sendButton(page).focus();
    await page.keyboard.press('Tab');
    await expect(dismiss(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(notice(page)).toHaveCount(0);
    await expect(dismiss(page)).toHaveCount(0);
    await expect(ui.messageBox(page)).toBeFocused();
  });
});

test('send notice: it goes when another conversation is opened', async ({ open, world }) => {
  await withChat(open, world, {}, async (page, env) => {
    await send(page, 'is anybody there? @nobodyhere');
    await expect(notice(page)).toContainText(NO_AGENT);
    // A conversation to switch to: a DM from someone else, written through the API as that member.
    env.addMember('bea', { kind: 'human', display_name: 'Bea' });
    const dm = await env.post('bea', 'ann', 'hello Ann');
    expect(dm.status).toBe(CREATED);
    await ui.conversation(page, dmWith('bea')).click();
    await expect(ui.conversation(page, dmWith('bea'))).toHaveAttribute('aria-current', 'true');
    await expect(notice(page)).toHaveCount(0);
  });
});

for (const { theme, media } of [
  { theme: UI.theme.light, media: { colorScheme: 'light', contrast: 'no-preference' } },
  { theme: UI.theme.dark, media: { colorScheme: 'dark', contrast: 'no-preference' } },
  { theme: UI.theme.hc, media: { colorScheme: 'light', contrast: 'more' } },
] as const) {
  test(`send notice: axe finds no serious or critical violation with the notice on screen, theme "${theme}"`, async ({ open, world }) => {
    await withChat(open, world, media, async (page) => {
      await send(page, `@nobodyhere and @${AGENT}, are you there?`);
      await expect(notice(page)).toContainText(NO_AGENT);
      await expect(notice(page)).toContainText(NOT_DELIVERED);
      expect(await seriousViolations(page), `${theme}, notice on screen`).toEqual([]);
    });
  });
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

test('send notice: at 1280 x 720 the notice is scrolled into view, with the newest message, the message box and Send on the same screen', async ({ open, world }) => {
  const env = await privateBridge(world);
  try {
    const token = env.addMember('ann', { kind: 'human', display_name: 'Ann' });
    env.addMember('talker', { kind: 'human', display_name: 'Talker' });
    env.seedAgent(AGENT);
    await insertFeed(env, 60);
    const { page } = await open({ baseURL: env.base, context: { viewport: { width: 1280, height: 720 } } });
    await signIn(page, token);
    await openChat(page, env.repoInfo.label);
    await send(page, `@nobodyhere and @${AGENT}, are you there?`);
    await expect(notice(page)).toContainText(NO_AGENT);
    await expect(notice(page)).toContainText(NOT_DELIVERED);

    // The composer is the bottom of the page and the log is at its floor on a window this high, so the notice
    // under Send starts below the fold: the composer scrolls the page just far enough to show it.
    await expect(notice(page), 'the notice is on screen').toBeInViewport({ ratio: 1 });
    await expect(dismiss(page), 'its button is too').toBeInViewport({ ratio: 1 });
    await expect(ui.messageBox(page)).toBeInViewport({ ratio: 1 });
    await expect(ui.sendButton(page)).toBeInViewport({ ratio: 1 });
    // A send does not yet bring the member's own message into view (exploratory pass, finding 6), so the reader is put at the log's end.
    await ui.feed(page).evaluate((log) => {
      log.scrollTop = log.scrollHeight;
    });
    await expect(ui.feed(page).getByRole('article').last(), 'the newest message is on screen with the notice showing').toBeInViewport({ ratio: 1 });
    await expect(ui.messageBox(page), 'scrolling the page did not take focus from the message box').toBeFocused();
    // Dismissed, the composer is as short as before: the first screen holds the message box without scrolling.
    await dismiss(page).click();
    await expect(notice(page)).toHaveCount(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(ui.messageBox(page)).toBeInViewport({ ratio: 1 });
    await expect(ui.sendButton(page)).toBeInViewport({ ratio: 1 });
  } finally {
    await env.stop();
  }
});

// The composer moves the page on its own to show the notice, so where the composer is taller than the window
// (a phone, 200% text: explore-7's guards) the scroll must not leave the focused message box out of view, and
// nothing may scroll sideways.
for (const { name, size, textPercent } of [
  { name: '375 x 667', size: { width: 375, height: 667 }, textPercent: undefined },
  { name: '320 x 568', size: { width: 320, height: 568 }, textPercent: undefined },
  { name: '200% text on 1280 x 720', size: { width: 1280, height: 720 }, textPercent: 200 },
] as const) {
  test(`send notice guard: at ${name} the page scrolling to the notice leaves the message box on screen and focused, and nothing scrolls sideways`, async ({ open, world }) => {
    const env = await privateBridge(world);
    try {
      const token = env.addMember('ann', { kind: 'human', display_name: 'Ann' });
      env.addMember('talker', { kind: 'human', display_name: 'Talker' });
      env.seedAgent(AGENT);
      await insertFeed(env, 60);
      const { page } = await open({ baseURL: env.base, context: { viewport: size } });
      await signIn(page, token);
      await openChat(page, env.repoInfo.label);
      if (textPercent !== undefined) {
        await page.evaluate((percent) => {
          document.documentElement.style.fontSize = `${percent}%`;
        }, textPercent);
      }
      await send(page, `@nobodyhere and @${AGENT}, are you there?`);
      await expect(notice(page)).toContainText(NO_AGENT);
      await expect(notice(page), 'some of the notice is on screen').toBeInViewport();
      await expect(ui.messageBox(page), 'the message box is still on screen').toBeInViewport({ ratio: 1 });
      await expect(ui.messageBox(page)).toBeFocused();
      const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
      expect(scrollWidth, 'nothing scrolls sideways').toBeLessThanOrEqual(innerWidth);
    } finally {
      await env.stop();
    }
  });
}
