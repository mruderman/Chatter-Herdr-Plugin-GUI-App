# Real-Herdr smoke (V3 of `docs/plans/deploy-verify.md`)

**Result, 2026-10-13, `pop-os-laptop`, Herdr 0.9.1:** every interlock, setup step and check passes except 7a, 7b and
8, which fail on one reproduced boundary break (Finding V3-1 below): a live Herdr agent that is not in Chatter's agents
table can be reached by a member who may not address agents, and a DM addressed to a member can be typed into that
agent's terminal, unaudited. Nothing was fixed here; the fix is a separate task and Flan hears of it first.

## What it is
`deploy/smoke/real-herdr-smoke.mjs` starts a Herdr under a throwaway `HOME`, links the production-identical Chatter
into it, makes dummy panes (programs that only print what they receive), starts the bridge exactly as deployed, then
runs the checks of V3 against it and prints one Markdown table: id, expected, observed, verdict (pass, fail, or
blocked with the reason). It exits non-zero on any fail or blocked row. A run takes about 25 seconds.

```sh
CHATTER_JS=/home/cyanfam/src/chatter-prod/dist/bin/chatter.js node deploy/smoke/real-herdr-smoke.mjs
node --test "deploy/smoke/*.test.mjs"        # the interlock tests (15), no Herdr involved
```

Needs: Node 22.5 or later (22.16 here), `herdr`, `setsid` (util-linux), `git`, `cat`, `stty`, `ps`, `find`, `sort` on
`PATH`; the production-identical Chatter from `docs/runbooks/chatter-prod/rebuild.sh`. No herdr process may be running
(the real one included) and `/run/user/$UID/hv-smoke` must not exist: the harness refuses otherwise.

## The danger and the interlocks
An admin `@everyone` types into every live agent's terminal. The harness never starts, stops, configures or talks to
the real Herdr (socket `~/.config/herdr/herdr.sock`), and nothing is sent until these hold. Any failure aborts the run
(blocked row), tears down and exits non-zero. The functions are in `deploy/smoke/interlocks.mjs`.

