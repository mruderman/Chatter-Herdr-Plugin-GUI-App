// Watchers attached to every browser context a spec opens: CSP violations, console output, requested
// URLs, uncaught page errors, and (for keyboard-only runs) a pointer-event tripwire. The token-hygiene
// check reads storage and the DOM back into Node and searches there, so no token is ever passed into
// the page (evaluate arguments end up in traces).
import type { BrowserContext, Page } from '@playwright/test';
import { UI } from './ui';

const BINDING = '__e2eGuard';
const REPORT_CSP = 'csp';
const REPORT_POINTER = 'pointer';
// Chromium also logs each refusal to the console; catching both means neither channel is a single point of failure.
const CSP_CONSOLE = /Content Security Policy/i;

/** Anything shaped like a bridge token (`cb_` plus 256 random bits in base64url), whoever it belongs to. */
export const TOKEN_SHAPE = /cb_[A-Za-z0-9_-]{40,}/;
const TOKEN_SHAPES = new RegExp(TOKEN_SHAPE.source, 'g');

/** What the guards record is printed when a test fails, so anything token-shaped is blanked first. */
export const redact = (s: string): string => s.replace(TOKEN_SHAPES, '[token]');

interface ProbeOptions {
  binding: string;
  tripwire: boolean;
  csp: string;
  pointer: string;
}

/** Runs in the page before any of its scripts. Must be self-contained: Playwright serializes it. */
function installProbes({ binding, tripwire, csp, pointer }: ProbeOptions): void {
  const report = (kind: string, detail: string): void => {
    const fn: unknown = Reflect.get(window, binding);
    if (typeof fn === 'function') void fn(kind, detail);
  };
  document.addEventListener('securitypolicyviolation', (e) => {
    report(csp, `${e.effectiveDirective} refused ${e.blockedURI || 'inline'}`);
  }, true);
  if (!tripwire) return;
  // Down, up and wheel never come from a keyboard. A button activated by Enter or Space also fires
  // "click", but with detail 0, so only a click with a pointer behind it counts.
  const always = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'auxclick', 'wheel', 'touchstart', 'touchend'];
  const listen = (type: string, counts: (e: Event) => boolean): void => {
    window.addEventListener(type, (e) => {
      if (!e.isTrusted || !counts(e)) return;
      const t = e.target;
      report(pointer, `${type} on ${t instanceof Element ? t.tagName.toLowerCase() : 'document'}`);
    }, true);
  };
  for (const type of always) listen(type, () => true);
  listen('click', (e) => e instanceof MouseEvent && e.detail > 0);
}

export class Guard {
  readonly cspViolations: string[] = [];
  readonly pointerEvents: string[] = [];
  readonly consoleLines: string[] = [];
  readonly requestUrls: string[] = [];
  readonly pageErrors: string[] = [];

  static async attach(context: BrowserContext, { tripwire = false }: { tripwire?: boolean } = {}): Promise<Guard> {
    const guard = new Guard();
    await context.exposeBinding(BINDING, (_source, kind: unknown, detail: unknown) => {
      if (kind === REPORT_CSP) guard.cspViolations.push(redact(String(detail)));
      else if (kind === REPORT_POINTER) guard.pointerEvents.push(String(detail));
    });
    await context.addInitScript(installProbes, { binding: BINDING, tripwire, csp: REPORT_CSP, pointer: REPORT_POINTER });
    // Console lines and URLs are kept as they are: the token-hygiene check searches them, and only
    // ever reports which channel held a token.
    context.on('console', (m) => {
      const text = m.text();
      guard.consoleLines.push(text);
      if (CSP_CONSOLE.test(text)) guard.cspViolations.push(`console: ${redact(text).slice(0, 200)}`);
    });
    context.on('request', (r) => { guard.requestUrls.push(r.url()); });
    context.on('weberror', (e) => { guard.pageErrors.push(redact(String(e.error()))); });
    return guard;
  }

  /** Hands back and forgets the violations seen so far (the CSP canary plants one on purpose). */
  takeCspViolations(): string[] {
    return this.cspViolations.splice(0);
  }

