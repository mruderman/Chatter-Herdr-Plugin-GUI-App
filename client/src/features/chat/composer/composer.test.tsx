// The composer against the fake store (ui-contract sections 3, 5, 7 and 8). Elements are found the way
// the E2E specs find them: the message box by its label, never by its role.
import { fireEvent, screen, waitFor, within } from '@testing-library/dom';
import axe from 'axe-core';
import { useEffect, useState } from 'preact/hooks';
import { act } from 'preact/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { recordedError } from '../../../../test/fixtures/recorded';
import { cleanup, render } from '../../../../test/render';
import { createFakeStore, type FakeStoreOptions } from '../../../state/fake';
import { NOTICE_LEAD, queuedText } from '../../../state/send-notice';
import { CHANNEL, type SendDraft, type Store, type StoreSnapshot } from '../../../state/types';
import { SKIP_TARGET } from '../../shell';
import { AXE_OPTIONS, expectNoAxeViolations, setupUser } from '../../shell/test-utils';
import { COMPOSER_TEXT, Composer, MAX_BODY } from './composer';

// The view the composer lives in, reduced to what page-level axe rules need, fed the way the app will
// feed it: the latest snapshot on every publish.
function Harness({ store }: { store: Store }) {
  const [snapshot, setSnapshot] = useState<StoreSnapshot>(() => store.getSnapshot());
  useEffect(() => {
    const stop = store.subscribe(setSnapshot);
    setSnapshot(store.getSnapshot());
    return stop;
  }, [store]);
  return (
    <main>
      <h1>Chat</h1>
      <Composer snapshot={snapshot} store={store} />
    </main>
  );
}

const box = (): HTMLTextAreaElement => screen.getByLabelText(COMPOSER_TEXT.message, { selector: 'textarea' });
const to = (): HTMLSelectElement => screen.getByLabelText(COMPOSER_TEXT.to, { selector: 'select' });
const sendButton = (): HTMLButtonElement => screen.getByRole('button', { name: COMPOSER_TEXT.send });
const suggestions = (): HTMLElement | null => screen.queryByRole('listbox', { name: COMPOSER_TEXT.suggestions });
const options = (): HTMLElement[] => within(screen.getByRole('listbox', { name: COMPOSER_TEXT.suggestions })).getAllByRole('option');
const optionNames = (): string[] => options().map((option) => option.textContent ?? '');
const sendError = (): HTMLElement | null => screen.queryByRole('alert', { name: COMPOSER_TEXT.sendError });
const sendNotice = (): HTMLElement | null => screen.queryByRole('status', { name: COMPOSER_TEXT.sendNotice });
const findSendNotice = (): Promise<HTMLElement> => screen.findByRole('status', { name: COMPOSER_TEXT.sendNotice });
const dismissButton = (): HTMLElement | null => screen.queryByRole('button', { name: COMPOSER_TEXT.dismissNotice });
// Chatter 0.19.0 writes the dash as U+2014 (bridge/src/server.js KNOWN_WARNINGS).
const NO_AGENT = (name: string): string => `mention @${name} matches no agent in this repo — not pushed`;
const findSendError = (): Promise<HTMLElement> => screen.findByRole('alert', { name: COMPOSER_TEXT.sendError });
const describedBy = (): string[] => box().getAttribute('aria-describedby')?.split(' ') ?? [];
const refusal = (name: string): string => `${COMPOSER_TEXT.sendErrorPrefix}${recordedError(name).message}`;

function conversationId(store: Store, label: string): string {
  const found = store.getSnapshot().conversations.find((conversation) => conversation.label === label);
  if (!found) throw new Error(`no conversation "${label}"`);
  return found.id;
}

function select(store: Store, label: string): void {
  act(() => store.selectConversation(conversationId(store, label)));
}

function mount(store: Store) {
  render(<Harness store={store} />);
  return setupUser();
}

function setup(options: FakeStoreOptions = {}) {
  const fake = createFakeStore(options);
  const send = vi.spyOn(fake, 'send');
  return { fake, store: fake as Store, send, user: mount(fake) };
}

/** The fake behind a gate: each send waits until the test lets it through, so "in flight" can be seen. */
function setupGated() {
  const fake = createFakeStore();
  const waiting: Array<() => void> = [];
  const send = vi.fn(
    (draft: SendDraft) =>
      new Promise<boolean>((resolve) => {
        waiting.push(() => void fake.send(draft).then(resolve));
      }),
  );
  const user = mount({ ...fake, send });
  async function release(): Promise<void> {
    await act(async () => {
      waiting.shift()?.();
    });
  }
  return { fake, send, user, release };
}

