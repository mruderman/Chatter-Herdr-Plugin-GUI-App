// Gate line 3 (CLAUDE.md, M3): a member's @everyone is refused with a visible error. D8 makes the bridge
// the enforcer (Chatter itself accepts @everyone from anyone, F9), so the spec requires the refusal to
// come back from the bridge (403 everyone_admin_only) and reads Chatter's own table to prove nothing
// was written. The sender is a non-admin; the admin may use @everyone.
import { HTTP, ROUTES, countChatterRows, nonce, type ApiError } from './harness/api';
import { enterChat, expect, test } from './harness/fixtures';
import { UI, suggestion, ui } from './harness/ui';

const EVERYONE_ADMIN_ONLY = 'everyone_admin_only'; // bridge/src/policy.js

test('M3 gate (CLAUDE.md), line 3: a member\'s @everyone shows the "Send error" alert with the bridge\'s message, keeps the draft, and adds nothing to the feed or to Chatter', async ({ open, world }) => {
  const { page } = await enterChat(open, world, world.members.ivo);
  const text = `@everyone gate check ${nonce()}`;
  await ui.recipient(page).selectOption({ label: UI.channel });

  const before = await countChatterRows(world);
  const posted = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === ROUTES.messages(world.repo.key));
  await ui.messageBox(page).fill(text);
  await ui.sendButton(page).click();
  const reply = await posted;
  expect(reply.status()).toBe(HTTP.forbidden);
  const { error } = (await reply.json()) as ApiError;
  expect(error.code).toBe(EVERYONE_ADMIN_ONLY);

  await expect(ui.sendError(page)).toContainText(`${UI.sendErrorPrefix}${error.message}`);
  await expect(ui.messageBox(page)).toHaveValue(text);
  await expect(ui.feed(page).getByText(text)).toHaveCount(0);
  expect(await countChatterRows(world), 'rows in Chatter\'s messages table').toBe(before);
});

test('ui-contract section 3: "everyone" is not offered to a member in the mention suggestions', async ({ open, world }) => {
  const { page } = await enterChat(open, world, world.members.ivo);
  const box = ui.messageBox(page);
  const list = ui.suggestions(page);
  const someone = list.getByRole('option', { name: suggestion(world.members.hana.handle, UI.kind.human), exact: true });

  await box.click();
  await page.keyboard.type('@');
  // The list opens on "@" with every candidate, so the narrowing below is visible when it applies.
  await expect(someone).toBeVisible();
  await page.keyboard.type('ev');
  await expect(someone).toHaveCount(0);
  await expect(page.getByRole('option', { name: /^everyone\b/ })).toHaveCount(0);
});