  /** Hands back and forgets the pointer events seen so far (the tripwire canary clicks on purpose). */
  takePointerEvents(): string[] {
    return this.pointerEvents.splice(0);
  }
}

interface PageDump {
  storage: string;
  indexedDb: string;
  dom: string;
  unreadable: string[];
}

/** Storage, IndexedDB and the page's HTML, minus any "New token for ..." dialog. */
async function dumpPage(page: Page): Promise<PageDump> {
  return page.evaluate(async (newTokenPrefix) => {
    const unreadable: string[] = [];
    const storage: string[] = [];
    for (const [name, area] of [['localStorage', () => window.localStorage], ['sessionStorage', () => window.sessionStorage]] as const) {
      try {
        const s = area();
        for (let i = 0; i < s.length; i++) {
          const k = s.key(i);
          if (k !== null) storage.push(k, s.getItem(k) ?? '');
        }
      } catch (e) { unreadable.push(`${name}: ${String(e)}`); }
    }

    const idb: string[] = [];
    const settle = <T>(r: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      for (const info of await indexedDB.databases()) {
        if (!info.name) continue;
        const open = indexedDB.open(info.name);
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          open.onsuccess = () => resolve(open.result);
          open.onerror = () => reject(open.error);
        });
        try {
          for (const storeName of Array.from(db.objectStoreNames)) {
            const store = db.transaction(storeName, 'readonly').objectStore(storeName);
            idb.push(info.name, storeName, JSON.stringify(await settle(store.getAllKeys())), JSON.stringify(await settle(store.getAll())));
          }
        } finally { db.close(); }
      }
    } catch (e) { unreadable.push(`IndexedDB: ${String(e)}`); }

    // The admin's "New token" dialog is the one place a token may appear (ui-contract section 7).
    const exempt = new Set<Node>();
    for (const d of Array.from(document.querySelectorAll('[role="dialog"], dialog'))) {
      const labelledBy = (d.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
      const name = (d.getAttribute('aria-label') ?? labelledBy).trim();
      if (name.startsWith(newTokenPrefix)) exempt.add(d);
    }
    // The page's HTML: text, comments and attributes. A form control's live value is not HTML, and the
    // sign-in field holds the token there until sign-in succeeds (ui-contract section 1).
    const dom: string[] = [];
    const walk = (node: Node): void => {
      if (exempt.has(node)) return;
      if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.COMMENT_NODE) dom.push(node.nodeValue ?? '');
      if (node instanceof Element) {
        for (const a of Array.from(node.attributes)) dom.push(a.value);
        if (node.shadowRoot) walk(node.shadowRoot);
      }
      for (const c of Array.from(node.childNodes)) walk(c);
    };
    walk(document.documentElement);
    return { storage: storage.join('\n'), indexedDb: idb.join('\n'), dom: dom.join('\n'), unreadable };
  }, UI.admin.newTokenPrefix);
}

/**
 * Where a token turned up, by channel name only (never the value): requested URLs, console output,
 * localStorage, sessionStorage, IndexedDB, and the page outside the admin's "New token" dialog.
 */
export async function tokenLeaks(page: Page, guard: Guard, secrets: readonly string[]): Promise<string[]> {
  const known = secrets.filter((s) => s.length > 0);
  const leaks = (s: string): boolean => TOKEN_SHAPE.test(s) || known.some((t) => s.includes(t));
  const found: string[] = [];
  if (guard.requestUrls.some(leaks)) found.push('a requested URL');
  if (guard.consoleLines.some(leaks)) found.push('console output');
  if (page.isClosed()) return found;
  const dump = await dumpPage(page);
  if (leaks(dump.storage)) found.push('localStorage or sessionStorage');
  if (leaks(dump.indexedDb)) found.push('IndexedDB');
  if (leaks(dump.dom)) found.push('the page outside the "New token" dialog');
  for (const u of dump.unreadable) found.push(`could not read ${u}`);
  return found;
}