/** The fake behind a delay: subscribers and getSnapshot() see its changes only when the test flushes. */
function setupLagging() {
  const fake = createFakeStore();
  let shown = fake.getSnapshot();
  const listeners = new Set<(snapshot: StoreSnapshot) => void>();
  const user = mount({
    ...fake,
    getSnapshot: () => shown,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  function flush(): void {
    act(() => {
      shown = fake.getSnapshot();
      for (const listener of listeners) listener(shown);
    });
  }
  return { fake, user, flush };
}

function expectNoStyleAttributes(): void {
  expect(document.querySelectorAll('[style]')).toHaveLength(0);
}

// What appears under Send (the "Send error" alert, the send notice) sits at the bottom of the page: on a window of
// ordinary height it could start below the fold, so the composer scrolls the page to show it, but never so far that
// the focused box leaves the window. jsdom has no layout, so the window's height and the rectangles are stood in for.
const WINDOW_HEIGHT = 700;
/** What the composer shows under Send: both get the same treatment. */
const UNDER_SEND = ['composer__notice', 'composer__alert'] as const;
/** The rectangles of what is under Send and of the message box, as a browser would give them, and a spy on the page's scroll. */
function layout(underSendBottom: number, boxTop: number) {
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: WINDOW_HEIGHT });
  const rect = (top: number, bottom: number): DOMRect => ({ top, bottom, left: 0, right: 0, x: 0, y: top, width: 0, height: bottom - top, toJSON: () => ({}) });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (UNDER_SEND.some((name) => this.classList.contains(name))) return rect(underSendBottom - 100, underSendBottom);
    if (this.tagName === 'TEXTAREA') return rect(boxTop, boxTop + 72);
    return rect(0, 0);
  });
  return vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
}
function restoreLayout(): void {
  vi.restoreAllMocks();
  Reflect.deleteProperty(document.documentElement, 'clientHeight');
}

describe('composer: the form the contract names (ui-contract section 3)', () => {
  it('is a form named "Message composer" with a textarea labelled "Message", a select labelled "To" and a Send button', () => {
    setup();
    const form = screen.getByRole('form', { name: COMPOSER_TEXT.form });
    expect(within(form).getByLabelText(COMPOSER_TEXT.message, { selector: 'textarea' })).toBe(box());
    expect(within(form).getByLabelText(COMPOSER_TEXT.to, { selector: 'select' })).toBe(to());
    expect(within(form).getByRole('button', { name: COMPOSER_TEXT.send })).toBe(sendButton());
  });

  it('gives the message box the id "Skip to message box" jumps to', () => {
    setup();
    expect(box().id).toBe(SKIP_TARGET.composer);
    expect(SKIP_TARGET.composer).toBe('chat-message-box');
  });

  it('is a plain multi-line text field while no suggestions show: no combobox role, no expanded state', () => {
    setup();
    for (const attribute of ['role', 'aria-expanded', 'aria-controls', 'aria-activedescendant']) expect(box().hasAttribute(attribute)).toBe(false);
  });

  it('describes the keys in a hint read with the field', () => {
    setup();
    expect(describedBy()).toEqual([screen.getByText(COMPOSER_TEXT.hint).id]);
  });

  // T21 puts "To", the message box and Send on one row with CSS alone, so the markup keeps the order the contract's
  // tab order and the reading order rely on: "To", the message box with its hint, Send.
  it('keeps the reading order "To", message box, hint, Send, and puts nothing in the tab order but the three controls', () => {
    setup();
    const follows = (a: Element, b: Element): boolean => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    const hint = screen.getByText(COMPOSER_TEXT.hint);
    expect(follows(to(), box())).toBe(true);
    expect(follows(box(), hint)).toBe(true);
    expect(follows(hint, sendButton())).toBe(true);
    expect(screen.getByRole('form', { name: COMPOSER_TEXT.form }).querySelectorAll('[tabindex]')).toHaveLength(0);
  });
});

