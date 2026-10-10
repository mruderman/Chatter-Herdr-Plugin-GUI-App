**Updated:** 2026-10-09 · baseline 30 pass / 0 fail on `2e09e44`; `m3-client` at `e8442ef` (docs only) · Wave 0 running

## Where we are
- Phase: M3 (web client core), Wave 0 running (T0 and T1).
- Branch: `m3-client` (from `main` at `2e09e44`), not pushed. Nothing is pushed without Flan's go-ahead.
- Agreed 2026-10-09: go; `/brief` and `/role` deferred (Q2); Claude subagents code, Codex reviews read-only; run to the M3 gate; up to 3 executors at once.

## In flight
| Task | State | Executor | Where | When it lands |
|---|---|---|---|---|
| T0 scaffold and deps | Blocked, nothing built: its first Write was refused by the waterfall plugin's `wf-auth` hook. Worktree clean at `e8442ef`, nothing installed. It carries the scope addition (testing-library dom and user-event, axe-core) unstarted | Sonnet subagent | the worktree under `.claude/worktrees/` that was to edit `client/**` | needs Flan's decision on the hook (see warnings); then re-dispatch or continue it |
| T1 static and CSP | Running, probably the same block ahead; told to stop and report if it is refused, with no workarounds | Opus subagent | the worktree that edits `bridge/**`, BASE `e8442ef` | if it did land: read `static.js` in full; rerun the four mutations myself; commit; merge; then G0 with Codex |

Dispatch deviation: the harness built both worktrees from `main` (`2e09e44`), so the docs were missing. I fast-forwarded both to `m3-client` by hand and messaged both agents. Every later prompt starts with Step 0 (confirm base, fast-forward).

## Open warnings
- BLOCKER, needs Flan: while the `waterfall` plugin is enabled, no subagent can Write or Edit. Its hook `wf-auth.sh` (Step 1, fail-closed) lets through only agent types `pm|po|tl|rv|qa|ds|dv|or`, in every project, and a `general-purpose` subagent is "unknown". Observed: T0's first Write refused, hook text quoted in its report. Verified by reading the hook. The main session passes (empty agent type counts as PM). No workaround was tried and none should be without Flan's say.
- Verified by T0 from registry tarballs (nothing written): `@playwright/test` 1.63.0 (published 2026-09-04) needs Chromium 1243, headless shell 1243 and ffmpeg 1011, all cached; 1.62.1 needs 1234, also cached; 1.64.0 (2026-10-07) is after the cutoff. Pin 1.63.0. Never run `playwright install`, not even `--dry-run`; check `executablePath()`, the INSTALLATION_COMPLETE markers and a headless launch instead. Not yet verified: that launch.
- The worktree isolation guard rejects some compound shell commands (`cd ... &&`, heredocs, loops piping into tar); plain single commands with absolute paths pass.
- Codex: ping succeeded under `--sandbox read-only`, weekly window 4.0% used. Not yet verified: that it can read a worktree and run `git diff` there (first real use is G0). Fallback is a fresh Opus subagent and Flan is told.

## Debt
1. `/brief` and `/role` are out of M3 (Q2); they need new bridge routes and `chatter brief --json` verified first.
2. `idb` joins in M4. `client/dist` is gitignored (F14): M5 packaging and the systemd unit must build it.
3. Still open from CLAUDE.md: D11, D9, Prime Agent identity, live-pane delivery needs a real Herdr.

## Next
When T0 and T1 land: accept each (checkpoint verification, convention gate), commit and merge, then G0 (I read `static.js`; Codex reviews it read-only), then brief and dispatch Wave 1 (T2, T3, T4).
