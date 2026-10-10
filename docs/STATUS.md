**Updated:** 2026-10-09 · baseline 30 pass / 0 fail on `2e09e44` (Node 22.16.0, Chatter 0.19.0 at `0edc18f`, `CHATTER_JS` set)

## Where we are
- Phase: M3 (web client core), docs committed, Wave 0 not yet dispatched.
- Branch: `m3-client` (from `main` at `2e09e44`), not pushed. Nothing is pushed without Flan's go-ahead.
- Agreed 2026-10-09: go; `/brief` and `/role` deferred (Q2); Claude subagents code, Codex reviews read-only; run to the M3 gate; up to 3 executors at once.

## In flight
Nothing dispatched yet.

## Open warnings
- Codex quota and sandbox behaviour are unverified (ping before G0; fallback is a fresh Opus subagent and Flan is told).
- Playwright pin unverified: local evidence says 1.62.1 maps to Chromium 1234 (cached). T0 must confirm publish date at or before 2026-09-25 and that it launches without a download.

## Debt
1. `/brief` and `/role` are out of M3 (Q2); they need new bridge routes and `chatter brief --json` verified first.
2. `idb` joins in M4. `client/dist` is gitignored (F14): M5 packaging and the systemd unit must build it.
3. Still open from CLAUDE.md: D11, D9, Prime Agent identity, live-pane delivery needs a real Herdr.

## Next
Create worktrees from `m3-client` and dispatch T0 (Sonnet) and T1 (Opus) in parallel; record both runs here with BASE sha, agent id and where the result lands.
