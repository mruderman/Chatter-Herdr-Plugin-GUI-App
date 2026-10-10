**Updated:** 2026-10-09 · baseline 30 pass / 0 fail on `2e09e44`; `m3-client` at `e8442ef` (docs only) · Wave 0 running

## Where we are
- Phase: M3 (web client core), Wave 0 running (T0 and T1).
- Branch: `m3-client` (from `main` at `2e09e44`), not pushed. Nothing is pushed without Flan's go-ahead.
- Agreed 2026-10-09: go; `/brief` and `/role` deferred (Q2); Claude subagents code, Codex reviews read-only; run to the M3 gate; up to 3 executors at once.

## In flight
| Task | State | Executor | Where | When it lands |
|---|---|---|---|---|
| T0 scaffold and deps | Running: launch confirmed, completion notice returns to this session | Sonnet subagent | the worktree under `.claude/worktrees/` that edits `client/**`, BASE `e8442ef` | verify from a clean `client/node_modules` (`npm ci`, typecheck, test, build, check:dist, `playwright test --list`); re-check `docs/dependencies.md` with `npm view`; commit in the worktree; merge into `m3-client` |
| T1 static and CSP | Running: same | Opus subagent | the worktree that edits `bridge/**`, BASE `e8442ef` | read `static.js` in full; rerun the four mutations myself; commit; merge; then G0 with Codex |

Dispatch deviation: the harness built both worktrees from `main` (`2e09e44`), so the docs were missing. I fast-forwarded both to `m3-client` by hand and messaged both agents. Every later prompt starts with Step 0 (confirm base, fast-forward).

## Open warnings
- Codex: ping succeeded under `--sandbox read-only`, weekly window 4.0% used. Not yet verified: that it can read a worktree and run `git diff` there (first real use is G0). Fallback is a fresh Opus subagent and Flan is told.
- Playwright pin unverified: local evidence says 1.62.1 maps to Chromium 1234 (cached). T0 must confirm the publish date is at or before 2026-09-25 and that it launches without a download.

## Debt
1. `/brief` and `/role` are out of M3 (Q2); they need new bridge routes and `chatter brief --json` verified first.
2. `idb` joins in M4. `client/dist` is gitignored (F14): M5 packaging and the systemd unit must build it.
3. Still open from CLAUDE.md: D11, D9, Prime Agent identity, live-pane delivery needs a real Herdr.

## Next
When T0 and T1 land: accept each (checkpoint verification, convention gate), commit and merge, then G0 (I read `static.js`; Codex reviews it read-only), then brief and dispatch Wave 1 (T2, T3, T4).
