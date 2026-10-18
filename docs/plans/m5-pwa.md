# M5: the PWA slice (and what happens to the installers)

**Status:** full plan, written 2026-10-18, **awaiting Flan's approval in chat; nothing dispatched.** It replaces the
outline of 2026-10-13. Run on its own short-lived branch `m5-pwa`, created from `main` after M4's archive has landed (the
shell part, M5a, can start earlier because it does not touch the archive). Decisions that need Flan are **Q1 to Q6**, each
with a recommended default; I apply a default only after the yes.

## 1. What this delivers

An installable web app (Edge, Chrome and Brave on Linux, Android Chrome; D20) whose shell starts when the bridge is
unreachable, so that with M4's archive a member can still read history and export offline. One web bundle, as SPEC
section 9 says: the bridge serves it at `/` over `https://<machine>.<tailnet>.ts.net:8446` (Tailscale Serve, SPEC section
4; HTTPS is also what makes service workers and notifications available, and `localhost` is a secure context for
development). Out of scope: Web Push, native installers, a native Android app, any change to what the bridge decides.

## 2. Decisions to confirm (recommended default first)

- **Q1. Do the PWA at all.** It is the least valuable piece for an MVP (installable, offline shell; no alerts when the page
  is closed). Recommended: yes, after M4, small, and droppable without harming anything else.
- **Q2. Native installers (SPEC section 9 and the M5 gate).** SPEC section 9 plans an Electron `.deb` and AppImage, and the
  M5 gate says "both installers build". Recommended: **defer the installers**, and change the M5 gate to "the PWA installs
  and passes the offline end-to-end run". Why: the PWA already gives an installable app on every browser D20 allows;
  Electron adds a binary pipeline, a cross-origin configuration (`CHATTER_BRIDGE_ORIGINS`), and an unverified sandbox risk
  on Ubuntu 24.04 (restricted unprivileged user namespaces break AppImages). Revisit only if a member cannot use a PWA.
  This amends SPEC sections 9 and 11, which is why it is yours to decide. (Electron, Tauri and installer work do not start
  without your explicit yes in any case.)
- **Q3. Web Push.** Recommended: no. It adds an outbound dependency on a vendor push service, keys, and stored
  subscriptions on the bridge. The PWA ships with a plain limit, told to members: no alerts when the page is closed.
