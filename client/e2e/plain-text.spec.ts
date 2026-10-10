// SPEC section 7 and section 10 (script injection), ui-contract sections 3 and 7: message text renders
// as plain text only. No HTML parsed from a body, no remote images, links shown as text, nothing run.
// Some bodies are in the history the page loads and some arrive over the live stream, so both
// rendering paths are covered. Each payload would leave a trace if it were parsed: an element id, a
// request for a probe image, a global, a dialog, or (inline handlers) a CSP violation the guard sees.
import { CHANNEL, nonce, postAs, visibleMessages } from './harness/api';
import { expect, openChat, signIn, test } from './harness/fixtures';
import { ui } from './harness/ui';

const PROBE_IMAGE = '/e2e-probe.png';
const XSS_FLAG = '__e2eXss';
const PARSED_MARKERS = '#e2e-img, #e2e-script, #e2e-b, #e2e-a';
const ACTIVE_ELEMENTS = 'a[href], img, script, iframe, object, embed';

test('SPEC section 7: message bodies with HTML, script tags and URLs render as literal text and run nothing', async ({ open, world }) => {
  const poster = world.members.kai;
  const tag = nonce();
  const inHistory = [
    `<img id="e2e-img" src="${PROBE_IMAGE}" onerror="window.${XSS_FLAG} = 1"> ${tag} image`,
    `<script id="e2e-script">window.${XSS_FLAG} = 2</script> ${tag} script`,
    `<b id="e2e-b">bold</b> &amp; <i>italic</i> ${tag} markup`,
  ];
  const live = [
    `see https://example.com/e2e?x=1&y=<z> or javascript:alert(1) ${tag} links`,
    `<a id="e2e-a" href="https://example.com/e2e">click</a> [md](https://example.com/md) ![img](https://example.com/e2e.png) ${tag} anchors`,
  ];

  // Harness first: the bridge accepts and stores the history bodies before the reader arrives.
  const ids: number[] = [];
  for (const body of inHistory) ids.push(await postAs(world, poster.token, CHANNEL, body));

  const { page } = await open();
  const probes: string[] = [];
  const dialogs: string[] = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.pathname === PROBE_IMAGE || url.hostname === 'example.com') probes.push(r.url());
  });
  page.on('dialog', (d) => {
    dialogs.push(d.type());
    void d.dismiss();
  });
  await signIn(page, world.members.hana.token);
  await openChat(page, world.repo.label);
  for (const body of live) ids.push(await postAs(world, poster.token, CHANNEL, body));

  // What the UI must show is what the bridge stored (Chatter may normalise a body; it is compared as stored).
  const stored = (await visibleMessages(world, world.members.hana.token)).filter((m) => ids.includes(m.id));
  expect(stored.map((m) => m.id)).toEqual(ids);
  const feed = ui.feed(page);
  for (const m of stored) await expect(feed.getByText(m.body)).toBeVisible();

  await expect(page.locator(PARSED_MARKERS)).toHaveCount(0);
  await expect(feed.locator(ACTIVE_ELEMENTS)).toHaveCount(0);
  expect(await page.evaluate((flag) => Reflect.get(window, flag), XSS_FLAG)).toBeUndefined();
  expect(probes, 'requests a parsed body would have made').toEqual([]);
  expect(dialogs, 'dialogs a parsed body would have opened').toEqual([]);
});
