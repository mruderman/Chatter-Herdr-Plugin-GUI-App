// Smoke (plan T4): the bridge serves the built client at / under the D15 CSP, the bundle runs without a
// CSP violation, and /healthz answers. The canaries prove each guard of the harness sees what it exists
// to catch, so a green gate run cannot be green because a guard went blind. None needs the real UI.
import http from 'node:http';
import { HTTP, ROUTES } from './harness/api';
import { axeScan } from './harness/axe';
import { expect, test } from './harness/fixtures';
import { tokenLeaks } from './harness/guard';
import { startProxy } from './harness/proxy';
import { D15_CSP } from './harness/world';

const ASSETS = '/assets/';
const HTML = 'text/html; charset=utf-8';

test.describe('smoke: the bridge serves the built client (plan T4; D15)', () => {
  test('the page loads from the bridge under the D15 CSP with no violation, and /healthz answers', async ({ open, world }) => {
    const { page } = await open();
    const assets: Array<{ url: string; status: number }> = [];
    page.on('response', (r) => {
      if (new URL(r.url()).pathname.startsWith(ASSETS)) assets.push({ url: r.url(), status: r.status() });
    });

    const res = await page.goto('/');
    expect(res?.status()).toBe(HTTP.ok);
    const headers = res?.headers() ?? {};
    expect(headers['content-security-policy']).toBe(D15_CSP);
    expect(headers['content-type']).toBe(HTML);
    expect(headers['x-content-type-options']).toBe('nosniff');

    // The bundle ran: every view, sign-in included, renders exactly one h1 (ui-contract section 2).
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(assets.length, 'the page loaded its bundle from /assets/').toBeGreaterThan(0);
    for (const a of assets) expect(a.status, a.url).toBe(HTTP.ok);

    const health = await page.request.get(ROUTES.healthz);
    expect(health.status()).toBe(HTTP.ok);
    expect(await health.json()).toMatchObject({ ok: true, repos: [world.repo, world.sidecar].length });
    // The fixture fails the test at teardown if the page reported any CSP violation.
  });
});

