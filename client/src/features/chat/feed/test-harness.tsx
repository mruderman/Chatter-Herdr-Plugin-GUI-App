// Shared by the chat view's tests; nothing in the app imports it.
import { fireEvent } from '@testing-library/dom';
import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useState } from 'preact/hooks';
import { ManualClock } from '../../../api/clock';
import type { Store, StoreSnapshot } from '../../../state/types';

/** After the recorded messages (2026-10-10T14:06:56Z), so a message the fake receives is newer than all of them. */
export const AFTER_RECORDINGS = Date.UTC(2026, 9, 10, 15, 0, 0);

export function clockAfterRecordings(): ManualClock {
  return new ManualClock(AFTER_RECORDINGS);
}

/** Renders `view` with the store's snapshot and again with every snapshot it publishes, as the app will. */
export function Live({ store, view }: { store: Store; view: (snapshot: StoreSnapshot) => ComponentChildren }) {
  const [snapshot, setSnapshot] = useState(() => store.getSnapshot());
  useLayoutEffect(() => {
    setSnapshot(store.getSnapshot());
    return store.subscribe(setSnapshot);
  }, [store]);
  return <>{view(snapshot)}</>;
}

function ownDescriptor(name: string): PropertyDescriptor {
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, name);
  if (!descriptor) throw new Error(`test-harness: jsdom has no Element.prototype.${name}`);
  return descriptor;
}

export interface FakeLayout {
  /** Height of the log's visible area, in px. */
  readonly viewport: number;
  /** Height of every child of the log (headings, separator, messages), in px. */
  readonly row: number;
  /** The log's distance from the top of the page, in px. */
  readonly top: number;
  /** The largest scrollTop the log can have now. */
  maxScroll(log: HTMLElement): number;
  /** Where `element`, a child of the log, sits below the top of the log's visible area. */
  offsetInView(log: HTMLElement, element: Element): number;
  uninstall(): void;
}

/**
 * jsdom has no layout. This gives the `log` a fixed visible height and each of its children the same
 * height, stacked in order, so scrollTop (clamped as a browser clamps it), scrollHeight, clientHeight
 * and getBoundingClientRect agree with each other as they do in a browser. Every other element keeps
 * jsdom's own values.
 */
export function installFakeLayout({ viewport = 200, row = 40, top = 100 } = {}): FakeLayout {
  const proto = Element.prototype;
  const originals = {
    scrollTop: ownDescriptor('scrollTop'),
    scrollHeight: ownDescriptor('scrollHeight'),
    clientHeight: ownDescriptor('clientHeight'),
    getBoundingClientRect: ownDescriptor('getBoundingClientRect'),
  };
  const scrolled = new WeakMap<Element, number>();
  const isLog = (element: Element): boolean => element.getAttribute('role') === 'log';
  const contentHeight = (log: Element): number => log.children.length * row;
  const maxScroll = (log: Element): number => Math.max(0, contentHeight(log) - viewport);
  const scrollOf = (log: Element): number => scrolled.get(log) ?? 0;

  Object.defineProperty(proto, 'scrollTop', {
    configurable: true,
    get(this: Element) {
      return isLog(this) ? scrollOf(this) : originals.scrollTop.get?.call(this);
    },
    set(this: Element, value: number) {
      if (isLog(this)) scrolled.set(this, Math.min(Math.max(0, value), maxScroll(this)));
      else originals.scrollTop.set?.call(this, value);
    },
  });
  Object.defineProperty(proto, 'scrollHeight', {
    configurable: true,
    get(this: Element) {
      return isLog(this) ? Math.max(viewport, contentHeight(this)) : originals.scrollHeight.get?.call(this);
    },
  });
  Object.defineProperty(proto, 'clientHeight', {
    configurable: true,
    get(this: Element) {
      return isLog(this) ? viewport : originals.clientHeight.get?.call(this);
    },
  });
  Object.defineProperty(proto, 'getBoundingClientRect', {
    configurable: true,
    writable: true,
    value(this: Element): DOMRect {
      if (isLog(this)) return new DOMRect(0, top, 320, viewport);
      const parent = this.parentElement;
      if (parent && isLog(parent)) {
        const index = Array.prototype.indexOf.call(parent.children, this);
        return new DOMRect(0, top + index * row - scrollOf(parent), 320, row);
      }
      return originals.getBoundingClientRect.value.call(this);
    },
  });

  return {
    viewport,
    row,
    top,
    maxScroll,
    offsetInView: (log, element) => element.getBoundingClientRect().top - log.getBoundingClientRect().top,
    uninstall() {
      for (const [name, descriptor] of Object.entries(originals)) Object.defineProperty(proto, name, descriptor);
    },
  };
}

/** What a reader's scrolling does: the offset changes, then the browser fires `scroll`. */
export function scrollLogTo(log: HTMLElement, top: number): void {
  log.scrollTop = top;
  fireEvent.scroll(log);
}
