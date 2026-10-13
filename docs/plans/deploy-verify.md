# Deploy and verify (between M3 and M4)

**Status:** plan, written 2026-10-13, **not approved, nothing dispatched.** Flan approves this plan in chat first.
Branch: `deploy-verify`, from `main` (created when the plan is approved; deleted when it lands).

## Why this comes first
Every gate so far ran against Chatter without Herdr, and no real agent has used the member client. What is unverified
is the part members care about: a message reaching an agent pane, a revocation ending a live session, a Letta or Prime
Agent member getting through the skill. This slice makes the product deployable and checks those against reality
before any more features. M4 (archive, export, search) and the PWA wait for it, as outlines only
(`docs/plans/m4-archive.md`, `docs/plans/m5-pwa.md`).

## Settled (Flan, 2026-10-13)
- Test host: any Herdr installed on any tailnet machine **except `baremetalcyansociety`**. This laptop
  (`pop-os-laptop`) has Herdr 0.9.1 and tmux and is the default test host. Never touch `baremetalcyansociety`'s Herdr.
- Git events (branches, merges, pushes) are left to the coordinator; keep branches and worktrees tidy.
- Still open and needed: D9 (is MIT confirmed?); how Prime Agent loads skills; which browsers members use; which
  real agent takes part in V4; for the production runbook only, D11 (which Herdr server and Chatter state directory).

## Hard constraints of the slice
- **Throwaway Herdr and state only.** A named Herdr session, its own Chatter state directory and config, dummy panes.
  An admin `@everyone` pushes into every live agent's terminal, so no test may reach a pane that is not a dummy. If Herdr
  cannot be isolated (V0), stop and ask Flan; do not improvise.
- Tokens: only throwaway test tokens, only against a local or throwaway bridge; never print one. Real-host click-throughs
  are live actions as the logged-in tailnet user and need Flan's explicit yes. No page is pointed at real DMs.
- Every exploratory finding is reproduced as a spec or script before it is fixed. Only a reproduced break of a hard
  boundary of `CLAUDE.md` is fixed in this slice; everything else goes to the Debt list in `docs/STATUS.md`.
- No new dependency. No change to the bridge's policy without a test that fails first.

## Tasks

**V0 Isolate Herdr (coordinator, first).** Establish from Herdr's own help and docs (`herdr --help`, `herdr session`,
`herdr status`, https://herdr.dev/llms.txt) how to run a Herdr that shares nothing with another session: a named session
(`herdr --session <name>`), its socket, `HERDR_CONFIG_PATH`, and Chatter's `HERDR_PLUGIN_STATE_DIR`,
`HERDR_PLUGIN_CONFIG_DIR` and `HERDR_BIN_PATH`. Prove it: `herdr session list` and `herdr status` before and after, a
dummy pane that no other session can see, and no write under the default `~/.config/herdr`. Output:
`docs/runbooks/herdr-test-env.md`. Done when the isolation is demonstrated, or the slice stops and asks Flan.

**V1 A repeatable client build.** `deploy/build-client.sh` (idempotent): `npm --prefix client ci` with
`ignore-scripts`, `npm --prefix client run build`, `npm --prefix client run check:dist`, then print the dist path and the
SHA-256 of `index.html`. Release layout in the runbook: `releases/<git-sha>/dist` and a `current` symlink that
`CHATTER_BRIDGE_STATIC_DIR` points at. The bridge resolves the static root's realpath once at start, so re-pointing the
symlink needs `systemctl --user restart chatter-bridge`. Test: the script run twice gives the same hash on the same
commit; `check:dist` failing fails the script.

