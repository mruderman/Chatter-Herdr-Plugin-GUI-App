// Gate line 4 (CLAUDE.md, M3): the main flow works by keyboard alone. Every test here runs under the
// pointer tripwire (ui-contract section 5) and moves focus only with keys. The first test is the gate
// line itself; the others certify the keyboard details the contract states, so a red gate test means
// the main flow broke, not a side rule.
import { HTTP, ROUTES, nonce, type ApiError } from './harness/api';
import { expect, test } from './harness/fixtures';
import { TAB_ORDER, activateSuggestion, chooseByKeyboard, clearByKeyboard, focusLap, goToView, regionOrder, signInByKeyboard, tabTo } from './harness/keyboard';
import { UI, suggestion, ui } from './harness/ui';

const WRONG_TOKEN = 'not-a-valid-token';
const MIN_TARGET_PX = 24; // ui-contract section 6
const TABS_INSIDE_DIALOG = 12;

test('M3 gate (CLAUDE.md), line 4: the main flow works by keyboard alone (sign in, skip link, repository, @-completion, send, read back, Board, Admin)', async ({ open, world }) => {
  const { page, guard } = await open({ tripwire: true });
  const hana = world.members.hana.handle;
  await signInByKeyboard(page, world.members.admin.token);
  await goToView(page, UI.views.chat);

  // Repository select: to the sidecar repo and back with the arrow keys, the feed following each choice.
  const repo = ui.repository(page);
  const channel = ui.conversation(page, UI.channel);
  await tabTo(page, repo);
  await chooseByKeyboard(page, repo, world.sidecar.label);
  await tabTo(page, channel);
  await page.keyboard.press('Enter');
  await expect(ui.feed(page).getByText(world.sidecar.seeded)).toBeVisible();
  await tabTo(page, repo);
  await chooseByKeyboard(page, repo, world.repo.label);
  await tabTo(page, channel);
  await page.keyboard.press('Enter');
  await expect(channel).toHaveAttribute('aria-current', 'true');
  await expect(ui.feed(page).getByText(world.sidecar.seeded)).toHaveCount(0);

  // Skip link to the message box; compose with @-completion by keys; Enter sends.
  await tabTo(page, ui.skipToComposer(page));
  await page.keyboard.press('Enter');
  const box = ui.messageBox(page);
  await expect(box).toBeFocused();
  const tag = nonce();
  await page.keyboard.type(`Keyboard flow @${hana.slice(0, 2)}`);
  await activateSuggestion(page, box, suggestion(hana, UI.kind.human));
  await page.keyboard.press('Enter');
  await expect(ui.suggestions(page)).toBeHidden();
  await expect(box).toHaveValue(new RegExp(`@${hana}\\b`));
  await page.keyboard.type(` by keys ${tag}`);
  await page.keyboard.press('Enter');
  await expect(box).toHaveValue('');
  const sent = ui.feed(page).getByText(tag);
  await expect(sent).toBeVisible();
  await expect(sent).toContainText(`@${hana}`);

  // Read it back: the other skip link puts focus on the feed.
  await tabTo(page, ui.skipToMessages(page));
  await page.keyboard.press('Enter');
  await expect(ui.feed(page)).toBeFocused();

  // Board and Admin from the primary navigation.
  await goToView(page, UI.views.board);
  await expect(ui.viewButton(page, UI.views.board)).toHaveAttribute('aria-current', 'page');
  await goToView(page, UI.views.admin);
  await expect(page.getByRole('table', { name: UI.admin.membersTable, exact: true })).toBeVisible();

  expect(guard.pointerEvents).toEqual([]);
});

test('ui-contract section 1 and D14: the token form follows a 401, refuses a bad token with the bridge\'s message, and Enter submits', async ({ open, world }) => {
  const { page, guard } = await open({ tripwire: true });
  const probes: number[] = [];
  page.on('response', (r) => {
    if (new URL(r.url()).pathname === ROUTES.me) probes.push(r.status());
  });
  await page.goto('/');
  const field = ui.tokenField(page);
  await expect(ui.signInHeading(page)).toBeVisible();
  await expect(field).toBeVisible();
  expect(probes[0], 'the form appears after /v1/me answered 401').toBe(HTTP.unauthorized);
  // Nothing has been tried yet, so a first-load 401 shows no failure (a 403 not_registered would).
  await expect(ui.signInError(page)).toHaveCount(0);
  await expect(field).toHaveAttribute('type', 'password');
  await expect(field).toHaveAttribute('autocomplete', 'off');

  await tabTo(page, field);
  await page.keyboard.type(WRONG_TOKEN);
  const attempt = page.waitForResponse((r) => new URL(r.url()).pathname === ROUTES.me);
  await page.keyboard.press('Enter');
  const refusal = await attempt;
  expect(refusal.status()).toBe(HTTP.unauthorized);
  const { error } = (await refusal.json()) as ApiError;
  await expect(ui.signInError(page)).toContainText(`${UI.signIn.failurePrefix}${error.message}`);

  await tabTo(page, field);
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type(world.members.admin.token);
  await page.keyboard.press('Enter');
  await expect(field).toHaveCount(0);
  await expect(ui.connection(page)).toHaveText(UI.status.online);
  expect(guard.pointerEvents).toEqual([]);
});

