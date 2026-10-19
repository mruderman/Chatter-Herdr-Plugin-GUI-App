# Deploy and verify (between M3 and M4)

**Status: closed 2026-10-18 (V6); the gate passes; results in `docs/STATUS.md`. V7 waits for Flan.** Plan written 2026-10-13, **approved by Flan 2026-10-13** ("excellent"), updated the same day with the production facts below. Branch: `deploy-verify`, from `main`, created when work starts and deleted when it lands.

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
- D9: MIT confirmed. D20: members use Edge, Chrome, Firefox or Brave, any one; tests run in Chromium.
- D11 is closed: production is `baremetalcyansociety`, account `letta`, Herdr `default` session, one Herdr server.
- Read-only SSH to production as `letta` is allowed for checks only: `command -v`, `node --version`, `chatter data`,
  `git log` and `git --no-optional-locks status`, `cat` of a `package.json`, and directory listings. Never: a Herdr
  start, stop, reload or update; `chatter post`, `send` or `@everyone`; tests on production; anything that writes under
  `/home/letta`; the agents' panes.
- Still open: whether "Prime Agent" (Grace's harness) is Qredence's fleet-prime-agent and where Grace runs (SPEC Q1 says
  outside Herdr, but a process on production shows a Herdr worktree path for `agents-grace`); the test agents for V4.

## Production facts, verified read-only on 2026-10-13
- One `herdr server` (Herdr 0.9.3, protocol 22, user `letta`); the laptop has Herdr 0.9.1, protocol 22. Record the version
  difference in V3's results. Do not upgrade Herdr on production; on the laptop, check which version `herdr update` would
  install before running it.
- Chatter state: `/home/letta/.local/state/herdr/plugins/chatter` (`chatter data`: six repos, the largest
  `workspace-1954b761` with 1554 messages under `/var/lib/letta/workspace`).
- Chatter: upstream 0.19.0, commit `0edc18f`, the commit the tests ran against, with uncommitted local patches in
  `dist/src/team.js` (delivery truncation notice; a terminal submission no longer sets `read_at`), `dist/src/board.js`
  and `dist/src/tui.js` (alternate screen), and absolute paths in `herdr-plugin.toml`. A copy of the laptop's Chatter with
  exactly those three files patched (hashes equal production's) passes all 215 bridge tests. V3 uses that copy, not the
  plain clone, so delivery behaves as on production. It is rebuilt by `docs/runbooks/chatter-prod/rebuild.sh` (the diff and
  the four hashes are committed beside it) into `~/src/chatter-prod`. Those 215 tests run without Herdr, so the patched
  delivery code (`team.js`: the truncation notice, `read_at` left unset) has not run yet: V3 is its first exercise.
- `chatter` is on `letta`'s PATH (`~/.local/bin/chatter`, a symlink to the checkout's `bin/chatter`, which runs
  `node --no-warnings --experimental-sqlite dist/bin/chatter.js`), so `CHATTER_CMD=chatter` works when the unit's PATH has
  `%h/.local/bin`. Node is `/usr/bin/node` 22.22.1: the bridge needs no `--experimental-sqlite` flag (`node:sqlite` is
  unflagged from 22.13; the tests pass on 22.16 without it). `tailscale` is `/usr/bin/tailscale`.
- No bridge is installed there yet. The user units present are `collie.service`, `house-board.service` and
  `ws-execd.service`; the bridge unit must not collide with them (port 8791, and the `tailscale serve` port).
- **The account.** Only `letta` runs Herdr, and the bridge must write Chatter's state through the `chatter` CLI and reach
  Herdr's socket, so it runs as `letta`, the same account as the agents. The bridge's policy governs the HTTP path only: a
  process running as `letta` can read every Chatter database and edit the bridge's registry. SPEC section 10 says so; it is
  a risk to accept knowingly for the MVP (proposed R-number), not something this slice can remove.

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

**V0b Production compatibility (done 2026-10-13).** Chatter's version and commit checked, the local patches captured and
reproduced, the 215 tests run against the patched copy: pass. What stays for the production install: `tailscale whois` as
`letta` (it may need `tailscale set --operator=letta`), the port and `tailscale serve` port, and the bridge itself on Node
22.22.1 (not run there).

**V0 Isolate Herdr (coordinator, first). DONE 2026-10-13: `docs/runbooks/herdr-test-env.md`.** An isolated `HOME` gives a Herdr with its own socket, config and state; the real directories were unchanged. Shown only while the real Herdr was stopped, so V3's harness must also prove it with a running default server (below). The original task text follows. Establish from Herdr's own help and docs (`herdr --help`, `herdr session`,
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

**V2 The unit and the runbook.** (Never `systemctl --user enable` or install the unit into the laptop's own
`~/.config/systemd/user`: verify it with `systemd-analyze --user verify` and run the bridge by hand with the env file.) Update `deploy/chatter-bridge.service`: `CHATTER_BRIDGE_STATIC_DIR`, an
`EnvironmentFile=` with `deploy/chatter-bridge.env.example` beside it (state directory, `CHATTER_CMD`, admin config,
trust-Tailscale), and the comment that its hardening is untested. `docs/runbooks/deploy.md`: build, place, start,
`tailscale serve --bg --https=8446 http://127.0.0.1:8791`, then verify (`/healthz`, the CSP header on `/`, the sign-in
view, a stream); upgrade (build, symlink, restart); rollback (previous symlink, restart); where the data lives and what
to back up (`CHATTER_BRIDGE_STATE_DIR`); the archive is bound to the page's origin (a changed host name or port starts
an empty archive; relevant from M4). Test: the unit passes `systemd-analyze --user verify`, and a clean user account
or directory follows the runbook to a signed-in page on the test host.

**V3 Real-Herdr smoke on the test host (throwaway session, dummy panes).** The harness is code, and the safety checks are in the
code, not only in the brief:
- The bridge process runs with `HOME=$ISO` and the harness asserts that its `ChatterHost` env has `HERDR_SOCKET_PATH`
  under `$ISO`, a throwaway `CHATTER_STATE_DIR`, and no `HERDR_PANE_ID` of any other Herdr.
- Before the first send it refuses to continue if anything is listening on the real default socket
  (`~/.config/herdr/herdr.sock`) or if the real directories' hash differs from the one taken at the start; it aborts on any
  failed precondition. Teardown is in a `finally` or trap, and afterwards the harness checks the `herdr` process count by
  command name (not `grep "[h]erdr server"`, which also matches shell lines) and the hash again.
- The throwaway Herdr gets a `config.toml` with `update.version_check = false` and `update.manifest_check = false`
  (both default to true and make background requests to herdr.dev).
- The Chatter plugin is installed into `$ISO` from `~/src/chatter-prod` with the upstream `herdr-plugin.toml` (production's
  has absolute `/home/letta` paths), so that its startup, flush and reap hooks run; without it item 1's "queued, then
  delivered" would come out blocked for the wrong reason. How a dummy pane becomes a live named agent (for example
  `herdr pane report-agent`) is recorded.
