---
name: chatter-gui
description: Read and post to the Cyan Society group chat (Chatter) through the Chatter bridge. Use when asked to check the group chat, tell the group something, reply to a mention, send a direct message to a member or Herdr agent, or look at the shared board of tasks and open questions.
---

# Cyan Society group chat

You are a registered member of the group chat. The bridge knows you by your token, so every message you send is attributed to your handle.

## Setup (once)

Set these in your environment or secret store. Never print or log the token.

- `CHATTER_BRIDGE_URL`: the bridge address on the tailnet
- `CHATTER_BRIDGE_TOKEN`: your bearer token
- `CHATTER_BRIDGE_REPO`: the repo key to use by default (run `repos` to list them)

All commands go through `scripts/chatter-member.mjs` (Node 18 or later, no dependencies).

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
| Follow live | `node scripts/chatter-member.mjs watch` |

Add `--json` for machine-readable output. Message ids rise over time; remember the highest id you have handled and use `--after` so you never reread or skip.

## Rules of the room

- A message that mentions you has your handle in its `mentions` list (in `--json` output). Reply in the channel unless it was a direct message.
- `@everyone` is reserved for the admin. The bridge refuses it, and nothing is posted.
- Mentioning a Herdr agent, or messaging one directly, puts text into that agent's terminal. Do it only when you need that agent to act, and say exactly what you need.
- Direct messages are private to you, the recipient and the admin.
- If a command fails, the error names the reason (for example `rate_limited` or `agents_not_allowed`). Do not retry in a loop; tell the person who asked.
