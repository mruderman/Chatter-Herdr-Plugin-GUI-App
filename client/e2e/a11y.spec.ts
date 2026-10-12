// Plan gate (docs/plans/m3-client.md, "Gate"): axe reports no serious or critical violations, with the
// WCAG 2.2 AA tag set, on sign-in, Chat, Board, Members, Admin, Settings and an open dialog, in the
// light, dark and high-contrast themes (ui-contract section 6, SPEC section 7). Each theme comes from
// the emulated system preference, which the contract says the default follows.
import type { BrowserContextOptions, Page } from '@playwright/test';
import { seriousViolations } from './harness/axe';
import { expect, openChat, signIn, test } from './harness/fixtures';
import { UI, ui } from './harness/ui';

// While the theme choice is "System", as in a fresh browser, <html> has no data-theme and the media
// queries pick the tokens (ui-contract section 8). So the theme a scan ran in is read from what the page
// shows: the body's background, which is that theme's --color-bg (src/styles/tokens.css), compared as
// the browser resolves it, so however the build spells the colour does not matter.
const THEMES: ReadonlyArray<{ theme: string; media: BrowserContextOptions; background: string }> = [
  { theme: UI.theme.light, media: { colorScheme: 'light', contrast: 'no-preference' }, background: 'rgb(243, 245, 247)' },
  { theme: UI.theme.dark, media: { colorScheme: 'dark', contrast: 'no-preference' }, background: 'rgb(14, 18, 22)' },
  { theme: UI.theme.hc, media: { colorScheme: 'light', contrast: 'more' }, background: 'rgb(0, 0, 0)' },
];
// Anything longer than this counts as motion; 0.01 ms is the common "reduce to nothing" idiom.
const MAX_MOTION_SECONDS = 0.00001;

for (const { theme, media, background } of THEMES) {
  test(`plan gate, axe (SPEC section 7, ui-contract section 6): no serious or critical violations on every view and an open dialog, theme "${theme}"`, async ({ open, world }) => {
    const { page } = await open({ context: media });
    const body = page.locator('body');
    const scan = async (state: string): Promise<void> => {
      await expect.soft(body, `the "${theme}" theme is showing while scanning ${state}`).toHaveCSS('background-color', background);
      expect.soft(await seriousViolations(page), `${theme}: ${state}`).toEqual([]);
    };

    await page.goto('/');
    await expect(ui.signInHeading(page)).toBeVisible();
    await scan('sign-in');

    await signIn(page, world.members.admin.token);
    await openChat(page, world.repo.label);
    await expect(ui.feed(page)).toBeVisible();
    await scan('Chat');
    for (const view of [UI.views.board, UI.views.members, UI.views.admin]) {
      await ui.viewButton(page, view).click();
      await expect(ui.viewHeading(page, view)).toBeVisible();
      await scan(view);
    }

    await page.getByRole('button', { name: UI.admin.addMember, exact: true }).click();
    await expect(ui.dialog(page, UI.admin.addMember)).toBeVisible();
    await scan('the "Add member" dialog');
    await page.keyboard.press('Escape');
    await expect(ui.dialog(page, UI.admin.addMember)).toBeHidden();

    await ui.settingsButton(page).click();
    await expect(ui.settingsDialog(page)).toBeVisible();
    await scan('the Settings dialog');
  });
}

/** Elements (and their ::before and ::after) whose computed transition or animation still moves. */
async function motion(page: Page, maxSeconds: number): Promise<string[]> {
  return page.evaluate((limit) => {
    const seconds = (list: string): number[] => list.split(',').map((v) => {
      const t = v.trim();
      return t.endsWith('ms') ? parseFloat(t) / 1000 : parseFloat(t);
    });
    const moving = (values: string): boolean => seconds(values).some((s) => s > limit);
    const found: string[] = [];
    for (const el of Array.from(document.querySelectorAll('*'))) {
      for (const pseudo of [null, '::before', '::after']) {
        const s = getComputedStyle(el, pseudo);
        const what = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${pseudo ?? ''}`;
        if (s.transitionProperty !== 'none' && moving(s.transitionDuration)) found.push(`${what} transition ${s.transitionProperty} ${s.transitionDuration}`);
        if (s.animationName !== 'none' && moving(s.animationDuration)) found.push(`${what} animation ${s.animationName} ${s.animationDuration}`);
      }
    }
    for (const a of document.getAnimations()) if (a.playState === 'running') found.push(`running animation ${a.constructor.name}`);
    return found;
  }, maxSeconds);
}

test('ui-contract section 6: with prefers-reduced-motion: reduce no transition or animation moves', async ({ open, world }) => {
  const { page } = await open({ context: { reducedMotion: 'reduce' } });
  await signIn(page, world.members.admin.token);
  await openChat(page, world.repo.label);
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
  expect.soft(await motion(page, MAX_MOTION_SECONDS), 'Chat view').toEqual([]);

  await ui.settingsButton(page).click();
  await expect(ui.settingsDialog(page)).toBeVisible();
  expect.soft(await motion(page, MAX_MOTION_SECONDS), 'Settings dialog open').toEqual([]);
});