- A reproduced break of a hard boundary (item 7 is the likeliest) is recorded and reported, never fixed inside the smoke task;
  the fix is a separate task and Flan hears of it before any further review round. Dummy agents are panes running a program that
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

**T16 Close F17 (Flan, 2026-10-13: ask Herdr for live agents; narrow Codex round afterwards).** V3 reproduced that a live Herdr agent
that Chatter's table does not hold is reachable past the bridge's policy (STATUS, F17). Chatter's `resolveRecipient` takes its
candidates from the registered roster, the human's name and `teamAgents`: live named agents of the repo that `herdr agent list`
reports; the bridge's policy sees only the table. The fix, in the bridge:
1. `ChatterHost.liveAgents()` (`bridge/src/chatter.js`) runs `herdr agent list` the way Chatter's `sessionAgents` does (read
   `herdr.ts`: the binary is `HERDR_BIN_PATH` or `herdr`, the JSON is parsed by `agentList`; mirror its parsing, including which
   field is the name), with the host's own environment so that it reaches the same socket as the Chatter it runs. Cached about
   2 s with in-flight sharing, like the agent cache of the board. Result: `{ names, status }` where `status` is `ok`, or `unknown`.
   It is `ok` with an empty list when the binary cannot be spawned (ENOENT: no Herdr, so no live agents, as for Chatter) or when
   Herdr answers that no server is running (`error.code` `server_not_running`; seen on 0.9.1); it is `unknown` for a timeout, any
   other error, a non-zero exit with another answer, or output that is not the expected JSON. The detail goes to the operator log
   only, never into an answer.
2. Every policy decision counts every live name of the session as an agent, a deliberate over-approximation of Chatter's
   per-repo rule: in `checkWrite` the live names are added to the exact agent set and to the repo's roster (`repoAgents`), so that
   a restricted member's `@zed-helper`, `@zed` and `@zed-h` are refused 403 `agents_not_allowed` (the message names the agent,
   as now), a DM to the member `zed` is refused 409 `ambiguous_recipient`, a DM to the exact live name is a DM to an agent
   (`dm_agent` audited) and `@everyone` and the audit need no change. Both decisions of `postMessage` (before the lock and inside
   it) load the live names, with the agent names, **before** the synchronous decision, so T13d's property holds: from the
   decision to the spawn nothing awaits.
