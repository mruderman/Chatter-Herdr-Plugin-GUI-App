**Updated:** 2026-10-10 · `m3-client` at `616ccb9` (docs plus the static server); `npm test` there 54 pass / 0 fail / 0 skipped · Wave 0: T1 Done, T0 and the G0 review running

## Where we are
- Phase: M3 (web client core), Wave 0. T1 is Done and merged. G0 needs T0, the Codex review of T1, and my re-check of T0's dependency table.
- Branch: `m3-client` (from `main` at `2e09e44`), not pushed. Nothing is pushed without Flan's go-ahead.
- Agreed 2026-10-09: go; `/brief` and `/role` deferred (Q2); Claude subagents code, Codex reviews read-only; run to the M3 gate; up to 3 executors at once.
- Subagent writes verified 2026-10-10 after Flan disabled the `waterfall` plugin and reloaded plugins twice (probe file landed).

## In flight
| Task | State | Executor | Where | When it lands |
|---|---|---|---|---|
| T0 scaffold and deps | Finished and cherry-picked at `d7ceb1f`; acceptance still open: clean `npm ci` plus every check from `m3-client`, and the real-browser CSP load | Sonnet subagent, finished | worktree under `.claude/worktrees/` (now only a leftover) | finish my checks; if one fails, fix forward or revert before Wave 1 |
| T1b static follow-ups | dispatching now (see below for the run) | Opus subagent | worktree under `.claude/worktrees/`, holds `bridge/src/static.js` and `bridge/test/static.test.js` | verify (tests, reproductions rerun, mutations), commit, cherry-pick, then Codex round 2 on the patched sites |

Done: T1 at `616ccb9`. Evidence: I reran the 54 tests; read `static.js` in full; drove the real CLI and curl (21 probes: nothing outside the root served, CSP byte-exact on every static response, API and `/healthz` untouched, bad dirs refused at startup); reran the four required mutations plus two extras on a scratch copy (15, 1, 1, 1, 1, 1 failing tests).

## G0 progress (2026-10-10)
- T0 committed and cherry-picked at `d7ceb1f`. My checks so far: footprint inside held paths; all 209 lockfile name@version pairs published before 2026-09-25 (newest `electron-to-chromium@1.5.439`, 2026-09-24); 12 of 12 direct deps exact pins; registry sources and integrity everywhere; `fsevents` (darwin-only) the only install script; engines floor corrected to Node 22.13. Still to do: clean `npm ci` and every check from `m3-client`, and a real browser load of the built page through the bridge's CSP.
- Codex round 1 on `616ccb9`: 3 Medium plus 1 Low coverage finding; I reproduced all of them on the real CLI. Decisions are in the plan (T1b): patch the escape-symlink fallback, the Content-Length framing and the descriptor-closure test gap; do not patch the dot-segment normalisation point. Of Codex's 17 proposed mutations 16 are caught; `sendFile` not closing its handle is the unguarded one.
- Accepted for now, revisit: `source-map-js` 1.2.1 has a high advisory (GHSA-68fv-2mgg-jv7q, build and test time only, not in `dist`); the fix 1.2.2 was published 2026-09-30 and becomes eligible under the two-week rule on 2026-10-14, then add an `overrides` pin and rerun `docs/dependencies.md`.

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
