// Keyboard-only moves for the gate's keyboard spec. Nothing here clicks, hovers or focuses by script:
// focus only ever moves through Tab, Shift+Tab, Enter, arrows and Escape (ui-contract section 5).
import { expect, type Locator, type Page } from '@playwright/test';
import { UI, ui } from './ui';

// One lap of the Chat view is well under this; a target not reached by then is not in the Tab order.
const MAX_TABS = 80;
const MAX_OPTIONS = 20;

const isFocused = (target: Locator): Promise<boolean> => target.evaluate((el) => el === document.activeElement);

/** Presses Tab until `target` has focus. */
export async function tabTo(page: Page, target: Locator): Promise<void> {
  // Attached, not visible: a skip link may be visually hidden until it has focus.
  await expect(target).toBeAttached();
  for (let i = 0; i < MAX_TABS; i++) {
    if (await isFocused(target)) return;
    await page.keyboard.press('Tab');
  }
  if (await isFocused(target)) return;
  throw new Error(`Tab did not reach ${target.toString()} in ${MAX_TABS} presses`);
}

export async function signInByKeyboard(page: Page, token: string): Promise<void> {
  await page.goto('/');
  const field = ui.tokenField(page);
  await expect(field).toBeVisible();
  await tabTo(page, field);
  await page.keyboard.type(token);
  await page.keyboard.press('Enter');
  await expect(field).toHaveCount(0);
  await expect(ui.connection(page)).toHaveText(UI.status.online);
}

export async function goToView(page: Page, name: string): Promise<void> {
  await tabTo(page, ui.viewButton(page, name));
  await page.keyboard.press('Enter');
  await expect(ui.viewHeading(page, name)).toBeVisible();
}

/**
 * Picks an option of the focused native select with the arrow keys, which on a closed select change
 * the choice at once (and fire change). Type-ahead is not used: Chromium joins letters typed within a
 * second into one search, which makes it timing-dependent.
 */
export async function chooseByKeyboard(page: Page, select: Locator, label: string): Promise<void> {
  await expect(select).toBeFocused();
  const labels = (await select.locator('option').allTextContents()).map((t) => t.trim());
  const target = labels.indexOf(label);
  expect(target, `the select offers "${label}" among ${JSON.stringify(labels)}`).toBeGreaterThanOrEqual(0);
  const current = await select.evaluate((el) => (el instanceof HTMLSelectElement ? el.selectedIndex : -1));
  const key = target > current ? 'ArrowDown' : 'ArrowUp';
  for (let i = 0; i < Math.abs(target - current); i++) await page.keyboard.press(key);
  await expect(select.locator('option:checked')).toHaveText(label);
}

export async function clearByKeyboard(page: Page, field: Locator): Promise<void> {
  await expect(field).toBeFocused();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  await expect(field).toHaveValue('');
}

/** ArrowDown until the combobox's aria-activedescendant points at the named suggestion. */
export async function activateSuggestion(page: Page, box: Locator, name: string): Promise<void> {
  const option = ui.suggestions(page).getByRole('option', { name, exact: true });
  await expect(option).toBeVisible();
  const id = await option.getAttribute('id');
  expect(id, 'a suggestion needs an id for aria-activedescendant').toBeTruthy();
  for (let i = 0; i < MAX_OPTIONS; i++) {
    if ((await box.getAttribute('aria-activedescendant')) === id) return;
    await page.keyboard.press('ArrowDown');
  }
  await expect(box).toHaveAttribute('aria-activedescendant', id ?? '');
}

/** Where focus sits, by the regions of ui-contract section 5's Tab order. */
export const TAB_ORDER = ['skip-messages', 'skip-composer', 'header', 'primary', 'conversations', 'feed', 'composer'] as const;
export type FocusRegion = (typeof TAB_ORDER)[number] | 'none' | 'other';

/**
 * Presses Tab until focus has gone once around the page and is back on "Skip to messages", recording
 * the region of every stop. Starting wherever focus happens to be makes it independent of where the
 * app leaves focus after sign-in.
 */
export async function focusLap(page: Page): Promise<FocusRegion[]> {
  const regions = await Promise.all([
    ui.skipToMessages(page), ui.skipToComposer(page), ui.primaryNav(page), ui.conversations(page),
    ui.feed(page), ui.composer(page), ui.banner(page),
  ].map((l) => l.elementHandle()));
  const stops: FocusRegion[] = [];
  for (let i = 0; i < 2 * MAX_TABS; i++) {
    await page.keyboard.press('Tab');
    const region = await page.evaluate(([skipMessages, skipComposer, primary, conversations, feed, composer, banner]) => {
      const a = document.activeElement;
      if (!a || a === document.body) return 'none';
      if (a === skipMessages) return 'skip-messages';
      if (a === skipComposer) return 'skip-composer';
      // Most specific first: the primary navigation may sit inside the banner.
      const inside: Array<[Element | undefined, string]> = [[primary, 'primary'], [conversations, 'conversations'], [feed, 'feed'], [composer, 'composer'], [banner, 'header']];
      for (const [el, name] of inside) if (el?.contains(a)) return name;
      return 'other';
    }, regions);
    stops.push(region as FocusRegion);
    const laps = stops.filter((s) => s === 'skip-messages').length;
    if (laps === 2) return stops.slice(stops.indexOf('skip-messages'), stops.lastIndexOf('skip-messages'));
  }
  throw new Error(`Tab did not come back around to "${UI.skipToMessages}" in ${2 * MAX_TABS} presses: ${stops.join(', ')}`);
}

/** The lap reduced to its known regions, each run of stops in one region counted once. */
export function regionOrder(lap: readonly FocusRegion[]): FocusRegion[] {
  const known = lap.filter((r) => (TAB_ORDER as readonly string[]).includes(r));
  return known.filter((r, i) => i === 0 || known[i - 1] !== r);
}
