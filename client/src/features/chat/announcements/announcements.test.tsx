import { screen } from '@testing-library/dom';
import { act } from 'preact/test-utils';
import { describe, expect, it } from 'vitest';
import { render } from '../../../../test/render';
import { createFakeStore, type FakeStore } from '../../../state/fake';
import '../../shell/test-utils';
import { Live, clockAfterRecordings } from '../feed/test-harness';
import { Announcements } from './announcements';

// The texts and the 3-second throttle are the store's (fake.ts implements them as ui-contract section 3
// writes them); this region's job is to put each announcement where a screen reader hears it.

function renderAnnouncements(store: FakeStore): HTMLElement {
  render(<Live store={store} view={(snapshot) => <Announcements snapshot={snapshot} store={store} />} />);
  return screen.getByRole('status', { name: 'Announcements' });
}

describe('the Announcements region (ui-contract section 3)', () => {
  it('is a polite status named "Announcements", visually hidden, and empty until the store announces', () => {
    const region = renderAnnouncements(createFakeStore({ as: 'thom' }));
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.classList.contains('visually-hidden')).toBe(true);
    expect(region.textContent).toBe('');
  });

  it('shows the text the store announces', () => {
    const store = createFakeStore({ as: 'thom', clock: clockAfterRecordings() });
    const region = renderAnnouncements(store);
    act(() => {
      store.receive({ from: 'mira', body: 'the deploy is done' });
    });
    expect(region.textContent).toBe('mira: the deploy is done');
  });

  it('announces an identical text again: each new seq puts it in a new element', () => {
    const store = createFakeStore({ as: 'thom', clock: clockAfterRecordings() });
    const region = renderAnnouncements(store);
    act(() => {
      store.receive({ from: 'mira', body: 'ping' });
    });
    const first = region.firstElementChild;
    const firstSeq = store.getSnapshot().announcement?.seq;
    act(() => {
      store.clock.advance(3_000);
      store.receive({ from: 'mira', body: 'ping' });
    });
    expect(store.getSnapshot().announcement?.seq).not.toBe(firstSeq);
    expect(region.textContent).toBe('mira: ping');
    expect(first?.isConnected).toBe(false);
    expect(region.firstElementChild).not.toBe(first);
    expect(region.children).toHaveLength(1);
  });

  it('shows a burst as the one text the store makes of it', () => {
    const store = createFakeStore({ as: 'thom', clock: clockAfterRecordings() });
    const region = renderAnnouncements(store);
    act(() => {
      store.receive({ from: 'mira', body: 'one' });
      store.receive({ from: 'grace', body: 'two' });
      store.receive({ from: 'flan', body: 'three' });
    });
    expect(region.textContent).toBe('mira: one');
    act(() => {
      store.clock.advance(3_000);
    });
    expect(region.textContent).toBe('2 new messages in #chat');
  });
});
