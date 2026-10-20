**Updated:** 2026-10-20 14:30 PDT · branch `main` (deploy-verify merged and deleted) · **The deploy-and-verify slice is closed (V6) and its gate passes.** M3 is done. The MVP's last step is V7, the production install, which needs Flan's explicit go-ahead and a window. M4 and M5 are planned and await approval.

The running log of the slice (every task, review round and decision, with evidence) is `docs/history/deploy-verify-status-log.md`; M3's is `docs/history/m3-status-log.md`.

## Gate of `docs/plans/deploy-verify.md`, on the final tree `45f609d` (all runs by the coordinator unless named)
| Item | Result | Evidence |
| --- | --- | --- |
| Closing check (`docs/review/final-check.py`, on `14fa891` plus T24's own runs) | pass | typecheck clean; client unit 1737 of 1737 (59 files); root `npm test` 268 pass, 0 skipped; build and `check:dist` OK; E2E 87 passed (the one ✘ is the `test.fail()` canary); gate mutations (break `canSee`, drop the `@everyone` rule, drop the CSP) each red in their named spec |
| V1, V2: unit and runbook from a clean directory | pass, with 7 runbook fixes | Executor V6b, sandbox `~/.chatter-gui-test/v6b-CuAy`: a fresh clone of `45f609d` under a throwaway `HOME` followed `docs/runbooks/deploy.md` to a signed-in page in headless Chromium (screenshots kept there); upgrade and rollback by hand; state dir 0700, `bridge.db` 0600. Runbook gaps found and fixed (see below). Not run: systemd itself (V2 forbids installing the unit on the laptop; `systemd-analyze --user verify` exits 0), `tailscale serve`, Tailscale sign-in |
| V3: real-Herdr smoke (`deploy/smoke/real-herdr-smoke.mjs`, production-identical Chatter) | pass, 21 of 21 rows | exit 0, 2026-10-18 23:30; 7a, 7b and 8 (F17) pass; the real Herdr directories hashed `8bbe8cb87b15fac8` before and after; no herdr process left; log `~/.chatter-gui-test/logs/smoke-1018-2330.md` |
| V4a: Claude Code and Codex CLI through the skill | pass | 2026-10-14, `docs/runbooks/agent-run.md` |
| V4b: Letta Code and Prime Agent | **unverified, by decision** | Flan, 2026-10-18: close V4 with these marked unverified; the reason is that a model login for each harness is Flan's to do and was not done (the isolated Letta home is empty). Runs after the MVP, never against `baremetalcyansociety` or its agents (D22) |
| V5: exploratory GUI pass | pass, all 10 findings fixed | T17 to T23; the guards are in `client/e2e/explore-*` |
| No boundary break open | pass | F17 closed (T16, T16b, Codex round 8); no open hard-boundary finding |

## Landed since the last STATUS (2026-10-16)
- **Pending-spec setup removed (2026-10-20, coordinator).** All ten V5 reproductions are guards in `client/e2e/`, so `client/playwright.pending.config.ts`, the `e2e:pending` script and the `e2e-pending` entries of `tsconfig.json` are gone; `docs/runbooks/exploratory-pass.md` says all ten are fixed (finding 5 marked), and `docs/ui-contract.md` has T23's History row and no longer lists the marker and "Load older messages" as uncovered. Checked on the result: typecheck clean, client unit 1737 of 1737, E2E 87 of 87 (27 files; the one ✘ is the canary), root 268 of 268.
- **T23 ACCEPTED (`14fa891`, V5 finding 5; Sonnet).** One press of "Load older messages" in a DM pages back until a message of that DM arrives, at most 10 pages or 1,000 messages, then says how far it looked. I read the store, repo-sync and feed diffs. **My 7 mutations:** 5 red (DM never sought; bound read before the found check; bound far too wide; the store not passing the conversation; no busy announcement). 2 survived: dropping the store-side check of the notice's conversation is an equivalent mutant (the render checks the key again); dropping the run check before each request survives because no test switches repository or epoch between two pages, so one extra GET for the old repository would go out and its answer be dropped (Debt, below).
- **T24 ACCEPTED (`45f609d`, Flan 2026-10-18: "fix before production"; Sonnet).** The bridge creates a missing state directory 0700 (every level), creates `bridge.db` 0600 before SQLite opens it, and forces `bridge.db`, `-wal` and `-shm` to 0600 on every open; an existing directory is never chmodded (it may be shared through `CHATTER_BRIDGE_STATE_DIR`) and is warned about on stderr when others can read it. 6 tests, 4 red on the old code; **my 5 mutations each red**; root 268. Executor's notes, accepted: the warning repeats on every CLI command against such a directory; a too-open parent directory is not warned about.
- **F15 was already closed** at `d12b7ad` (2026-10-11): the board rebuilds a non-admin's agent rows from an allowlist of non-path keys, with an integration test. The old STATUS still listed it as open.
- **`AGENTS.md`** is already a short pointer to `CLAUDE.md`, committed at `0f2a210`; the old STATUS still asked about it.
- **Runbook fixes from V6b** (`docs/runbooks/deploy.md`, `deploy/chatter-bridge.env.example`): `CHATTER_CMD`'s JSON example names node by absolute path (a bare `node` found `/usr/bin/node` 18 under the unit's PATH and `/healthz` answered 502); build with `NODE_ENV` unset (`env -u NODE_ENV ...`; with `production`, `npm ci` skips the dev dependencies); how the admin gets a token for sign-in without Tailscale, and to send printed tokens to a mode-600 file; check the node versions, since `systemd-analyze verify` does not; what a 502 `chatter_error` means; the dynamic-import grep limited to `bridge/src bridge/bin` (re-run: only the two JSDoc comments); rollback's `ln -s` takes the bare revision name.
- **Environment note for whoever runs the suites through Desktop Commander:** its shell sets `NODE_ENV=production`, which makes Vitest resolve `node:fs` as a browser external and fail 8 client test files (`No such built-in module: node:`). Unset it.

