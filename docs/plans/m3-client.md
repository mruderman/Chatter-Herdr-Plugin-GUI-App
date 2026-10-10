# M3 plan: web client core

Scope and hard rules come from [CLAUDE.md](../../CLAUDE.md) and [SPEC.md](../SPEC.md) (§5 API, §7 client). This file says how M3 is split, who does what and how each piece is accepted. Codes marked (proposed) are not yet in the Claude Doc.

- **Tier** T3 · **Mode** prefer parallel, at most 3 executors at once (Flan, 2026-10-09) · **Plan style** points: goals, constraints, done-whens; executors write the code (inferred from CLAUDE.md; unconfirmed).
- **Gate** (CLAUDE.md): two Playwright clients exchange messages end to end against a real bridge and real Chatter; a DM is invisible to a third member; a member's `@everyone` is refused with a visible error; the main flow works by keyboard alone. Plus: axe reports no serious or critical violations.
- Wave 0 is briefed in full below. Waves 1 to 4 are briefed at the gate before them, with what the earlier wave taught.

## Decisions (proposed numbers)
- **Q2** decided by Flan, 2026-10-09: `/brief` and `/role` are out of M3. They need new bridge routes and `chatter brief --json` is unverified. Tracked as debt.
- **D12** `client/` is its own package with its own lockfile. Root and bridge stay dependency-free. `idb` waits for M4.
- **D13** SSE runs over `fetch`: the bridge reads credentials only from `Authorization: Bearer` (F11), so `EventSource` cannot authenticate. `Last-Event-ID` is sent by the client. No token in any URL.
- **D14** The token form ships in every build and appears only after `/v1/me` returns 401. The token lives in memory only.
- **D15** The app shell is served without credentials; everything under `/v1` still needs them. CSP: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.
- **D16** The admin panel does full member management (add, edit, revoke, rotate) plus audit. A new token is shown once.
- **D17** Notifications show the sender and "mentioned you" or "DM", never message text. Permission is asked on a button press.
- **Dependencies** exact pins, resolved with `npm install --before=2026-09-25` (two weeks before 2026-10-09) so transitive packages predate the cutoff too. `ignore-scripts=true` where the toolchain allows.
- D12 to D17 were stated as defaults at go-ahead; Flan raised no objection.

## Findings that shape the plan (observed 2026-10-09)
- **F11** credentials only from `Authorization: Bearer` (`bridge/src/auth.js:39`).
- **F12** no `/brief` or `/role` route in the bridge.
- **F13** admins see every DM (`bridge/src/messages.js:10`): the DM-privacy gate needs a non-admin third member, and the `@everyone` gate needs a non-admin sender.
- **F14** `.gitignore` excludes `dist/`: a deployed bridge must build `client/dist` first (M5).
- `GET messages` with no cursor returns the newest page, oldest first; scroll back with `before_id`.

## Waves and assignment
```
W0  T0 || T1          -> G0   I read static.js; Codex reviews it; I re-check the dependency table
W1  T2 || T3 || T4    -> G1   API types diffed against live bridge responses; contract frozen
W2  T5 || T8 || T7
W3  T6 || T9          (T6 waits here only because W2 is full; T9 needs T5's behaviour)
W4  T10               -> G2   Codex reviews the whole diff; mutation checks; CLAUDE.md State updated
```
W4 is one task because integration needs the behaviour of everything before it. T4 needs T1's static route and T0's Playwright. T2 and T3 need T0's toolchain. T5, T7, T8 need only the frozen contract from G1; T8 builds against T2's fake store while T5 is built.

