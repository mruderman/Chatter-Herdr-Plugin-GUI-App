// The specs' shared fixtures. `open` gives each simulated member a separate browser context with the
// guards attached, and when the test ends it fails the test on any CSP violation, uncaught page error or
// token leak in any page the test opened, whether the test itself passed or not.
import { test as base, expect, type BrowserContext, type BrowserContextOptions, type Page } from '@playwright/test';
import { Guard, redact, tokenLeaks } from './guard';
import { UI, ui } from './ui';
import { readWorld, worldTokens, type World, type WorldMember } from './world';

export { expect };

export interface Opened {
  context: BrowserContext;
  page: Page;
  guard: Guard;
}

export interface OpenOptions {
  /** Record pointer events; the keyboard specs assert that none fired. */
  tripwire?: boolean;
  /** Skip the end-of-test token check. Only the hygiene canary, which plants fake tokens, does. */
  skipHygiene?: boolean;
  /** An origin other than the shared bridge: the identity bridge, the reconnect proxy. */
  baseURL?: string;
  context?: BrowserContextOptions;
}

export type OpenFn = (options?: OpenOptions) => Promise<Opened>;

interface TestFixtures {
  open: OpenFn;
}

interface WorkerFixtures {
  world: World;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  world: [async ({}, use) => {
    await use(readWorld());
  }, { scope: 'worker' }],
  open: async ({ browser, world }, use) => {
    const opened: Array<{ o: Opened; hygiene: boolean }> = [];
    await use(async (options = {}) => {
      const context = await browser.newContext({ ...options.context, baseURL: options.baseURL ?? world.baseURL });
      const guard = await Guard.attach(context, { tripwire: options.tripwire ?? false });
      const page = await context.newPage();
      const o = { context, page, guard };
      opened.push({ o, hygiene: !options.skipHygiene });
      return o;
    });

    const problems: string[] = [];
    const secrets = worldTokens(world);
    for (const [i, { o, hygiene }] of opened.entries()) {
      const which = `browser ${i + 1}`;
      for (const v of o.guard.cspViolations) problems.push(`${which}: CSP violation: ${v}`);
      for (const p of o.guard.pointerEvents) problems.push(`${which}: pointer event in a keyboard-only run: ${p}`);
      // An uncaught error is a bug the selected assertions may never touch, so it fails the test (the guard
      // has already redacted anything token-shaped; a spec that throws on purpose hands the error back first).
      for (const e of o.guard.pageErrors) problems.push(`${which}: uncaught page error: ${e}`);
      if (!hygiene) continue;
      const leaks = await tokenLeaks(o.page, o.guard, secrets).catch((e: unknown) => [`(check failed: ${redact(String(e))})`]);
      for (const where of leaks) problems.push(`${which}: token found in ${where}`);
    }
    await Promise.all(opened.map(({ o }) => o.context.close()));
    expect(problems, 'CSP violations, pointer events under the tripwire, uncaught page errors and token leaks in the browsers this test opened').toEqual([]);
  },
});

/** Signs in through the token form (ui-contract section 1) and waits for the shell. */
export async function signIn(page: Page, token: string): Promise<void> {
  await page.goto('/');
  const field = ui.tokenField(page);
  await expect(field).toBeVisible();
  await field.fill(token);
  await ui.signInButton(page).click();
  // Signed in: the field is removed (section 1) and the header shows the connection status (section 2).
  await expect(field).toHaveCount(0);
  await expect(ui.connection(page)).toBeVisible();
}

/** Picks the repository, the Chat view and #chat, then waits for the live stream (status Online). */
export async function openChat(page: Page, repoLabel: string): Promise<void> {
  await ui.repository(page).selectOption({ label: repoLabel });
  await ui.viewButton(page, UI.views.chat).click();
  await expect(ui.viewHeading(page, UI.views.chat)).toBeVisible();
  await ui.conversation(page, UI.channel).click();
  await expect(ui.conversation(page, UI.channel)).toHaveAttribute('aria-current', 'true');
  await expect(ui.connection(page)).toHaveText(UI.status.online);
}

/** A member's own browser, signed in and looking at #chat in the main repo. */
export async function enterChat(open: OpenFn, world: World, member: WorldMember, options?: OpenOptions): Promise<Opened> {
  const o = await open(options);
  await signIn(o.page, member.token);
  await openChat(o.page, world.repo.label);
  return o;
}

/**
 * Chooses a DM recipient in the composer's "To" select. The contract fixes the order of the options
 * but not a member option's text or value, so this accepts the handle as the value, as the whole
 * text, or as "{handle} (...)" or "... ({handle})".
 */
export async function chooseRecipient(page: Page, handle: string): Promise<void> {
  const select = ui.recipient(page);
  await expect(select).toBeVisible();
  const options = await select.locator('option').evaluateAll((els) =>
    els.map((el) => ({ value: el instanceof HTMLOptionElement ? el.value : '', text: (el.textContent ?? '').trim() })));
  const match = options.find((o) => o.value === handle || o.text === handle || o.text.startsWith(`${handle} (`) || o.text.endsWith(`(${handle})`));
  if (!match) throw new Error(`the "${UI.recipient}" select offers no option for ${handle}: ${JSON.stringify(options.map((o) => o.text))}`);
  await select.selectOption({ value: match.value });
}

/** Types a message and presses Send; the composer clears only after the bridge accepted it (section 3). */
export async function send(page: Page, text: string): Promise<void> {
  await ui.messageBox(page).fill(text);
  await ui.sendButton(page).click();
  await expect(ui.messageBox(page)).toHaveValue('');
}
