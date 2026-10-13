# Deploy the Chatter bridge (V1 and V2 of the deploy-and-verify slice)

Build the web client, place a release, run the bridge as a systemd user service, publish it on the tailnet, check it,
upgrade it, roll it back. Written for the host where the bridge is really installed.

**What was verified (2026-10-13, `pop-os-laptop`, nothing installed or enabled, no Herdr touched):** the build script (a
real build from the lockfile, twice, same hash), `systemd-analyze --user verify` on the unit, and a bridge started by
hand with the env-file settings against throwaway state: `/healthz`, the CSP header on `/`, the page with its script, a
bearer-token call and an event stream. **Not verified:** the unit running under systemd, `tailscale serve`, signing in
as a human through Tailscale identity, delivery into any Herdr pane (that is V3), and anything on
`baremetalcyansociety`. Steps that rest on the systemd or Tailscale manuals alone are marked "(not run)".

## Names used below

| Name | Default here | Notes |
| --- | --- | --- |
| checkout | `~/Chatter-Herdr-Plugin-GUI-App` | The unit's `WorkingDirectory`. The bridge's own code runs from here, and so does the build script. |
| releases | `~/chatter-bridge/releases` | `<git-sha>/dist` per release, and a relative symlink `current` that the unit's `CHATTER_BRIDGE_STATIC_DIR` goes through. |
| env file | `~/.config/chatter-bridge/env` | Optional. `deploy/chatter-bridge.env.example` documents every variable. |
| state | `~/.local/state/chatter-bridge` | `CHATTER_BRIDGE_STATE_DIR`. What to back up. |
| ports | `8791` (loopback), `8446` (tailnet) | Funnel can only use 443, 8443 and 10000, so 8446 cannot be exposed to the internet by accident. |

Keep the releases outside the checkout: inside it they would show as untracked files and make every later build `-dirty`.

## 1. Prerequisites
- Linux with a systemd user manager. A host that must run the bridge without anyone logged in needs lingering:
  `loginctl show-user $USER -p Linger` (not run).
- Node 22.13 or later. The client needs it to build (`client/package.json`); the bridge needs 22.5, and from 22.13
  `node:sqlite` needs no `--experimental-sqlite` flag, so the unit has none. The unit runs `/usr/bin/node`: check
  `/usr/bin/node --version`. The laptop's `/usr/bin/node` is v18.19.1, so there the unit's `ExecStart` must name another
  node. Production has `/usr/bin/node` 22.22.1.
- `npm` with access to the npm registry (`npm ci` fetches from the lockfile and runs no install scripts), `git`,
  `sha256sum` or `shasum`, `diff`, and `curl` 7.55 or later for the stream check below.
- Chatter installed as a Herdr plugin with `chatter` on the unit's `PATH` (the unit's `PATH` starts with `%h/.local/bin`).
- Tailscale with HTTPS certificates enabled.
- Ports 8791 and 8446 free: `ss -ltn`.

## 2. Build and place a release
Check out the commit to deploy, then build. The release is named by the commit, so the bridge code (the checkout) and
the client (the release) come from the same one.

```sh
cd ~/Chatter-Herdr-Plugin-GUI-App
git fetch && git checkout <commit>
RELEASES_DIR=~/chatter-bridge/releases deploy/build-client.sh
```

The script runs `npm ci --ignore-scripts`, `npm run build` and `npm run check:dist` in `client/`, and prints success
only after all three pass and the release is in place. Then it prints:

```
build-client: OK
revision: <12-character sha>          # ends in -dirty when the checkout has uncommitted or untracked changes
dist: <checkout>/client/dist
index.html sha256: <64 hex digits>    # the same commit gives the same value
release: ~/chatter-bridge/releases/<revision>/dist
current: ~/chatter-bridge/releases/current -> <revision>
```

- Serve only a release whose `revision` has no `-dirty`. A dirty build is named `<sha>-dirty-<8 hex of the hash>`, so it
  never replaces another release.
- A release is never changed once placed: building the same commit again reuses it if the files are identical and fails
  if they differ (a running bridge may be serving that directory). Remove one only when nothing serves it.
- `current` moves last and atomically. The script never restarts anything. The bridge resolves the static root's real path
  once, at start, so a running bridge keeps serving the release it started with until it is restarted.
- Without `RELEASES_DIR` the script only builds into `client/dist` (useful for a check; the unit does not read that).

## 3. Configure
Optional: the unit works with its own settings on a host where Chatter is in its default place.

```sh
mkdir -p ~/.config/chatter-bridge
cp deploy/chatter-bridge.env.example ~/.config/chatter-bridge/env && chmod 600 ~/.config/chatter-bridge/env
# uncomment and edit what the host needs (production: see section 11)
```