| Task | Wave | Who | Why | Holds | Waits |
|---|---|---|---|---|---|
| T0 scaffold, deps | 0 | Sonnet | checklist work; I re-verify the table | `client/` (placeholder `src/main.tsx` only), root `package.json` scripts, root `.gitignore`, `docs/dependencies.md` | none |
| T1 static + CSP | 0 | Opus | security-sensitive file serving, tests first | `bridge/src/static.js`, hook in `bridge/src/server.js`, `bridge/bin/chatter-bridge.js`, `bridge/test/static.test.js`, `bridge/test/helpers.js`, README configuration table | none |
| G0 | 0 | me, Codex read-only | independent eyes on file serving and the dependency table | none | T0, T1 |
| T2 API + state contract | 1 | Opus | contract-heavy, SSE edge cases | `client/src/api/**`, `client/src/state/types.ts`, `client/src/state/fake.ts`, `client/test/fixtures/**` | G0 |
| T3 design system + shell | 1 | Sonnet | semantic shell driven by the UI contract | `client/src/styles/**`, `client/src/features/shell/**`, `client/src/features/index.ts`, `client/src/app.tsx`, `client/src/main.tsx` | G0 |
| T4 E2E harness + blind specs | 1 | Opus, writes none of the UI | independence of the certifier | `client/e2e/**`, `client/playwright.config.ts` | G0 |
| G1 | 1 | me | contract gate | none | T2, T3, T4 |
| T5 session + sync | 2 | Opus | sync correctness | `client/src/state/**` except frozen `types.ts`, `fake.ts` | G1 |
| T8 feed, composer, DMs, repos | 2 | Opus | largest UI slice, combobox accessibility | `client/src/features/feed/**`, `client/src/features/repos/**` | G1 (shape) |
| T7 admin panel | 2 | Sonnet | forms and dialogs against the contract; I read the token display | `client/src/features/admin/**` | G1 |
| T6 board + members | 3 | Sonnet | simple read-only views | `client/src/features/board/**`, `client/src/features/members/**` | G1 |
| T9 notifications | 3 | Sonnet | small; needs T5's events | `client/src/features/notify/**` | T5 |
| T10 integrate + gate | 4 | me, plus an Opus fixer if needed | wiring and mutation checks | `client/src/features/index.ts`, `client/src/app.tsx`, fixes under `client/e2e/**` | T5 to T9 |
| G2 | 4 | Codex read-only, me | adversarial review of the whole diff | none | T10 |

## Wave 0 briefs

