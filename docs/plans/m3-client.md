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
- Scripts: `dev`, `build`, `typecheck`, `test` (Vitest, with one toolchain test that renders a Preact component into the test DOM), `e2e`, `check:dist` (fails on inline script bodies, inline `<style>`, `style=` attributes, `on*=` handlers or any foreign-origin URL in `dist/index.html`). Root `package.json` gets only `client:build`, `client:test`, `client:e2e` that run `npm --prefix client run ...`. Root gets no dependencies and `npm test` stays the bridge's. Root `.gitignore` gains `test-results/` and `playwright-report/`.
- Dependencies, and no others (no router, no state library, no ESLint, no `idb`): `preact`, `vite`, `@preact/preset-vite`, `typescript`, `vitest`, a DOM test environment (`jsdom` unless you find a reason against it), `@playwright/test`, `@axe-core/playwright`, `@types/node` if needed.
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

## Waves 1 to 4 (outline; briefed at the gate before each)
- **T2** types and fixtures recorded from a live `makeEnv` bridge (tokens scrubbed), not from SPEC prose; SSE over `fetch` with `Last-Event-ID` resume, jittered backoff, `bye revoked` stops reconnecting, `bye epoch` triggers resync; typed errors from `{error:{code,message}}`; a store interface and a fake store the views build against; unit tests for all of it.
- **T3** tokens and four themes as CSS custom properties; shell per `docs/ui-contract.md`; token form; view registry; axe clean on the shell in every theme.
- **T4** Playwright harness: `makeEnv` with real Chatter and the bridge serving built `client/dist`; an admin plus three non-admin members of both kinds; specs written from SPEC and the UI contract without reading UI code; a smoke spec that is green, feature specs red until built; a keyboard-only run with a pointer-event tripwire; an axe fixture; a CSP-violation guard; a token-hygiene guard.
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
