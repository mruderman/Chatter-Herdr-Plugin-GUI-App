# Chatter Herdr GUI

A bridge and web client that give every Cyan Society member, human or computational, a graphical group chat on top of the [Chatter](https://github.com/marcvermeeren/chatter) plugin for [Herdr](https://herdr.dev), reached over Tailscale.

**Status:** milestone M2 (the bridge) is built and tested. The web client (M3), offline archive and Markdown export (M4) and packaging (M5) are not started. The specification lives in the project's Claude Doc, "Chatter GUI: Specification v0.1".

## What is here

| Path | What it is |
| --- | --- |
| `bridge/` | Zero-dependency Node service. Reads Chatter's SQLite read-only, writes only by running the `chatter` CLI, and enforces members, tokens and policy. |
| `clients/chatter-member.mjs` | Command-line client for computational members (and a reference for the HTTP API). |
| `skills/chatter-gui/` | An agent skill wrapping that client, for Letta Code, Prime Agent and other harnesses that load skills. |
| `deploy/` | systemd user unit. |

## Requirements

- Node 22.5 or later (the same floor as Chatter), Linux or macOS
- Chatter installed as a Herdr plugin, with `chatter` on the service's `PATH`
- Tailscale with HTTPS certificates enabled, for `tailscale serve`

## Run it on the Herdr host

```sh
git clone https://github.com/mruderman/Chatter-Herdr-Plugin-GUI-App.git
cd Chatter-Herdr-Plugin-GUI-App

# 1. Create the admin, tied to your Tailscale login
node --no-warnings bridge/bin/chatter-bridge.js init --login you@example.com

# 2. Add a computational member; the token is printed once
node --no-warnings bridge/bin/chatter-bridge.js member add thom --kind computational --name "Thom"

# 3. Run as a service (edit the paths first)
cp deploy/chatter-bridge.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now chatter-bridge

# 4. Publish on the tailnet. Use a port Funnel cannot use (Funnel allows only 443, 8443 and 10000).
tailscale serve --bg --https=8446 http://127.0.0.1:8791
tailscale serve status
```

The bridge refuses to listen on anything but loopback. Check that port 8791 is free first (`ss -ltn`).

## Members and permissions

- Handles are lowercase letters, digits, `_` and `-`. A handle may not match any Herdr agent name.
- Humans authenticate through the Tailscale identity header, trusted only from loopback and only when `tailscale whois` agrees. Computational members use a bearer token.
- The admin can use `@everyone`. Members cannot; the bridge refuses it and writes nothing.
- Members may address Herdr agents (put text into their terminals) unless the admin switches `can_address_agents` off for them. Every such push is recorded in the audit log.

```sh
chatter-bridge member list
chatter-bridge member set thom --agents off
chatter-bridge member revoke thom
chatter-bridge token rotate thom
chatter-bridge audit --limit 50
```

## Tests

```sh
CHATTER_JS=/path/to/chatter/dist/bin/chatter.js npm test
```

Unit tests run anywhere. Contract tests run the bridge against a real Chatter CLI in a scratch repo, with no Herdr; they cover attribution, `@everyone`, DM visibility, awkward message bodies, the event stream and resume, revocation and the audit log. Delivery into live agent panes is not covered until a real Herdr is available.

## License

MIT.
