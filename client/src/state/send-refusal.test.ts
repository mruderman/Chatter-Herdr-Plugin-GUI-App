// @vitest-environment node
// A direct message that the bridge refuses with 409 `ambiguous_recipient` (the handle begins an agent's
// name, or the sender's own handle, so Chatter could deliver it to the wrong one; bridge/src/policy.js)
// has to reach the member the way every refusal does: the real store's send resolves false with the
// bridge's own code and message in `sendError`, which the composer shows as "Not sent: ..." and keeps the
// draft for (composer.test.tsx, "keeps the draft and shows the bridge's refusal"). The scripted bridge
// answers with the 409 itself, as the real one does; store.test.ts is another file's.
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../api/clock';
import { ApiError, ERROR_CODES } from '../api/errors';
import type { StreamTiming } from '../api/stream';
import { BRIDGE_ROUTES, FakeBridge } from './fake-api';
import { createStore } from './store';
import type { Store } from './types';

const QUIET: Partial<StreamTiming> = { deadAfterMs: 24 * 60 * 60_000 };
const FIVE_MINUTES = 5 * 60_000;
const MIRA = 'mira';

// The two refusals of bridge/src/policy.js, worded as it words them for this handle.
const BEGINS_AN_AGENT = '"mira" begins the name of the Herdr agent mira-worker, so Chatter could deliver this message to the agent instead; nothing was sent. An admin can rename the member or the agent.';
const BEGINS_OWN_HANDLE = '"mira" begins your own handle, so Chatter would take it for you; nothing was sent. mira can still message you, or an admin can rename one of you.';

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
  const errors: unknown[] = [];
  const store = createStore({ api: bridge.api, clock, random: () => 0.5, streamTiming: QUIET, reportError: (error) => errors.push(error) });
  stores.push(store);
  await settle();
  const conversation = store.getSnapshot().conversations.find((candidate) => candidate.label === `DM with ${MIRA}`);
  if (!conversation) throw new Error('the scripted member has no DM with mira');
  store.selectConversation(conversation.id);
  await settle();
  return {
    bridge,
    clock,
    store,
    errors,
    now: () => store.getSnapshot(),
    sends: (): number => bridge.count(BRIDGE_ROUTES.send),
  };
}

// The code is built from the client's own list and compared with the literal the bridge sends, so that a
// list without it fails here, where the refusal would otherwise carry an undefined code through unseen.
const refusedAs = (message: string): ApiError => new ApiError(409, ERROR_CODES.ambiguousRecipient, message);

describe('a direct message refused as ambiguous_recipient', () => {
  it.each([
    ['begins the name of an agent', BEGINS_AN_AGENT],
    ['begins the sender\'s own handle', BEGINS_OWN_HANDLE],
  ])('when the handle %s, comes back as the Send error in the bridge\'s own words, and nothing else changes', async (_why, message) => {
    const h = await harness();
    const before = h.now();
    h.bridge.failNext(BRIDGE_ROUTES.send, refusedAs(message));

    expect(await h.store.send({ to: MIRA, body: 'see you at five' })).toBe(false);

    expect(h.now().sendError).toEqual({ code: 'ambiguous_recipient', message });
    // The refusal is the bridge's word on this one message, not a fault: the session, the connection,
    // the conversation and the messages stay as they were, and nothing is reported as a bug.
    expect(h.now().session).toEqual(before.session);
    expect(h.now().connection).toBe(before.connection);
    expect(h.now().selectedConversation).toBe(before.selectedConversation);
    expect(h.now().messages).toEqual(before.messages);
    expect(h.errors).toEqual([]);
  });

  it('is asked once and not retried by the store, however long it waits', async () => {
    const h = await harness();
    h.bridge.failNext(BRIDGE_ROUTES.send, refusedAs(BEGINS_AN_AGENT));
    expect(await h.store.send({ to: MIRA, body: 'once' })).toBe(false);
    expect(h.sends()).toBe(1);
    h.clock.advance(FIVE_MINUTES);
    await settle();
    expect(h.sends()).toBe(1);
    expect(h.now().sendError).toEqual({ code: 'ambiguous_recipient', message: BEGINS_AN_AGENT });
  });

  it('is cleared by the next send, which goes through', async () => {
    const h = await harness();
    h.bridge.failNext(BRIDGE_ROUTES.send, refusedAs(BEGINS_AN_AGENT));
    expect(await h.store.send({ to: MIRA, body: 'first try' })).toBe(false);
    expect(h.now().sendError).not.toBeNull();

    expect(await h.store.send({ to: MIRA, body: 'second try' })).toBe(true);
    expect(h.now().sendError).toBeNull();
    expect(h.now().messages.map((message) => message.body)).toContain('second try');
    expect(h.now().messages.map((message) => message.body)).not.toContain('first try');
  });
});
