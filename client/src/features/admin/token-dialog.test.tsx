// The token dialog is the one place a member's token is on screen, so these tests hold it to the rules
// of ui-contract sections 4 and 7: shown once, in one field, and afterwards in no place at all, whichever
// way the dialog was closed. Every check on the token is a count or a yes/no: a failing test must never
// print the value it is guarding, so there is no toContain, no toBe(token) and no snapshot of the page.
import { screen, within } from '@testing-library/dom';
import { useState } from 'preact/hooks';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '../../../test/render';
import { ApiError, ERROR_CODES, NetworkError, ProtocolError } from '../../api/errors';
import { describeChangeFailure, describeFailure } from './failure';
import { expectNoAxeViolations, setupUser } from '../shell/test-utils';
import { TokenDialog } from './token-dialog';
import { cells, loaded, memberRow, placesHolding, renderAdmin, settle, status, treeHolds, treeSize, watchConsole, type Rendered } from './test-support';

const TOKEN = `cb_throwaway_${'0123456789'.repeat(4)}`;

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

// ------------------------------------------------------------------------------------ the dialog alone

function Harness({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <main id="main-content" tabIndex={-1}>
      <button type="button" onClick={() => setOpen(true)}>
        Show token
      </button>
      {open && (
        <TokenDialog
          handle="kestrel"
          token={TOKEN}
          onClose={() => {
            onClose?.();
            setOpen(false);
          }}
        />
      )}
    </main>
  );
}

async function showToken(onClose?: () => void) {
  const user = setupUser();
  const container = render(<Harness onClose={onClose} />);
  const opener = screen.getByRole('button', { name: 'Show token' });
  await user.click(opener);
  return { user, container, opener, dialog: screen.getByRole('dialog', { name: 'New token for kestrel' }) };
}

const field = (): HTMLTextAreaElement => screen.getByLabelText('Token');
const COPY_FAILED = 'Could not copy the token. Select the field and copy it by hand.';

describe('the token dialog: what it shows', () => {
  it('is a named modal dialog that says the token is shown once, and is described by that sentence', async () => {
    const { dialog } = await showToken();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const notice = screen.getByText('This token is shown once');
    expect(dialog.getAttribute('aria-describedby')).toBe(notice.id);
  });

  it('holds the token in one read-only field labelled Token, with the buttons Copy token and Done', async () => {
    const { dialog } = await showToken();
    const token = within(dialog).getByLabelText('Token') as HTMLTextAreaElement;
    expect(token.readOnly).toBe(true);
    expect(token.value === TOKEN).toBe(true);
    // Not a field a browser should complete or remember. (jsdom has no `spellcheck` property, so that
    // attribute is checked in a real browser instead.)
    expect(token.getAttribute('autocomplete')).toBe('off');
    expect(within(dialog).getByRole('button', { name: 'Copy token' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Done' })).toBeTruthy();
  });

  it('has the token in that field and nowhere else: not in the text, an attribute, a store, the address or the title', async () => {
    await showToken();
    expect(field().value === TOKEN).toBe(true);
    expect(placesHolding(TOKEN)).toBe(1);
  });

  it('puts focus on the field with its text selected, so that copying by hand is one key away', async () => {
    await showToken();
    expect(document.activeElement).toBe(field());
    expect(field().selectionStart).toBe(0);
    expect(field().selectionEnd).toBe(TOKEN.length);
  });

  it('selects the whole token whenever the field is focused again', async () => {
    const { user } = await showToken();
    await user.click(screen.getByRole('button', { name: 'Copy token' }));
    await user.click(field());
    expect(field().selectionStart).toBe(0);
    expect(field().selectionEnd).toBe(TOKEN.length);
  });

  it('does not take the token from the field when typing is attempted, because the field is read only', async () => {
    const { user } = await showToken();
    await user.type(field(), 'x');
    expect(field().value === TOKEN).toBe(true);
  });

  it('has nothing for axe to report', async () => {
    await showToken();
    await expectNoAxeViolations();
  });
});

describe('the token dialog: Copy token', () => {
  it('puts exactly the token on the clipboard, says so, and writes nothing to the console', async () => {
    const watch = watchConsole();
    const { user } = await showToken();
    await user.click(screen.getByRole('button', { name: 'Copy token' }));
    await settle();
    expect((await navigator.clipboard.readText()) === TOKEN).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('Token copied.');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(watch.total()).toBe(0);
  });

  it('says it again each time it is pressed, by putting the words in a new node', async () => {
    const { user } = await showToken();
    const live = screen.getByRole('status');
    await user.click(screen.getByRole('button', { name: 'Copy token' }));
    await settle();
    const first = live.firstElementChild;
    expect(first?.textContent).toBe('Token copied.');
    await user.click(screen.getByRole('button', { name: 'Copy token' }));
    await settle();
    const second = live.firstElementChild;
    expect(second?.textContent).toBe('Token copied.');
    expect(second).not.toBe(first);
    expect(first?.isConnected).toBe(false);
  });

  it('says plainly that it failed, and selects the field, when the browser refuses', async () => {
    const { user } = await showToken();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new DOMException('not allowed', 'NotAllowedError'));
    // Something else is selected in the field when the button is pressed, so that "selected" means it was done.
    field().setSelectionRange(3, 3);
    await user.click(screen.getByRole('button', { name: 'Copy token' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(COPY_FAILED);
    expect(screen.getByRole('status').textContent).toBe('');
    expect(field().selectionStart).toBe(0);
    expect(field().selectionEnd).toBe(TOKEN.length);
    expect(placesHolding(TOKEN)).toBe(1);
  });

  it('says the same when the browser has no clipboard at all', async () => {
    const { user } = await showToken();
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue(undefined as unknown as Clipboard);
    await user.click(screen.getByRole('button', { name: 'Copy token' }));
    expect((await screen.findByRole('alert')).textContent).toBe(COPY_FAILED);
  });

  it('says it failed again each time, and a success after a failure clears the failure', async () => {
    const { user } = await showToken();
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('no'));
    await user.click(screen.getByRole('button', { name: 'Copy token' }));
    const first = await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'Copy token' }));
    await settle();
    const second = await screen.findByRole('alert');
    expect(second).not.toBe(first);
    write.mockResolvedValue(undefined);
    await user.click(screen.getByRole('button', { name: 'Copy token' }));
    await settle();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Token copied.');
  });

  it('writes nothing to the console when copying fails, even if the browser puts the token in its error', async () => {
    const watch = watchConsole();
    const { user } = await showToken();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error(`refused for ${TOKEN}`));
    await user.click(screen.getByRole('button', { name: 'Copy token' }));
    await screen.findByRole('alert');
    expect(watch.total()).toBe(0);
    // The error is not shown either: the alert says its own words, and the token is still only in the field.
    expect(placesHolding(TOKEN)).toBe(1);
  });
});

