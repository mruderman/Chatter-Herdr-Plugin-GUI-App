import type { ComponentType } from 'preact';

// Placeholder view: only its heading. The feature tasks replace each registry entry with the real view.
export function createStubView(title: string): ComponentType {
  return function StubView() {
    return <h1>{title}</h1>;
  };
}
