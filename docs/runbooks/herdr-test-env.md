# A throwaway Herdr for tests (V0 result, 2026-10-13)

Use this for every test that needs a real Herdr (`docs/plans/deploy-verify.md`, V3 and V4). It shares nothing with any
other Herdr on the machine. Never use it on `baremetalcyansociety`, and never point a test at a Herdr you did not start
from this recipe: an admin `@everyone` types into every live agent's terminal.

## Recipe
```sh
ISO=/run/user/$(id -u)/hv            # a short path: a socket path over about 100 characters fails
mkdir -p "$ISO"
HOME="$ISO" nohup herdr server > "$ISO/server.out" 2>&1 &     # a headless server
H() { HOME="$ISO" herdr "$@"; }
H status                                                         # running; socket under $ISO
H workspace create --cwd "$ISO" --label v0 --no-focus            # a workspace with one pane, w1:p1
H pane run w1:p1 cat                                             # a dummy receiver
H pane send-text w1:p1 'hello'; H pane send-keys w1:p1 Enter
H pane read w1:p1 --source visible --lines 6                     # what the pane received
# teardown
H server stop; rm -rf "$ISO"
```

## Why `HOME` and not `--session`
Herdr's own documentation (v0.9.3; the laptop runs 0.9.1) says a named session "has its own panes, tabs, workspaces,
sockets, and runtime state" but "still shares the same global config file", and plugin state lives under the user's
home (`~/.local/state/herdr/plugins/<id>`), the same place for every session. Overriding `HOME` moves all of it: the
socket (`$HOME/.config/herdr/herdr.sock`), the config, the logs, the agent-detection state and the plugin state
directories. Panes inherit `HOME`, so anything run inside them (Chatter included) stays inside the throwaway home.

## What was observed (Herdr 0.9.1 on `pop-os-laptop`)
- With `HOME=/run/user/1000/hv`, `herdr status` reports the socket `/run/user/1000/hv/.config/herdr/herdr.sock`. With a
  long `HOME` it fails with "local socket name length exceeds capacity of sun_path": that is why the path is short, and
  why `$XDG_RUNTIME_DIR` is used rather than a scratch directory.
- While that server ran, the real home's `herdr status` said "not running", `herdr pane list` answered
  `server_not_running`, and `ps` showed exactly one `herdr server` (the throwaway one).
- Every file the server created is under `$ISO` (`.config/herdr/` with the sockets, the log and `.plugins.lock`;
  `.local/state/herdr/agent-detection`). A hash of the names, sizes and mtimes of `~/.config/herdr` and
  `~/.local/state/herdr` (1495 entries) was identical before, during and after.
- A pane's environment held `HOME=$ISO`, `HERDR_SOCKET_PATH=$ISO/.config/herdr/herdr.sock`, `HERDR_BIN_PATH`,
  `HERDR_ENV=1`, `HERDR_PANE_ID=w1:p1`, `HERDR_WORKSPACE_ID=w1` and `HERDR_TAB_ID=w1:t1`. The dummy `cat` received the text.
- After `server stop` and `rm -rf`, no `herdr` process was left and the real directories were unchanged.

## Rules that follow
- Start every test Herdr this way, check that the real home's `herdr status` is unchanged before and after, and stop it
  and delete `$ISO` at the end.
- Point the bridge's Chatter at the same home: `HERDR_SOCKET_PATH=$ISO/.config/herdr/herdr.sock`, `HERDR_BIN_PATH` the
  real `herdr`, and a throwaway `CHATTER_STATE_DIR` (passed to Chatter as `HERDR_PLUGIN_STATE_DIR`).
- Dummy agents are panes running a program that only prints what it receives; no model runs in them.
- Not covered here: how a pane becomes a registered Chatter agent (V3 works that out); that Herdr 0.9.3 (production)
  behaves as 0.9.1 does (the protocol is 22 in both; record any difference V3 meets).