- **Q4. Icons.** An installable app needs 192 and 512 px PNG icons (and a maskable one). Recommended: a plain generated
  monogram (white "C" on the theme's cyan) written by a small zero-dependency script (`node:zlib`) and committed as
  files, until you give me the Cyan Society mark. Say if you have an asset to use.
- **Q5. Update behaviour.** When a new bundle is deployed, the app shows a polite "A new version is ready. Reload" notice and
  never reloads by itself (a reload would drop an unsent draft). Recommended: yes.
- **Q6. Scope of the cache.** The service worker caches the static shell only (`index.html`, the hashed assets, the manifest,
  the icons) and **never** anything under `/v1/` or `/healthz`: no message, no directory, no token, no DM ever enters
  Cache Storage (the archive of M4 is the one deliberate store of messages, and it is the member's, per P2 to P5 in the M4
  plan). Recommended: yes; it is also a hard-boundary test (T33).

## 3. Contract

- **Manifest** (`/manifest.webmanifest`, already served with its MIME type and allowed by the CSP's `manifest-src 'self'`):
  name "Chatter", short name "Chatter", `display: standalone`, `start_url: "./"`, `scope: "./"`, theme and background
  colours from the design tokens, the icons of Q4. No `id` that names a host.
- **Service worker** (`/sw.js`, same origin, allowed by `worker-src 'self'`; served with `Cache-Control: no-cache` so an
  update is seen at once):
  - `install`: cache the shell under a versioned name (the build's hash); never `skipWaiting` by itself (Q5).
  - `fetch`: only same-origin GETs outside `/v1/` and `/healthz`. `index.html`: network first, the cached copy only when the
    network fails. Hashed assets: cache first. Everything else is passed through untouched; a request with an
    `Authorization` header or a non-GET is never intercepted.
  - `activate`: delete the caches of older versions. **Kill switch:** a query-less file `/sw-kill` (or a version value of
    `kill` in `sw.js`) makes the worker unregister itself and clear its caches on the next load, so a bad worker can be
    removed by deploying one small change.
- **Offline UX.** With the bridge unreachable the shell loads, the Connection status reads "Offline", the feed shows
  what is held (the archive, once M4 has landed; before that, what the page had loaded), Send says "Not sent: the bridge
  could not be reached" as today, and Export works from the archive. A short line on the sign-in view says that sign-in
  needs the bridge.
- **Storage.** The persistent-storage request is M4's (P7); M5 reuses it and shows nothing new.
- **Phone pass.** A Playwright project with a phone profile and touch: 320 px, 200% text, 24 px targets, the @-completion
  list and the area of the on-screen keyboard (a visual-viewport emulation), the export and search dialogs once M4 exists.
  A hand check on a real Android phone is listed as unverified until you have done it.

## 4. Tasks, waves and who does them

| Wave | Task | Who | Holds (edit) | Done when |
| --- | --- | --- | --- | --- |
| 0 | **T30 contract**: ui-contract sections (offline start, update notice, install), the SPEC amendments of Q2, the manifest and worker rules above | me | `docs/ui-contract.md`, `docs/SPEC.md` | you have read it |
| 1 | **T31 bridge static**: serve `/sw.js` with `no-cache` and `Service-Worker-Allowed`, `/manifest.webmanifest` and the icons, keep the CSP as it is (it already allows both), test that a service-worker path cannot be used to escape the static root | Sonnet | `bridge/src/static.js`, `bridge/test/**` | new tests red first; the CSP header unchanged byte for byte |
| 1 | **T32 icons and manifest**: the icon script and files, the manifest, the `<link>` tags, the theme colour | Sonnet | `client/public/**` (new), `client/index.html`, `client/scripts/**` | the manifest validates (Playwright reads it and checks the installability fields) |
| 2 | **T33 service worker**: `sw.js`, registration with the kill switch, the update notice, the never-cache rule, offline UX | Opus | `client/src/sw/**`, `client/src/wiring/**`, `client/src/features/shell/**` | the specs of section 5 pass; a spec asserts Cache Storage holds no `/v1/` URL after a full session |
| 3 | **T34 phone project and offline e2e**: the Playwright phone project, `context.setOffline`, the offline start | Sonnet | `client/playwright.config.ts`, `client/e2e/pwa-*.spec.ts` | green; the M5 gate below |
| 4 | **Verification**: my mutations, one Codex round on the worker (cache poisoning, stale shell, authenticated responses cached) | me, Codex | the review tooling | the gate passes; STATUS current |

T31 and T32 run in parallel. M5a is T30 to T33 without the archive part; M5b adds the offline archive read and export once
M4 has landed.

## 5. Gate, and my mutations

The gate (changed by Q2, otherwise as in the outline): the shell loads with the bridge unreachable; with M4, the archive
stays readable and an export works offline; a new bundle shows the update notice and does not reload by itself; the kill
switch removes the worker; nothing under `/v1/` is ever in Cache Storage; the existing E2E guards stay green; axe is clean
in three themes. Verified in Chromium; Firefox only with your approval.

My mutations, each of which must turn a named test red: cache `/v1/` responses; intercept a request that carries an
`Authorization` header; make `index.html` cache first (a stale shell after a deploy); `skipWaiting` on install (a reload
under a draft); drop the kill switch; serve `sw.js` with a long `max-age`; widen the worker's scope above `/`; let the
CSP drop `worker-src`.

## 6. Risks and what stays unverified

- Service-worker update flows are where PWAs go wrong (a stale shell that cannot be replaced); the kill switch and the
  version-named caches are the answer, and the Codex round looks at exactly this.
- A real phone, iOS (not a D20 browser), Firefox and Safari: unverified.
- HTTPS is required in production (Tailscale Serve provides it); a plain-HTTP tailnet name has no service worker and the app
  then works as a normal page, said in the deployment runbook.

## 7. Estimate (rough)

Five executor tasks in four waves and one Codex round; smaller than M4. It can be dropped (Q1) without harming M4.