The file follows systemd's rules, not a shell's: absolute paths, no `$VAR` or `~`, single quotes round a value that has
double quotes. It holds no token. A value in it wins over the unit's `Environment=` lines.

Create the admin and the first members with the env file's variables, or the CLI edits another registry. Sourcing the
file does not bring in the unit's own `Environment=` lines (`PATH`, `CHATTER_CMD`): `member add` runs `chatter` to check the
agent names, so make sure `command -v chatter` in this shell is the `chatter` the service will run.

```sh
cd ~/Chatter-Herdr-Plugin-GUI-App
set -a; . ~/.config/chatter-bridge/env; set +a      # skip when there is no env file
node --no-warnings bridge/bin/chatter-bridge.js init --handle <name> --login <tailscale-login>
node --no-warnings bridge/bin/chatter-bridge.js member add <handle> --kind computational     # the token is shown once
```

The example's forms (a plain `KEY=/absolute/path`, and single-quoted JSON for `CHATTER_CMD`) are valid for both `sh` and
systemd. Checked here: `sh` keeps the single-quoted JSON intact. systemd's side follows `man systemd.exec` and was not
run. `serve` refuses to start until an admin exists.

The state directory holds `bridge.db` (token hashes among other things). It is created with the account's umask; run
`chmod 700 ~/.local/state/chatter-bridge` (or your `CHATTER_BRIDGE_STATE_DIR`) so other local accounts cannot read it.

## 4. Install the unit and start it
Only on the host where the bridge is really installed.

```sh
mkdir -p ~/.config/systemd/user
cp deploy/chatter-bridge.service ~/.config/systemd/user/
# edit the lines marked CHANGE: WorkingDirectory, PATH, the node in ExecStart, the releases path
systemd-analyze --user verify ~/.config/systemd/user/chatter-bridge.service
systemctl --user daemon-reload && systemctl --user enable --now chatter-bridge
systemctl --user status chatter-bridge
journalctl --user -u chatter-bridge -n 30
```

`systemd-analyze --user verify` printed nothing and exited 0 on the laptop. A host without `/usr/bin/node` gets a warning
about that path and nothing else should appear. The hardening lines (`NoNewPrivileges`, `PrivateTmp`) are untested on a real
host. If the service stops at once, `journalctl` says why: no admin yet, no `index.html` in the static directory (build and
place a release first), or a port in use.

## 5. Publish on the tailnet (not run)
```sh
tailscale serve --bg --https=8446 http://127.0.0.1:8791
tailscale serve status
```
The page's origin is then `https://<machine>.<tailnet>.ts.net:8446`. Human sign-in rests on `tailscale whois` working as
the service's account; see section 11.

## 6. Verify
First against loopback, on the host:

```sh
curl -sS http://127.0.0.1:8791/healthz
curl -sSI http://127.0.0.1:8791/
curl -sS http://127.0.0.1:8791/
```

- `/healthz` answers `{"ok":true,"version":"0.1.0","repos":N}`; `repos` is the number of Chatter repositories the bridge sees.
- `/` answers 200 with these headers (D15; anything different is a stop):
  ```
  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Frame-Options: DENY
  Cache-Control: no-cache
  ```
- The page holds one module script and one stylesheet, both under `/assets/`
  (`<script type="module" crossorigin src="/assets/index-<hash>.js">`). The sign-in view is that script's work: open
  `/assets/index-<hash>.js` with `curl` and it contains `Access token` and `Enter the access token you were given.`
  Then open the origin in a browser. Expected (not run: it needs the tailnet): a member whose Tailscale login the bridge
  knows is signed in at once, anyone else sees the "Sign in" heading and the "Access token" field.
- A stream, with a throwaway or real computational member's token kept in a file only the account can read, never typed
  on a command line, and not shown on screen while you paste it:
  ```sh
  stty -echo; (umask 077; cat > ~/verify.hdr); stty echo    # paste one line, Authorization: Bearer <token>, Enter, then Ctrl-D
  curl -sS -H @$HOME/verify.hdr http://127.0.0.1:8791/v1/me
  curl -sS -H @$HOME/verify.hdr http://127.0.0.1:8791/v1/repos            # note a "key"
  curl -sSN --max-time 5 -H @$HOME/verify.hdr http://127.0.0.1:8791/v1/repos/<key>/stream
  rm ~/verify.hdr
  ```
  `/v1/me` names the member; the stream answers `200 text/event-stream` with `event: hello` and ends with curl exit 28
  when `--max-time` stops it, which is the intended end. A bridge that sees no repositories answers the stream with
  `404 no_such_repo`: check `CHATTER_STATE_DIR` then.
- Then the same `curl -sSI`, `/healthz` and `/v1/me` against `https://<machine>.<tailnet>.ts.net:8446` from another tailnet
  machine (not run).