describe('composer: "To" (ui-contract section 8)', () => {
  it('lists #chat, then every other active member as "{display_name} ({handle})", then every agent as "{name} (agent)"', () => {
    setup();
    expect(Array.from(to().options).map((option) => [option.value, option.text])).toEqual([
      [CHANNEL, '#chat'],
      ['flan', 'flan (flan)'],
      ['mira', 'Mira (mira)'],
      ['ezra', 'Ezra (ezra)'],
      ['kieran', 'Kieran (kieran)'],
      ['grace', 'Grace (grace)'],
      ['temp', 'Temporary (temp)'],
      ['codex', 'codex (agent)'],
    ]);
  });

  it('has no "everyone" option, even for an admin', () => {
    setup({ as: 'flan' });
    expect(Array.from(to().options).filter((option) => /everyone/i.test(`${option.value} ${option.text}`))).toEqual([]);
  });

  it('lists the agents for a member who may not address them: refusing is the bridge\'s job', () => {
    setup({ as: 'kieran' });
    expect(Array.from(to().options).map((option) => option.value)).toContain('codex');
  });

  it('shows the selected conversation\'s recipient as the conversation changes', () => {
    const { store } = setup();
    expect(to().value).toBe(CHANNEL);
    select(store, 'DM with mira');
    expect(to().value).toBe('mira');
    select(store, 'DM with codex');
    expect(to().value).toBe('codex');
    select(store, '#chat');
    expect(to().value).toBe(CHANNEL);
  });

  it('selects the existing conversation when a recipient who has one is chosen', async () => {
    const { store, user } = setup();
    await user.selectOptions(to(), 'mira');
    expect(store.getSnapshot().selectedConversation).toBe(conversationId(store, 'DM with mira'));
    expect(to().value).toBe('mira');
    await user.selectOptions(to(), CHANNEL);
    expect(store.getSnapshot().selectedConversation).toBe(conversationId(store, '#chat'));
    expect(to().value).toBe(CHANNEL);
  });

  it('holds a recipient who has no conversation yet, sends to them, then selects the new DM', async () => {
    const { store, send, user } = setup();
    await user.selectOptions(to(), 'ezra');
    // Nothing to select yet: #chat stays selected and "To" shows the held recipient.
    expect(store.getSnapshot().selectedConversation).toBe(conversationId(store, '#chat'));
    expect(to().value).toBe('ezra');
    await user.type(box(), 'hello ezra{Enter}');
    expect(send).toHaveBeenCalledWith({ to: 'ezra', body: 'hello ezra' });
    await waitFor(() => expect(store.getSnapshot().selectedConversation).toBe(conversationId(store, 'DM with ezra')));
    expect(to().value).toBe('ezra');
    expect(box().value).toBe('');
  });

  it('selects the new DM when the store lists it only in a later snapshot', async () => {
    const { fake, user, flush } = setupLagging();
    await user.selectOptions(to(), 'ezra');
    await user.type(box(), 'first words{Enter}');
    await waitFor(() => expect(fake.sent).toEqual([{ to: 'ezra', body: 'first words' }]));
    expect(fake.getSnapshot().selectedConversation).toBe(CHANNEL);
    flush();
    await waitFor(() => expect(fake.getSnapshot().selectedConversation).toBe(conversationId(fake, 'DM with ezra')));
  });

  it('forgets a held recipient when another conversation is selected', async () => {
    const { store, send, user } = setup();
    await user.selectOptions(to(), 'ezra');
    select(store, 'DM with mira');
    expect(to().value).toBe('mira');
    await user.type(box(), 'for mira{Enter}');
    expect(send).toHaveBeenCalledWith({ to: 'mira', body: 'for mira' });
  });

  it('keeps showing a recipient the directory no longer lists, rather than one a send would not go to', async () => {
    const { fake, store } = setup();
    const directory = fake.getSnapshot().directory;
    if (!directory) throw new Error('the fake starts with a directory');
    fake.setDirectory({ ...directory, members: directory.members.filter((member) => member.handle !== 'mira') });
    await act(async () => {
      await fake.refreshDirectory();
    });
    select(store, 'DM with mira');
    expect(to().value).toBe('mira');
    expect(to().selectedOptions[0]?.text).toBe('mira');
  });
});

