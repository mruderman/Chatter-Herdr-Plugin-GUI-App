import { screen, waitFor } from '@testing-library/dom';
import { useState } from 'preact/hooks';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '../../../test/render';
import { SignInView } from './sign-in';
import { setupUser } from './test-utils';

// Not a real token: the tests must never hold one.
const THROWAWAY = 'throwaway-sign-in-value';
const NOT_REGISTERED = 'your Tailscale login is not registered as a member';
const INVALID = 'Invalid or revoked token';

function fields() {
  return {
    field: screen.getByLabelText('Access token') as HTMLInputElement,
    button: screen.getByRole('button', { name: 'Sign in' }),
  };
}

function renderSignIn(props: Partial<Parameters<typeof SignInView>[0]> = {}) {
  render(<SignInView onSubmit={() => undefined} {...props} />);
  return fields();
}

// A parent the way the app wires it: it clears the error when an attempt starts, then either sets a
// new one or turns the session signed-in, which removes the view.
function Parent({ responses, seen, initialError }: { responses: Array<string | 'ok'>; seen?: string[]; initialError?: string }) {
  const [error, setError] = useState<string | undefined>(initialError);
  const [signedIn, setSignedIn] = useState(false);
  if (signedIn) return <p>Signed in</p>;
  return (
    <SignInView
      error={error}
      onSubmit={async (token) => {
        seen?.push(token);
        setError(undefined);
        await Promise.resolve();
        const next = responses.shift() ?? 'ok';
        if (next === 'ok') setSignedIn(true);
        else setError(next);
      }}
    />
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe('sign-in view: what the contract lists (ui-contract section 1)', () => {
  it('has the heading, a password field labelled Access token, and a Sign in button', () => {
    const { field, button } = renderSignIn();
    expect(screen.getByRole('heading', { name: 'Sign in', level: 1 })).toBeTruthy();
    expect(field.tagName).toBe('INPUT');
    expect(field.type).toBe('password');
    expect(field.getAttribute('autocomplete')).toBe('off');
    expect(button.tagName).toBe('BUTTON');
  });

  it('has the field ready for typing', () => {
    const { field } = renderSignIn();
    expect(document.activeElement).toBe(field);
  });
});

describe('sign-in view: the alert depends on the error it is given', () => {
  it('shows no alert when there is no error, as on first load after a plain 401', () => {
    renderSignIn();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(fields().field.hasAttribute('aria-invalid')).toBe(false);
  });

  it('shows the message at once, with the token form still there, for a first-load 403', () => {
    const { field, button } = renderSignIn({ error: NOT_REGISTERED });
    expect(screen.getByRole('alert').textContent).toBe(`Sign-in failed: ${NOT_REGISTERED}`);
    expect(field).toBeTruthy();
    expect(button).toBeTruthy();
    // Nothing has been typed or tried, so the field is not "invalid".
    expect(field.hasAttribute('aria-invalid')).toBe(false);
    expect(document.activeElement).toBe(field);
  });

  it('shows whatever message it is given, prefixed, and drops the alert when the error goes', async () => {
    function Changing() {
      const [error, setError] = useState<string | undefined>('first message');
      return (
        <>
          <button type="button" onClick={() => setError('a different message')}>
            Change
          </button>
          <button type="button" onClick={() => setError(undefined)}>
            Clear
          </button>
          <SignInView error={error} onSubmit={() => undefined} />
        </>
      );
    }
    const user = setupUser();
    render(<Changing />);
    expect(screen.getByRole('alert').textContent).toBe('Sign-in failed: first message');
    await user.click(screen.getByRole('button', { name: 'Change' }));
    expect(screen.getByRole('alert').textContent).toBe('Sign-in failed: a different message');
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('points the field at the alert so it is read with the field', () => {
    const { field } = renderSignIn({ error: NOT_REGISTERED });
    const alert = screen.getByRole('alert');
    expect(field.getAttribute('aria-describedby')?.split(' ')).toContain(alert.id);
  });
});

describe('sign-in view: submitting', () => {
  it('submits the typed value when Enter is pressed in the field', async () => {
    const onSubmit = vi.fn();
    const user = setupUser();
    const { field } = renderSignIn({ onSubmit });
    await user.type(field, `${THROWAWAY}{Enter}`);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(THROWAWAY);
  });

  it('submits when the button is clicked', async () => {
    const onSubmit = vi.fn();
    const user = setupUser();
    const { field, button } = renderSignIn({ onSubmit });
    await user.type(field, THROWAWAY);
    await user.click(button);
    expect(onSubmit).toHaveBeenCalledWith(THROWAWAY);
  });

  it('leaves out whitespace around a pasted token', async () => {
    const onSubmit = vi.fn();
    const user = setupUser();
    const { field } = renderSignIn({ onSubmit });
    await user.type(field, `   ${THROWAWAY}  {Enter}`);
    expect(onSubmit).toHaveBeenCalledWith(THROWAWAY);
  });

  it('does not submit an empty field, or one holding only spaces', async () => {
    const onSubmit = vi.fn();
    const user = setupUser();
    const { field, button } = renderSignIn({ onSubmit });
    await user.click(button);
    await user.type(field, '{Enter}');
    await user.type(field, '   {Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('ignores a second submit while the first is still waiting for the bridge', async () => {
    let finish: () => void = () => undefined;
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const user = setupUser();
    const { field, button } = renderSignIn({ onSubmit });
    await user.type(field, `${THROWAWAY}{Enter}`);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await user.type(field, '{Enter}');
    await user.click(button);
    expect(onSubmit).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish();
    });
    expect(button.hasAttribute('aria-disabled')).toBe(false);
  });
});

describe('sign-in view: failure, with a parent that reports the error', () => {
  it('shows the message the parent gives, keeps what was typed, returns focus to the field and marks it invalid', async () => {
    const user = setupUser();
    render(<Parent responses={[INVALID]} />);
    const { field, button } = fields();
    await user.type(field, THROWAWAY);
    await user.click(button);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(`Sign-in failed: ${INVALID}`);
    expect(field.value).toBe(THROWAWAY);
    expect(document.activeElement).toBe(field);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby')?.split(' ')).toContain(alert.id);
  });

  it('returns focus to the field after every failed attempt, even when the message is the same', async () => {
    const user = setupUser();
    render(<Parent responses={[INVALID, INVALID]} />);
    const { field, button } = fields();
    await user.type(field, THROWAWAY);
    await user.click(button);
    await screen.findByRole('alert');
    await waitFor(() => expect(document.activeElement).toBe(field));
    // Focus moves to the button for the second attempt, and must come back again.
    await user.click(button);
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(field));
  });

  it('removes the old alert while another attempt is under way, and can succeed afterwards', async () => {
    const seen: string[] = [];
    const user = setupUser();
    render(<Parent responses={[INVALID, 'ok']} seen={seen} />);
    const { field, button } = fields();
    await user.type(field, THROWAWAY);
    await user.click(button);
    await screen.findByRole('alert');
    await user.click(button);
    await waitFor(() => expect(screen.queryByLabelText('Access token')).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(seen).toEqual([THROWAWAY, THROWAWAY]);
  });

  it('shows a rejection as the failure when the parent gave no message, and forgets it on the next attempt', async () => {
    const attempts: Array<() => Promise<void>> = [
      async () => {
        throw new Error('Network unreachable');
      },
      async () => undefined,
    ];
    const onSubmit = vi.fn(async () => {
      await attempts.shift()?.();
    });
    const user = setupUser();
    const { field, button } = renderSignIn({ onSubmit });
    await user.type(field, THROWAWAY);
    await user.click(button);
    expect((await screen.findByRole('alert')).textContent).toBe('Sign-in failed: Network unreachable');
    expect(document.activeElement).toBe(field);
    await user.click(button);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});

describe('sign-in view: the token is not kept', () => {
  it('is blanked in the field when the view is removed after a successful sign-in', async () => {
    const user = setupUser();
    render(<Parent responses={['ok']} />);
    const { field } = fields();
    await user.type(field, `${THROWAWAY}{Enter}`);
    await waitFor(() => expect(screen.queryByLabelText('Access token')).toBeNull());
    expect(screen.getByText('Signed in')).toBeTruthy();
    expect(field.isConnected).toBe(false);
    expect(field.value).toBe('');
  });

  it('is nowhere in the markup while it is being typed, nor after a failure', async () => {
    const user = setupUser();
    render(<Parent responses={[INVALID]} />);
    const { field } = fields();
    await user.type(field, THROWAWAY);
    expect(document.body.innerHTML).not.toContain(THROWAWAY);
    expect(field.hasAttribute('value')).toBe(false);
    await user.type(field, '{Enter}');
    await screen.findByRole('alert');
    expect(document.body.innerHTML).not.toContain(THROWAWAY);
  });

  it('is never written to localStorage, sessionStorage or the console', async () => {
    const consoleCalls: unknown[][] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void consoleCalls.push(args));
    }
    const user = setupUser();
    render(<Parent responses={[INVALID, 'ok']} />);
    const { field } = fields();
    await user.type(field, `${THROWAWAY}{Enter}`);
    await screen.findByRole('alert');
    await user.type(field, '{Enter}');
    await waitFor(() => expect(screen.queryByLabelText('Access token')).toBeNull());

    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(JSON.stringify(consoleCalls)).not.toContain(THROWAWAY);
  });
});

describe('sign-in view: going away while waiting', () => {
  it('does not throw when the answer arrives after the view was removed, and the field is blank', async () => {
    let finish: () => void = () => undefined;
    const user = setupUser();
    const { field } = renderSignIn({
      onSubmit: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });
    await user.type(field, `${THROWAWAY}{Enter}`);
    cleanup();
    await act(async () => {
      finish();
    });
    expect(field.value).toBe('');
  });
});
