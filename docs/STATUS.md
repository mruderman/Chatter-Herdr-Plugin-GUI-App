**Updated:** 2026-10-10 · `m3-client` with T0, T1, T1b and T2 merged; `npm test` 59 pass; client: typecheck clean, 255 tests pass with real Chatter (250 plus 5 skips without `CHATTER_JS`) · G0 in round 3, Wave 1: T3 and T4 running, T2b queued

## Where we are
- Phase: M3 (web client core). Done: T0 `d7ceb1f`, T1 `616ccb9`, T1b `35a7315`, T2 (see `git log`). Open: G0 (T1c, then Codex round 3) and G1 (needs T2b, T3, T4). Running: T1c, T3, T4.
- Branch: `m3-client` (from `main` at `2e09e44`), not pushed. Nothing is pushed without Flan's go-ahead.
- Agreed 2026-10-09: go; `/brief` and `/role` deferred (Q2); Claude subagents code, Codex reviews read-only; run to the M3 gate; up to 3 executors at once.
- Wave 1 started before G0 fully closed, on purpose: T1b only hardened edge cases of the static server (symlink escapes, response framing), not the surface Wave 1 consumes (CSP, headers, SPA fallback). G1 cannot close before G0 does.

## In flight
All run in the background; each completion notice returns to this session. Worktrees are under `.claude/worktrees/`; `git worktree list` shows them (T2 and T4 at BASE `2c60253`, T3 at `a2adec9`).

| Task | Executor | Holds | When it lands |
|---|---|---|---|
| T1c static follow-ups, round 2 (Codex round 2 on `35a7315`: 1 Medium, `EACCES` on `lstat` treated as missing; 1 Low, empty-file closure not counted; both valid; brief in the plan) | Sonnet, running (BASE `8d47613`) | `bridge/src/static.js`, `bridge/test/static.test.js` | rerun tests, my reproductions and all mutation sets (`mutate-t1*.sh`, add the new ones); commit; cherry-pick; Codex round 3 on the patched sites (GO means zero surviving findings; curve so far 4, then 2) |
| T2b store contract amendments at G1 (rulings from my review of T2: alphabetical observed DM labels, burst-across-conversations text, `refreshDirectory()`, 403 start state; brief in the plan) | Sonnet, queued: dispatch when a slot frees (width 3) | `client/src/state/types.ts`, `fake.ts`, `fake.test.ts` | typecheck and tests green; no PROVISIONAL text left; then G1 can freeze the contract once T3 and T4 have landed too |
| T4 E2E harness and blind gate specs | Opus, blind to UI source | `client/e2e/**`, `client/playwright.config.ts` | smoke green; every other spec fails at an expected selector; read the specs for tautologies; the mutation checks come at T10 |
| T3 design system and shell | Sonnet, running (BASE `a2adec9`) | `client/src/styles/**`, `features/shell/**`, `features/index.ts`, `app.tsx`, `main.tsx`, `test/toolchain.test.tsx` (retarget only) | on landing: run its tests, build, check:dist; look at the shell in a real browser (axe per theme); check the contrast assertions against `tokens.css` |

Leftover finished worktrees (T0 and T1) stay until the milestone ends; their commits are already cherry-picked.

## For Flan (surfaced, with a default I am applying; none blocks the client)
- **F15 (proposed number), bridge visibility:** `GET /v1/repos/{key}/board` returns every agent's `repo_root` and `cwd` (host paths) to every member, while `/v1/repos` hides `repo_root` from non-admins. Recommended default: redact those two fields for non-admins in the bridge (a visibility-policy change, so a test that fails without it), as a small follow-up bridge task; the client already drops them and renders none. Say if you would rather leave the bridge as is.
- Smaller bridge observations from T2's recordings, left as they are: agents' times on `/board` are Chatter's zoneless strings (the client converts them to ISO with `Z`); the send result's `id` can be null; `max_id` counts rows the member cannot see (a client must not infer gaps from it); there is no directory-refresh route (handled client-side by `refreshDirectory()`); the read pointer is one per repo, so marking one conversation read also passes older DMs in other conversations. All follow from SPEC section 5 and the bridge's design.

## Open warnings
- Codex: ping and one real review work under `--sandbox read-only`; round 1 found 3 Medium plus 1 Low, all reproduced. Round 2 is the next use. Fallback is a fresh Opus subagent and Flan is told.
- Accepted for now, revisit on 2026-10-14: `source-map-js` 1.2.1 has a high advisory (GHSA-68fv-2mgg-jv7q; build and test time only; not in `dist`). The fix 1.2.2 was published 2026-09-30; once it is 14 days old add an `overrides` pin, regenerate the lockfile and rerun `docs/dependencies.md`.
- Brand-new majors pinned (TypeScript 7.0.2, Vite 8.3.1, Vitest 5.0.1, jsdom 29.1.1): all work today; older lines are untried fallbacks if a task hits a toolchain bug.
- The hand-back call can be refused ("only the auto-mode classifier can allow SubagentHandback"). Executors also write `.executor-report.md` in their worktree (git-excluded); if a report does not arrive, parse the transcript under `/tmp/claude-1000/.../tasks/`.
- The harness builds executor worktrees from `main`, not `m3-client`; every prompt starts with Step 0 and I also fast-forward each new worktree myself. The worktree isolation guard rejects some compound shell commands; executors use plain single commands.
- If a hook refuses an executor's write again: stop, tell Flan, never work around it.

## Debt
1. `/brief` and `/role` are out of M3 (Q2); they need new bridge routes and `chatter brief --json` verified first.
2. `idb` joins in M4. `client/dist` is gitignored (F14): M5 packaging and the systemd unit must build it, and must restart the bridge after a deploy that re-points a symlinked static directory (the root's realpath is resolved once at startup).
3. Still open from CLAUDE.md: D11, D9, Prime Agent identity, live-pane delivery needs a real Herdr.
4. A test-hygiene smell in `static.test.js`: when `createBridge` throws in a setup, the runner hangs (seen only under mutation S2). Not fixed.

## Next
As each of T1b, T2 and T4 lands: accept it (checkpoint verification, convention gate), commit and cherry-pick. When T1b lands, dispatch T3 into the freed slot and run Codex round 2. G1 (types against live responses, UI contract frozen) closes Wave 1; then Wave 2 (T5, T8, T7).