describe('composer: sending (ui-contract section 3)', () => {
  it('sends with Enter, clears the box once the store accepted, and keeps focus in the box', async () => {
    const { send, user } = setup();
    await user.type(box(), 'hello all{Enter}');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ to: CHANNEL, body: 'hello all' });
    await waitFor(() => expect(box().value).toBe(''));
    expect(document.activeElement).toBe(box());
  });

  it('inserts a line break with Shift+Enter and does not send', async () => {
    const { send, user } = setup();
    await user.type(box(), 'line one{Shift>}{Enter}{/Shift}line two');
    expect(box().value).toBe('line one\nline two');
    expect(send).not.toHaveBeenCalled();
  });

  it('never sends on an Enter that belongs to an IME composition', async () => {
    const { send, user } = setup();
    await user.type(box(), 'konnichiwa');
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true });
    fireEvent.keyDown(box(), { key: 'Enter', keyCode: 229 });
    expect(send).not.toHaveBeenCalled();
    expect(box().value).toBe('konnichiwa');
    // The same key once the composition is over does send.
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends with the Send button and puts focus back in the box', async () => {
    const { send, user } = setup();
    await user.type(box(), 'by button');
    await user.click(sendButton());
    expect(send).toHaveBeenCalledWith({ to: CHANNEL, body: 'by button' });
    expect(document.activeElement).toBe(box());
    await waitFor(() => expect(box().value).toBe(''));
  });

  it('keeps the draft and shows the bridge\'s refusal as the "Send error" alert', async () => {
    const { send, user } = setup();
    await user.type(box(), '@everyone standup now{Enter}');
    // The composer did not pre-check @everyone: the store was asked, and its refusal is what shows.
    expect(send).toHaveBeenCalledWith({ to: CHANNEL, body: '@everyone standup now' });
    const alert = await findSendError();
    expect(alert.textContent).toBe(refusal('post-everyone-member'));
    expect(box().value).toBe('@everyone standup now');
    expect(describedBy()).toContain(alert.id);
  });

  // V5 finding 3: after the bridge revoked the member the composer stays as it is (everything stays readable)
  // and a send used to go nowhere, with no word. Now it says so, in the words of the Connection status.
  it('tells a member whose access was revoked that nothing was sent, keeps the draft, and does the same on every press', async () => {
    const { fake, user } = setup();
    act(() => fake.setConnection('revoked'));
    await user.type(box(), 'is anybody there?{Enter}');
    const alert = await findSendError();
    expect(alert.textContent).toBe(`${COMPOSER_TEXT.sendErrorPrefix}Access revoked, so nothing was sent.`);
    expect(box().value).toBe('is anybody there?');
    expect(describedBy()).toContain(alert.id);
    expect(fake.sent).toEqual([]);
    // A second press gives a fresh alert, so that it is announced again; the draft is still there.
    const first = alert;
    await user.click(sendButton());
    const again = await findSendError();
    expect(again.textContent).toBe(first.textContent);
    expect(again).not.toBe(first);
    expect(box().value).toBe('is anybody there?');
    expect(fake.sent).toEqual([]);
  });

  it('asks the store about an agent the member may not address, and shows its refusal', async () => {
    const { send, user } = setup({ as: 'kieran' });
    await user.selectOptions(to(), 'codex');
    await user.type(box(), 'run the tests{Enter}');
    expect(send).toHaveBeenCalledWith({ to: 'codex', body: 'run the tests' });
    expect((await findSendError()).textContent).toBe(refusal('post-dm-agent-not-allowed'));
    expect(box().value).toBe('run the tests');
  });

  it('leaves an empty message for the store to refuse too', async () => {
    const { send, user } = setup();
    await user.type(box(), '   {Enter}');
    expect(send).toHaveBeenCalledWith({ to: CHANNEL, body: '   ' });
    expect((await findSendError()).textContent).toBe(refusal('post-empty'));
  });

  it('announces a repeated identical refusal again, with a fresh alert', async () => {
    const { user } = setup();
    await user.type(box(), '@everyone again{Enter}');
    const first = await findSendError();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(first.isConnected).toBe(false));
    const second = await findSendError();
    expect(second).not.toBe(first);
    expect(second.textContent).toBe(first.textContent);
  });

  it('announces it again even when the refusal comes back before the view renders the send', async () => {
    const { user } = setup();
    await user.type(box(), '@everyone twice{Enter}');
    const first = await findSendError();
    // One flush for the whole round trip, so the alert is never unmounted in between: only its key renews it.
    await act(async () => {
      fireEvent.keyDown(box(), { key: 'Enter' });
    });
    expect(first.isConnected).toBe(false);
    expect((await findSendError()).textContent).toBe(first.textContent);
  });

  it('removes the alert when the store clears the error', async () => {
    const { store, user } = setup();
    await user.type(box(), '@everyone hi{Enter}');
    await findSendError();
    select(store, 'DM with mira');
    expect(sendError()).toBeNull();
    expect(describedBy()).toEqual([screen.getByText(COMPOSER_TEXT.hint).id]);
  });

  it('ignores a second send while one is in flight, and marks Send as busy', async () => {
    const { fake, send, user, release } = setupGated();
    await user.type(box(), 'only once{Enter}');
    await user.keyboard('{Enter}');
    await user.click(sendButton());
    expect(send).toHaveBeenCalledTimes(1);
    expect(sendButton().getAttribute('aria-disabled')).toBe('true');
    expect(box().value).toBe('only once');
    await release();
    await waitFor(() => expect(box().value).toBe(''));
    expect(sendButton().hasAttribute('aria-disabled')).toBe(false);
    expect(fake.sent).toEqual([{ to: CHANNEL, body: 'only once' }]);
  });

  it('keeps what the member typed while the send was in flight', async () => {
    const { user, release } = setupGated();
    await user.type(box(), 'first{Enter}');
    await user.type(box(), ' second');
    await release();
    await waitFor(() => expect(box().value).toBe('second'));
  });

  it('hides the old alert while a new send is in flight, so the next refusal is a new one', async () => {
    const { user, release } = setupGated();
    await user.type(box(), '@everyone one{Enter}');
    await release();
    await findSendError();
    await user.keyboard('{Enter}');
    expect(sendError()).toBeNull();
    await release();
    expect(await findSendError()).toBeTruthy();
  });

  // T21: the alert is under Send like the notice, so a window of ordinary height used to leave it below the fold,
  // clipped, with nothing to scroll to it. It gets the notice's treatment (the same function: see the notice's
  // tests, further down, for the rest of what that does).
  it('scrolls the page just far enough to show the end of a new "Send error" alert, at once, once for each failure, and leaves focus in the box', async () => {
    const scroll = layout(WINDOW_HEIGHT + 40, 300);
    try {
      const { user } = setup();
      await user.type(box(), '@everyone one{Enter}');
      const first = await findSendError();
      // An effect: it runs after the alert is in the document, which is when findSendError returns.
      await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
      expect(scroll).toHaveBeenLastCalledWith({ top: 40, behavior: 'instant' });
      expect(document.activeElement).toBe(box());
      // Typing does not scroll it back into view: only a new failure does.
      await user.type(box(), ' more');
      expect(scroll).toHaveBeenCalledTimes(1);
      // The same refusal again is a new alert, announced again, and brought into view again.
      await user.keyboard('{Enter}');
      await waitFor(() => expect(first.isConnected).toBe(false));
      await findSendError();
      await waitFor(() => expect(scroll).toHaveBeenCalledTimes(2));
    } finally {
      restoreLayout();
    }
  });

  it('scrolls the alert no further than keeps the message box in the window, where the composer is taller than the window', async () => {
    const scroll = layout(WINDOW_HEIGHT + 900, 60);
    try {
      const { user } = setup();
      await user.type(box(), '@everyone one{Enter}');
      await findSendError();
      await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
      expect(scroll).toHaveBeenLastCalledWith({ top: 60, behavior: 'instant' });
    } finally {
      restoreLayout();
    }
  });

  it('scrolls nothing when the alert is already in the window', async () => {
    const scroll = layout(WINDOW_HEIGHT - 10, 300);
    try {
      const { user } = setup();
      await user.type(box(), '@everyone one{Enter}');
      await findSendError();
      // Lets the effect that would have scrolled run, so that "not called" is not just "not yet".
      await act(async () => undefined);
      expect(scroll).not.toHaveBeenCalled();
    } finally {
      restoreLayout();
    }
  });

  it('shows the alert after Send in the reading order, and does not announce it any other way than as the alert it was', async () => {
    const { user } = setup();
    await user.type(box(), '@everyone one{Enter}');
    const alert = await findSendError();
    expect(sendButton().compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.getAttribute('aria-label')).toBe(COMPOSER_TEXT.sendError);
    expect(alert.hasAttribute('tabindex')).toBe(false);
  });

  // T18's executor: while the suggestions for text ending in "@codex" were open, a mouse click on Send was lost. The
  // press took focus from the box, the list closed on blur, the log grew into the room the list had taken, Send was
  // no longer under the pointer when the button came up, and the click went to something else.
  it('keeps focus in the message box and the suggestions open while the mouse is pressed on Send, so that the click lands', async () => {
    const { send, user } = setup();
    await user.type(box(), 'are you there @co');
    expect(suggestions()).not.toBeNull();
    // The browser's default action for a mousedown is to focus the button; the composer cancels it.
    expect(fireEvent.mouseDown(sendButton())).toBe(false);
    await user.pointer({ keys: '[MouseLeft>]', target: sendButton() });
    expect(document.activeElement).toBe(box());
    expect(suggestions()).not.toBeNull();
    await user.pointer({ keys: '[/MouseLeft]' });
    expect(send).toHaveBeenCalledWith({ to: CHANNEL, body: 'are you there @co' });
    await waitFor(() => expect(box().value).toBe(''));
    expect(suggestions()).toBeNull();
    expect(document.activeElement).toBe(box());
  });
});