## Waiting for Flan
1. **V7, the production install** (`docs/runbooks/deploy.md` section 11, the checklist): your explicit go-ahead and a window. Nothing has been installed, started or changed on `baremetalcyansociety`. Read-only checks first, as before.
2. **M4 plan** (`docs/plans/m4-archive.md`): approve or change; eight decisions P1 to P8, each with a recommended default.
3. **M5 plan** (`docs/plans/m5-pwa.md`): approve or change; six decisions Q1 to Q6 (Q2 amends SPEC sections 9 and 11).
4. **V4b, after the MVP:** a model login for Letta Code (`--backend local`, `HOME=~/.chatter-gui-test/letta-home`) and Prime Agent, in your own terminal; then I build the V4b runner.
5. **Name collisions** (a handle that is the start of an agent's name; detail in the slice log, "For Flan"): default is to leave it and consider an add-time refusal in M4.

## Unverified (not shown by any test or run)
Letta Code and Prime Agent members (V4b); systemd running the unit, its hardening, lingering; `tailscale serve`, `tailscale whois` and human Tailscale sign-in; the tailnet origin; screen readers (Orca); Firefox and Safari; a real OS notification; Wayland scaling and forced colours; Herdr 0.9.3 itself (the smoke ran 0.9.1, same protocol 22); real agent harnesses receiving pane deliveries (the smoke uses dummy panes).

## Debt (open, none a hard-boundary break; full evidence in the slice log)
- T23: no test that a repository or epoch switch between two pages of a DM search asks no further page (one superfluous GET today).
- T22: a mention in a right-to-left message renders as "bo@" (bidi; needs `<bdi>`, which the one-text-node rule forbids); a day heading seen clipped once above "New messages", not reproduced.
- T21: long recipient names clip in the closed select; the 48rem breakpoint follows the browser's default font size.
- T20: a hung rotation call delays a session end; a moment of "Offline" after an own rotation; a send racing an own rotation is not retried.
- Round 8: timeout test with a wrapper executable; no `ok` to `unknown` status change inside the lock; ordering test observes `host.run` entry.
- G2 rounds 6 and 7: the member client accepts a JSON array as a successful answer; send-order test observes `host.run` entry; JSON `null` bodies answer 500; send and audit not atomic; and the smaller items listed in the slice log.
- V1/V2: `bridge.db` is WAL (stop before copying, in the runbook); a release holds only the client (the runbook says to check out the matching commit).
- Cosmetic: console 401 lines, a constant page title, raw `in_progress` and "none" on the Board.
- `static.test.js` hangs when `createBridge` throws in a setup (seen only under a mutation).

## Next
1. V7 on Flan's go-ahead: install from `docs/runbooks/deploy.md` section 11 as `letta`, read-only against the real state first; then the MVP is live.
2. M4 and M5 once their plans are approved; V4b once the logins exist; M6 (Flan's manual checklist, SPEC section 11).

## Pointers
`docs/plans/deploy-verify.md`, `docs/plans/m4-archive.md`, `docs/plans/m5-pwa.md`, `docs/SPEC.md`, `docs/ui-contract.md`, `docs/working-agreement.md`, `docs/runbooks/` (deploy, real-Herdr smoke, agent run, Herdr test environment, exploratory pass, production-identical Chatter), `docs/review/`, `docs/history/`.