test('ui-contract sections 2 and 5: Tab runs skip links, header, primary navigation, conversations, feed, composer; skip links show on focus', async ({ open, world }) => {
  const { page, guard } = await open({ tripwire: true });
  await signInByKeyboard(page, world.members.admin.token);
  await goToView(page, UI.views.chat);

  const lap = await focusLap(page);
  expect(lap.slice(0, 2), 'the first two tab stops').toEqual(['skip-messages', 'skip-composer']);
  expect(regionOrder(lap), `Tab order (whole lap: ${lap.join(', ')})`).toEqual([...TAB_ORDER]);

  for (const link of [ui.skipToMessages(page), ui.skipToComposer(page)]) {
    await tabTo(page, link);
    await expect(link).toBeInViewport();
    const box = await link.boundingBox();
    expect(box !== null && box.width >= MIN_TARGET_PX && box.height >= MIN_TARGET_PX, `${await link.textContent()} is a visible ${MIN_TARGET_PX} px target when focused`).toBe(true);
  }
  expect(guard.pointerEvents).toEqual([]);
});

test('ui-contract section 3: mention suggestions by keys (combobox semantics; Escape keeps the text; Tab accepts; agents and "everyone" for the admin)', async ({ open, world }) => {
  const { page, guard } = await open({ tripwire: true });
  const kai = world.members.kai.handle;
  await signInByKeyboard(page, world.members.admin.token);
  await goToView(page, UI.views.chat);
  await tabTo(page, ui.skipToComposer(page));
  await page.keyboard.press('Enter');
  const box = ui.messageBox(page);
  const list = ui.suggestions(page);
  await expect(box).toBeFocused();

  await page.keyboard.type('@');
  await expect(list).toBeVisible();
  await expect(box).toHaveAttribute('role', 'combobox');
  await expect(box).toHaveAttribute('aria-expanded', 'true');
  const listId = await list.getAttribute('id');
  expect(listId, 'the listbox has an id for aria-controls').toBeTruthy();
  await expect(box).toHaveAttribute('aria-controls', listId ?? '');
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();
  await expect(box).toHaveValue('@');
  await clearByKeyboard(page, box);

  // The admin may address agents (SPEC section 6, D4) and use everyone (D8), so both are offered.
  await page.keyboard.type(`@${world.agent.slice(0, 2)}`);
  await expect(list.getByRole('option', { name: suggestion(world.agent, UI.kind.agent), exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await clearByKeyboard(page, box);
  await page.keyboard.type('@ev');
  await expect(list.getByRole('option', { name: /^everyone\b/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await clearByKeyboard(page, box);

  // Tab accepts the active suggestion and keeps focus in the message box.
  await page.keyboard.type(`@${kai.slice(0, 2)}`);
  await activateSuggestion(page, box, suggestion(kai, UI.kind.computational));
  await page.keyboard.press('Tab');
  await expect(list).toBeHidden();
  await expect(box).toBeFocused();
  await expect(box).toHaveValue(new RegExp(`@${kai}\\b`));
  await clearByKeyboard(page, box);
  expect(guard.pointerEvents).toEqual([]);
});

test('ui-contract section 5: dialogs by keyboard (focus moves in, Tab and Shift+Tab stay inside, Escape closes, focus returns)', async ({ open, world }) => {
  const { page, guard } = await open({ tripwire: true });
  await signInByKeyboard(page, world.members.admin.token);
  const dialogs = [
    { view: UI.views.chat, opener: ui.settingsButton(page), dialog: ui.settingsDialog(page) },
    { view: UI.views.admin, opener: page.getByRole('button', { name: UI.admin.addMember, exact: true }), dialog: ui.dialog(page, UI.admin.addMember) },
  ];
  for (const { view, opener, dialog } of dialogs) {
    await goToView(page, view);
    await tabTo(page, opener);
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog, 'every dialog is named').toHaveAccessibleName(/\S/);
    const focusInside = () => dialog.evaluate((d) => d.contains(document.activeElement));
    await expect.poll(focusInside, 'focus moved into the dialog').toBe(true);
    for (const key of ['Tab', 'Shift+Tab']) {
      for (let i = 1; i <= TABS_INSIDE_DIALOG; i++) {
        await page.keyboard.press(key);
        await expect.poll(focusInside, `${key} x${i} stays inside`).toBe(true);
      }
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  }
  expect(guard.pointerEvents).toEqual([]);
});