describe('composer: the 8,000-character limit (SPEC section 6)', () => {
  it('takes exactly 8,000 characters without comment, and the store accepts them', async () => {
    const { fake, user } = setup();
    box().focus();
    await user.paste('x'.repeat(MAX_BODY));
    expect(box().value).toHaveLength(MAX_BODY);
    expect(screen.queryByText(/the limit is 8,000/)).toBeNull();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(fake.sent).toHaveLength(1));
  });

  it('says how far over a longer draft is, keeps all of it, and leaves the refusal to the store', async () => {
    const { send, user } = setup();
    box().focus();
    await user.paste('y'.repeat(MAX_BODY + 1));
    expect(box().value).toHaveLength(MAX_BODY + 1);
    const note = screen.getByText('8,001 characters; the limit is 8,000.');
    expect(describedBy()).toContain(note.id);
    await user.keyboard('{Enter}');
    expect(send).toHaveBeenCalledTimes(1);
    expect((await findSendError()).textContent).toBe(refusal('post-too-long'));
    expect(box().value).toHaveLength(MAX_BODY + 1);
  });
});

describe('composer: mention suggestions (ui-contract sections 3 and 8)', () => {
  it('opens a listbox named "Mention suggestions" on "@", with the combobox attributes on the message box', async () => {
    const { user } = setup();
    await user.type(box(), '@');
    const list = suggestions();
    expect(list).not.toBeNull();
    expect(box().getAttribute('role')).toBe('combobox');
    expect(box().getAttribute('aria-expanded')).toBe('true');
    expect(box().getAttribute('aria-controls')).toBe(list?.id);
    const [first] = options();
    expect(box().getAttribute('aria-activedescendant')).toBe(first?.id);
    expect(first?.getAttribute('aria-selected')).toBe('true');
    expect(optionNames()).toEqual([
      'flan (Human)',
      'mira (Human)',
      'ezra (Human)',
      'kieran (Computational)',
      'grace (Computational)',
      'temp (Computational)',
      'codex (Agent)',
    ]);
  });

  it('opens after whitespace but not inside a word', async () => {
    const { user } = setup();
    await user.type(box(), 'mail@');
    expect(suggestions()).toBeNull();
    await user.type(box(), ' @');
    expect(suggestions()).not.toBeNull();
  });

  it('narrows the list by the typed prefix, ignoring case, and closes when nothing matches', async () => {
    const { user } = setup();
    await user.type(box(), '@M');
    expect(optionNames()).toEqual(['mira (Human)']);
    await user.type(box(), 'x');
    expect(suggestions()).toBeNull();
    for (const attribute of ['role', 'aria-expanded', 'aria-controls', 'aria-activedescendant']) expect(box().hasAttribute(attribute)).toBe(false);
  });

  it('moves through the options with ArrowDown and ArrowUp, wrapping at both ends', async () => {
    const { user } = setup();
    await user.type(box(), '@');
    const all = options();
    const active = (): string | null => box().getAttribute('aria-activedescendant');
    expect(active()).toBe(all[0]?.id);
    await user.keyboard('{ArrowDown}');
    expect(active()).toBe(all[1]?.id);
    expect(all[1]?.getAttribute('aria-selected')).toBe('true');
    expect(all[0]?.getAttribute('aria-selected')).toBe('false');
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(active()).toBe(all.at(-1)?.id);
    await user.keyboard('{ArrowDown}');
    expect(active()).toBe(all[0]?.id);
  });

  it('accepts with Enter: inserts the handle, keeps focus in the box, closes the list and sends nothing', async () => {
    const { send, user } = setup();
    await user.type(box(), 'ask @mi');
    await user.keyboard('{Enter}');
    expect(box().value).toBe('ask @mira ');
    expect(box().selectionStart).toBe('ask @mira '.length);
    expect(document.activeElement).toBe(box());
    expect(suggestions()).toBeNull();
    expect(box().hasAttribute('role')).toBe(false);
    expect(send).not.toHaveBeenCalled();
    // With the list closed, the next Enter sends.
    await user.keyboard('please{Enter}');
    expect(send).toHaveBeenCalledWith({ to: CHANNEL, body: 'ask @mira please' });
  });

  it('accepts the active option with Tab and keeps focus in the box', async () => {
    const { user } = setup();
    await user.type(box(), '@k');
    await user.keyboard('{Tab}');
    expect(box().value).toBe('@kieran ');
    expect(document.activeElement).toBe(box());
    expect(suggestions()).toBeNull();
  });

  it('accepts the option the arrows chose', async () => {
    const { user } = setup();
    await user.type(box(), '@');
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(box().value).toBe('@ezra ');
  });

  it('closes with Escape without losing text, stays closed when deleting, and reopens on the next typed character', async () => {
    const { user } = setup();
    await user.type(box(), 'hey @mir');
    await user.keyboard('{Escape}');
    expect(suggestions()).toBeNull();
    expect(box().value).toBe('hey @mir');
    expect(box().hasAttribute('aria-expanded')).toBe(false);
    await user.keyboard('{Backspace}');
    expect(box().value).toBe('hey @mi');
    expect(suggestions()).toBeNull();
    await user.keyboard('r');
    expect(optionNames()).toEqual(['mira (Human)']);
    expect(box().getAttribute('aria-expanded')).toBe('true');
  });

  it('does not reopen on a typed character once the word no longer begins with "@"', async () => {
    const { user } = setup();
    await user.type(box(), '@mi');
    await user.keyboard('{Escape} x');
    expect(box().value).toBe('@mi x');
    expect(suggestions()).toBeNull();
  });

  it('offers "everyone (all members)" to an admin', async () => {
    const { user } = setup({ as: 'flan' });
    await user.type(box(), '@ev');
    expect(optionNames()).toEqual(['everyone (all members)']);
    await user.keyboard('{Enter}');
    expect(box().value).toBe('@everyone ');
  });

  it('does not offer everyone to a member', async () => {
    const { user } = setup();
    await user.type(box(), '@');
    expect(optionNames().filter((name) => name.startsWith('everyone'))).toEqual([]);
    await user.type(box(), 'ev');
    expect(suggestions()).toBeNull();
  });

  it('offers agents only to a member who may address them', async () => {
    const allowed = setup();
    await allowed.user.type(box(), '@co');
    expect(optionNames()).toEqual(['codex (Agent)']);
    cleanup();
    const restricted = setup({ as: 'kieran' });
    await restricted.user.type(box(), '@co');
    expect(suggestions()).toBeNull();
  });

  it('accepts an option that is clicked, keeping focus in the box', async () => {
    const { user } = setup();
    await user.type(box(), '@');
    await user.click(screen.getByRole('option', { name: 'grace (Computational)' }));
    expect(box().value).toBe('@grace ');
    expect(document.activeElement).toBe(box());
    expect(suggestions()).toBeNull();
  });

  it('closes when the caret moves, or focus leaves the box', async () => {
    const { user } = setup();
    await user.type(box(), '@');
    await user.keyboard('{ArrowLeft}');
    expect(suggestions()).toBeNull();
    await user.type(box(), 'g');
    expect(suggestions()).not.toBeNull();
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(document.activeElement).toBe(to());
    expect(suggestions()).toBeNull();
  });

  it('keeps out of an IME composition, and opens when the composition ends', async () => {
    const { user } = setup();
    await user.type(box(), '@');
    const before = box().getAttribute('aria-activedescendant');
    fireEvent.keyDown(box(), { key: 'ArrowDown', isComposing: true });
    fireEvent.keyDown(box(), { key: 'Enter', keyCode: 229 });
    expect(box().getAttribute('aria-activedescendant')).toBe(before);
    expect(box().value).toBe('@');
    fireEvent.input(box(), { target: { value: '@mi' }, isComposing: true, inputType: 'insertCompositionText' });
    expect(suggestions()).toBeNull();
    fireEvent.compositionEnd(box());
    expect(optionNames()).toEqual(['mira (Human)']);
  });
});