## 7. Upgrade
1. In the checkout: `git fetch && git checkout <new-commit>`. The running bridge keeps the code it loaded at start (it has
   no dynamic imports: `grep -rn "import(\|require(" bridge/` finds only two JSDoc comments).
2. `RELEASES_DIR=~/chatter-bridge/releases deploy/build-client.sh`; `revision` must not end in `-dirty`.
3. If the upgrade touches the bridge, copy the state directory first (section 9).
4. `systemctl --user restart chatter-bridge`. This is what switches both the bridge's code and the served client. Open
   streams end with `bye shutdown` and clients reconnect.
5. Verify (section 6).

## 8. Roll back
The releases are named by commit, so the previous one names the commit to return to. A release is only the client: also put
the checkout back, or the bridge's code and the client no longer match.

```sh
ls -l ~/chatter-bridge/releases                      # the previous release; a -dirty one has no commit to return to
git -C ~/Chatter-Herdr-Plugin-GUI-App checkout <previous-sha>
ln -s <previous-release> ~/chatter-bridge/releases/current.new
mv -T ~/chatter-bridge/releases/current.new ~/chatter-bridge/releases/current      # GNU mv: an atomic swap
systemctl --user restart chatter-bridge
```

Then verify. Do not delete the release `current` points at, or the one a running bridge started with. Whether an older
bridge reads a `bridge.db` that a newer one has changed is not tested; the copy taken before the upgrade is the way back.

## 9. What to back up
The state directory, `CHATTER_BRIDGE_STATE_DIR` (default `~/.local/state/chatter-bridge`): `bridge.db` (members, token
hashes, the audit log, read pointers) and `members/` (one Chatter config directory per member). Tokens are not stored, only
hashes, so a lost token is replaced with `token rotate`. `bridge.db` runs in WAL mode, so copy while the service is
stopped: `systemctl --user stop chatter-bridge`, copy the directory, `systemctl --user start chatter-bridge`.

Not the bridge's to back up: Chatter's own state (`CHATTER_STATE_DIR`), which belongs to the Chatter plugin. The releases
rebuild from their commits. The env file and the unit are small: keep a copy.

## 10. The archive is bound to the page's origin
From M4 on, a member's archive lives in their browser, under the page's origin (scheme, host and port). A different host
name (a renamed machine, another tailnet) or a different port starts an empty archive in every browser; the old one stays
under the old origin. Choose the host name and the serve port once, and say so before changing either.

## 11. Production install checklist (NOT part of V1 or V2; nothing here has been run)
For `baremetalcyansociety`, account `letta`. Needs Flan's explicit go-ahead and a window (V7). Read-only checks first.

- [ ] `command -v node chatter tailscale`; `/usr/bin/node --version` is 22.13 or later (22.22.1 expected), because that is
  the node the unit runs.
- [ ] `tailscale whois <a tailnet address>` as `letta`. If it is refused, `tailscale set --operator=letta` (run by an
  administrator) is what lets the bridge verify identities; without it no human can sign in through Tailscale.
- [ ] Port 8791 is free, and so is the `tailscale serve` port (8446): `ss -ltn`, `tailscale serve status`. Adding the serve
  listener must not replace anything already published there.
- [ ] The existing user units `collie`, `house-board` and `ws-execd` (`systemctl --user list-units`) do not collide: unit
  name, ports, state directories.
- [ ] Env file: `CHATTER_STATE_DIR=/home/letta/.local/state/herdr/plugins/chatter`, and `CHATTER_CMD=chatter` (the unit's
  default). On production `chatter` is `~/.local/bin/chatter`, a symlink to the checkout's `bin/chatter`, which runs
  `node --no-warnings --experimental-sqlite dist/bin/chatter.js`; the unit's `PATH` includes `%h/.local/bin`, and the
  bridge needs no such flag itself.
- [ ] The bridge runs as `letta`, the account that runs Herdr and the agents (SPEC section 10). Its policy governs the HTTP
  path only: a process running as `letta` can read every Chatter database and edit the bridge's registry. That is a
  known risk to accept for the MVP, not something this install removes.
- [ ] `init --handle <name> --login <login>` (with `--handle`, so it does not depend on the admin config directory), then
  `chmod 700` of the state directory.
- [ ] Lingering is on for `letta` (`loginctl show-user letta -p Linger`), or the service stops at logout.
- [ ] The Chatter on production is the one the 215 tests ran against (`docs/runbooks/chatter-prod/`).
- [ ] The first start is read-only against the real state: `/healthz` lists the six repositories. No `chatter post`, `send`
  or `@everyone`, no test against any pane, and no Herdr start, stop, reload or update.
