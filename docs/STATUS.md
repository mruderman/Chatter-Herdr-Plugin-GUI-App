**Updated:** 2026-10-10 · `m3-client` with T0, T1, T1b, T1c, T1d, T2, T2b, T3 and T4 merged; `npm test` 83 pass / 0 fail / 0 skipped; client typecheck clean, 435 unit tests pass, build and check:dist green · G0 and G1 closed · running: T5, T8b, T8a

## Where we are
- Phase: M3 (web client core). Done: T0, T1, T1b, T1c, T1d, T2, T2b, T3, T4 (see `git log`); G0 and G1 closed. Wave 2 running: T5 (real store), T8b (composer), T8a (conversations and feed). Queued for free slots: T7 (admin), T6 (board and members), T9 (notifications); T10 (integration and the gate) after them.
- Branch: `m3-client` (from `main` at `2e09e44`), not pushed. Nothing is pushed without Flan's go-ahead.
- Agreed 2026-10-09: go; `/brief` and `/role` deferred (Q2); Claude subagents code, Codex reviews read-only; run to the M3 gate; up to 3 executors at once.
- Wave 1 started before G0 fully closed, on purpose: T1b only hardened edge cases of the static server (symlink escapes, response framing), not the surface Wave 1 consumes (CSP, headers, SPA fallback). G1 cannot close before G0 does.

## In flight
All run in the background; each completion notice returns to this session. Worktrees are under `.claude/worktrees/`; `git worktree list` shows them (T2 and T4 at BASE `2c60253`, T3 at `a2adec9`).

| Task | Executor | Holds | When it lands |
|---|---|---|---|
| T5 session and sync, the real store (brief in the plan; the fake store is the behavioural reference; streams for every non-orphan repo up to 8) | Opus, running (BASE `2ef5be0`) | new files under `client/src/state/` (not `types.ts`, `fake.ts`, `fake.test.ts`) | typecheck, unit and real-bridge integration tests green; read `store.ts` and the conformance suite myself; my own mutation spot-checks; commit; cherry-pick |
| T8b composer and mention suggestions (brief in the plan; follows the UI contract section 8) | Opus, running (BASE `aafb18a`) | `client/src/features/chat/composer/**` | tests, build, check:dist, the agent's real-browser axe results; I read the combobox code; mutation spot-checks; commit; cherry-pick |
| T8a conversations and feed, announcements, `ChatView` (brief in the plan) | Opus, running (BASE `086ba15`) | `client/src/features/chat/{conversations,feed,announcements}/**`, `ChatView.tsx`, `index.ts` | tests, build, check:dist, the agent's real-browser axe and scroll results; I read the feed code; mutation spot-checks; commit; cherry-pick |

Leftover finished worktrees (T0 and T1) stay until the milestone ends; their commits are already cherry-picked.

## For Flan (surfaced, with a default I am applying; none blocks the client)
- **F15 (proposed number), bridge visibility:** `GET /v1/repos/{key}/board` returns every agent's `repo_root` and `cwd` (host paths) to every member, while `/v1/repos` hides `repo_root` from non-admins. Recommended default: redact those two fields for non-admins in the bridge (a visibility-policy change, so a test that fails without it), as a small follow-up bridge task; the client already drops them and renders none. Say if you would rather leave the bridge as is.
- Smaller bridge observations from T2's recordings, left as they are: agents' times on `/board` are Chatter's zoneless strings (the client converts them to ISO with `Z`); the send result's `id` can be null; `max_id` counts rows the member cannot see (a client must not infer gaps from it); there is no directory-refresh route (handled client-side by `refreshDirectory()`); the read pointer is one per repo, so marking one conversation read also passes older DMs in other conversations. All follow from SPEC section 5 and the bridge's design.

## Carried to T10 (from T4's report and my review)
- Only the "drop the CSP" mutation can turn a spec red today. "Break `canSee`" and "drop the `@everyone` rule" cannot show anything until the real UI exists, because those specs fail at sign-in now. Do not read "still red" as "caught" at G1; run the three mutations at T10 against the integrated UI and require each to flip its named spec.
- T4's specs use tolerant selectors where the contract was ambiguous; the rulings are now in `docs/ui-contract.md` section 8, so T10 may tighten them. E2E does not cover announcements, the "New messages" marker, day separators, "Load older messages", Board and Members contents, or 200% text; unit tests with the fake store carry those. Add E2E for any of them if time allows (day separators need rows with older timestamps, which only a direct write to the scratch Chatter database can seed; `seedAgent` in the test helpers already sets that precedent).
- T4's specs read Chatter's table directly (`countChatterRows`); the harness world is: admin `flan`, humans `hana` and `ivo`, computational `kai`, agent `codex`, repos "main" and "sidecar".

## Carried from T3 to T10 (integration)
- T3's shell takes `ShellSession`, `RepoOption` and `ShellMember` props; T10 maps the store onto them, passes T9's `notifications` prop, and supplies the real views through the registry (T3's `features/index.ts`).
- `app.tsx` known limitation: on a re-sign-in in the same page the previously open view mounts for one commit before the reset to Chat; once T6/T7 fetch on mount that would fire one wasted request. Fix at T10: hold the view choice with a per-sign-in counter so the reset happens during render.
- T4's `a11y.spec.ts` asserts `data-theme` is set under media emulation, but the ruling (UI contract section 8, T3 implemented it) is that System mode sets no attribute. Change the soft assertion to read a computed style per theme, or run the dark and high-contrast scans through Settings so the attribute is set. T4 emulates high contrast with `contrast: more`, which axe can evaluate; forced-colors contrast stays unverified.
- Unverified by T3 and still open: real screen readers (Orca, M6), Firefox and Safari behaviour, any flash of a stored theme before the app runs.
- Vite 8's Lightning CSS adds `--lightningcss-*` custom properties and shortens `#000000` to `#000`; an E2E that reads a token value must normalise.

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