describe('composer: read-only and unavailable states (ui-contract section 8)', () => {
  it('is replaced by "Read-only: a conversation between {a} and {b}" while an admin views others\' DM', () => {
    const { store, send } = setup({ as: 'flan' });
    select(store, 'DM codex to thom');
    expect(screen.queryByRole('form', { name: COMPOSER_TEXT.form })).toBeNull();
    expect(screen.queryByLabelText(COMPOSER_TEXT.message)).toBeNull();
    expect(screen.queryByRole('button', { name: COMPOSER_TEXT.send })).toBeNull();
    const notice = screen.getByText('Read-only: a conversation between codex and thom');
    // "Skip to message box" lands on the reason there is no box.
    expect(notice.id).toBe(SKIP_TARGET.composer);
    expect(notice.tabIndex).toBe(-1);
    expect(send).not.toHaveBeenCalled();
  });

  it('comes back with the draft it had when the admin returns to a conversation of their own', async () => {
    const { store, user } = setup({ as: 'flan' });
    await user.type(box(), 'half a thought');
    select(store, 'DM grace to thom');
    expect(screen.getByText('Read-only: a conversation between grace and thom')).toBeTruthy();
    select(store, '#chat');
    expect(box().value).toBe('half a thought');
  });

  it('is disabled when no conversation is selected', () => {
    setup({ session: 'signed-out' });
    expect(box().disabled).toBe(true);
    expect(to().disabled).toBe(true);
    expect(sendButton().disabled).toBe(true);
  });
});

