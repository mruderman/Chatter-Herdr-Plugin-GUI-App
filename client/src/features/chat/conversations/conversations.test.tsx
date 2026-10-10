import { screen, within } from '@testing-library/dom';
import { describe, expect, it, vi } from 'vitest';
import { render } from '../../../../test/render';
import { createFakeStore, type FakeStore } from '../../../state/fake';
import { setupUser } from '../../shell/test-utils';
import { Live } from '../feed/test-harness';
import { Conversations } from './conversations';

// Names and labels are written out as docs/ui-contract.md (sections 3 and 8) and the store contract
// spell them, not read from constants, so a changed constant cannot quietly change the contract.

function renderConversations(store: FakeStore): HTMLElement {
  render(<Live store={store} view={(snapshot) => <Conversations snapshot={snapshot} store={store} />} />);
  return screen.getByRole('navigation', { name: 'Conversations' });
}

const labels = (nav: HTMLElement): Array<string | null> => within(nav).getAllByRole('button').map((button) => button.textContent);
const current = (nav: HTMLElement): HTMLElement[] => within(nav).getAllByRole('button').filter((button) => button.hasAttribute('aria-current'));

describe('the Conversations navigation (ui-contract section 3)', () => {
  it('lists "#chat", then the member\'s DMs by peer, each button named exactly by its label', () => {
    const nav = renderConversations(createFakeStore({ as: 'thom' }));
    expect(labels(nav)).toEqual(['#chat', 'DM with codex', 'DM with grace', 'DM with mira']);
    for (const name of ['#chat', 'DM with codex', 'DM with grace', 'DM with mira']) {
      expect(within(nav).getByRole('button', { name })).toBeTruthy();
    }
  });

  it('shows an admin the DMs between two others as "DM {a} to {b}", after the admin\'s own', () => {
    const nav = renderConversations(createFakeStore({ as: 'flan' }));
    expect(labels(nav)).toEqual(['#chat', 'DM with codex', 'DM codex to thom', 'DM grace to thom', 'DM mira to thom']);
  });

  it('holds nothing but the conversation buttons', () => {
    const store = createFakeStore({ as: 'thom' });
    const nav = renderConversations(store);
    expect(within(nav).getAllByRole('button')).toHaveLength(store.getSnapshot().conversations.length);
    expect(within(nav).queryAllByRole('link')).toHaveLength(0);
  });

  it('marks the selected conversation, and only it, with aria-current="true"', () => {
    const nav = renderConversations(createFakeStore({ as: 'thom' }));
    expect(current(nav)).toEqual([within(nav).getByRole('button', { name: '#chat' })]);
    expect(current(nav)[0]?.getAttribute('aria-current')).toBe('true');
  });

  it('selects a conversation through the store when its button is pressed', async () => {
    const user = setupUser();
    const store = createFakeStore({ as: 'thom' });
    const selectConversation = vi.spyOn(store, 'selectConversation');
    const nav = renderConversations(store);
    await user.click(within(nav).getByRole('button', { name: 'DM with mira' }));
    const mira = store.getSnapshot().conversations.find((conversation) => conversation.label === 'DM with mira');
    expect(selectConversation).toHaveBeenCalledWith(mira?.id);
    expect(current(nav)).toEqual([within(nav).getByRole('button', { name: 'DM with mira' })]);
  });

  it('works by keyboard alone: Tab reaches each button in order, Enter and Space select', async () => {
    const user = setupUser();
    const nav = renderConversations(createFakeStore({ as: 'thom' }));
    await user.tab();
    expect(document.activeElement).toBe(within(nav).getByRole('button', { name: '#chat' }));
    await user.tab();
    expect(document.activeElement).toBe(within(nav).getByRole('button', { name: 'DM with codex' }));
    await user.keyboard('{Enter}');
    expect(current(nav)).toEqual([within(nav).getByRole('button', { name: 'DM with codex' })]);
    await user.tab();
    await user.keyboard(' ');
    expect(current(nav)).toEqual([within(nav).getByRole('button', { name: 'DM with grace' })]);
    // Focus stays on the button the member chose.
    expect(document.activeElement).toBe(within(nav).getByRole('button', { name: 'DM with grace' }));
  });

  it('says so in text when there is no conversation to list', () => {
    const store = createFakeStore({ as: 'thom' });
    render(<Conversations snapshot={{ ...store.getSnapshot(), conversations: [], selectedConversation: null }} store={store} />);
    const nav = screen.getByRole('navigation', { name: 'Conversations' });
    expect(within(nav).queryAllByRole('button')).toHaveLength(0);
    expect(nav.textContent).toContain('No conversations yet.');
  });
});
