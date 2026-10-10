// SPEC sections 5 and 6 (revocation closes the member's streams at once through the API), ui-contract
// section 2 (status "Access revoked") and plan T2 ("bye revoked" stops reconnecting for good): a revoked
// member's open stream ends with "Access revoked" and the page never asks for the stream again.
// The member is made for this test so revoking it leaves the shared cast alone.
import { HTTP, ROUTES, call, nonce, type ApiError } from './harness/api';
import { expect, openChat, signIn, test } from './harness/fixtures';
import { UI, ui } from './harness/ui';

// Far past the 30 s backoff cap of plan T2, so any reconnect timer the page set has come due.
const JUMP = '05:00';

test('SPEC sections 5 and 6, ui-contract section 2: a revoked member\'s open stream ends with "Access revoked" and the page stops reconnecting', async ({ open, world }) => {
  const admin = world.members.admin;
  const handle = `gone-${nonce()}`;

  // Harness first: the member exists and its token works.
  const created = await call<{ token: string } | ApiError>(world.baseURL, admin.token, 'POST', ROUTES.members, { handle, kind: 'computational', display_name: 'Gone' });
  expect(created.status).toBe(HTTP.created);
  if (!('token' in created.body)) throw new Error('adding the member returned no token');
  const token = created.body.token;
  expect((await call(world.baseURL, token, 'GET', ROUTES.me)).status).toBe(HTTP.ok);

  const { page, context } = await open();
  // The page's own clock, so the spec can let any reconnect timer come due without waiting for it.
  await page.clock.install();
  await page.goto('/');
  // Installed, the clock still runs by itself: the app's timers fire as usual until the jump below.
  await page.evaluate(() => new Promise<void>((resolve) => { setTimeout(resolve, 10); }));
  const streamPath = ROUTES.stream(world.repo.key);
  let streamRequests = 0;
  context.on('request', (r) => {
    if (new URL(r.url()).pathname === streamPath) streamRequests += 1;
  });

  await signIn(page, token);
  await openChat(page, world.repo.label);
  expect(streamRequests, 'the page opened the stream').toBeGreaterThan(0);

  expect((await call(world.baseURL, admin.token, 'DELETE', ROUTES.member(handle))).status).toBe(HTTP.ok);
  await expect(ui.connection(page)).toHaveText(UI.status.revoked);

  const before = streamRequests;
  await page.clock.fastForward(JUMP);
  // Fence: a request the page makes after the jump. Any stream request a due timer fired was issued
  // before it, so once the fence is seen the count is final.
  await Promise.all([
    page.waitForRequest((r) => new URL(r.url()).pathname === ROUTES.healthz),
    page.evaluate((route) => fetch(route).then((r) => r.status), ROUTES.healthz),
  ]);
  expect(streamRequests, 'stream requests after "Access revoked"').toBe(before);
  await expect(ui.connection(page)).toHaveText(UI.status.revoked);
});