**V2 The unit and the runbook.** Update `deploy/chatter-bridge.service`: `CHATTER_BRIDGE_STATIC_DIR`, an
`EnvironmentFile=` with `deploy/chatter-bridge.env.example` beside it (state directory, `CHATTER_CMD`, admin config,
trust-Tailscale), and the comment that its hardening is untested. `docs/runbooks/deploy.md`: build, place, start,
`tailscale serve --bg --https=8446 http://127.0.0.1:8791`, then verify (`/healthz`, the CSP header on `/`, the sign-in
view, a stream); upgrade (build, symlink, restart); rollback (previous symlink, restart); where the data lives and what
to back up (`CHATTER_BRIDGE_STATE_DIR`); the archive is bound to the page's origin (a changed host name or port starts
an empty archive; relevant from M4). Test: the unit passes `systemd-analyze --user verify`, and a clean user account
or directory follows the runbook to a signed-in page on the test host.

**V3 Real-Herdr smoke on the test host (throwaway session, dummy panes).** Dummy agents are panes running a program that
only prints what it receives; the bridge runs against the throwaway Chatter state. `tmux-cli` may drive them. Each line
below is recorded as pass, fail or blocked, with the observed output (never a token):
1. A permitted member's `@agent` mention reaches the agent's pane: delivered, and queued when the pane is not ready
   (the answer's `delivery` and `pushed`).
2. A DM to an agent: the text and the sender's attribution as the pane shows them; `delivery`.
3. An admin's `@everyone` reaches every live dummy pane and no one else; the count equals the live panes.
4. A restricted member (`can_address_agents` off) cannot push: 403, nothing in any pane, nothing audited as a push.
5. A non-admin's `@everyone`, `@everyoneX`, `@codX`: refused, nothing in any pane.
6. Revocation ends a live stream (`bye revoked`) and the token is refused (401); token rotation through the HTTP route
   and through the CLI ends the old stream (`bye token_rotated`).
7. Prefix resolution against a live agent that is not in Chatter's agents table (a pane registered only in Herdr): what a
   DM to its prefix and a mention of it do. The bridge cannot see such agents, so this is the one place where the
   fail-closed rule is known to be incomplete; record the real behaviour. A boundary break here is a finding to fix.
8. The audit log holds the pushes, `@everyone` and registry changes, with the right actors.
9. A broken Chatter command answers a fixed message on `/healthz` and `/v1/repos` and the detail appears in the
   bridge's log (T13d's change, seen against a real failure).

**V4 A real agent run (Flan nominates the agent).** Install `skills/chatter-gui/` into one real Letta or Prime Agent
harness and use `clients/chatter-member.mjs` through the skill: `whoami`, `read`, `post`, `dm`, `watch`, a mention of the
agent, and a token rotation done by the admin. Record where the skill tells the agent to keep the token and how to
rotate it, and what the harness's own memory or logs retain of it. Exercise first the Debt items that touch agents (the
array answer, `watch` on a non-OK stream, `die` printing the bridge's text). Needs Flan, or the agent's owner, for the
install and for the token. Unverified until then.

**V5 An exploratory GUI pass.** The built-in browser, jev-browser or browseros-neo (start it; it last failed with
`ECONNREFUSED`) against the test deployment with test tokens only; computer-use only to look (Wayland scaling, an OS
notification). The Playwright suite stays the gate. Screen readers and Firefox stay manual and are Flan's.

**V6 Close.** The results table in `docs/STATUS.md` (every V3 line, V4, V5), findings fixed or in Debt, the runbooks
committed, the throwaway session, state and worktrees removed.

## Gate
The unit and runbook work from a clean directory on the test host; every V3 line has a recorded result; V4 is done or
explicitly marked unverified with the reason; no boundary break is open. Failures become tasks, tests first, mine to
verify by mutation as before.

## Risks
- Herdr may not isolate completely (V0); then the slice stops and asks.
- A dummy pane may not behave like a real agent harness (it will not run a model); delivery is checked, not what an agent
  does with the text.
- The service unit's hardening is untested on a real host; the test host is not the production host.
- V4 depends on a person; without it the agent path stays unverified, and the plan says so.
