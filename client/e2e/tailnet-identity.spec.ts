// SPEC section 6 and D14: a human reaches the bridge through `tailscale serve`, which adds the tailnet
// identity headers; the bridge trusts them only from loopback and only when `tailscale whois` on the
// forwarded address agrees. A registered login is signed in by those headers alone and never sees the
// token form; an unregistered one (403 not_registered) gets the sign-in view with the bridge's message
// on first load (ui-contract section 1). Each test runs its own second bridge with trustTailscale and
// a stub whois, serving the same build.
import type { Response as PlaywrightResponse } from '@playwright/test';
import { HTTP, ROUTES, nonce, type ApiError } from './harness/api';
import { loadBridgeHelpers, type BridgeEnv } from './harness/bridge';
import { expect, openChat, send, test } from './harness/fixtures';
import { UI, memberIdentity, ui } from './harness/ui';
import { CAST, POLL_MS, type World } from './harness/world';

const MEMBER = CAST.hana;
const REGISTERED = { address: '100.64.0.7', login: 'hana@example.com' };
const STRANGER = { address: '100.64.0.8', login: 'stranger@example.com' };
const NOT_REGISTERED = 'not_registered'; // bridge/src/auth.js
const SAW_TOKEN_FORM = '__e2eSawTokenForm';

const identityHeaders = (who: { address: string; login: string }) => ({ 'Tailscale-User-Login': who.login, 'X-Forwarded-For': who.address });

/** A second bridge that trusts the identity headers, with a whois that knows both addresses. */
async function identityBridge(world: World): Promise<BridgeEnv> {
  const logins = new Map([[REGISTERED.address, REGISTERED.login], [STRANGER.address, STRANGER.login]]);
  const { makeEnv } = await loadBridgeHelpers();
  const env = await makeEnv({
    trustTailscale: true,
    whois: async (ip) => logins.get(ip) ?? null,
    staticDir: world.staticDir,
    pollMs: POLL_MS,
  });
  env.addMember(MEMBER.handle, { kind: MEMBER.kind, display_name: MEMBER.display_name, tailscale_login: REGISTERED.login });
  return env;
}

test('SPEC section 6 and D14: a registered member arriving through the tailnet is signed in by the identity headers, and no token form is shown', async ({ open, world }) => {
  const env = await identityBridge(world);
  try {
    const headers = identityHeaders(REGISTERED);
    // Harness first: this bridge answers /v1/me for the identity headers alone, and refuses without them.
    const me = await fetch(new URL(ROUTES.me, env.base), { headers });
    expect(me.status).toBe(HTTP.ok);
    expect(await me.json()).toMatchObject({ handle: MEMBER.handle, kind: MEMBER.kind });
    expect((await fetch(new URL(ROUTES.me, env.base))).status).toBe(HTTP.unauthorized);

    const { page, context } = await open({ baseURL: env.base, context: { extraHTTPHeaders: headers } });
    const bearer: Array<Promise<string | null>> = [];
    context.on('request', (r) => {
      bearer.push(r.allHeaders().then((h) => (h.authorization ? r.url() : null), () => null));
    });
    // Records the token form if it ever appears, even for a moment, not only at the end.
    await page.addInitScript((flag) => {
      new MutationObserver(() => {
        if (document.querySelector('input[type="password"]')) Reflect.set(window, flag, true);
      }).observe(document, { childList: true, subtree: true });
    }, SAW_TOKEN_FORM);

    await page.goto('/');
    await expect(ui.banner(page).getByText(memberIdentity(MEMBER.display_name, MEMBER.handle))).toBeVisible();
    await expect(ui.banner(page).getByText(UI.kind.human, { exact: true })).toBeVisible();
    await expect(ui.connection(page)).toHaveText(UI.status.online);
    await expect(ui.tokenField(page)).toHaveCount(0);
    expect(await page.evaluate((flag) => Reflect.get(window, flag), SAW_TOKEN_FORM), 'the token form appeared at some point').toBeUndefined();

    // Reading and writing work on the identity alone.
    await openChat(page, env.repoInfo.label);
    const text = `Identity ${nonce()}`;
    await send(page, text);
    await expect(ui.feed(page).getByText(text)).toBeVisible();
    expect((await Promise.all(bearer)).filter((u) => u !== null), 'requests that carried an Authorization header').toEqual([]);
  } finally {
    await env.stop();
  }
});

test('ui-contract section 1: an unregistered tailnet login gets the sign-in view with "Sign-in failed: ..." on first load, and the token form still works', async ({ open, world }) => {
  const env = await identityBridge(world);
  try {
    const headers = identityHeaders(STRANGER);
    // Harness first: whois vouches for the login, but no member holds it.
    const probe = await fetch(new URL(ROUTES.me, env.base), { headers });
    expect(probe.status).toBe(HTTP.forbidden);
    expect(((await probe.json()) as ApiError).error.code).toBe(NOT_REGISTERED);

    const { page } = await open({ baseURL: env.base, context: { extraHTTPHeaders: headers } });
    const probes: PlaywrightResponse[] = [];
    page.on('response', (r) => {
      if (new URL(r.url()).pathname === ROUTES.me) probes.push(r);
    });
    await page.goto('/');
    await expect(ui.signInHeading(page)).toBeVisible();
    const first = probes[0];
    if (!first) throw new Error('the page showed the sign-in view without asking /v1/me');
    expect(first.status()).toBe(HTTP.forbidden);
    const { error } = (await first.json()) as ApiError;
    expect(error.code).toBe(NOT_REGISTERED);
    await expect(ui.signInError(page)).toContainText(`${UI.signIn.failurePrefix}${error.message}`);
    const field = ui.tokenField(page);
    await expect(field).toBeEditable();

    // A bearer token is checked before the identity headers, so the form signs the member in.
    const token = env.tokens[MEMBER.handle];
    if (!token) throw new Error(`the identity bridge issued no token for ${MEMBER.handle}`);
    await field.fill(token);
    await ui.signInButton(page).click();
    await expect(field).toHaveCount(0);
    await expect(ui.banner(page).getByText(memberIdentity(MEMBER.display_name, MEMBER.handle))).toBeVisible();
  } finally {
    await env.stop();
  }
});
