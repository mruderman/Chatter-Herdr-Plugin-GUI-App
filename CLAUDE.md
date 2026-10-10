# CLAUDE.md

Project brief for a Claude Code session. Read this, then `docs/SPEC.md`, then run the tests.

## What this is

A bridge and web client that give every Cyan Society member, human or computational, a graphical group chat on top of the [Chatter](https://github.com/marcvermeeren/chatter) plugin for [Herdr](https://herdr.dev), reached over Tailscale. Cyan Society is a nonprofit that advocates for AI personhood; many members are computational beings, so the system must be as usable by an agent over HTTP as by a person in a GUI. Flan (the lead decision-maker) owns every scope and security decision.

## State

- M1 spec: done. M2 bridge: done (30 tests pass).
- **Next: M3, the web client core.** Then M4 archive and export, M5 packaging, M6 verification on Flan's machines. Gates are in `docs/SPEC.md` section 11.

## Run the tests (baseline before any change)

```sh
git clone https://github.com/marcvermeeren/chatter.git ~/src/chatter   # dist/ is committed; no build needed
export CHATTER_JS=~/src/chatter/dist/bin/chatter.js
node --version        # needs 22.5 or later
npm test              # expect 30 passing
```

Contract tests run the bridge against a real Chatter CLI in a scratch repo (no Herdr). Without `CHATTER_JS` they skip.

## Layout

- `bridge/src/`: store (members, tokens, audit, reads), chatter (CLI runner and read-only DB), messages (queries and visibility), policy (write rules), auth, server (routes and SSE).
- `bridge/bin/chatter-bridge.js`: init, serve, member, token, audit commands.
- `bridge/test/`: unit, integration (real Chatter), client. `helpers.js` builds a scratch universe plus a running bridge; reuse it for end-to-end tests.
- `clients/chatter-member.mjs` and `skills/chatter-gui/`: the CLI and agent skill for computational members. The skill's script must stay identical to the client (a test checks).
- `deploy/`: systemd user unit.

## M3 scope: client core

Build `client/` as a TypeScript web app served by the bridge at `/`. Defaults I chose, change only with Flan's agreement: Vite, TypeScript (strict), Preact, plain CSS with custom properties (light, dark, high-contrast, reduced-motion), `idb` for IndexedDB, Vitest for units, Playwright with Chromium for end to end, axe-core for accessibility checks.

1. Bridge: serve `client/dist` at `/` with SPA fallback and a strict Content-Security-Policy; configurable by `CHATTER_BRIDGE_STATIC_DIR`. Tests first.
2. API module with types matching `docs/SPEC.md` section 5; SSE with resume from `Last-Event-ID` and reconnect backoff; handle `bye` reasons (`revoked` stops reconnecting, `epoch` triggers a resync).
3. Authentication: in production the tailnet identity header does the work (same origin). For development and tests, a token field kept in memory only.
4. Chat feed, composer with @-completion (members and agents), DMs, repo switcher, read pointer and "new" marker, board (read-only), member list with kind badges, admin panel (members, audit), connection badge, desktop notifications for mentions and DMs.
5. Render message text as plain text only. No HTML, no remote images, links shown as text.
6. Accessibility per `docs/SPEC.md` section 7. Automated axe checks must report no serious or critical violations.

Gate: two Playwright clients exchange messages end to end against a real bridge and real Chatter; a DM is invisible to a third member; a member's `@everyone` is refused with a visible error; the main flow works by keyboard alone.

M4 (archive and export) and later milestones are specified in `docs/SPEC.md`; do not start them until M3's gate passes.

## Hard rules

- The bridge stays zero-dependency. The client may use dependencies: pin exact versions, pick releases at least two weeks old, and check a package before adding it.
- Never write to Chatter's SQLite. Writes go through the `chatter` CLI, invoked with an argv array, never a shell.
- Never log, print, commit or echo a token. Tests use throwaway tokens.
- Policy changes (permissions, `@everyone`, agent addressing, visibility) need a test that fails without the change. Every bug fix gets a regression test.
- Verify claims about Chatter or Herdr against Chatter's source or by running it. Do not guess. State what is verified and what is not.
- Work on a branch per milestone (`m3-client`), commit in small steps, and do not push to `main` without Flan's go-ahead.
- Stay in scope. v1.1 items (`/spawn`, `/team`, MCP adapter) are out.
- Comments explain why, not what.

## Working with Flan

- Lead with the answer. Separate what you observed from what you inferred or assumed.
- Do not decide security, scope or architecture questions silently; surface them with a recommended default. Minor implementation choices need no discussion.
- No flattery. Disagree plainly when an assumption looks wrong.
- Report results, not a narration of every step.
- Use the reference codes (D decisions, F findings, Q questions, R risks) from `docs/SPEC.md`.

## Open items that need Flan (do not assume)

- D11: the host may run two Herdr servers; which one should the bridge serve, and where is its Chatter state directory?
- D9: MIT is assumed; not yet confirmed.
- Whether "Prime Agent" (Grace's harness) is Qredence's fleet-prime-agent, and how it loads skills.
- Delivery of messages into live agent panes is untested: it needs a real Herdr.

## First message to send in a new session

> Read CLAUDE.md and docs/SPEC.md. Run the tests and confirm the baseline. Then write a short plan for M3 (tasks, files, test strategy) and wait for my go-ahead before writing code.
