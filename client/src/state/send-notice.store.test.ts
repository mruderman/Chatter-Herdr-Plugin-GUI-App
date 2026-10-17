// @vitest-environment node
// The timing of the real store's send notice, which the conformance suite (the same for the fake store)
// cannot see: when the answer comes, relative to the stream and to the member moving on. The scripted
// bridge (fake-api.ts) holds and releases the send route.
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../api/clock';
import { CHANNEL } from '../api/types';
import type { StreamTiming } from '../api/stream';
import { BRIDGE_ROUTES, FakeBridge } from './fake-api';
import { NOTICE_LEAD } from './send-notice';
import { createStore } from './store';
import type { Store } from './types';

const QUIET: Partial<StreamTiming> = { deadAfterMs: 24 * 60 * 60_000 };
// One second: how long the store waits for a sent message to come back through the stream (store.ts SEND_WAIT_MS).
const SEND_WAIT_MS = 1_000;
const NO_AGENT = 'mention @nobodyhere matches no agent in this repo — not pushed';

const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function harness() {
  const clock = new ManualClock();
  const bridge = new FakeBridge({ clock, identity: 'thom' });
  const store = createStore({ api: bridge.api, clock, random: () => 0.5, streamTiming: QUIET });
  stores.push(store);
  await settle();
  return {
    bridge,
    clock,
    store,
    now: () => store.getSnapshot(),
    open(label: string): void {
      const conversation = store.getSnapshot().conversations.find((candidate) => candidate.label === label);
      if (!conversation) throw new Error(`no conversation "${label}"`);
      store.selectConversation(conversation.id);
    },
  };
}

describe('the real store\'s send notice', () => {
  it('is set when the bridge answers, before the message has come back through the stream', async () => {
    const h = await harness();
    h.bridge.holdDelivery();
    const sending = h.store.send({ to: CHANNEL, body: '@nobodyhere' });
    await settle();
    expect(h.now().sendNotice?.lines).toEqual([NO_AGENT]);
    expect(h.now().announcement?.text).toBe(`${NOTICE_LEAD} ${NO_AGENT}`);
    // The send itself is still waiting for the stream, up to its second.
    h.clock.advance(SEND_WAIT_MS);
    await settle();
    expect(await sending).toBe(true);
    expect(h.now().sendNotice?.lines).toEqual([NO_AGENT]);
  });

  it('is not shown in another conversation when the answer comes after the member moved on', async () => {
    const h = await harness();
    h.bridge.hold(BRIDGE_ROUTES.send);
    const sending = h.store.send({ to: CHANNEL, body: '@nobodyhere' });
    await settle();
    h.open('DM with mira');
    h.bridge.release(BRIDGE_ROUTES.send);
    await settle();
    expect(await sending).toBe(true);
    expect(h.now().sendNotice).toBeNull();
    expect(h.now().announcement).toBeNull();
  });

  it('is gone as soon as the next send starts, before that send is answered', async () => {
    const h = await harness();
    await h.store.send({ to: CHANNEL, body: '@nobodyhere' });
    expect(h.now().sendNotice).not.toBeNull();
    h.bridge.hold(BRIDGE_ROUTES.send);
    const sending = h.store.send({ to: CHANNEL, body: 'second' });
    await settle();
    expect(h.now().sendNotice).toBeNull();
    h.bridge.release(BRIDGE_ROUTES.send);
    await settle();
    await sending;
    expect(h.now().sendNotice).toBeNull();
  });
});
