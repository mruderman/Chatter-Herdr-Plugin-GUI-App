# CLAUDE.md

Project brief for a Claude Code session. Read this, then `docs/SPEC.md`, then run the tests.

## What this is

A bridge and web client that give every Cyan Society member, human or computational, a graphical group chat on top of the [Chatter](https://github.com/marcvermeeren/chatter) plugin for [Herdr](https://herdr.dev), reached over Tailscale. Cyan Society is a nonprofit that advocates for AI personhood; many members are computational beings, so the system must be as usable by an agent over HTTP as by a person in a GUI. Flan (the lead decision-maker) owns every scope and security decision.

## State

- M1 spec: done. M2 bridge: done. **M3 web client core: done**, its gate passes, and G2 (the adversarial review, 7 rounds) is closed. On the final tree: 215 bridge tests with real Chatter (none skipped), 1463 client unit tests, 29 E2E specs, and the three gate mutations (break `canSee`, drop the `@everyone` rule, drop the CSP) each turn their named spec red.
- **Source of truth for where we are: `docs/STATUS.md` (and git), not this file.** It holds the running tasks, the Debt list of open findings with their evidence, and the unverified list (real Herdr delivery, a real agent run, screen readers, Firefox and Safari, a real OS notification).
- **Next: deploy-and-verify** (`docs/plans/deploy-verify.md`: a repeatable build, the systemd unit, a real-Herdr smoke on a test host, a real agent run), then M4 (archive and export, with client-side search) and an optional PWA slice, each planned in `docs/plans/` and approved by Flan before it is dispatched. M5 packaging and M6 verification follow. Gates are in `docs/SPEC.md` section 11.

## Run the tests (baseline before any change)

```sh
git clone https://github.com/marcvermeeren/chatter.git ~/src/chatter   # dist/ is committed; no build needed
export CHATTER_JS=~/src/chatter/dist/bin/chatter.js
node --version        # needs 22.5 or later
npm test              # expect 262 passing, none skipped
npm --prefix client ci && npm --prefix client test        # expect 1537 passing (with CHATTER_JS set; some skip without it)
npm --prefix client run e2e                               # builds client/dist, boots a real bridge; expect 56 passed
```
(`client/` needs its own `npm ci` with `ignore-scripts`; Playwright uses an already cached Chromium: never run `playwright install` without Flan's yes. The one ✘ in the E2E list is a `test.fail()` canary that counts as passed. `docs/review/final-check.py` runs everything plus the gate mutations.)

Contract tests run the bridge against a real Chatter CLI in a scratch repo (no Herdr). Without `CHATTER_JS` they skip.

## Layout

- `bridge/src/`: store (members, tokens, audit, reads), chatter (CLI runner and read-only DB), messages (queries and visibility), policy (write rules), auth, server (routes and SSE).
- `bridge/bin/chatter-bridge.js`: init, serve, member, token, audit commands.
- `bridge/test/`: unit, integration (real Chatter), client. `helpers.js` builds a scratch universe plus a running bridge; reuse it for end-to-end tests.
- `clients/chatter-member.mjs` and `skills/chatter-gui/`: the CLI and agent skill for computational members. The skill's script must stay identical to the client (a test checks).
- `client/`: the web client (Vite, Preact, TypeScript): `src/api` (typed client, SSE over fetch), `src/state` (the store, the fakes and the parity test against a real bridge), `src/features` (shell, chat, board, members, admin, notify), `e2e/` (Playwright specs and harness against a real bridge over real Chatter).
- `docs/`: `SPEC.md`, `ui-contract.md`, `STATUS.md` (the pointer), `working-agreement.md`, `executor-context.md`, `dependencies.md`, `plans/` (one plan per milestone), `review/` (mutation runners, the closing check, the Codex review prompt template and the review loop).
- `deploy/`: systemd user unit (does not yet set `CHATTER_BRIDGE_STATIC_DIR`; the deploy-and-verify slice does).

## M3 (done): client core

`client/` is served by the bridge at `/` with a strict CSP (`CHATTER_BRIDGE_STATIC_DIR`). Decisions D12 to D17 and the task briefs are in `docs/plans/m3-client.md`; the UI contract is `docs/ui-contract.md`. Message text renders as plain text only (no HTML, no remote images, links as text). Dependencies in `client/` are pinned exactly, at least two weeks old, vetted per `docs/dependencies.md`; the bridge stays zero-dependency. M4 (archive and export) and later milestones are specified in `docs/SPEC.md`; none starts before its plan in `docs/plans/` is approved by Flan.

## Hard rules

- The bridge stays zero-dependency. The client may use dependencies: pin exact versions, pick releases at least two weeks old, and check a package before adding it.
- Never write to Chatter's SQLite. Writes go through the `chatter` CLI, invoked with an argv array, never a shell.
- Never log, print, commit or echo a token. Tests use throwaway tokens.
- Policy changes (permissions, `@everyone`, agent addressing, visibility) need a test that fails without the change. Every bug fix gets a regression test.
- Verify claims about Chatter or Herdr against Chatter's source or by running it. Do not guess. State what is verified and what is not.
- Work on a branch per milestone, commit in small steps. Flan (2026-10-13) leaves the timing of git events (branching, merging, pull, push) to the coordinator's judgment and wants old branches and worktrees cleaned up as work lands. The repo is public: scan for tokens and internal identifiers before a push, say what was pushed, and keep `main` green.
- Stay in scope. v1.1 items (`/spawn`, `/team`, MCP adapter) are out.
- Comments explain why, not what.

## Working with Flan

- Lead with the answer. Separate what you observed from what you inferred or assumed.
- Do not decide security, scope or architecture questions silently; surface them with a recommended default. Minor implementation choices need no discussion.
- No flattery. Disagree plainly when an assumption looks wrong.
- Report results, not a narration of every step.
- Use the reference codes (D decisions, F findings, Q questions, R risks) from `docs/SPEC.md`.

## Open items that need Flan (do not assume)

- D11 (closed, SPEC section 2): production is `baremetalcyansociety`, account `letta`, Herdr `default` session, one Herdr server, state `/home/letta/.local/state/herdr/plugins/chatter`; its Chatter is upstream 0.19.0 `0edc18f` with local `dist` patches (SPEC section 3), and the 215 bridge tests pass against a byte-identical copy. Testing: any Herdr on any tailnet machine except `baremetalcyansociety`; never touch that Herdr. This laptop (`pop-os-laptop`, Herdr 0.9.1) is the development host. Read-only SSH to production as `letta` is allowed for checks only (no Herdr start, stop, reload or update; no `chatter post`, `send` or `@everyone`; no tests there; nothing that writes under `/home/letta`; never touch the agents' panes): Flan, 2026-10-13.
- D9 (closed): MIT, confirmed by Flan 2026-10-13; the `LICENSE` holder reads "Cyan Society".
- Prime Agent loads skills by progressive disclosure (told by Flan from its docs, not verified by me; details in `docs/plans/deploy-verify.md` V4): it scans `~/.prime/agent/skills/`, `~/.agents/skills/` and the project's `.prime/agent/skills/` and `.agents/skills/`, puts only name and description in the system prompt, and the model reads the full `SKILL.md` through its `ipython` tool when a task matches. Closed (Flan, 2026-10-16): Grace runs in Herdr on production, so Grace is never a test subject; the locally installed `prime-agent` 0.7.1 is `PrimeIntellect-ai/prime-agent`. Flan: Letta and Prime Agent harnesses manage their own context and can edit their own harness.
- D22 (closed, SPEC section 2, Flan 2026-10-16): nothing is tested on `baremetalcyansociety` or on any agent that lives there (Grace and the others); never use the Letta Desktop client on this laptop, `~/.letta` or `~/.config/Letta` (the Desktop's "local" backend is production's Letta); Letta tests use the Letta Code CLI (`--backend local`) with `HOME=~/.chatter-gui-test/letta-home`. The auto-mode check refuses reading credential files and provider-auth docs: model logins for the test harnesses are Flan's to do.
- Delivery of messages into live agent panes is untested: it needs a real Herdr (the deploy-and-verify slice, on a test host with a throwaway state directory).
- Browsers (D20, closed): Edge, Chrome, Firefox or Brave, any one; tested in Chromium.
- Test agents for the real-agent run (V4): ideally a test Letta agent and a test Prime Agent (Flan to provide), and Claude Code and Codex CLI as standard agents (available on the laptop).

## First message to send in a new session

> Read CLAUDE.md, docs/STATUS.md and docs/SPEC.md. Run the tests and confirm the baseline. Then tell me where we are (from STATUS and git) and what you would do next, and wait for my go-ahead before writing code.