### T0 Scaffold `client/` and vet dependencies
Build an empty but real client package. The only user-visible thing is a placeholder heading.
- `client/` with: `package.json` (private, `type: module`, `engines.node >=22.5`), `.npmrc`, `tsconfig.json` (strict, `noUncheckedIndexedAccess`, Preact JSX), `vite.config.ts` (Preact preset; `build.outDir dist`; no source maps; dev server proxies `/v1` and `/healthz` to `http://127.0.0.1:8791`), `index.html` (`lang=en`, viewport, title "Chatter", `#app`, one module script), `src/main.tsx` (heading "Chatter"), `playwright.config.ts` (one Chromium project, `testDir e2e`, `baseURL` from `E2E_BASE_URL`), `client/.gitignore`, `scripts/check-dist.mjs`.
- Scripts: `dev`, `build`, `typecheck`, `test` (Vitest, with a toolchain test proving role queries, keyboard input and axe all work in jsdom against the placeholder, plus `test/render.ts`, a helper that renders a vnode into a fresh container with `act` and cleans up), `e2e`, `check:dist` (fails on inline script bodies, inline `<style>`, `style=` attributes, `on*=` handlers or any foreign-origin URL in `dist/index.html`). Root `package.json` gets only `client:build`, `client:test`, `client:e2e` that run `npm --prefix client run ...`. Root gets no dependencies and `npm test` stays the bridge's. Root `.gitignore` gains `test-results/` and `playwright-report/`.
- Dependencies, and no others (no router, no state library, no ESLint, no `idb`): `preact`, `vite`, `@preact/preset-vite`, `typescript`, `vitest`, a DOM test environment (`jsdom` unless you find a reason against it), `@playwright/test`, `@axe-core/playwright`, `@testing-library/dom`, `@testing-library/user-event` and `axe-core` (added to T0 on 2026-10-09 so unit tests can query by role and name, drive the keyboard and run axe's structural rules in jsdom; no `@testing-library/preact`), `@types/node` if needed.
- Vetting: resolve with `npm install --before=2026-09-25 --save-exact`. Write `docs/dependencies.md`: per direct dependency the exact version, its publish date from `npm view <pkg>@<ver> time`, purpose and whether it has install scripts; plus the total package count, every lockfile entry with `hasInstallScript`, and the `npm audit` summary. Any advisory against a runtime dependency, or high or critical against a dev one, goes in the report.
- Playwright pin: it must match a Chromium build already cached in `~/.cache/ms-playwright` (builds 1234 and 1243 are present; local evidence says Playwright 1.62.1 maps to 1234, unverified). Pick the newest release at or before the cutoff whose `playwright-core/browsers.json` chromium revision is cached. Confirm with `npx playwright install --dry-run chromium` (it must show nothing to download) and by launching headless Chromium once. Never run `playwright install`. If nothing matches, stop and report. The snap Chromium is not an option.
- Done when, from a clean `client/node_modules` with pasted output: `npm ci`, `typecheck`, `test`, `build`, `check:dist`, `npx playwright test --list` and the headless launch all succeed; `docs/dependencies.md` is complete; every direct dependency in `package.json` is an exact version; `git status` shows only held paths; the report states whether `ignore-scripts=true` is set, and if the toolchain needs a script, which package and why (stop; do not weaken it).

### T1 Bridge: static serving and CSP
Serve a built SPA from `CHATTER_BRIDGE_STATIC_DIR` at `/`, zero dependencies, no change to anything else. Tests first: write them, watch them fail, then implement.
- Config: a `staticDir` option on `createBridge` and the `CHATTER_BRIDGE_STATIC_DIR` environment variable in `bridge/bin/chatter-bridge.js` (help text and README table too). If set but not a directory containing `index.html`, fail at startup with a clear message. If unset, behaviour is byte-identical to today.
- Routing: `/healthz` and `/v1/*` are handled first, exactly as today. Static handling applies only to `GET` and `HEAD` on other paths. A `/v1/*` path that does not match a route stays a JSON 404.
- Resolving a path: percent-decode once and reject invalid encoding (400); reject NUL, backslash and `..` after normalisation; any segment starting with `.` is a 404; resolve with `fs.realpath` and require the result inside `realpath(staticDir)` (symlink escape is a 404); only regular files (no directory listing; `/` maps to `index.html`).
- SPA fallback: only when the path has no file extension, the request `Accept` includes `text/html`, and the path is not `/healthz` or under `/v1`. A missing path that has an extension, such as `/assets/x.js`, is a 404, never `index.html`.
- Headers on every static response, including the fallback: the D15 CSP exactly as written, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, a correct `Content-Type` (html, js, mjs, css, json, svg, png, ico, webmanifest, woff2, txt; anything else `application/octet-stream`), `Content-Length`. `Cache-Control: no-cache` for `index.html` and the fallback, `public, max-age=31536000, immutable` under `/assets/`, `no-cache` otherwise. `HEAD` returns headers without a body. Stream files with errors handled; never log tokens or full request headers.
- Tests (`bridge/test/static.test.js`, `node:test`): every rule above, plus encoded and double-encoded traversal, symlink to a file and to a directory outside the root, dotfiles, directory request, `HEAD`, content types, cache headers, and that `/v1/*` and `/healthz` behave as before. `makeEnv` in `helpers.js` gains a `staticDir` option, used by the integration cases and later by T4.
- Done when, with pasted output: the new tests were seen failing first; `npm test` shows the old 30 still pass plus the new ones, none skipped, with `CHATTER_JS` set. You performed each mutation and report which test went red: remove the CSP header, remove the traversal guard, remove the `realpath` check, remove the `/v1` exclusion from the fallback. `git status` shows only held paths.

## Wave 1 briefs (drafted during Wave 0; adjust at G0 if Wave 0 teaches something)

### T2 API module and state contract
Build the typed, tested client-side API layer and the state contract the views build against. No UI.
- Fixtures first. `client/scripts/record-fixtures.mjs` boots `makeEnv` from `bridge/test/helpers.js` over real Chatter (needs `CHATTER_JS`), creates an admin and members of both kinds, a seeded agent, and messages including a DM, an `@mention` and an admin `@everyone`. It records real responses for every route in SPEC §5, including the error shapes (401, 403 `everyone_admin_only`, 400, 404) and the raw bytes of an SSE session (`hello`, messages, `bye`), into `client/test/fixtures/`. Scrub tokens and absolute temp paths. Types come from these recordings and SPEC §5; where they differ the recording wins and your report says so.
- `client/src/api/`: types for every request and response; `ApiError` (status, code, message) built from `{error:{code,message}}`, and a `NetworkError`; `createApi({ baseUrl, getToken, fetch })` with one method per route. `Authorization: Bearer` is added only when `getToken()` returns a token, which is never logged, stored or put in a URL. Responses are checked at the boundary by small type guards for the shapes the UI depends on; a mismatch throws a `ProtocolError` naming the field.
- SSE over `fetch` (D13): a streaming parser that survives a chunk boundary in the middle of a line or of a multi-byte character, CRLF, multi-line `data`, comments and `retry:`; tracks the last event id; reconnects with `Last-Event-ID` and exponential backoff with full jitter (1 s base, 30 s cap, reset after a `hello`); detects a dead connection when no bytes, not even a `: ping`, arrive for about three times the server's ping interval (read the interval from `bridge/src/server.js`, do not guess); `bye revoked` stops reconnecting for good and reports `revoked`; `bye epoch` closes and reports `resync`; reports `connecting`, `open`, `reconnecting`, `closed` or `revoked`. Clock, randomness and `fetch` are injectable so tests are deterministic.
- `client/src/state/types.ts` and `fake.ts`, the store contract and a fake. The contract is what the views need and nothing more: immutable snapshots plus `subscribe`; session (unknown, signed out with an error, signed in with `me`), directory, repos and the selected repo, connection state, the conversation list (`#chat` plus DMs derived from messages), the selected conversation's messages (ordered, deduped), `hasMore`, the "new" marker position (frozen when a conversation opens), the send error, the throttled announcement text, and a stream of incoming messages for notifications. Actions: sign in, sign out, select repo, select conversation, send, load older, mark read. Write it so it can be implemented without changing it. The fake is deterministic, seeded from the fixtures, supports the same actions, and refuses a non-admin's `@everyone` the way the bridge does so view tests can show the error.
- Done when, with pasted output: fixtures regenerate from a clean run and a grep proves no `cb_` token string and no temp path remains in them; the guards and parser pass fixture-driven tests; SSE tests cover chunk splits, resume, backoff and reset, dead-connection detection, `revoked`, `epoch` and abort; `npm test` and `typecheck` pass; no UI code; nothing outside held paths changed. The report lists every place the live recording differed from SPEC §5.

### T3 Design system and shell
Build the visual and structural base the views plug into. It is store-agnostic: it does not use T2's contract, and components take props. Follow `docs/ui-contract.md` sections 1, 2, 4 (Settings), 5, 6 and 7.
- `client/src/styles/`: tokens as CSS custom properties for `light`, `dark` and `hc`, with the default chosen from `prefers-color-scheme`, `prefers-contrast: more` and `forced-colors`; `prefers-reduced-motion: reduce` removes every transition and animation; plain CSS for base, layout and components; rem units, reflow at 320 CSS px, 24 px minimum targets, a 3 px focus ring.
- `client/src/features/shell/`: skip links; the header (name, repository `select`, connection `status`, member identity with kind badge, Settings button); primary navigation with `aria-current`; a `Dialog` primitive (modal, named, focus moves in, Tab and Shift+Tab stay inside, Escape closes, focus returns to the opener); the Settings dialog (theme select, with the notification controls rendered but their state and handlers passed in as props); the sign-in view (token field, button, error `alert`); a theme manager that sets `data-theme` and remembers the choice, with every storage access in try/catch and the token never stored.
- `client/src/features/index.ts` is the view registry (id, label, admin only, component) with stub views that render only their h1. `client/src/app.tsx` and `src/main.tsx` compose the shell from props. T10 connects the store; do not invent one.
- Tests (Vitest, jsdom, role and name queries from the contract): landmarks, skip links and tab order; `aria-current`; Dialog focus trap, Escape and focus return; the theme manager, including storage failing; the sign-in form submitting on Enter and showing its error; axe structural rules clean in every shell state; a token contrast test that parses `tokens.css` and asserts WCAG ratios (4.5:1 text, 3:1 UI components and focus ring) for every declared foreground and background pair in each theme.
- Done when, with pasted output: those tests pass; `npm run build` and `npm run check:dist` pass; no `style=` attribute and no colour-only state anywhere; nothing outside held paths changed. State what you could not verify without a real browser; the integration E2E will check it.

### T4 E2E harness and blind gate specs
You write the certifying tests, so you must not read or write any UI source. Work from `docs/SPEC.md`, `CLAUDE.md` (the gate), `docs/ui-contract.md` and the bridge. The UI does not exist yet, so feature specs fail until T10; that is expected. Do not edit the contract: if it is ambiguous or untestable, stop and report.
- Harness (`client/playwright.config.ts`, `client/e2e/**`): a `globalSetup` that builds the client (`vite build`) and boots `makeEnv({ staticDir, pollMs: 50 })` from `bridge/test/helpers.js` over real Chatter (needs `CHATTER_JS`) on port 0, so the bridge serves the built `client/dist` and the CSP and static route are exercised. Members: the admin `flan`, three non-admins of both kinds (two human, one computational), and a seeded agent. Pass the base URL, tokens and Chatter DB path to the workers through the environment. One Chromium project, `retries: 0`, traces on failure, web-first assertions only and no fixed sleeps.
- Shared fixtures: `signIn(page, token)` through the contract's label and button; helpers for several browser contexts; a console and `securitypolicyviolation` collector that fails any test with a CSP violation; a token-hygiene check (the member's token is absent from every requested URL, all console output, `localStorage`, `sessionStorage`, IndexedDB and the page HTML, except inside the admin's "New token" dialog); a pointer-event tripwire for keyboard-only runs.
- Specs, each named for the gate line or SPEC section it certifies: (1) two members in separate contexts exchange messages through the real bridge and Chatter, with delivery time logged and a generous timeout (the 2 s figure is "proposed, not agreed"); (2) a DM between two members is invisible to a non-admin third member in the UI and through the API, while the admin sees it labelled "Admin view"; (3) a non-admin's `@everyone` shows the "Send error" alert with the bridge's message, keeps the draft, shows nothing in the feed and leaves Chatter's message count unchanged (read the DB read-only); (4) the main flow by keyboard alone (sign in, skip link, repository select, compose with @-completion by keys, send, read it back, Board, Admin) under the tripwire; (5) axe (`wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`) on sign-in, Chat, Board, Members, Admin, Settings and an open dialog in light, dark and high-contrast, failing on serious or critical, and reduced motion removing transitions; (6) message bodies containing HTML, script tags and URLs render as literal text and run nothing; (7) tailnet-identity mode: a second bridge with `trustTailscale` and a stub `whois`, requests carrying the identity headers, no token form shown; (8) a revoked member's open stream ends with "Access revoked" and the page stops reconnecting (count `/stream` requests); (9) losing and regaining the connection shows Offline then Online and the missed messages arrive in order. Try Playwright's offline emulation first for (9) and say plainly if it cannot break an in-flight stream.
- A smoke spec that passes against the T0 placeholder: the page loads from the bridge, no CSP violation, `/healthz` answers.
- Done when, with pasted output: the smoke spec is green; every other spec runs to a meaningful failure at an expected selector (not a harness error) against the placeholder; `playwright test --list` shows them all; each spec cites the gate line or SPEC section it certifies; nothing outside held paths changed. The report lists every contract line you found ambiguous or untestable.

## Waves 2 to 4 (outline; briefed at the gate before each)
- **T5** `/v1/me` probe, token form on 401, directory and repos, per-repo cursors, dedupe by id, gap-tolerant, resume after reconnect, epoch resync, read pointer only moves forward, failed sends surface the bridge's error, own message visible even if the stream lags.
- **T8** feed, composer, DMs, repo switcher exactly as the UI contract describes; HTML in a body renders literally.
- **T7** admin members and audit; token shown once, never stored or logged; dialogs per the contract.
- **T6, T9** read-only board, member list with kind badges; notifications for mentions of the member and DMs to the member only.
- **T10** wire everything through the registry, run the gate scenarios, then my mutation checks.

## Dispatch and acceptance notes
- The harness builds executor worktrees from `main`, not from `m3-client`. Every prompt therefore begins with Step 0: confirm `git log -1 --format=%H` equals the BASE, else `git merge --ff-only m3-client`.
- Executors do not commit. After acceptance I commit in the worktree with the harness trailer, then merge into `m3-client` (`--ff-only` if the branch has not moved, else cherry-pick the one commit).
- Acceptance per task: `checkpoint-verification` (call-sites and the real runtime path), then `convention-commit-gate` (constants rather than literals, no suppressions, existing patterns). An executor's report is a hint, not evidence.
- G0 and G2 follow `adversarial-review-to-go` with the diff template. Codex runs read-only, so it proposes seeded mutations by reading and I execute them.

## Test strategy
- **Bridge** (`node:test`, real Chatter): static and CSP, tests first; the existing 30 untouched.
- **Client unit** (Vitest): SSE parsing, backoff, resume and bye handling; merge, dedupe, gaps; grouping and day separators; new marker; mention parsing; notification gating; plain-text rendering.
- **E2E** (Playwright, headless Chromium, built `client/dist` served by the bridge over real Chatter): the four gate scenarios; axe in light, dark and high-contrast; CSP-violation guard; token-hygiene guard. The 2 s delivery figure is "proposed, not agreed" (SPEC §1): it is a timeout, not an acceptance claim.
- **Independence:** the E2E specs are written by an agent that writes none of the UI. I run these mutation checks myself, and each must turn its spec red: break `canSee` (DM spec), drop the `@everyone` rule (refusal spec), drop the CSP (CSP guard).
- Orca checks stay manual (M6).

## Risks
- The browser pin may not match the cached Chromium (T0 verifies; no download without Flan).
- Codex quota and sandbox behaviour are unverified; ping before G0; fallback is a fresh Opus subagent, and I tell Flan.
- The E2E gate can only go green at T10, so integration risk concentrates there; the fake store and the UI contract are how W2 and W3 reduce it.
- The `@`-completion combobox is the hardest accessibility piece; Orca checks are manual (M6).
- `client/dist` is gitignored (F14): M5 must add the build to packaging and the systemd unit.
