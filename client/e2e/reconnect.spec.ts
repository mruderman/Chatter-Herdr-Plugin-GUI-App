// SPEC section 5 sync rules (ids only rise; resume with Last-Event-ID), ui-contract section 2 (status
// Offline, then Online) and plan T5 (resume after reconnect, dedupe by id): losing and regaining the
// connection shows Offline then Online, and the messages sent meanwhile arrive in order, once each.
// Chromium's offline emulation alone leaves an in-flight fetch stream open and delivering (the smoke
// canary shows it), so the page reaches the bridge through a proxy this spec cuts, together with
// setOffline, which flips navigator.onLine and fires "offline" as a real network loss does.
import { CHANNEL, HTTP, ROUTES, nonce, postAs } from './harness/api';
import { expect, openChat, signIn, test } from './harness/fixtures';
import { startProxy } from './harness/proxy';
import { UI, ui } from './harness/ui';

// Past the 30 s backoff cap of plan T2, with margin: the client may be mid-backoff when the network returns.
const RECONNECT_TIMEOUT = 45_000;
// Room for sign-in plus two reconnect timeouts.
const SPEC_TIMEOUT = 120_000;
const MISSED = 3;

test('SPEC section 5 sync rules, ui-contract section 2: losing and regaining the connection shows Offline then Online, and missed messages arrive in order, once each', async ({ open, world }) => {
  test.setTimeout(SPEC_TIMEOUT);
  const proxy = await startProxy(world.baseURL);
  try {
    const { page, context } = await open({ baseURL: proxy.url });
    // Harness first: the app shell and the API both answer through the proxy.
    expect((await page.goto('/'))?.status()).toBe(HTTP.ok);
    expect((await page.request.get(ROUTES.healthz)).status()).toBe(HTTP.ok);

    await signIn(page, world.members.kai.token);
    await openChat(page, world.repo.label);

    const tag = nonce();
    const missed = Array.from({ length: MISSED }, (_, i) => `Missed ${tag} number ${i + 1}`);
    proxy.cut();
    await context.setOffline(true);
    await expect(ui.connection(page)).toHaveText(UI.status.offline);
    for (const text of missed) await postAs(world, world.members.hana.token, CHANNEL, text);

    proxy.restore();
    await context.setOffline(false);
    await expect(ui.connection(page)).toHaveText(UI.status.online, { timeout: RECONNECT_TIMEOUT });

    const feed = ui.feed(page);
    for (const text of missed) await expect(feed.getByText(text)).toHaveCount(1, { timeout: RECONNECT_TIMEOUT });
    const shown = await feed.innerText();
    const positions = missed.map((text) => shown.indexOf(text));
    expect(positions, 'missed messages in the order they were sent').toEqual([...positions].sort((a, b) => a - b));
  } finally {
    await proxy.close();
  }
});
