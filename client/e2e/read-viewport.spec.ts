// G2 round 4, finding 2 (plan T14d): the read pointer follows what the reader can see. At 200% text on a
// phone the feed is a box in a page that scrolls, and the page can be scrolled until the box is entirely
// above the browser window while the box itself still sits at its own end. A message that arrives then
// has not been shown, so the page must not acknowledge it; it does so once the reader scrolls the page
// back to the feed's end. The check is made through the browser's own layout, which no jsdom test has.
import type { Locator } from '@playwright/test';
import { CHANNEL, nonce, postAs } from './harness/api';
import { enterChat, expect, test } from './harness/fixtures';
import { ui } from './harness/ui';

const PHONE = { width: 360, height: 420 };
/** The bridge's read route is /v1/repos/{key}/read (SPEC section 5); the repo key varies, so the end of the path is matched. */
const READ_PATH_END = '/read';
/** The debounce before an acknowledgement is 500 ms (plan T8a); a second is long enough for one to have been sent. */
const SETTLE_MS = 1_000;
/** The brief's window for "no acknowledgement": longer than the debounce plus the stream's delivery. */
const QUIET_MS = 2_000;
/** Where the log's bottom edge lands when the page is scrolled back to it: clearly inside the window, not on its edge. */
const INSET_PX = 40;

interface Geometry {
  /** The log's rect in the browser window. */
  top: number;
  bottom: number;
  windowHeight: number;
  /** The log is scrolled to its own end. */
  atEnd: boolean;
}

function geometry(log: Locator): Promise<Geometry> {
  return log.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      top: rect.top,
      bottom: rect.bottom,
      windowHeight: window.innerHeight,
      atEnd: element.scrollHeight - element.scrollTop - element.clientHeight <= 4,
    };
  });
}

test('G2 round 4, finding 2: no read acknowledgement while the feed is above the browser window; one when the page is scrolled back to it', async ({ open, world }) => {
  const { hana, kai } = world.members;
  const { page } = await enterChat(open, world, hana, { context: { viewport: PHONE } });
  const feed = ui.feed(page);

  // Every acknowledgement this page sends, with the id it says. Counted per page, from here on.
  const reads: Array<number | null> = [];
  page.on('request', (request) => {
    if (request.method() !== 'POST' || !new URL(request.url()).pathname.endsWith(READ_PATH_END)) return;
    const sent = request.postDataJSON() as { up_to_id?: unknown } | null;
    reads.push(typeof sent?.up_to_id === 'number' ? sent.up_to_id : null);
  });

  // A test-only emulation of a member who set 200% text: nothing in the app reads or sets this.
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  // The reader has read down to the feed's end, and then down the page to the composer.
  await feed.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
  });
  // Whatever acknowledgement opening the conversation and these scrolls led to has been sent by now.
  await page.waitForTimeout(SETTLE_MS);
  const before = reads.length;

  const away = await geometry(feed);
  console.log(`feed above the window: top ${away.top}, bottom ${away.bottom}, window ${away.windowHeight}, feed at its own end: ${away.atEnd}`);
  expect(away.bottom, 'the precondition of the defect: the page is scrolled until the whole feed is above the window').toBeLessThan(0);
  expect(away.atEnd, 'the feed itself is scrolled to its end').toBe(true);

  const text = `Viewport ${nonce()}: written while the feed is out of sight`;
  const id = await postAs(world, kai.token, CHANNEL, text);
  // It has arrived in the feed (which follows its own end) while the window still shows something else.
  await expect(feed.getByText(text)).toBeVisible();
  expect((await geometry(feed)).bottom).toBeLessThan(0);
  await page.waitForTimeout(QUIET_MS);
  expect(reads.slice(before), 'nothing is acknowledged for a message that was never on screen').toEqual([]);

  // Scroll the page back until the feed's bottom edge is in view: the newest message is there.
  await feed.evaluate((element, inset) => {
    const rect = element.getBoundingClientRect();
    window.scrollTo(0, window.scrollY + rect.bottom - (window.innerHeight - inset));
  }, INSET_PX);
  const back = await geometry(feed);
  console.log(`feed scrolled back: top ${back.top}, bottom ${back.bottom}, window ${back.windowHeight}, feed at its own end: ${back.atEnd}`);
  expect(back.bottom).toBeGreaterThan(0);
  expect(back.bottom).toBeLessThanOrEqual(back.windowHeight);
  expect(back.atEnd).toBe(true);

  await expect.poll(() => reads.length - before, { message: 'the acknowledgement follows the scroll, after the debounce' }).toBe(1);
  await page.waitForTimeout(SETTLE_MS);
  expect(reads.slice(before), 'exactly one, with the newest id').toEqual([id]);
});