describe('the token dialog: closing it on its own', () => {
  it('Done closes it once, and the token is gone', async () => {
    const onClose = vi.fn();
    const { user } = await showToken(onClose);
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(placesHolding(TOKEN)).toBe(0);
  });

  it('Escape closes it once, and focus returns to the button that opened it', async () => {
    const onClose = vi.fn();
    const { user, opener } = await showToken(onClose);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(placesHolding(TOKEN)).toBe(0);
    expect(document.activeElement).toBe(opener);
  });

  it('keeps Tab and Shift+Tab inside, over the field and both buttons', async () => {
    const { user, dialog } = await showToken();
    for (let press = 0; press < 6; press += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    for (let press = 0; press < 6; press += 1) {
      await user.tab({ shift: true });
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });
});

// ---------------------------------------------------------- the token after each way the dialog goes

type Way = 'add' | 'rotate';

interface Shown extends Rendered {
  readonly token: string;
  readonly opener: HTMLElement;
  readonly dialog: HTMLElement;
}

/** Gets a real token dialog onto the page the way an admin would: adding a computational member, or rotating a token. */
async function openThroughTheView(way: Way): Promise<Shown> {
  const rendered = renderAdmin();
  const { user, bridge } = rendered;
  await loaded();
  let opener: HTMLElement;
  if (way === 'add') {
    opener = screen.getByRole('button', { name: 'Add member' });
    await user.click(opener);
    await user.type(screen.getByLabelText('Handle'), 'kestrel');
    await user.type(screen.getByLabelText('Display name'), 'Kestrel');
    await user.selectOptions(screen.getByLabelText('Kind'), 'Computational');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await screen.findByRole('dialog', { name: 'New token for kestrel' });
  } else {
    opener = within(memberRow('mira')).getByRole('button', { name: 'Rotate token for mira' });
    await user.click(opener);
    await user.click(screen.getByRole('button', { name: 'Rotate' }));
    await screen.findByRole('dialog', { name: 'New token for mira' });
  }
  const token = bridge.issued[0] ?? '';
  expect(token).not.toBe('');
  return { ...rendered, token, opener, dialog: screen.getByRole('dialog', { name: /^New token for / }) };
}

interface Route {
  readonly name: string;
  /** Whether the dialog is expected to be replaced by nothing, and focus to go back to the opener. */
  readonly closes: boolean;
  readonly close: (shown: Shown) => Promise<void>;
}

const ROUTES: readonly Route[] = [
  {
    name: 'Done',
    closes: true,
    close: async ({ user }) => user.click(screen.getByRole('button', { name: 'Done' })),
  },
  {
    name: 'Escape',
    closes: true,
    close: async ({ user }) => user.keyboard('{Escape}'),
  },
  {
    name: 'the browser asking to cancel the dialog',
    closes: true,
    close: async ({ dialog }) => {
      act(() => {
        dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
      });
    },
  },
  {
    name: 'the browser closing the dialog itself',
    closes: true,
    close: async ({ dialog }) => {
      act(() => {
        dialog.dispatchEvent(new Event('close'));
      });
    },
  },
  {
    name: 'another dialog taking its place',
    closes: false,
    // jsdom does not make the page behind a modal inert, so this stands for anything that opens another dialog.
    close: async ({ user }) => user.click(within(memberRow('thom')).getByRole('button', { name: 'Edit thom' })),
  },
  {
    name: 'the view being removed from the page',
    closes: false,
    close: async () => {
      cleanup();
    },
  },
];

describe.each<Way>(['add', 'rotate'])('the token after %s', (way) => {
  it('is in the one field while the dialog is open, and the checks below can see it there', async () => {
    const watch = watchConsole();
    const shown = await openThroughTheView(way);
    expect((within(shown.dialog).getByLabelText('Token') as HTMLTextAreaElement).value === shown.token).toBe(true);
    expect(placesHolding(shown.token)).toBe(1);
    // The component tree does hold it (as a prop), so a search that finds nothing later means something.
    expect(treeSize(shown.container)).toBeGreaterThan(20);
    expect(treeHolds(shown.container, shown.token)).toBeGreaterThan(0);
    expect(watch.holding(shown.token)).toBe(0);
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it.each(ROUTES)('is nowhere afterwards when it closes by $name', async (route) => {
    const watch = watchConsole();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const shown = await openThroughTheView(way);
    await route.close(shown);
    await settle();

    // The page's markup, the form fields, both stores, the address, the history entry and the title.
    expect(placesHolding(shown.token)).toBe(0);
    // The props and the hook state (state, refs, the submit and list hooks) of every component still mounted.
    expect(treeHolds(shown.container, shown.token)).toBe(0);
    expect(watch.holding(shown.token)).toBe(0);
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length + sessionStorage.length).toBe(0);
    expect(screen.queryByRole('dialog', { name: /^New token for / })).toBeNull();
    if (route.closes) {
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(shown.opener);
    }
  });

  it('is nowhere after the dialog is replaced by another token dialog', async () => {
    const shown = await openThroughTheView(way);
    const first = shown.token;
    // A second rotation while the first token is showing (possible in jsdom, where nothing is inert).
    await shown.user.click(within(memberRow('ezra')).getByRole('button', { name: 'Rotate token for ezra' }));
    await shown.user.click(screen.getByRole('button', { name: 'Rotate' }));
    await screen.findByRole('dialog', { name: 'New token for ezra' });
    const second = shown.bridge.issued[1] ?? '';
    expect(second).not.toBe('');
    expect(placesHolding(first)).toBe(0);
    expect(treeHolds(shown.container, first)).toBe(0);
    expect(placesHolding(second)).toBe(1);
    await shown.user.click(screen.getByRole('button', { name: 'Done' }));
    expect(placesHolding(first) + placesHolding(second)).toBe(0);
    expect(treeHolds(shown.container, first) + treeHolds(shown.container, second)).toBe(0);
  });

  it('is nowhere in the members table, the audit log or the announcement, which only say that something happened', async () => {
    const shown = await openThroughTheView(way);
    await shown.user.click(screen.getByRole('button', { name: 'Done' }));
    await settle();
    expect(cells(memberRow(way === 'add' ? 'kestrel' : 'mira')).some((text) => text.includes(shown.token))).toBe(false);
    expect(placesHolding(shown.token)).toBe(0);
    expect(status().textContent).toBe(way === 'add' ? 'Member added' : 'Token rotated');
  });

});

describe('the token and the requests and messages', () => {
  it('is never sent: the calls that make a token carry only the handle and the typed fields', async () => {
    const shown = await openThroughTheView('add');
    await shown.user.click(screen.getByRole('button', { name: 'Done' }));
    await shown.user.click(within(memberRow('mira')).getByRole('button', { name: 'Rotate token for mira' }));
    await shown.user.click(screen.getByRole('button', { name: 'Rotate' }));
    await screen.findByRole('dialog', { name: 'New token for mira' });
    const sent = JSON.stringify(shown.bridge.calls.map((call) => call.args));
    for (const issued of shown.bridge.issued) expect(sent.includes(issued)).toBe(false);
  });

  it('cannot reach a message: only the three error classes are read, and an unknown error is not echoed at all', () => {
    const unknown = new Error(`boom ${TOKEN}`);
    for (const describe of [describeFailure, describeChangeFailure]) {
      expect(describe(unknown).includes(TOKEN)).toBe(false);
      expect(describe(`${TOKEN}`).includes(TOKEN)).toBe(false);
      expect(describe({ message: TOKEN }).includes(TOKEN)).toBe(false);
    }
    // The messages of the three classes are the bridge's own words or this client's fixed ones, never a request or a body.
    expect(describeFailure(new ApiError(409, ERROR_CODES.handleTaken, 'member "x" already exists'))).toBe('member "x" already exists');
    expect(describeFailure(new NetworkError('could not reach the bridge'))).toBe('could not reach the bridge');
    expect(describeFailure(new ProtocolError('token', 'is not a string'))).toBe('The bridge answered in a way this page does not understand (token is not a string).');
  });

  it('is not in the words said after a success, which are fixed texts', async () => {
    const shown = await openThroughTheView('add');
    await shown.user.click(screen.getByRole('button', { name: 'Done' }));
    expect(status().textContent).toBe('Member added');
    expect((status().textContent ?? '').includes(shown.token)).toBe(false);
  });
});
