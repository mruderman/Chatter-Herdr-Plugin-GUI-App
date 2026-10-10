// Canary for the unit-test toolchain: when this fails, suspect the tooling before the app.
// The heading and axe tests target the placeholder in src/main.tsx; retarget them when that file is replaced.
import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { useEffect, useState } from 'preact/hooks';
import { describe, expect, it } from 'vitest';
import { Placeholder } from '../src/main';
import { cleanup, render } from './render';

// jsdom has no layout engine, so colour contrast is left to the real-browser E2E run.
const AXE_OPTIONS: axe.RunOptions = { rules: { 'color-contrast': { enabled: false } } };

describe('unit-test toolchain (Vitest, jsdom, Testing Library, axe)', () => {
  it('finds the placeholder heading by role and accessible name', () => {
    render(<Placeholder />);
    const heading = screen.getByRole('heading', { name: 'Chatter', level: 1 });
    expect(heading.tagName).toBe('H1');
  });

  it('moves focus with the keyboard', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">First</button>
        <button type="button">Second</button>
      </>,
    );
    await user.keyboard('{Tab}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First' }));
    await user.keyboard('{Tab}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Second' }));
  });

  it('reports no axe violations on the placeholder', async () => {
    const container = render(<Placeholder />);
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations).toEqual([]);
  });

  it('reports a known violation, so a clean axe result means something', async () => {
    const container = render(<button type="button" />);
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations.map((violation) => violation.id)).toContain('button-name');
  });

  it('render() flushes state set in effects before it returns', () => {
    function Counter() {
      const [count, setCount] = useState(0);
      useEffect(() => setCount(1), []);
      return <p>{count}</p>;
    }
    const container = render(<Counter />);
    expect(container.textContent).toBe('1');
  });

  it('cleanup() unmounts rendered trees and detaches their containers', () => {
    let unmounted = false;
    function Probe() {
      useEffect(
        () => () => {
          unmounted = true;
        },
        [],
      );
      return <p>probe</p>;
    }
    const container = render(<Probe />);
    expect(container.isConnected).toBe(true);
    cleanup();
    expect(unmounted).toBe(true);
    expect(container.isConnected).toBe(false);
  });
});
