**Updated:** 2026-10-10 · baseline 30 pass / 0 fail on `2e09e44`; `m3-client` at `4aeda94` (docs only) · Wave 0 running

## Where we are
- Phase: M3 (web client core). Wave 0 (T0, T1) is running again after the hook block cleared.
- Branch: `m3-client` (from `main` at `2e09e44`), docs commits only so far, not pushed. Nothing is pushed without Flan's go-ahead.
- Agreed 2026-10-09: go; `/brief` and `/role` deferred (Q2); Claude subagents code, Codex reviews read-only; run to the M3 gate; up to 3 executors at once.
- Subagent writes verified 2026-10-10: after Flan disabled the `waterfall` plugin and reloaded plugins a second time, a Haiku probe wrote a scratchpad file and I confirmed the file exists.

## In flight
| Task | State | Executor | Where | When it lands |
|---|---|---|---|---|
| T0 scaffold and deps | Running: resumed 2026-10-10, completion notice returns to this session. BASE `4aeda94`. Carries the scope addition (testing-library dom and user-event, axe-core, `test/render.ts`) | Sonnet subagent, resumed | the worktree under `.claude/worktrees/` for `client/**` | verify from a clean `client/node_modules` (`npm ci`, typecheck, test, build, check:dist, `playwright test --list`, headless launch); re-check `docs/dependencies.md` with `npm view`; commit in the worktree; merge into `m3-client` |
| T1 static and CSP | Running: resumed 2026-10-10, same notice path. BASE `4aeda94`. Resumes with about 22 drafted tests and the accepted design notes | Opus subagent, resumed | the worktree under `.claude/worktrees/` for `bridge/**` | read `static.js` in full; rerun the four mutations myself; commit; merge; then G0 with Codex |

## Open warnings
- Codex: ping succeeded under `--sandbox read-only`, weekly window 4.0% used. Not yet verified: that it can read a worktree and run `git diff` there (first real use is G0). Fallback is a fresh Opus subagent and Flan is told.
- Playwright pin settled by T0's tarball check: `@playwright/test` 1.63.0 (published 2026-09-04) needs Chromium 1243, headless shell 1243 and ffmpeg 1011, all cached; fallback 1.62.1. Never run `playwright install`, not even `--dry-run`. The headless launch is not yet verified.
- The hand-back call can be refused ("only the auto-mode classifier can allow SubagentHandback: the session is not in auto mode"). Executors also write `.executor-report.md` in their worktree (git-excluded); if a report does not arrive, parse the transcript under `/tmp/claude-1000/.../tasks/`.
- The harness builds executor worktrees from `main`, not `m3-client`; every prompt starts with Step 0 (template in the plan). The worktree isolation guard also rejects some compound shell commands; executors use plain single commands.
- If a hook refuses an executor's write again: stop, tell Flan, never work around it.

## Debt
1. `/brief` and `/role` are out of M3 (Q2); they need new bridge routes and `chatter brief --json` verified first.
2. `idb` joins in M4. `client/dist` is gitignored (F14): M5 packaging and the systemd unit must build it.
3. Still open from CLAUDE.md: D11, D9, Prime Agent identity, live-pane delivery needs a real Herdr.

## Next
When T0 and T1 land: accept each (checkpoint verification, convention gate), commit and merge, then G0 (I read `static.js`; Codex reviews it read-only; I re-check the dependency table), then dispatch Wave 1 (T2, T3, T4; briefs are in the plan; the dispatch template is there too).
