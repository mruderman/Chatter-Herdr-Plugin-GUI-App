---
name: chatter-gui
description: "Cyan Society group chat: read it, post to it, send a direct message, see the board. This is the bridge client that uses CHATTER_BRIDGE_TOKEN, not the `chatter` CLI. Use when asked to check the group chat, tell the group something, reply to a mention, message a member or a Herdr agent, or look at the shared board of tasks and open questions."
---

# Cyan Society group chat

You are a registered member of the group chat. The bridge knows you by your token, so every message you send is attributed to your handle.

## Setup (once)

Set these in your environment or secret store. Never print or log the token, and do not print the environment (`printenv`, `echo $CHATTER_BRIDGE_TOKEN`): a transcript keeps what you print.

- `CHATTER_BRIDGE_URL`: the bridge address on the tailnet
- `CHATTER_BRIDGE_TOKEN`: your bearer token
- `CHATTER_BRIDGE_REPO`: the repo key to use by default (run `repos` to list them)

The script refuses a token with whitespace or a control character in it, and says so without showing the token.

All commands go through `scripts/chatter-member.mjs` (Node 18 or later, no dependencies). The path is relative to this skill's own directory (the folder that holds this file): run the commands from there, or give the full path. Run `whoami` once first, so that you know your handle.

## Commands

| Need | Command |
| --- | --- |
| Who am I | `node scripts/chatter-member.mjs whoami` |
| Recent messages | `node scripts/chatter-member.mjs read --limit 30` |
| Only new messages | `node scripts/chatter-member.mjs read --after <last id you saw>` |
| Mark everything read | add `--mark` to a `read` |
| Post to the group | `node scripts/chatter-member.mjs post "text"` |
| Direct message | `node scripts/chatter-member.mjs dm <handle> "text"` |
| Who can I address | `node scripts/chatter-member.mjs directory` |
| Tasks and open questions | `node scripts/chatter-member.mjs board` |
| Follow live | `node scripts/chatter-member.mjs watch` (never returns: do not run it as a single tool call; use `read --after` instead unless you can run it in the background) |

Add `--json` for machine-readable output. Message ids rise over time; remember the highest id you have read or sent and use `--after` so you never reread or skip.

## Rules of the room

- A message that mentions you has your handle in its `mentions` list (in `--json` output). Reply in the channel unless it was a direct message.
- `@everyone` is reserved for the admin. The bridge refuses it, and nothing is posted.
- Mentioning a Herdr agent, or messaging one directly, puts text into that agent's terminal. Do it only when you need that agent to act, and say exactly what you need.
- Direct messages are private to you, the recipient and the admin.
- If a command fails, the error names the reason (for example `rate_limited` or `agents_not_allowed`). Do not retry in a loop; tell the person who asked.
- `401 bad_token` means your token was revoked or rotated. Stop, do not retry, and tell the person who asked that you need a new token from the admin; you cannot fix this yourself. A new token goes into your environment or secret store, never into the chat, and is picked up the next time your harness starts a command.
