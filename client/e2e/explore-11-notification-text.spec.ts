// Exploratory pass (docs/runbooks/exploratory-pass.md, section 2, "no message text in notifications").
// This one is expected to PASS: it certifies a hard boundary of CLAUDE.md in a real browser, where the pane used
// for the pass could not (its notification permission is denied). A recording stand-in replaces `Notification`
// before the page's scripts run, and the page is made to notify: a mention and a direct message arrive while
// the member looks at the Board. Whatever the page passes to `new Notification(...)` must name the sender and
// the repository and carry none of the message's text. Runs against its own bridge.
import { loadBridgeHelpers, type BridgeEnv } from './harness/bridge';
import { expect, openChat, signIn, test } from './harness/fixtures';
import { UI, ui } from './harness/ui';
import { POLL_MS, type World } from './harness/world';

async function privateBridge(world: World): Promise<BridgeEnv> {
  const { makeEnv } = await loadBridgeHelpers();
  return makeEnv({ staticDir: world.staticDir, pollMs: POLL_MS });
}

const RECORDED = '__notifications';
const SECRET_MENTION = 'hunter2-in-a-mention';
const SECRET_DM = 'hunter2-in-a-direct-message';

test('explore 11: a notification for a mention and for a DM names the sender and carries no message text', async ({ open, world }) => {
  const env = await privateBridge(world);
  try {
    const token = env.addMember('ann', { kind: 'human', display_name: 'Ann' });
    env.addMember('bob', { kind: 'human', display_name: 'Bob' });
    const { page } = await open({ baseURL: env.base });
    await page.addInitScript((key) => {
      const calls: Array<{ title: string; options: unknown }> = [];
      Reflect.set(window, key, calls);
      class Recorder {
        static permission = 'granted';
        static requestPermission(): Promise<string> { return Promise.resolve('granted'); }
        onclick: unknown = null;
        constructor(title: string, options?: unknown) { calls.push({ title, options }); }
        close(): void { /* nothing to close */ }
      }
      Reflect.set(window, 'Notification', Recorder);
    }, RECORDED);

    await signIn(page, token);
    await openChat(page, env.repoInfo.label);
    // Chat is the open view and on screen, which suppresses a notification; the Board does not.
    await ui.viewButton(page, UI.views.board).click();
    await expect(ui.viewHeading(page, UI.views.board)).toBeVisible();

    const bob = { handle: 'bob', cwd: env.repo };
    expect((await env.host.run({ ...bob, args: ['post', `@ann ${SECRET_MENTION}`] })).code).toBe(0);
    expect((await env.post('bob', 'ann', SECRET_DM)).status).toBe(201);

    const calls = () => page.evaluate((key) => JSON.stringify(Reflect.get(window, key)), RECORDED);
    await expect.poll(async () => (JSON.parse(await calls()) as unknown[]).length, 'the page made notifications').toBeGreaterThanOrEqual(2);
    const text = await calls();
    expect(text).toContain('bob');
    expect(text, 'a notification carried message text').not.toContain('hunter2');
  } finally {
    await env.stop();
  }
});
