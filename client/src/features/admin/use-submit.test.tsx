// The hook every dialog that sends something shares, on its own: one call at a time, a refusal shown
// until the next attempt, and a failure it does not understand put in fixed words that never echo what
// was thrown.
import { screen, waitFor } from '@testing-library/dom';
import { describe, expect, it, vi } from 'vitest';
import { render } from '../../../test/render';
import { setupUser } from '../shell/test-utils';
import { MAYBE_DONE, UNEXPECTED_FAILURE } from './failure';
import type { Outcome } from './outcome';
import { useSubmit } from './use-submit';

function Harness({ action }: { action: () => Promise<Outcome> }) {
  const { busy, message, run } = useSubmit();
  return (
    <div>
      <button type="button" onClick={() => void run(action)}>
        Go
      </button>
      <p>{busy ? 'busy' : 'idle'}</p>
      {message !== null && <p role="alert">{message}</p>}
    </div>
  );
}

/** An action that stays out until the test lets it finish. */
function held() {
  let finish: (outcome: Outcome) => void = () => undefined;
  const pending = new Promise<Outcome>((resolve) => {
    finish = resolve;
  });
  return { action: vi.fn(() => pending), finish };
}

describe('useSubmit', () => {
  it('runs one action at a time: a second press while the first is out does nothing, and the next one after it is allowed', async () => {
    const user = setupUser();
    const { action, finish } = held();
    render(<Harness action={action} />);
    expect(screen.getByText('idle')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Go' }));
    await user.click(screen.getByRole('button', { name: 'Go' }));
    expect(action).toHaveBeenCalledTimes(1);
    expect(screen.getByText('busy')).toBeTruthy();
    finish({ ok: true });
    await waitFor(() => expect(screen.getByText('idle')).toBeTruthy());
    await user.click(screen.getByRole('button', { name: 'Go' }));
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('shows a refusal until the next attempt starts, and takes it off the screen while that attempt is out', async () => {
    const user = setupUser();
    let answerSecond: (outcome: Outcome) => void = () => undefined;
    const action = vi
      .fn<() => Promise<Outcome>>()
      .mockResolvedValueOnce({ ok: false, message: 'cannot do that' })
      .mockImplementationOnce(
        () =>
          new Promise<Outcome>((resolve) => {
            answerSecond = resolve;
          }),
      );
    render(<Harness action={action} />);
    await user.click(screen.getByRole('button', { name: 'Go' }));
    expect((await screen.findByRole('alert')).textContent).toBe('cannot do that');
    await user.click(screen.getByRole('button', { name: 'Go' }));
    expect(screen.queryByRole('alert')).toBeNull();
    answerSecond({ ok: false, message: 'still not' });
    expect((await screen.findByRole('alert')).textContent).toBe('still not');
  });

  it('puts a failure it does not understand in fixed words, and does not repeat what was thrown', async () => {
    const user = setupUser();
    const action = vi.fn(async (): Promise<Outcome> => {
      throw new Error('boom cb_secret_value');
    });
    render(<Harness action={action} />);
    await user.click(screen.getByRole('button', { name: 'Go' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(`${UNEXPECTED_FAILURE} ${MAYBE_DONE}`);
    expect(alert.textContent?.includes('cb_secret_value')).toBe(false);
  });

  it('can run again after a failure', async () => {
    const user = setupUser();
    const action = vi.fn(async (): Promise<Outcome> => {
      throw new Error('boom');
    });
    render(<Harness action={action} />);
    await user.click(screen.getByRole('button', { name: 'Go' }));
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'Go' }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
  });
});