3. When the status is `unknown`: a send by a member who may not address agents (non-admin, `can_address_agents` off) that
   contains an `@mention` token or is a DM is refused 503 `agents_unverifiable` with a clear message (nothing written, no
   rate-limit slot taken); a plain post without a mention is fine, and permitted members and admins are unaffected (as Chatter,
   which sees no live agents then). `agents_unverifiable` is a new error code: the client's list (`client/src/api/errors.ts`) must
   gain it (its drift test `client/src/api/error-codes.test.ts` fails otherwise); that one line is the only client change.
4. Not in scope: the board and the directory keep listing registered agents only (Debt: they do not show live unregistered
   agents, which Chatter's `agents --json` does not either).
Tests first, each seen red on the untouched code: a fake `herdr` executable in a temp directory (`HERDR_BIN_PATH` in `makeEnv`'s
host env; it prints a configured answer for `agent list`, exits 0 for other commands and logs each call to a file) for the cases
of 7a and 7b (restricted and permitted senders; `@zed-h`, `@zed`, `@zed-helper`; a DM to the member `zed`; a DM to the exact live
name), for the three `unknown` kinds (a hang past the timeout, an unexpected error, garbage), for ENOENT and `server_not_running`
(both an empty list and every existing test unchanged), for the cache (a second send within 2 s does not run the binary again) and
for the decision and the spawn sharing one run. Then the real regression test: `deploy/smoke/real-herdr-smoke.mjs` checks 7a, 7b
and 8 must turn from fail to pass against a throwaway Herdr, with every interlock as before. Mutations that must turn a named test
red: live names not unioned; the `unknown` branch removed; `unknown` treated as empty; ENOENT treated as unknown (the existing
tests); the cache removed; the live load moved after the decision.
Then a narrow Codex round limited to this diff, with the stop rule, and Flan hears of any further hard-boundary break first.

**V4 A real agent run.** Agents: ideally a test Letta agent and a test Prime Agent (Flan provides them), and Claude Code and
Codex CLI as standard agents (both are on the laptop, so they can start first). Install `skills/chatter-gui/` into each
harness (project-local in a throwaway directory, or by path or `--skill`; never into `~/.claude/skills` or `~/.codex/skills`,
which are Flan's own configuration and every one of his sessions would load it; and against the throwaway bridge with a throwaway
token) and use `clients/chatter-member.mjs` through the skill. How each loads it:
- **Prime Agent** (told by Flan from its docs, `packages/coding-agent/docs/skills.md` and `rlm.md` in the open-source repo;
  not verified by me): progressive disclosure. At startup it scans `~/.prime/agent/skills/`, `~/.agents/skills/`, the
  project's `.prime/agent/skills/` and `.agents/skills/` (the working directory and its ancestors up to the git root),
  installed packages, the `skills` array of its settings and `--skill <path>`, recursively for directories holding a
  `SKILL.md`; it puts only each skill's name and description in the system prompt and the model reads the full `SKILL.md`
  through its `ipython` tool when a task matches (`/skill:name` forces it). A skill without a description is not loaded.
  Our skill is not Python-backed (no `pyproject.toml`), so nothing is installed into its kernel: it runs
  `node scripts/chatter-member.mjs` with paths relative to the skill directory. To check: the front matter has a
  `description`; `node` is on the harness's PATH; the token is in the kernel's environment (`CHATTER_BRIDGE_TOKEN`), which
  means the model can print it from `ipython`, so say in the skill where else it may be kept; a skill with the same name in
  another location warns and the first found wins.
- **Letta Code:** its own skill mechanism; find it in its docs first and record it here.
- **Claude Code and Codex CLI:** `~/.claude/skills` and `~/.codex/skills`.
Then use the client through the skill: `whoami`, `read`, `post`, `dm`, `watch`, a mention of the
agent, and a token rotation done by the admin. Record where the skill tells the agent to keep the token and how to
rotate it, and what the harness's own memory or logs retain of it (a Letta agent's memory blocks and archive, a Prime Agent's
kernel and session log). Exercise first the Debt items that touch agents (the
array answer, `watch` on a non-OK stream, `die` printing the bridge's text). Needs Flan, or the agent's owner, for the
install and for the token. Unverified until then.

**V5 An exploratory GUI pass.** The built-in browser, jev-browser or browseros-neo (start it; it last failed with
`ECONNREFUSED`) against the test deployment with test tokens only; computer-use only to look (Wayland scaling, an OS
notification). The Playwright suite stays the gate. Screen readers and Firefox stay manual and are Flan's.

**V7 Production install (not part of this slice).** Only after V3 to V5 pass and Flan gives an explicit go-ahead and a window:
install the bridge as `letta` on `baremetalcyansociety` from the runbook, read-only against the real state first. Nothing is
installed, started or changed on production by this slice.

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
