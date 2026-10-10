// Shared by the shell's tests; nothing in the app imports it.
import { configure } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { act } from 'preact/test-utils';
import { expect } from 'vitest';

// Preact defers renders. Wrapping every event the Testing Library dispatches in `act` flushes the
// state updates and effects it causes before the next line of a test runs.
configure({
  eventWrapper: (callback) => {
    let result: unknown;
    act(() => {
      result = callback();
    });
    return result;
  },
});

export function setupUser() {
  return userEvent.setup();
}

// jsdom has no layout, so contrast is checked from the tokens (styles/tokens.test.ts) and in a real
// browser. Everything else axe knows runs, including its best-practice rules.
const AXE_OPTIONS: axe.RunOptions = {
  rules: { 'color-contrast': { enabled: false } },
};

/**
 * Runs axe over the whole document, so page-level rules (one main landmark, a level-one heading,
 * landmark uniqueness) apply. The document is given what index.html provides in the real page.
 */
export async function expectNoAxeViolations(options: axe.RunOptions = AXE_OPTIONS): Promise<void> {
  document.documentElement.lang = 'en';
  document.title = 'Chatter';
  const results = await axe.run(document, options);
  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target.join(' ')),
    })),
  ).toEqual([]);
}

export { AXE_OPTIONS };
