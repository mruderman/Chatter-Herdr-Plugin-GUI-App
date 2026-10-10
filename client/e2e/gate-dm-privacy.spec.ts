// Gate line 2 (CLAUDE.md, M3): a DM is invisible to a third member (SPEC section 2, D5). The bystander
// is a non-admin because admins see every DM (F13), and is connected before the DM is sent: the live
// stream (canSee in bridge/src/messages.js) and the history query are separate paths, and both are
// checked, in the UI and through the API. The admin sees the DM labelled "Admin view".
import { CHANNEL, HTTP, ROUTES, nonce, postAs, visibleMessages } from './harness/api';
import { loadBridgeHelpers, type SseEvent } from './harness/bridge';
import { chooseRecipient, enterChat, expect, send, test } from './harness/fixtures';
import { UI, adminDm, dmWith, ui } from './harness/ui';

const STREAM_WAIT = 15_000;
const isMessage = (id: number) => (ev: SseEvent): boolean =>
  ev.event === 'message' && typeof ev.data === 'object' && ev.data !== null && Reflect.get(ev.data, 'id') === id;

test('M3 gate (CLAUDE.md), line 2: a DM between two members is invisible to a third member in the UI and through the API; the admin sees it as "Admin view"', async ({ open, world }) => {
  const { admin, hana: sender, kai: recipient, ivo: bystander } = world.members;
  const tag = nonce();
  const dm = `Private ${tag}: not for the bystander`;
  const fence = `Fence ${tag}: public`;

  // Harness first: the bystander's own API stream is open and live before anything is sent.
  const { openSse } = await loadBridgeHelpers();
  const stream = await openSse(new URL(ROUTES.stream(world.repo.key), world.baseURL).href, { Authorization: `Bearer ${bystander.token}` });
  try {
    expect(stream.status).toBe(HTTP.ok);
    await stream.waitFor((ev) => ev.event === 'hello', STREAM_WAIT);

    const watcher = await enterChat(open, world, bystander);
    const overseer = await enterChat(open, world, admin);
    const receiver = await enterChat(open, world, recipient);
    const writer = await enterChat(open, world, sender);

    await chooseRecipient(writer.page, recipient.handle);
    const posted = writer.page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === ROUTES.messages(world.repo.key));
    await send(writer.page, dm);
    const reply = await posted;
    expect(reply.status()).toBe(HTTP.created);
    const dmId = Number(((await reply.json()) as { id: unknown }).id);

    // The two parties see it, labelled as a DM (ui-contract section 3).
    await ui.conversation(receiver.page, dmWith(sender.handle)).click();
    await expect(ui.feed(receiver.page).getByText(dm)).toBeVisible();
    await expect(ui.feed(receiver.page).getByText(UI.label.direct, { exact: true }).first()).toBeVisible();
    await ui.conversation(writer.page, dmWith(recipient.handle)).click();
    await expect(ui.feed(writer.page).getByText(dm)).toBeVisible();

    // A later public message fences the check: streams deliver in id order, so once the bystander
    // holds the fence it holds every earlier message it was ever going to be sent.
    const fenceId = await postAs(world, sender.token, CHANNEL, fence);
    await expect(ui.feed(watcher.page).getByText(fence)).toBeVisible();
    await stream.waitFor(isMessage(fenceId), STREAM_WAIT);

    // The bystander, in the UI: not in #chat, and no DM conversation at all (ivo is never party to one).
    await expect(ui.feed(watcher.page).getByText(dm)).toHaveCount(0);
    await expect(ui.conversations(watcher.page).getByRole('button')).toHaveCount(1);
    await expect(ui.conversation(watcher.page, UI.channel)).toBeVisible();
    // The bystander, through the API: neither the history nor the live stream carries it.
    expect((await visibleMessages(world, bystander.token)).map((m) => m.id)).not.toContain(dmId);
    expect(stream.events.some(isMessage(dmId)), 'the DM on the bystander\'s stream').toBe(false);

    // The admin sees every DM (F13), labelled so it is not mistaken for the admin's own.
    await ui.conversation(overseer.page, adminDm(sender.handle, recipient.handle)).click();
    await expect(ui.feed(overseer.page).getByText(dm)).toBeVisible();
    await expect(ui.feed(overseer.page).getByText(UI.label.adminView, { exact: true }).first()).toBeVisible();
  } finally {
    stream.close();
  }
});
