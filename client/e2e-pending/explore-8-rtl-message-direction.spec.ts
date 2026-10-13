// Exploratory pass (docs/runbooks/exploratory-pass.md, finding 8). Written to FAIL on the current code.
// A message body is one `<p class="message__body">` with no `dir`, so every message is laid out left to
// right, whatever it says. A message written entirely in Hebrew or Arabic sits against the left edge of its
// box and its closing punctuation lands at the wrong end of the line. `dir="auto"` on the body (the browser
// picks the direction from the first strong letter) is the standard remedy; the body stays a plain text node.
// Cyan Society members write in many languages. Runs against its own bridge.
import { loadBridgeHelpers, type BridgeEnv } from '../e2e/harness/bridge';
import { expect, openChat, signIn, test } from '../e2e/harness/fixtures';
import { UI, ui } from '../e2e/harness/ui';
import { POLL_MS, type World } from '../e2e/harness/world';

async function privateBridge(world: World): Promise<BridgeEnv> {
  const { makeEnv } = await loadBridgeHelpers();
  return makeEnv({ staticDir: world.staticDir, pollMs: POLL_MS });
}

const HEBREW = 'שלום עולם! מה שלומך?';
const SLACK_PX = 4;

test('explore 8: a message written entirely in Hebrew is laid out right to left, against the right edge of its box', async ({ open, world }) => {
  const env = await privateBridge(world);
  try {
    const token = env.addMember('ann', { kind: 'human', display_name: 'Ann' });
    env.addMember('bob', { kind: 'human', display_name: 'Bob' });
    expect((await env.post('bob', UI.channel, HEBREW)).status).toBe(201);

    const { page } = await open({ baseURL: env.base });
    await signIn(page, token);
    await openChat(page, env.repoInfo.label);
    const body = ui.feed(page).getByText(HEBREW, { exact: true });
    await expect(body).toBeVisible();

    const edges = await body.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const text = range.getClientRects()[0];
      const box = el.getBoundingClientRect();
      if (!text) throw new Error('the message has no text rectangle');
      return { fromLeft: Math.round(text.left - box.left), fromRight: Math.round(box.right - text.right), direction: getComputedStyle(el).direction };
    });
    expect(edges.fromRight, `distance of the Hebrew text from the right edge of its box (computed direction: ${edges.direction}, from the left edge: ${edges.fromLeft} px)`).toBeLessThan(SLACK_PX);
  } finally {
    await env.stop();
  }
});
