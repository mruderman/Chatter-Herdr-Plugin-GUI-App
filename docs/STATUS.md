**Updated:** 2026-10-09 · baseline 30 pass / 0 fail on `2e09e44`; `m3-client` docs-only, nothing built yet · Wave 0 blocked by a hook

## Where we are
- Phase: M3 (web client core). Wave 0 (T0, T1) dispatched but nothing is built: executors cannot write files (see blocker).
- Branch: `m3-client` (from `main` at `2e09e44`), docs commits only, not pushed. Nothing is pushed without Flan's go-ahead.
- Agreed 2026-10-09: go; `/brief` and `/role` deferred (Q2); Claude subagents code, Codex reviews read-only; run to the M3 gate; up to 3 executors at once. Flan chose to disable the `waterfall` plugin to clear the blocker.

## In flight
| Task | State | Executor | Where | When it lands |
|---|---|---|---|---|
| T0 scaffold and deps | Blocked, nothing built: first Write refused by the hook. Worktree clean at `e8442ef`. Scope addition (testing-library dom and user-event, axe-core) not started | Sonnet subagent, finished | worktree under `.claude/worktrees/` for `client/**` | re-dispatch with the template in the plan |
| T1 static and CSP | Blocked, nothing built: stopped after its one Write attempt (the tests-first file) was refused by the hook; no workaround tried; worktree clean at `e8442ef`. Its design notes are saved in the plan | Opus subagent, finished (its context still holds about 22 drafted tests; resumable with SendMessage in this session once writes work) | worktree under `.claude/worktrees/` for `bridge/**` | re-dispatch or resume; then read `static.js` in full, rerun the four mutations myself, commit, merge, G0 with Codex |

## Open warnings
- BLOCKER: the `waterfall` plugin's `wf-auth.sh` hook (Step 1, fail-closed) refuses Write and Edit from every subagent type except `pm|po|tl|rv|qa|ds|dv|or`, in any project; `general-purpose` is "unknown". After Flan disabled the plugin at account level and ran `/reload-plugins`, the account's plugin list no longer showed it, but a throwaway Haiku subagent was refused with the same message (its transcript has the text; its file never landed) and the reload still reported 39 plugins and 14 hooks, unchanged. Inferred, not verified: hooks stay registered until a new session. The main session passes the hook, so docs work here.
- Verified by T0 from registry tarballs: `@playwright/test` 1.63.0 (published 2026-09-04) needs Chromium 1243, headless shell 1243 and ffmpeg 1011, all cached; fallback 1.62.1 (Chromium 1234, cached); 1.64.0 (2026-10-07) is after the cutoff. Never run `playwright install`, not even `--dry-run`. Launch not yet verified.
- Codex: ping succeeded under `--sandbox read-only`, weekly window 4.0% used. Not yet verified: that it can read a worktree and run `git diff` there (first real use is G0). Fallback is a fresh Opus subagent and Flan is told.
- The hand-back call can be refused ("only the auto-mode classifier can allow SubagentHandback: the session is not in auto mode"): T1's four attempts were. Its report was recovered by parsing its transcript under `/tmp/claude-1000/.../tasks/`. Executors now also write `.executor-report.md` in their worktree (git-excluded).
- The harness builds executor worktrees from `main`, not `m3-client`; every prompt starts with Step 0 (template in the plan). The worktree isolation guard also rejects some compound shell commands; executors use plain single commands.

## Debt
1. `/brief` and `/role` are out of M3 (Q2); they need new bridge routes and `chatter brief --json` verified first.
2. `idb` joins in M4. `client/dist` is gitignored (F14): M5 packaging and the systemd unit must build it.
3. Still open from CLAUDE.md: D11, D9, Prime Agent identity, live-pane delivery needs a real Herdr.

## Next
1. Confirm subagents can write: in a session where the hook is gone, dispatch T0. If its first Write is refused, stop and tell Flan; do not work around it.
2. Dispatch T0 and T1 from the template in `docs/plans/m3-client.md` (BASE is the current `m3-client` HEAD; first remove the clean leftover worktrees with `git worktree list`, `git worktree unlock`, `git worktree remove`, and delete their branches). T0 carries the Playwright 1.63.0 pin and the three test libraries.
3. When T0 and T1 land: accept each (checkpoint verification, convention gate), commit and merge, then G0 (I read `static.js`; Codex reviews it read-only), then dispatch Wave 1 (T2, T3, T4; briefs are in the plan).