describe('composer: what the bridge said about a send it accepted (the send notice)', () => {
  it('shows nothing after an ordinary send', async () => {
    const { user } = setup();
    await user.type(box(), 'good morning{Enter}');
    await waitFor(() => expect(box().value).toBe(''));
    expect(sendNotice()).toBeNull();
    expect(dismissButton()).toBeNull();
  });

  it('shows the warning of a mention that reaches nobody as a status, in the form, after the box was cleared', async () => {
    const { user } = setup();
    await user.type(box(), 'is anyone there @nobodyhere{Enter}');
    const notice = await findSendNotice();
    expect(notice.textContent).toBe(`${NOTICE_LEAD}${NO_AGENT('nobodyhere')}`);
    expect(screen.getByRole('form', { name: COMPOSER_TEXT.form }).contains(notice)).toBe(true);
    expect(box().value).toBe('');
    // The send went through, so this is not the "Send error" alert, and nothing is an alert at all.
    expect(sendError()).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    // Words say what it is: the colour of the box is not the only cue.
    expect(notice.textContent).toMatch(/sent/i);
  });

  it('says that a DM to an agent was saved but not delivered', async () => {
    const { user } = setup();
    await user.selectOptions(to(), 'codex');
    await user.type(box(), 'run the tests{Enter}');
    expect((await findSendNotice()).textContent).toBe(`${NOTICE_LEAD}${queuedText('codex')}`);
  });

  it('never moves focus: the message box keeps it when the notice appears', async () => {
    const { user } = setup();
    await user.type(box(), '@nobodyhere{Enter}');
    await findSendNotice();
    expect(document.activeElement).toBe(box());
  });

  it('shows a warning as the text it is, never as markup', async () => {
    const hostile = '<img src=x onerror="window.pwned = 1">';
    const fake = createFakeStore();
    const base = fake.getSnapshot();
    mount({ ...fake, getSnapshot: () => ({ ...base, sendNotice: { lead: NOTICE_LEAD, lines: [hostile, '<b>bold</b>'], seq: 1 } }) });
    const notice = await findSendNotice();
    expect(notice.textContent).toBe(`${NOTICE_LEAD}${hostile}<b>bold</b>`);
    expect(notice.querySelector('img, b, script')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });

  it('is removed by its button, which puts focus in the message box and tells the store', async () => {
    const { fake, user } = setup();
    const dismiss = vi.spyOn(fake, 'dismissSendNotice');
    await user.type(box(), '@nobodyhere{Enter}');
    await findSendNotice();
    const button = dismissButton();
    if (!button) throw new Error('no Dismiss notice button');
    await user.click(button);
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(sendNotice()).toBeNull();
    expect(dismissButton()).toBeNull();
    // The button that had focus is gone; leaving focus on the page body would lose the keyboard's place.
    expect(document.activeElement).toBe(box());
  });

  it('is dismissed by keyboard: Tab to the button, Enter', async () => {
    const { user } = setup();
    await user.type(box(), '@nobodyhere{Enter}');
    await findSendNotice();
    sendButton().focus();
    await user.tab();
    expect(document.activeElement).toBe(dismissButton());
    await user.keyboard('{Enter}');
    expect(sendNotice()).toBeNull();
    expect(document.activeElement).toBe(box());
  });

  it('stays while the member types, and is replaced by the next send', async () => {
    const { user } = setup();
    await user.type(box(), '@nobodyhere{Enter}');
    const first = await findSendNotice();
    await user.type(box(), 'a second thought');
    expect(sendNotice()).toBe(first);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(first.isConnected).toBe(false));
    expect(sendNotice()).toBeNull();
  });

  it('is a new element when the same notice comes again, so it is read again', async () => {
    const { user } = setup();
    await user.type(box(), '@nobodyhere{Enter}');
    const first = await findSendNotice();
    await user.type(box(), '@nobodyhere{Enter}');
    await waitFor(() => expect(first.isConnected).toBe(false));
    const second = await findSendNotice();
    expect(second).not.toBe(first);
    expect(second.textContent).toBe(first.textContent);
  });

  it('goes when another conversation is opened', async () => {
    const { store, user } = setup();
    await user.type(box(), '@nobodyhere{Enter}');
    await findSendNotice();
    select(store, 'DM with mira');
    expect(sendNotice()).toBeNull();
  });

  // The notice sits under Send, which is the bottom of the page: on a window of ordinary height it could start
  // below the fold, so the composer scrolls the page to show it, but never so far that the focused box leaves
  // the window (the layout helpers are above, shared with the "Send error" alert, which gets the same treatment).
  it('scrolls the page just far enough to show the end of a new notice, at once, once for each, and leaves focus in the box', async () => {
    const scroll = layout(WINDOW_HEIGHT + 40, 300);
    try {
      const { user } = setup();
      await user.type(box(), '@nobodyhere{Enter}');
      const first = await findSendNotice();
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(scroll).toHaveBeenLastCalledWith({ top: 40, behavior: 'instant' });
      expect(document.activeElement).toBe(box());
      // Typing again does not scroll it back into view: only a new notice does.
      await user.type(box(), 'a second thought');
      expect(scroll).toHaveBeenCalledTimes(1);
      await user.keyboard('{Enter}');
      await waitFor(() => expect(first.isConnected).toBe(false));
      await user.type(box(), '@nobodyhere{Enter}');
      await findSendNotice();
      expect(scroll).toHaveBeenCalledTimes(2);
    } finally {
      restoreLayout();
    }
  });

  it('scrolls no further than keeps the message box in the window, where the composer is taller than the window', async () => {
    const scroll = layout(WINDOW_HEIGHT + 900, 60);
    try {
      const { user } = setup();
      await user.type(box(), '@nobodyhere{Enter}');
      await findSendNotice();
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(scroll).toHaveBeenLastCalledWith({ top: 60, behavior: 'instant' });
    } finally {
      restoreLayout();
    }
  });

  it('scrolls nothing when the notice is already in the window, or when there is none', async () => {
    const scroll = layout(WINDOW_HEIGHT - 10, 300);
    try {
      const { user } = setup();
      await user.type(box(), '@nobodyhere{Enter}');
      await findSendNotice();
      await user.type(box(), 'good morning{Enter}');
      await waitFor(() => expect(sendNotice()).toBeNull());
      expect(scroll).not.toHaveBeenCalled();
    } finally {
      restoreLayout();
    }
  });

  it('is not part of what the message box is described by, and sits after Send in the reading order', async () => {
    const { user } = setup();
    await user.type(box(), '@nobodyhere{Enter}');
    const notice = await findSendNotice();
    expect(describedBy()).toEqual([screen.getByText(COMPOSER_TEXT.hint).id]);
    expect(sendButton().compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('composer: accessibility and markup (ui-contract sections 6 and 7)', () => {
  it('has no axe violations idle, read-only, with a refusal or a send notice showing, or disabled, and no style attributes', async () => {
    const admin = setup({ as: 'flan' });
    expectNoStyleAttributes();
    await expectNoAxeViolations();
    select(admin.store, 'DM grace to thom');
    expectNoStyleAttributes();
    await expectNoAxeViolations();
    cleanup();

    const member = setup();
    await member.user.type(box(), '@everyone no{Enter}');
    await findSendError();
    expectNoStyleAttributes();
    await expectNoAxeViolations();
    cleanup();

    const noticed = setup();
    await noticed.user.type(box(), '@nobodyhere{Enter}');
    await findSendNotice();
    expectNoStyleAttributes();
    await expectNoAxeViolations();
    cleanup();

    setup({ session: 'signed-out' });
    await expectNoAxeViolations();
  });

  it('while suggestions show, has only the violation the contract makes unavoidable: a combobox role on a textarea', async () => {
    const { user } = setup();
    await user.type(box(), '@');
    expectNoStyleAttributes();
    const results = await axe.run(document, AXE_OPTIONS);
    // ui-contract section 3 puts role=combobox on the textarea itself. axe 4.13 allows no role on a
    // textarea and reports it under this best-practice rule (impact minor), which is outside the WCAG
    // tags the E2E gate runs.
    expect(results.violations.map((violation) => ({ id: violation.id, impact: violation.impact, targets: violation.nodes.map((node) => node.target.join(' ')) }))).toEqual([
      { id: 'aria-allowed-role', impact: 'minor', targets: [`#${SKIP_TARGET.composer}`] },
    ]);
    expect(results.violations[0]?.tags.some((tag) => tag.startsWith('wcag'))).toBe(false);
  });
});