test.describe('harness canaries: each guard sees what it exists to catch', () => {
  test('the CSP guard hears a refused inline script on both channels (event and console)', async ({ open }) => {
    const { page, guard } = await open();
    await page.goto('/');
    await page.evaluate(() => {
      const s = document.createElement('script');
      s.textContent = 'window.__e2eCanaryRan = true';
      document.head.append(s);
    });
    const both = () => guard.cspViolations.some((v) => v.startsWith('console:')) && guard.cspViolations.some((v) => !v.startsWith('console:'));
    await expect.poll(both).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, '__e2eCanaryRan'))).toBeUndefined();
    expect(guard.takeCspViolations().some((v) => v.includes('script-src'))).toBe(true);
  });

  test('the pointer tripwire counts a mouse click but not a keyboard activation', async ({ open }) => {
    const { page, guard } = await open({ tripwire: true });
    await page.goto('/');
    await page.evaluate(() => {
      const b = document.createElement('button');
      b.id = 'e2e-canary';
      b.textContent = 'canary';
      b.addEventListener('click', () => { Reflect.set(window, '__e2eClicks', Number(Reflect.get(window, '__e2eClicks') ?? 0) + 1); });
      document.body.append(b);
      b.focus();
    });
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await expect.poll(() => page.evaluate(() => Reflect.get(window, '__e2eClicks'))).toBe(2);
    expect(guard.pointerEvents).toEqual([]);

    await page.locator('#e2e-canary').click();
    await expect.poll(() => guard.pointerEvents.some((e) => e.startsWith('click'))).toBe(true);
    expect(guard.takePointerEvents()).toContain('pointerdown on button');
  });

  test('the token-hygiene check finds a planted token in every channel, except inside a "New token" dialog', async ({ open }) => {
    // This test plants a fake token on purpose, so the fixture's own end-of-test check is off for it.
    const { page, guard } = await open({ skipHygiene: true });
    await page.goto('/');
    const fake = `cb_${'Q'.repeat(43)}`; // shaped like a bridge token; belongs to no one
    expect(await tokenLeaks(page, guard, [])).toEqual([]);

    await page.evaluate((t) => {
      const d = document.createElement('div');
      d.setAttribute('role', 'dialog');
      d.setAttribute('aria-label', 'New token for canary');
      d.textContent = t;
      document.body.append(d);
    }, fake);
    expect(await tokenLeaks(page, guard, []), 'the New token dialog is exempt').toEqual([]);

    await page.evaluate((t) => {
      const p = document.createElement('p');
      p.id = 'e2e-planted';
      p.title = t;
      document.body.append(p);
    }, fake);
    expect(await tokenLeaks(page, guard, [])).toEqual(['the page outside the "New token" dialog']);
    await page.evaluate(() => document.getElementById('e2e-planted')?.remove());

    // A form control's value is a property, not HTML, so the walk above never reads it. It is read on its own:
    // the sign-in field (type=password) and anything inside a "New token" dialog are the exemptions.
    await page.evaluate((t) => {
      const input = document.createElement('input');
      input.id = 'e2e-field';
      document.body.append(input);
      input.value = t;
    }, fake);
    expect(await tokenLeaks(page, guard, [])).toEqual(['a form control\'s value outside the "New token" dialog']);
    await page.evaluate(() => document.getElementById('e2e-field')?.remove());

    // The exemption is for the sign-in field alone, found by its label. A password input anywhere else that
    // holds a token is a leak: masking a credential is no licence to keep it.
    await page.evaluate((t) => {
      const extra = document.createElement('input');
      extra.type = 'password';
      extra.id = 'e2e-extra';
      document.body.append(extra);
      extra.value = t;
    }, fake);
    expect(await tokenLeaks(page, guard, []), 'a password input that is not the sign-in field').toEqual(['a form control\'s value outside the "New token" dialog']);
    await page.evaluate(() => document.getElementById('e2e-extra')?.remove());

    await page.evaluate((t) => {
      const label = document.createElement('label');
      label.id = 'e2e-signin-label';
      label.htmlFor = 'e2e-signin';
      label.textContent = 'Access token';
      const signIn = document.createElement('input');
      signIn.type = 'password';
      signIn.id = 'e2e-signin';
      document.body.append(label, signIn);
      signIn.value = t;
      const area = document.createElement('textarea');
      document.querySelector('[role="dialog"]')?.append(area);
      area.value = t;
    }, fake);
    expect(await tokenLeaks(page, guard, []), 'the sign-in field and a New token dialog may hold one').toEqual([]);
    await page.evaluate(() => {
      document.getElementById('e2e-signin')?.remove();
      document.getElementById('e2e-signin-label')?.remove();
    });

    await page.evaluate((t) => sessionStorage.setItem('e2e', t), fake);
    expect(await tokenLeaks(page, guard, [])).toEqual(['localStorage or sessionStorage']);
    await page.evaluate(() => sessionStorage.clear());

    await page.evaluate(async (t) => {
      const open = indexedDB.open('e2e-canary', 1);
      open.onupgradeneeded = () => { open.result.createObjectStore('s'); };
      const db = await new Promise<IDBDatabase>((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('s', 'readwrite');
        tx.objectStore('s').put({ token: t }, 'k');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    }, fake);
    expect(await tokenLeaks(page, guard, [])).toEqual(['IndexedDB']);
    await page.evaluate(() => new Promise<void>((resolve) => { indexedDB.deleteDatabase('e2e-canary').onsuccess = () => resolve(); }));

    await page.evaluate((t) => console.log(`planted ${t}`), fake);
    await expect.poll(async () => tokenLeaks(page, guard, [])).toEqual(['console output']);

    await page.evaluate((t) => fetch(`/healthz?planted=${t}`).then((r) => r.status), fake);
    await expect.poll(async () => tokenLeaks(page, guard, [])).toEqual(['a requested URL', 'console output']);
  });

  test('the token-hygiene check finds a token in an uncaught page error, and what the guard keeps for display is redacted', async ({ open }) => {
    // Throws on purpose, so the fixture's end-of-test checks are off for it and the error is handed back below.
    const { page, guard } = await open({ skipHygiene: true });
    await page.goto('/');
    const fake = `cb_${'R'.repeat(43)}`;
    expect(await tokenLeaks(page, guard, [])).toEqual([]);

    await page.evaluate((t) => { setTimeout(() => { throw new Error(`request failed with ${t}`); }, 0); }, fake);
    await expect.poll(async () => tokenLeaks(page, guard, [])).toContain('an uncaught page error');

    const shown = guard.takePageErrors();
    expect(shown.length, 'the error was recorded').toBeGreaterThan(0);
    expect(shown.some((line) => line.includes(fake)), 'what is printed or annotated is redacted').toBe(false);
    expect(guard.pageErrors, 'handed back and forgotten').toEqual([]);
    expect(guard.pageErrorsHoldToken([]), 'the raw copy is forgotten with it').toBe(false);
  });

  test('an uncaught page error fails the test that left it behind', async ({ open }) => {
    // Marked as expected to fail: it passes only while the fixture fails it at teardown. If the fixture stops
    // failing on page errors this test passes unexpectedly, and Playwright reports that as a failure.
    test.fail(true, 'the fixture has to fail a test that leaves an uncaught page error behind');
    const { page, guard } = await open();
    await page.goto('/');
    await page.evaluate(() => { setTimeout(() => { throw new Error('a canary error with no token in it'); }, 0); });
    // Waits without asserting. If the guard stopped recording the error nothing fails here, the test passes, and
    // test.fail() reports that as a failure: the only way to be marked as failing is the fixture's own check.
    for (let waited = 0; guard.pageErrors.length === 0 && waited < 5_000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
  });

  test('axe runs under the D15 CSP without causing a violation', async ({ open }) => {
    const { page } = await open();
    await page.goto('/');
    const results = await axeScan(page);
    expect(results.passes.length + results.violations.length).toBeGreaterThan(0);
  });

  test('offline emulation leaves an in-flight fetch stream delivering; cutting the reconnect proxy breaks it', async ({ open }) => {
    // A local ticker stands in for the bridge's stream, so no token is involved.
    const ticker = await startTicker();
    const proxy = await startProxy(ticker.url);
    try {
      const { page, context } = await open({ baseURL: proxy.url });
      await page.goto('/');
      await page.evaluate((route) => {
        void fetch(route).then(async (res) => {
          const reader = res.body?.getReader();
          if (!reader) throw new Error('no body');
          for (;;) {
            const { done } = await reader.read();
            if (done) break;
            Reflect.set(window, '__e2eTicks', Number(Reflect.get(window, '__e2eTicks') ?? 0) + 1);
          }
          Reflect.set(window, '__e2eTickEnd', 'done');
        }).catch((e: unknown) => { Reflect.set(window, '__e2eTickEnd', String(e)); });
      }, TICK_ROUTE);
      const ticks = () => page.evaluate(() => Number(Reflect.get(window, '__e2eTicks') ?? 0));
      await expect.poll(ticks).toBeGreaterThan(0);

      await context.setOffline(true);
      expect(await page.evaluate(() => navigator.onLine)).toBe(false);
      const offlineAt = await ticks();
      await expect.poll(ticks, 'the stream keeps delivering while "offline"').toBeGreaterThan(offlineAt + 3);
      expect(await page.evaluate(() => fetch('/').then(() => 'fetched', () => 'refused'))).toBe('refused');

      proxy.cut();
      await expect.poll(() => page.evaluate(() => Reflect.get(window, '__e2eTickEnd'))).toMatch(/TypeError|network/i);
    } finally {
      await proxy.close();
      await ticker.close();
    }
  });
});

const TICK_ROUTE = '/tick';
const TICK_MS = 50;

/** A page plus an endless event stream, on port 0, standing in for the bridge in the proxy canary. */
async function startTicker(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url === TICK_ROUTE) {
      res.writeHead(HTTP.ok, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const timer = setInterval(() => res.write(': tick\n\n'), TICK_MS);
      req.on('close', () => clearInterval(timer));
      return;
    }
    res.writeHead(HTTP.ok, { 'Content-Type': HTML });
    res.end('<!doctype html><html lang="en"><title>ticker</title><h1>ticker</h1></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the ticker did not get a TCP port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