| Interlock | Where | How it was tested |
|---|---|---|
| Every child (Herdr server, bridge, every `chatter` the bridge runs, the panes, `git`, the bridge CLI) gets an environment built from an allowlist (`PATH`, locale, `TERM`, `USER`, `LOGNAME`, `SHELL`, `TZ`) plus `HOME=$ISO` and `HERDR_SOCKET_PATH=$ISO/.config/herdr/herdr.sock`. No `HERDR_*` or `XDG_*_HOME` is inherited: a caller inside a real Herdr pane carries `HERDR_SOCKET_PATH` and `HERDR_SESSION`, which Herdr's CLI prefers over the home-derived socket. All Herdr calls go through one wrapper that refuses any other socket. | `childEnv`, `herdrRaw` | unit test: a base env with `HERDR_SOCKET_PATH`, `HERDR_SESSION`, `HERDR_PANE_ID`, `XDG_CONFIG_HOME` and a secret yields only `PATH`, `HOME`, the throwaway socket and `HERDR_BIN_PATH` |
| The real home is taken from the password database (`os.userInfo()`), not `$HOME`. | `realHome` | unit test with `$HOME` pointed elsewhere |
| Before anything starts (I1) and again just before the first send (I5): nothing accepts a connection on the real default socket, and the hash of `find ~/.config/herdr ~/.local/state/herdr -printf '%p %T@ %s\n' \| sort \| sha256sum` equals the one taken at the start. A socket that cannot be judged (timeout, other error) counts as a refusal. | `preflight`, `socketState`, `dirsHash` | unit tests against a socket this test listens on in its own scratch directory (abort, and a gated send is never made), a missing path and a plain file (nobody listening), a scratch tree changed after its hash (abort); the hash equals the shell pipeline's. Whole-harness runs below. |
| I1 also refuses when any herdr process runs (counted by command name, `ps -eo comm`, as `grep -cx herdr`), when `$ISO` exists, or when `CHATTER_JS`'s tree does not match `docs/runbooks/chatter-prod/EXPECTED_SHA256` or its `herdr-plugin.toml` has absolute (`/home/letta`) paths. | `herdrCount` | unit test of the counter (a `herdr-helper` or a shell line is not counted) |
| I5: the bridge's effective environment, read from `/proc/<pid>/environ`, has `HOME=$ISO`, `HERDR_SOCKET_PATH` equal to the throwaway socket, no `HERDR_*` but the socket and the binary (so no `HERDR_PANE_ID`, no `HERDR_SESSION`), and `CHATTER_STATE_DIR`, `CHATTER_BRIDGE_STATE_DIR`, `CHATTER_ADMIN_CONFIG_DIR` under `$ISO`. Every herdr process runs with `HOME=$ISO` and there is exactly one. Every dummy agent is deliverable. | `envProblems`, `readEnviron` | unit tests on crafted environments and on `/proc/<pid>/environ` of a live child started with `HERDR_PANE_ID` and a foreign socket |
| One gate in front of every write (every non-GET request to the bridge): shut until I5 passes, shut again at teardown. | `SendGate` | unit test; the abort runs below show 0 message POSTs |
| The throwaway Herdr gets `$ISO/.config/herdr/config.toml` with `[update] version_check = false` and `manifest_check = false` (names checked in the v0.9.3 config reference and in 0.9.1's `herdr --default-config`; both default to true). | I2 | its log shows no update or manifest line; no network trace was taken |
| Teardown in `finally` and in the SIGINT, SIGTERM and SIGHUP handlers, synchronous: stop the bridges (by their pids), `herdr server stop` through the throwaway socket, then anything left with `HOME=$ISO` (found by that environment, never by a name pattern), `rm -rf $ISO`; then assert no herdr process is left (by command name), nothing with `HOME=$ISO`, and the real directories' hash unchanged. The server is started with `setsid -f`, so it is not this process's child and leaves no zombie for the count. | `teardown` | every run below ends with row T: pass, the SIGINT run included |
| Test-only, additive: `SMOKE_EXTRA_GUARD_SOCKETS` (colon-separated) adds sockets to the guard. It can never remove the real one. | I1, I5 | the two abort runs below |
| Throwaway tokens only, never printed: every token (and its SHA-256) is redacted from all output; the CLI's output, which holds a token, is never shown; answers and log lines quoted in the table hold none. | `redact`, `tokenFrom` | `grep cb_` and a search for 64-hex strings in every run's output: none |

If the harness is killed with SIGKILL, nothing tears down: the next run refuses (I1). Clean up by hand:
`ISO=/run/user/$(id -u)/hv-smoke; HOME=$ISO HERDR_SOCKET_PATH=$ISO/.config/herdr/herdr.sock herdr server stop`, end the
bridge (its environment has `HOME=$ISO`), then `rm -rf "$ISO"`.

## Setup (verified against Chatter's source and Herdr's docs, and observed)
- **Plugin.** `HOME=$ISO herdr plugin link /home/cyanfam/src/chatter-prod` before the server starts (Herdr can link
  with no server running; startup hooks run when a server starts, not on link). `plugin install` takes GitHub shorthand
  only and would clone upstream, not the patched copy; `link` runs no build, which is fine since `dist/` is committed.
  The copy keeps the upstream `herdr-plugin.toml` (relative `dist/bin/chatter.js` commands; `git diff` clean on it).
  Hooks run with the plugin root as working directory, `node` from `PATH`, and Herdr's `HERDR_PLUGIN_STATE_DIR`
  (`$ISO/.local/state/herdr/plugins/chatter`) and `HERDR_PLUGIN_CONFIG_DIR` (`$ISO/.config/herdr/plugins/config/chatter`).
  The startup hook ran ("chatter startup: ready") and wrote the `state-dir` pointer; it also links
  `$ISO/.local/bin/chatter`, inside the throwaway home. The `pane.agent_status_changed` hook (`_flush`) delivered the
  queued mention in 1b ("flushed 1"). `_reap` (`pane.closed`, `worktree.removed`) was not exercised.
- **One Chatter universe.** The bridge's `CHATTER_STATE_DIR` is the plugin's state directory under `$ISO`, and its
  `CHATTER_ADMIN_CONFIG_DIR` the plugin's config directory, whose `name` file holds the admin (`flan`), as production's
  bridge would point at `letta`'s. Otherwise the agents registered in panes and the hooks' flushes would live in a
  universe the bridge does not read.
- **How a dummy pane becomes a live, named Chatter agent** (Herdr 0.9.1):
  1. `herdr pane report-agent <pane> --source custom:hv-smoke --agent pi --state idle` (an agent of a supported kind);
  2. `herdr agent rename <pane> <name>` (Herdr's name is what Chatter's `whoami` uses);
  3. `herdr pane run <pane> "node --no-warnings --experimental-sqlite <chatter.js> whoami && stty -echo && exec $ISO/bin/pi"`:
     `chatter whoami` inside the pane (it has `HERDR_PANE_ID`) finds itself in `herdr agent list` and upserts its row in
     the repo's `agents` table (`team.ts` `whoami`), then the shell is replaced by `$ISO/bin/pi`, a symlink to `cat`,
     with echo off so each delivery shows once.
  Why `pi`: in 0.9.1 `herdr agent prompt` (Chatter's `tryDeliver`) refuses a pane reported with a custom label
  ("agent ... is not an active named agent"), and for a supported kind refuses until a process of that kind's name
  owns the pane's foreground. Herdr then also detects the `pi` process itself (server log `agent changed ...
  agent=Some(Pi) process=pi`); the custom report keeps authority over its state, so `report-agent --state blocked` and
  `idle` drive "not ready" and "ready". A pane running plain `cat` is not an agent. Skip step 3's `whoami` and the pane
  is an agent only Herdr knows (check 7).
- **A member's Chatter identity.** For a member, `ChatterHost.run` drops every `HERDR_PANE*` variable, sets
  `HERDR_PLUGIN_CONFIG_DIR=$CHATTER_BRIDGE_STATE_DIR/members/<handle>`, whose `name` file `ensureMemberConfig` writes,
  and `HERDR_PLUGIN_STATE_DIR=$CHATTER_STATE_DIR`. Outside a pane Chatter's `whoami` is the human, named by that file
  (`db.ts` `humanName`), so deliveries read "[chatter] message from ada". `chatter data` runs as the admin with
  `CHATTER_ADMIN_CONFIG_DIR`.
- **The bridge** is `node --no-warnings bridge/bin/chatter-bridge.js serve --host 127.0.0.1 --port <free port>` (as the
  unit runs it) with `CHATTER_CMD=["<node>","--no-warnings","--experimental-sqlite","<chatter-prod>/dist/bin/chatter.js"]`
  (as production's `bin/chatter` launches it). The admin is made with `chatter-bridge init`, its token with
  `chatter-bridge token rotate flan`; the members through `POST /v1/members` as the admin.

## The checks
I1 to I6 are the interlocks and setup; 1a to 9 are V3's items; T is teardown. The panes: `alpha` and `coder` (dummy
agents of the repo, registered), `plain` (`cat`, not an agent), `outsider` (a dummy agent of another repo), and for
check 7 only `zed-helper` (a dummy agent of the repo that never ran chatter). Members: `flan` (admin), `ada` (may
address agents), `rex` (`can_address_agents` off), `grace`, `thom`, `zed`. Check 7 runs after 9, and its pane is made
only then, because Chatter's `@everyone` reaches every live agent of the repo, registered or not.

Check 5's `@codX` is refused because `rex` may not address agents. For a member who may, it is allowed and reaches
`coder` by design (SPEC section 6: a handle that is the start of a roster agent's name counts as addressing it), so it
is not tested as a refusal for `ada`.

## Finding V3-1 (reproduced boundary break; not fixed; a proposed F-number, the coordinator assigns it)
A live Herdr agent of the repo that is not in Chatter's `agents` table (it has not run a chatter command, for example
an agent just started, or one that never uses Chatter) is invisible to the bridge's policy but reachable through
Chatter:
- **A restricted member reaches it.** `rex` (`can_address_agents` off) posts `@zed-h ...` (a bare prefix), `@zed ...`
  (a member's handle that is its prefix) or `@zed-helper ...` (its exact name): each answers 201
  `pushed: ["zed-helper"]` and the text is typed into its terminal (7b). Audited as `push_agent` by `rex`.
- **A DM goes to an agent other than the one named.** `rex` or `ada` sends `{"to": "zed", ...}` to the member `zed`:
  201 with `id: null`, `delivery: null`, `mentioned_members: ["zed"]`; Chatter stores the row with
  `to_agent = 'zed-helper'` and types "[chatter] message from rex: ..." into that terminal (7a). `zed` never gets it,
  the sender is told nothing, and **no audit entry** is written (8: 4 pushes by rex seen, 3 audited; ada 2 and 1).
- A DM to a bare prefix (`zed-h`, no such member) is refused 404, as it should be.

Steps: on a throwaway Herdr (this runbook), with a repo `R` whose universe the bridge serves: (1) in a pane with cwd `R`,
make a live named agent `zed-helper` without `whoami` (the recipe above without step 3's `chatter whoami`; any agent
started in `R` that has not run chatter yet should do the same, inferred); (2) add members `zed` and `rex`
(`can_address_agents: false`); (3) as `rex`, `POST /v1/repos/<key>/messages` with `{"to":"zed","body":"x"}`, then with
`{"to":"#chat","body":"@zed-helper x"}`; (4) `herdr pane read <zed-helper's pane>` shows both.

Cause (from the source, consistent with what was observed): the bridge knows agents only from the `agents` tables
(`ChatterHost.agentNames` and `rosterNames`), while Chatter's `resolveRecipient` (`team.ts`), behind `send` and the
mentions of `post`, adds `teamAgents(d)` (live Herdr agents whose working directory is in the repo, from `herdr agent
list`) and matches by exact name and by unique case-insensitive prefix. SPEC section 6 names the prefix case as known
and incomplete; the observed reach is wider: an exact mention, and a DM addressed to a member. Inferred from the source,
not observed (the Herdr-only pane is made after check 3): an admin's `@everyone` also reaches such agents, since
`postToChat` iterates `teamAgents`. Production exposure (whether agents there sit live in a repo before their first
chatter command) is not known.

## Herdr 0.9.1 here and the 0.9.3 docs
- Protocol 22 on both (`herdr status`: `private_protocol: 22`).
- `herdr --help` (0.9.1) does not list `plugin`, but `herdr plugin` exists with the install, link, list, log and
  config-dir commands the docs describe.
- `agent prompt` to a custom-labelled agent: refused in 0.9.1 (see the recipe). The 0.9.3 integrations page shows custom
  labels for `report-agent` and says nothing about prompts needing a supported kind; not checked on 0.9.3. Real
  agents (claude, codex, letta, ...) are supported kinds, so production delivery is not affected (inferred).
- `update.version_check` and `update.manifest_check` exist in 0.9.1's default config, as in the 0.9.3 reference.

## Not verified
- That the throwaway server made no network request (config set, nothing in its log; no trace).
- `_reap` on `pane.closed` and `worktree.removed`; a real agent harness receiving deliveries (dummies only); Herdr
  0.9.3; production; the tailnet identity path (every request used a bearer token).
- The plan's V0 note asks V3 to show isolation while a default server runs; the interlocks refuse to run then and this
  task never starts the real Herdr, so it was not done.

## Results

Root suite: `CHATTER_JS=/home/cyanfam/src/chatter/dist/bin/chatter.js npm test`: 215 pass, 0 skipped. Interlock tests:
15 pass; two mutations of `interlocks.mjs` (an accepting socket counted as nobody listening, the `HERDR_*` check
removed) turned 1 and 2 of them red. After each run: no herdr process, `$ISO` gone, real directories' hash
`01db012167418331` as at the start, `~/src/chatter-prod` still clean apart from its three patched `dist` files.

Runs A and B below are pasted as printed. A later edit changed only the header of a run that starts no Herdr; a
confirming run on the final code (7db769) gave the same verdicts row for row.

### Interrupted run (SIGINT)
The harness started detached, `kill -INT` sent to its pid only (not its process group, so the bridge had to be stopped
by the teardown) while check 1b ran. Run 95124a: I1 to I6 and 1a pass, then

| id | expected | observed | verdict |
|---|---|---|---|
| X | The run completes |  | blocked: interrupted by SIGINT |
| T | Teardown: ... | message POSTs in the bridge logs: 2, rows in the repo's messages table: 4; bridges left: 0; herdr server stop exit 0; processes that had to be signalled: 0; HOME=$ISO left: 0; $ISO removed; herdr processes (ps -eo comm \| grep -cx herdr): 0; real dirs: 1495 entries, sha256 01db012167418331 (start 01db012167418331) | pass |

### Final run A
real-herdr smoke, run 110b92, 2026-10-13T10:37:18.394Z: herdr: herdr 0.9.1, server protocol 22, node v22.16.0, $ISO=/run/user/1000/hv-smoke

| id | expected | observed | verdict |
|---|---|---|---|
| I1 | Preconditions, before anything starts: nothing accepts a connection on the real default socket; the real Herdr directories are hashed; no herdr process runs; $ISO does not exist; CHATTER_JS is the production-identical copy with the upstream manifest | sockets: /home/cyanfam/.config/herdr/herdr.sock: absent; herdr processes: 0; real dirs: 1495 entries, sha256 01db012167418331; chatter: 4/4 production hashes, manifest upstream: yes; herdr: /home/cyanfam/.local/bin/herdr | pass |
| I2 | A Herdr server under HOME=$ISO only, update and manifest checks off, Chatter linked from the production-identical copy, its startup hook run | herdr 0.9.1, protocol 22, server pid 665213, socket /run/user/1000/hv-smoke/.config/herdr/herdr.sock; config.toml [update] version_check=false manifest_check=false; plugin linked (local, enabled) from /home/cyanfam/src/chatter-prod; startup hook succeeded: "chatter startup: ready"; state-dir pointer = /run/user/1000/hv-smoke/.local/state/herdr/plugins/chatter | pass |
| I3 | Dummy panes: alpha and coder (agents of the repo), plain (cat, not an agent), outsider (an agent of another repo); each agent registered by `chatter whoami` in its own pane, then replaced by the dummy | alpha w1:p1 agent=pi status=idle fg=pi; coder w1:p2 agent=pi status=idle fg=pi; outsider w2:p1 agent=pi status=idle fg=pi; plain w1:p3 fg=cat, not an agent; agents table: repo [alpha@w1:p1, coder@w1:p2], other [outsider] | pass |
| I4 | The bridge as deployed: `node bridge/bin/chatter-bridge.js serve --host 127.0.0.1 --port <free>` with HOME=$ISO, the throwaway socket, state, admin config and CHATTER_CMD of the production-identical Chatter; the admin made by the CLI | pid 665469, port 39359; CHATTER_CMD [node, --no-warnings, --experimental-sqlite, /home/cyanfam/src/chatter-prod/dist/bin/chatter.js]; CHATTER_STATE_DIR = plugin state dir; admin "flan" by `init`, its token by `token rotate` (captured, not printed); /healthz 200 {"ok":true,"version":"0.1.0","repos":2} | pass |
| I5 | Pre-send gate: the bridge's /proc/<pid>/environ has HOME=$ISO, HERDR_SOCKET_PATH under $ISO, no HERDR_PANE_*; nothing accepts on the real socket; the real dirs are unchanged; every herdr process runs with HOME=$ISO; every dummy agent is deliverable | bridge env: HOME=$ISO, HERDR_SOCKET_PATH=/run/user/1000/hv-smoke/.config/herdr/herdr.sock, Herdr keys [HERDR_BIN_PATH, HERDR_SOCKET_PATH], CHATTER_STATE_DIR, CHATTER_BRIDGE_STATE_DIR and CHATTER_ADMIN_CONFIG_DIR under $ISO; /home/cyanfam/.config/herdr/herdr.sock: absent; real dirs sha256 01db012167418331 (unchanged); herdr processes 1, all HOME=$ISO; dummies deliverable | pass |
| I6 | Members added through the API by the admin: ada (computational, may address agents), rex (computational, can_address_agents off), grace and thom (computational), zed (human, no token); the repo is listed | 5 members added (201 each), tokens captured for ada, rex, grace, thom; repo repo-9ff19eab (2 repos listed); rex can_address_agents=false | pass |
| 1a | A permitted member's @mention of an idle agent: 201, pushed ["alpha"], delivery null (a post); alpha's pane shows it as a #chat mention from ada | 201 pushed=["alpha"] delivery=null; pane: "[chatter] #chat mention from ada: @alpha M1A-110b92 hello from the smoke / (reply: chatter post "@ada ..." · new here: chatter help)"; mention row delivered_at=2026-10-13 10:36:58 read_at=null | pass |
| 1b | Queued when the pane is not ready: with alpha reported blocked, pushed ["alpha (queued)"] and nothing in the pane; reported idle, the plugin's pane.agent_status_changed hook (_flush) delivers it | 201 pushed=["alpha (queued)"]; in the pane while blocked: no; row delivered_at while blocked: null; after "report-agent --state idle": in the pane after 260 ms ("[chatter] #chat mention from ada: @alpha M1B-110b92 sent while alpha is blocked"), delivered_at=2026-10-13 10:37:00, read_at=null; hook: pane.agent_status_changed -> "flushed 1" | pass |
| 1c | A mention longer than 700 characters: the pane shows the first 700 and production's patched notice "[TRUNCATED: showing 700 of N chars; ...]"; read_at stays NULL after the terminal submission (the patch) | 201; body 1000 chars, stored in full (1000); pane: "...fffffffffffffffffffffffffffffffffffffff [TRUNCATED: showing 700 of 1000 chars; read the full message with: chatter inbox --all] (reply: chatter post "@ada ...")"; text past 700 in the pane: no; mention row delivered_at=2026-10-13 10:37:00 read_at=NULL | pass |
| 2 | A DM from a member to an agent: 201, delivery "delivered"; the pane shows the text attributed to the sender, with a reply hint naming the sender | 201 delivery=delivered pushed=[]; pane: "[chatter] message from ada: M2-110b92 a direct message to alpha / (reply: chatter send ada "...")"; row ada->alpha kind=chat delivered_at=2026-10-13 10:37:00 read_at=NULL | pass |
| 3 | The admin's @everyone reaches every live dummy agent of the repo and no other pane: pushes = live dummy agents of the repo; plain (not an agent) and outsider (an agent of another repo) get nothing | 201 pushed=["alpha","coder"] (2) for live dummy agents of the repo ["alpha","coder"] (2); panes with the text: alpha, coder; plain and outsider unchanged: yes; 4 panes in all | pass |
| 4 | A restricted member (can_address_agents off): a mention and a DM of an agent answer 403 agents_not_allowed; nothing in any pane, nothing written, nothing audited as a push | mention 403 agents_not_allowed, DM 403 agents_not_allowed; panes changed: none; rows written: 0; audit entries by rex since: 0 | pass |
| 5 | A non-admin's @everyone and @everyoneX answer 403 everyone_admin_only (ada, who may address agents, and rex); rex's @codX (only a case-sensitive prefix of "coder" as Chatter reads it) answers 403 agents_not_allowed; nothing in any pane | ada @everyone: 403 everyone_admin_only; ada @everyoneX: 403 everyone_admin_only; rex @everyoneX: 403 everyone_admin_only; rex @codX: 403 agents_not_allowed; panes changed: none; rows written: 0 | pass |
| 6a | Revocation ends a live stream with bye revoked, and the token is refused afterwards (401) | stream 200, hello; DELETE /v1/members/grace 200; bye {"reason":"revoked"}; GET /v1/me with the token 401 bad_token | pass |
| 6b | Rotation through the HTTP route ends the old stream with bye token_rotated; the old token answers 401, the new one 200 | POST /v1/members/thom/token 201 (token captured, not printed); bye {"reason":"token_rotated"}; old token 401 bad_token, new token 200 | pass |
| 6c | Rotation through the CLI (`chatter-bridge token rotate thom`, a separate process on the same state directory) ends the open stream with bye token_rotated within about 2 s | CLI rotate exit 0 (token captured, not printed); bye {"reason":"token_rotated"} after 1988 ms; old token 401 bad_token | pass |
| 9 | A broken Chatter command (a second bridge on the same state, CHATTER_CMD pointing at a missing script): /healthz and /v1/repos answer 502 with the fixed message, to a member and to the admin; the detail is in the bridge's log; no path in any answer | /healthz: 502 {"error":{"code":"chatter_error","message":"Chatter could not list the repositories"}}; /v1/repos as ada: 502 {"error":{"code":"chatter_error","message":"Chatter could not list the repositories"}}; /v1/repos as admin: 502 {"error":{"code":"chatter_error","message":"Chatter could not list the repositories"}}; the log has "chatter data failed (exit 1): node:internal/modules/cjs/loader:1404" followed by "Error: Cannot find module '/run/user/1000/hv-smoke/missing/chatter.js'" | pass |
| 7a | DMs to a prefix of an agent only Herdr knows (zed-helper), as a restricted member (rex) and a permitted one (ada): a bare prefix ("zed-h") is refused 404; a DM to the member "zed" must reach zed only, never the agent (fail closed) | zed-helper (w1:p4): live in Herdr (name=zed-helper, agent=pi, idle, cwd in the repo: yes), in the agents table: no, in /v1/directory: no \|\| rex -> "zed-h": 404 unknown_recipient id=null delivery=null mentioned_members=null; stored no row; in zed-helper's pane: no \|\| ada -> "zed-h": 404 unknown_recipient id=null delivery=null mentioned_members=null; stored no row; in zed-helper's pane: no \|\| rex -> "zed": 201 id=null delivery=null mentioned_members=["zed"]; stored to_agent=zed-helper delivered_at=set; in zed-helper's pane: YES ("[chatter] message from rex: M7A-rex-zed-110b92 a DM from rex to zed / (reply: chatter send...") \|\| ada -> "zed": 201 id=null delivery=null mentioned_members=["zed"]; stored to_agent=zed-helper delivered_at=set; in zed-helper's pane: YES ("[chatter] message from ada: M7A-ada-zed-110b92 a DM from ada to zed / (reply: chatter send...") | fail: BOUNDARY BREAK: rex's DM addressed to member "zed" was typed into zed-helper's terminal; BOUNDARY BREAK: rex's DM to "zed" was stored for zed-helper; BOUNDARY BREAK: ada's DM addressed to member "zed" was typed into zed-helper's terminal; BOUNDARY BREAK: ada's DM to "zed" was stored for zed-helper |
| 7b | Mentions of that agent in #chat by a restricted member (rex): a bare prefix (@zed-h), a member's handle that is its prefix (@zed), its exact name (@zed-helper); and @zed by a permitted member (ada). A restricted member must reach no agent (fail closed) | rex "@zed-h": 201 pushed=["zed-helper"] mentioned_members=[] warnings=[]; in zed-helper's pane: YES \|\| rex "@zed": 201 pushed=["zed-helper"] mentioned_members=["zed"] warnings=[]; in zed-helper's pane: YES \|\| rex "@zed-helper": 201 pushed=["zed-helper"] mentioned_members=[] warnings=[]; in zed-helper's pane: YES \|\| ada "@zed": 201 pushed=["zed-helper"] mentioned_members=["zed"] warnings=[]; in zed-helper's pane: YES | fail: BOUNDARY BREAK: restricted member rex reached zed-helper with "@zed-h"; BOUNDARY BREAK: restricted member rex reached zed-helper with "@zed"; BOUNDARY BREAK: restricted member rex reached zed-helper with "@zed-helper" |
| 8 | The audit log (GET /v1/audit as the admin) holds every push into an agent terminal, the @everyone and the registry changes, with the right actors; nothing by rex in check 4's window | 21 entries: ada push_agent x4, rex push_agent x3, cli token_rotate x2, flan token_rotate x1, flan member_revoke x1, flan everyone x1, flan push_agent x2, ada dm_agent x1, flan member_add x5, cli init x1; everyone detail.pushed=["alpha","coder"]; registry entries present: 11/11; pushes seen in panes vs audited: rex->zed-helper: 4 seen in the pane, 3 audited; ada->zed-helper: 2 seen in the pane, 1 audited | fail: terminal pushes without an audit entry: rex->zed-helper: 4 seen in the pane, 3 audited; ada->zed-helper: 2 seen in the pane, 1 audited |
| T | Teardown: bridges stopped, the throwaway server stopped through its socket, nothing left with HOME=$ISO, $ISO removed; no herdr process left (by command name); the real Herdr directories unchanged | message POSTs in the bridge logs: 19, rows in the repo's messages table: 20; bridges left: 0; herdr server stop exit 0; processes that had to be signalled: 0; HOME=$ISO left: 0; $ISO removed; herdr processes (ps -eo comm \| grep -cx herdr): 0; real dirs: 1495 entries, sha256 01db012167418331 (start 01db012167418331) | pass |

NOT PASSED: 7a fail, 7b fail, 8 fail

### Final run B (same code, run again right after)
real-herdr smoke, run e29839, 2026-10-13T10:37:40.522Z: herdr: herdr 0.9.1, server protocol 22, node v22.16.0, $ISO=/run/user/1000/hv-smoke

| id | expected | observed | verdict |
|---|---|---|---|
| I1 | Preconditions, before anything starts: nothing accepts a connection on the real default socket; the real Herdr directories are hashed; no herdr process runs; $ISO does not exist; CHATTER_JS is the production-identical copy with the upstream manifest | sockets: /home/cyanfam/.config/herdr/herdr.sock: absent; herdr processes: 0; real dirs: 1495 entries, sha256 01db012167418331; chatter: 4/4 production hashes, manifest upstream: yes; herdr: /home/cyanfam/.local/bin/herdr | pass |
| I2 | A Herdr server under HOME=$ISO only, update and manifest checks off, Chatter linked from the production-identical copy, its startup hook run | herdr 0.9.1, protocol 22, server pid 666100, socket /run/user/1000/hv-smoke/.config/herdr/herdr.sock; config.toml [update] version_check=false manifest_check=false; plugin linked (local, enabled) from /home/cyanfam/src/chatter-prod; startup hook succeeded: "chatter startup: ready"; state-dir pointer = /run/user/1000/hv-smoke/.local/state/herdr/plugins/chatter | pass |
| I3 | Dummy panes: alpha and coder (agents of the repo), plain (cat, not an agent), outsider (an agent of another repo); each agent registered by `chatter whoami` in its own pane, then replaced by the dummy | alpha w1:p1 agent=pi status=idle fg=pi; coder w1:p2 agent=pi status=idle fg=pi; outsider w2:p1 agent=pi status=idle fg=pi; plain w1:p3 fg=cat, not an agent; agents table: repo [alpha@w1:p1, coder@w1:p2], other [outsider] | pass |
| I4 | The bridge as deployed: `node bridge/bin/chatter-bridge.js serve --host 127.0.0.1 --port <free>` with HOME=$ISO, the throwaway socket, state, admin config and CHATTER_CMD of the production-identical Chatter; the admin made by the CLI | pid 666356, port 43155; CHATTER_CMD [node, --no-warnings, --experimental-sqlite, /home/cyanfam/src/chatter-prod/dist/bin/chatter.js]; CHATTER_STATE_DIR = plugin state dir; admin "flan" by `init`, its token by `token rotate` (captured, not printed); /healthz 200 {"ok":true,"version":"0.1.0","repos":2} | pass |
| I5 | Pre-send gate: the bridge's /proc/<pid>/environ has HOME=$ISO, HERDR_SOCKET_PATH under $ISO, no HERDR_PANE_*; nothing accepts on the real socket; the real dirs are unchanged; every herdr process runs with HOME=$ISO; every dummy agent is deliverable | bridge env: HOME=$ISO, HERDR_SOCKET_PATH=/run/user/1000/hv-smoke/.config/herdr/herdr.sock, Herdr keys [HERDR_BIN_PATH, HERDR_SOCKET_PATH], CHATTER_STATE_DIR, CHATTER_BRIDGE_STATE_DIR and CHATTER_ADMIN_CONFIG_DIR under $ISO; /home/cyanfam/.config/herdr/herdr.sock: absent; real dirs sha256 01db012167418331 (unchanged); herdr processes 1, all HOME=$ISO; dummies deliverable | pass |
| I6 | Members added through the API by the admin: ada (computational, may address agents), rex (computational, can_address_agents off), grace and thom (computational), zed (human, no token); the repo is listed | 5 members added (201 each), tokens captured for ada, rex, grace, thom; repo repo-9ff19eab (2 repos listed); rex can_address_agents=false | pass |
| 1a | A permitted member's @mention of an idle agent: 201, pushed ["alpha"], delivery null (a post); alpha's pane shows it as a #chat mention from ada | 201 pushed=["alpha"] delivery=null; pane: "[chatter] #chat mention from ada: @alpha M1A-e29839 hello from the smoke / (reply: chatter post "@ada ..." · new here: chatter help)"; mention row delivered_at=2026-10-13 10:37:20 read_at=null | pass |
| 1b | Queued when the pane is not ready: with alpha reported blocked, pushed ["alpha (queued)"] and nothing in the pane; reported idle, the plugin's pane.agent_status_changed hook (_flush) delivers it | 201 pushed=["alpha (queued)"]; in the pane while blocked: no; row delivered_at while blocked: null; after "report-agent --state idle": in the pane after 271 ms ("[chatter] #chat mention from ada: @alpha M1B-e29839 sent while alpha is blocked"), delivered_at=2026-10-13 10:37:22, read_at=null; hook: pane.agent_status_changed -> "flushed 1" | pass |
| 1c | A mention longer than 700 characters: the pane shows the first 700 and production's patched notice "[TRUNCATED: showing 700 of N chars; ...]"; read_at stays NULL after the terminal submission (the patch) | 201; body 1000 chars, stored in full (1000); pane: "...fffffffffffffffffffffffffffffffffffffff [TRUNCATED: showing 700 of 1000 chars; read the full message with: chatter inbox --all] (reply: chatter post "@ada ...")"; text past 700 in the pane: no; mention row delivered_at=2026-10-13 10:37:22 read_at=NULL | pass |
| 2 | A DM from a member to an agent: 201, delivery "delivered"; the pane shows the text attributed to the sender, with a reply hint naming the sender | 201 delivery=delivered pushed=[]; pane: "[chatter] message from ada: M2-e29839 a direct message to alpha / (reply: chatter send ada "...")"; row ada->alpha kind=chat delivered_at=2026-10-13 10:37:23 read_at=NULL | pass |
| 3 | The admin's @everyone reaches every live dummy agent of the repo and no other pane: pushes = live dummy agents of the repo; plain (not an agent) and outsider (an agent of another repo) get nothing | 201 pushed=["alpha","coder"] (2) for live dummy agents of the repo ["alpha","coder"] (2); panes with the text: alpha, coder; plain and outsider unchanged: yes; 4 panes in all | pass |
| 4 | A restricted member (can_address_agents off): a mention and a DM of an agent answer 403 agents_not_allowed; nothing in any pane, nothing written, nothing audited as a push | mention 403 agents_not_allowed, DM 403 agents_not_allowed; panes changed: none; rows written: 0; audit entries by rex since: 0 | pass |
| 5 | A non-admin's @everyone and @everyoneX answer 403 everyone_admin_only (ada, who may address agents, and rex); rex's @codX (only a case-sensitive prefix of "coder" as Chatter reads it) answers 403 agents_not_allowed; nothing in any pane | ada @everyone: 403 everyone_admin_only; ada @everyoneX: 403 everyone_admin_only; rex @everyoneX: 403 everyone_admin_only; rex @codX: 403 agents_not_allowed; panes changed: none; rows written: 0 | pass |
| 6a | Revocation ends a live stream with bye revoked, and the token is refused afterwards (401) | stream 200, hello; DELETE /v1/members/grace 200; bye {"reason":"revoked"}; GET /v1/me with the token 401 bad_token | pass |
| 6b | Rotation through the HTTP route ends the old stream with bye token_rotated; the old token answers 401, the new one 200 | POST /v1/members/thom/token 201 (token captured, not printed); bye {"reason":"token_rotated"}; old token 401 bad_token, new token 200 | pass |
| 6c | Rotation through the CLI (`chatter-bridge token rotate thom`, a separate process on the same state directory) ends the open stream with bye token_rotated within about 2 s | CLI rotate exit 0 (token captured, not printed); bye {"reason":"token_rotated"} after 1982 ms; old token 401 bad_token | pass |
| 9 | A broken Chatter command (a second bridge on the same state, CHATTER_CMD pointing at a missing script): /healthz and /v1/repos answer 502 with the fixed message, to a member and to the admin; the detail is in the bridge's log; no path in any answer | /healthz: 502 {"error":{"code":"chatter_error","message":"Chatter could not list the repositories"}}; /v1/repos as ada: 502 {"error":{"code":"chatter_error","message":"Chatter could not list the repositories"}}; /v1/repos as admin: 502 {"error":{"code":"chatter_error","message":"Chatter could not list the repositories"}}; the log has "chatter data failed (exit 1): node:internal/modules/cjs/loader:1404" followed by "Error: Cannot find module '/run/user/1000/hv-smoke/missing/chatter.js'" | pass |
| 7a | DMs to a prefix of an agent only Herdr knows (zed-helper), as a restricted member (rex) and a permitted one (ada): a bare prefix ("zed-h") is refused 404; a DM to the member "zed" must reach zed only, never the agent (fail closed) | zed-helper (w1:p4): live in Herdr (name=zed-helper, agent=pi, idle, cwd in the repo: yes), in the agents table: no, in /v1/directory: no \|\| rex -> "zed-h": 404 unknown_recipient id=null delivery=null mentioned_members=null; stored no row; in zed-helper's pane: no \|\| ada -> "zed-h": 404 unknown_recipient id=null delivery=null mentioned_members=null; stored no row; in zed-helper's pane: no \|\| rex -> "zed": 201 id=null delivery=null mentioned_members=["zed"]; stored to_agent=zed-helper delivered_at=set; in zed-helper's pane: YES ("[chatter] message from rex: M7A-rex-zed-e29839 a DM from rex to zed / (reply: chatter send...") \|\| ada -> "zed": 201 id=null delivery=null mentioned_members=["zed"]; stored to_agent=zed-helper delivered_at=set; in zed-helper's pane: YES ("[chatter] message from ada: M7A-ada-zed-e29839 a DM from ada to zed / (reply: chatter send...") | fail: BOUNDARY BREAK: rex's DM addressed to member "zed" was typed into zed-helper's terminal; BOUNDARY BREAK: rex's DM to "zed" was stored for zed-helper; BOUNDARY BREAK: ada's DM addressed to member "zed" was typed into zed-helper's terminal; BOUNDARY BREAK: ada's DM to "zed" was stored for zed-helper |
| 7b | Mentions of that agent in #chat by a restricted member (rex): a bare prefix (@zed-h), a member's handle that is its prefix (@zed), its exact name (@zed-helper); and @zed by a permitted member (ada). A restricted member must reach no agent (fail closed) | rex "@zed-h": 201 pushed=["zed-helper"] mentioned_members=[] warnings=[]; in zed-helper's pane: YES \|\| rex "@zed": 201 pushed=["zed-helper"] mentioned_members=["zed"] warnings=[]; in zed-helper's pane: YES \|\| rex "@zed-helper": 201 pushed=["zed-helper"] mentioned_members=[] warnings=[]; in zed-helper's pane: YES \|\| ada "@zed": 201 pushed=["zed-helper"] mentioned_members=["zed"] warnings=[]; in zed-helper's pane: YES | fail: BOUNDARY BREAK: restricted member rex reached zed-helper with "@zed-h"; BOUNDARY BREAK: restricted member rex reached zed-helper with "@zed"; BOUNDARY BREAK: restricted member rex reached zed-helper with "@zed-helper" |
| 8 | The audit log (GET /v1/audit as the admin) holds every push into an agent terminal, the @everyone and the registry changes, with the right actors; nothing by rex in check 4's window | 21 entries: ada push_agent x4, rex push_agent x3, cli token_rotate x2, flan token_rotate x1, flan member_revoke x1, flan everyone x1, flan push_agent x2, ada dm_agent x1, flan member_add x5, cli init x1; everyone detail.pushed=["alpha","coder"]; registry entries present: 11/11; pushes seen in panes vs audited: rex->zed-helper: 4 seen in the pane, 3 audited; ada->zed-helper: 2 seen in the pane, 1 audited | fail: terminal pushes without an audit entry: rex->zed-helper: 4 seen in the pane, 3 audited; ada->zed-helper: 2 seen in the pane, 1 audited |
| T | Teardown: bridges stopped, the throwaway server stopped through its socket, nothing left with HOME=$ISO, $ISO removed; no herdr process left (by command name); the real Herdr directories unchanged | message POSTs in the bridge logs: 19, rows in the repo's messages table: 20; bridges left: 0; herdr server stop exit 0; processes that had to be signalled: 0; HOME=$ISO left: 0; $ISO removed; herdr processes (ps -eo comm \| grep -cx herdr): 0; real dirs: 1495 entries, sha256 01db012167418331 (start 01db012167418331) | pass |

NOT PASSED: 7a fail, 7b fail, 8 fail

### A failed interlock aborts before any send
A guard socket (`SMOKE_EXTRA_GUARD_SOCKETS=/run/user/1000/hv-guard.sock`) that a helper starts listening on only once the
throwaway server's socket exists, so I1 passes and the pre-send gate (I5) meets it:

```sh
G=/run/user/$(id -u)/hv-guard.sock
node -e "const fs=require('fs'),net=require('net');const [g,t]=process.argv.slice(1);const i=setInterval(()=>{if(fs.existsSync(t)){clearInterval(i);net.createServer(c=>c.end()).listen(g);}},50);setTimeout(()=>process.exit(0),120000);" $G /run/user/$(id -u)/hv-smoke/.config/herdr/herdr.sock &
SMOKE_EXTRA_GUARD_SOCKETS=$G CHATTER_JS=/home/cyanfam/src/chatter-prod/dist/bin/chatter.js node deploy/smoke/real-herdr-smoke.mjs; kill %1; rm -f $G
```

Run 36064c (exit 1): I1 (both sockets absent at the start), I2, I3 and I4 pass, then (expected column shortened here):

| id | expected | observed | verdict |
|---|---|---|---|
| I5 | Pre-send gate: ... | bridge env: HOME=$ISO, HERDR_SOCKET_PATH=/run/user/1000/hv-smoke/.config/herdr/herdr.sock, Herdr keys [HERDR_BIN_PATH, HERDR_SOCKET_PATH], CHATTER_STATE_DIR, CHATTER_BRIDGE_STATE_DIR and CHATTER_ADMIN_CONFIG_DIR under $ISO; preflight refused (see verdict); herdr processes 1, all HOME=$ISO; dummies deliverable | blocked: precondition failed: /run/user/1000/hv-guard.sock accepts a connection |
| T | Teardown: ... | message POSTs in the bridge logs: 0, rows in the repo's messages table: 0; bridges left: 0; herdr server stop exit 0; processes that had to be signalled: 0; HOME=$ISO left: 0; $ISO removed; herdr processes (ps -eo comm \| grep -cx herdr): 0; real dirs: 1495 entries, sha256 01db012167418331 (start 01db012167418331) | pass |

NOT PASSED: I5 blocked

With the guard socket listening from the start (run 55215c, exit 1), nothing is started:

| id | expected | observed | verdict |
|---|---|---|---|
| I1 | Preconditions, before anything starts: ... | sockets: not judged; herdr processes: 0; real dirs: 1495 entries, sha256 01db012167418331; chatter: 4/4 production hashes, manifest upstream: yes; herdr: /home/cyanfam/.local/bin/herdr | blocked: precondition failed: /run/user/1000/hv-guard.sock accepts a connection |
| T | Teardown: ... | nothing to count; bridges left: 0; not started; processes that had to be signalled: 0; HOME=$ISO left: 0; $ISO never created; herdr processes (ps -eo comm \| grep -cx herdr): 0; real dirs: 1495 entries, sha256 01db012167418331 (start 01db012167418331) | pass |

NOT PASSED: I1 blocked
