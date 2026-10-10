**Updated:** 2026-10-10 · `m3-client` at `616ccb9` (docs plus the static server); `npm test` there 54 pass / 0 fail / 0 skipped · Wave 0: T1 Done, T0 and the G0 review running

## Where we are
- Phase: M3 (web client core), Wave 0. T1 is Done and merged. G0 needs T0, the Codex review of T1, and my re-check of T0's dependency table.
- Branch: `m3-client` (from `main` at `2e09e44`), not pushed. Nothing is pushed without Flan's go-ahead.
- Agreed 2026-10-09: go; `/brief` and `/role` deferred (Q2); Claude subagents code, Codex reviews read-only; run to the M3 gate; up to 3 executors at once.
- Subagent writes verified 2026-10-10 after Flan disabled the `waterfall` plugin and reloaded plugins twice (probe file landed).

## In flight
| Task | State | Executor | Where | When it lands |
|---|---|---|---|---|
| T0 scaffold and deps | Running: resumed 2026-10-10, completion notice returns to this session. BASE `4aeda94`. Carries the scope addition (testing-library dom and user-event, axe-core, `test/render.ts`) | Sonnet subagent, resumed | the worktree under `.claude/worktrees/` for `client/**` | verify from a clean `client/node_modules` (`npm ci`, typecheck, test, build, check:dist, `playwright test --list`, headless launch); re-check `docs/dependencies.md` with `npm view`; commit in the worktree; cherry-pick onto `m3-client` |
| G0 review of T1 | Running since 06:08 local: Codex CLI, `--sandbox read-only`, on `m3-client` at `616ccb9`; its session file exists and is active; the exit notice returns to this session | Codex | prompt `scratchpad/codex-g0/prompt.md`, answer `scratchpad/codex-g0/review.md` | re-verify every finding on the source; patch valid ones minimally; run any mutations it proposes; round 2 only if findings survive |

Done: T1 at `616ccb9`. Evidence: I reran the 54 tests; read `static.js` in full; drove the real CLI and curl (21 probes: nothing outside the root served, CSP byte-exact on every static response, API and `/healthz` untouched, bad dirs refused at startup); reran the four required mutations plus two extras on a scratch copy (15, 1, 1, 1, 1, 1 failing tests).

## Open warnings
- Codex: ping and one real review launch work under `--sandbox read-only` (weekly window was 4.0% used). Finding quality not yet seen. Fallback is a fresh Opus subagent and Flan is told.
- Playwright pin settled by T0's tarball check: `@playwright/test` 1.63.0 (published 2026-09-04) needs Chromium 1243, headless shell 1243 and ffmpeg 1011, all cached; fallback 1.62.1. Never run `playwright install`, not even `--dry-run`. The headless launch is not yet verified.
- The hand-back call can be refused ("only the auto-mode classifier can allow SubagentHandback: the session is not in auto mode"). Executors also write `.executor-report.md` in their worktree (git-excluded); if a report does not arrive, parse the transcript under `/tmp/claude-1000/.../tasks/`.
- The harness builds executor worktrees from `main`, not `m3-client`; every prompt starts with Step 0 (template in the plan). The worktree isolation guard also rejects some compound shell commands; executors use plain single commands.
- If a hook refuses an executor's write again: stop, tell Flan, never work around it.

## Debt
1. `/brief` and `/role` are out of M3 (Q2); they need new bridge routes and `chatter brief --json` verified first.
2. `idb` joins in M4. `client/dist` is gitignored (F14): M5 packaging and the systemd unit must build it, and must restart the bridge after a deploy that re-points a symlinked static directory (the root's realpath is resolved once at startup).
3. Still open from CLAUDE.md: D11, D9, Prime Agent identity, live-pane delivery needs a real Herdr.

## Next
When T0 lands: accept it (checkpoint verification, convention gate), commit and cherry-pick. When the Codex review lands: re-verify its findings on the source. Then G0 closes, and Wave 1 (T2, T3, T4) is dispatched from the briefs and template in the plan.
