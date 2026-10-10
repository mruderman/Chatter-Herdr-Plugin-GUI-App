import { render as preactRender, type ComponentChild } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach } from 'vitest';

const mounted = new Set<HTMLElement>();

/**
 * Renders into a fresh container attached to document.body. Preact defers renders and effects,
 * so `act` flushes them and assertions can run as soon as this returns.
 */
export function render(ui: ComponentChild): HTMLElement {
  const container = document.createElement('div');
  document.body.append(container);
  mounted.add(container);
  act(() => {
    preactRender(ui, container);
  });
  return container;
}

/** Unmounts what `render` created, so effect cleanups run and no test sees another test's DOM. */
export function cleanup(): void {
  for (const container of mounted) {
    act(() => {
      preactRender(null, container);
    });
    container.remove();
  }
  mounted.clear();
}

afterEach(cleanup);
