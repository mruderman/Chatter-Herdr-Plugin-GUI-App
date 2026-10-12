# Chatter GUI: specification (repo copy, v0.2)

This is the implementer's copy of the project spec. The original is the Claude Doc "Chatter GUI: Specification v0.1", which holds the decision history and diagrams. Where the two differ, this file reflects what is built. Reference codes (F, D, Q, R) match the Claude Doc.

## 1. Goal

Give every Cyan Society member, human or computational, a graphical group chat on top of the Chatter plugin for Herdr, reached over Tailscale.

- Match the Chatter TUI: group chat, DMs, board (agents, tasks, open questions, notes), unread marker, @-completion, `/brief`, `/role`. `/spawn` and `/team` come in v1.1.
- Export chat history to Markdown: the last N messages, or a range of positions.
- Keep history locally so export works offline.
- Run on Pop!_OS 24.04 (COSMIC, Wayland) and Kubuntu (Wayland and X11), as a PWA and as an Electron app.
- Computational members use the same HTTP API; none of them needs a terminal pane.

Non-goals for v1: changing Chatter's coordination logic, exposing anything to the public internet, showing agent terminals.

Proposed targets (not agreed): a new message reaches every connected client within 2 seconds; a 10,000-message export finishes offline in under 5 seconds.

## 2. Decisions

| ID | Decision | Choice | Status |
| --- | --- | --- | --- |
| Q1 | Who connects | The admin, other humans, computational members outside Herdr (Thom, Kieran, Ezra on Letta Code; Grace on Prime Agent) | Decided |
| D4 | Outside members may @mention or DM Herdr agents (text goes into agent terminals) | On for every registered member; admin can switch it off per member. Kept safeguards: admin-only registration, revocation, audit log, Chatter's own sanitizing | Decided |
| D1 | Export scope | `#chat` only by default; a toggle adds the DMs the exporting member can see | Default |
| D2 | v1 scope | Chat, DMs, board, export, `/brief`, `/role`. `/spawn`, `/team` in v1.1 | Default |
| D3 | Multiple repos | Repo switcher built on the repo list | Default |
| D5 | DM privacy | Members see `#chat` and their own DMs; only the admin sees everyone's | Default |
| D6 | Reach | Tailnet only. No Funnel | Default |
| D7 | Client shell | PWA first; same bundle in Electron 38 or later. Tauri deferred | Default |
| D8 | `@everyone` | Admin only, enforced by the bridge (Chatter allows it for anyone, F9) | Default |
| D9 | License | MIT (assumed; not yet confirmed) | Default |
| D10 | Code home | https://github.com/mruderman/Chatter-Herdr-Plugin-GUI-App | Decided |
| D11 | Which Chatter state the bridge serves | One state directory via `CHATTER_STATE_DIR`. Which of the host's Herdr servers is open | Open |

Range export is inclusive at both ends. "Between 200 and 100 messages ago" is positions 100 to 200 (101 messages). Confirmed by Flan.

## 3. Findings about Chatter 0.19.0

- F1: no network server; one SQLite file per repo, WAL mode; a read-only reader is safe during writes.
- F2: any command run outside a Herdr pane acts as the human; `chatter post` works from there.
- F3: `chat`, `log`, `agents`, `data` accept `--json`.
- F5: timestamps are UTC strings `YYYY-MM-DD HH:MM:SS` with no zone marker.
- F6: Herdr plugin v1 has no non-terminal UI; startup hooks are one-shot; remote access is SSH-based.
- F7: per-member attribution works by running the CLI with `HERDR_PLUGIN_CONFIG_DIR` pointing at a directory whose `name` file holds the member's handle, and `HERDR_PANE_ID` unset.
- F8: a DM to a name Chatter does not know needs `--queue`; it is stored and visible through `inbox`.
- F9: Chatter accepts `@everyone` from any identity outside a pane.
- F10: the SQLite layout is an internal detail; the bridge pins the columns it reads and refuses a drifted repo.
- `chatter send` treats only a final `--queue` argument as a flag; the bridge always appends `--queue` after the body so a body like `--queue` survives.
- `chatter purge --older-than` deletes old rows and keeps the database file and ids.
- Mention rows (`kind = 'mention'`) are per-recipient copies of a post; every feed skips them.
- Chatter's `dist/` is committed to its repo, so a plain clone has a runnable `dist/bin/chatter.js`.

Not yet verified: delivery into live agent panes (needs a real Herdr); `chatter brief --json`.

## 4. Architecture

```
clients (PWA / Electron / CLI / skill) --HTTPS over tailnet--> tailscale serve --> bridge (127.0.0.1)
bridge --read-only SQL--> Chatter SQLite        bridge --argv, no shell--> chatter CLI --> SQLite + Herdr panes
```

The bridge is a zero-dependency Node service. It reads Chatter's SQLite read-only and writes only by running the Chatter CLI, so mention, queueing and sanitizing logic stays in Chatter. It binds loopback only and is published with `tailscale serve`.

Planned host layout: bridge on `127.0.0.1:8791`, published at `https://baremetalcyansociety.tail5c44ac.ts.net:8446`. Port 8446 is outside Funnel's permitted set (443, 8443, 10000). The host already serves 443, 8443, 8444, 8445.

## 5. Bridge API (as implemented, v0.1.0)

All routes return JSON; errors are `{"error":{"code","message"}}`. `GET /healthz` needs no credentials; everything under `/v1` does.

| Route | Purpose |
| --- | --- |
| `GET /v1/me` | `{handle, display_name, kind, role, can_address_agents}` |
| `GET /v1/directory` | `{members:[{handle, display_name, kind}], agents:[names]}` |
| `GET /v1/repos` | `{repos:[{key, label, repo_root (admin only), orphan, messages, last_activity, epoch, last_read_id}]}` |
| `GET /v1/repos/{key}/messages?after_id&before_id&limit` | `{repo, epoch, messages, has_more, max_id}`; at most 500; oldest first |
| `POST /v1/repos/{key}/messages` | body `{to:"#chat"\|handle, body}` returns 201 `{id, pushed, warnings, mentioned_members, delivery}` |
| `GET /v1/repos/{key}/stream` | server-sent events: `hello {epoch, max_id}`, `message` (id = message id), `bye {reason}`; resume with `Last-Event-ID` or `?after_id` |
| `GET /v1/repos/{key}/board` | `{agents, agents_error, tasks, notes, questions, handoffs}`; for a non-admin each agent row keeps only the non-path keys (no `repo_root`, no `cwd`), as `/v1/repos` hides `repo_root` from non-admins (F15) |
| `POST /v1/repos/{key}/read` | body `{up_to_id}`; pointer only moves forward |
| `/v1/members` (admin) | `GET` list; `POST` add (computational members get a token); `PATCH /{h}`; `DELETE /{h}` revoke; `POST /{h}/token` rotate |
| `GET /v1/audit` (admin) | pushes into agents, `@everyone`, registry changes |

Message shape: `{id, from, to, body, kind, ref_id, created_at (ISO 8601, UTC, "Z"), mentions:[handles], everyone}`.

Sync rules:
- Ids only rise. A member's view has gaps (other people's DMs are invisible), so clients track `after_id` cursors and never infer a purge from a gap.
- `epoch` changes if a repo's database is deleted and recreated; the stream then sends `bye {reason:"epoch"}`.
- Streams poll the database every 500 ms; revocation closes streams at once through the API and within about 2 s from the CLI.

## 6. Members, authentication, policy

- Registry fields: handle (`^[a-z0-9][a-z0-9_-]{0,31}$`, not `everyone`), display name, kind (human or computational), role (admin or member), `can_address_agents`, status, Tailscale login, timestamps.
- A handle may not match any Herdr agent name, live or departed.
- Humans: Tailscale identity header, trusted only from loopback and only when `tailscale whois` on `X-Forwarded-For` returns the same login. Computational members: bearer token (`cb_` plus 256 random bits), stored as SHA-256, shown once, rotatable, revocable.
- Policy, checked before any CLI call: members cannot use `@everyone` (rejected with `everyone_admin_only`, nothing written); mentioning or DMing a Herdr agent needs `can_address_agents`; DM recipients must be an active member or a known agent; message at most 8,000 characters, no NUL; 20 writes per minute per member.
- Every push into an agent terminal, every `@everyone` and every registry change goes to the audit log.
- The UI says "member" and shows kind as a badge; it never says "bot".

## 7. Client (milestone M3) and archive (M4)

Chat feed: group by sender within 5 minutes, day separators, a "new" marker from the read pointer, mention highlight plus a text label (never colour alone), DMs labelled, @-completion over members and agents, repo switcher, board (read-only), `/brief` and `/role` as text commands, member list with kind badges, admin panel for members and the audit log, a connection badge (online, syncing, offline), desktop notifications for mentions and DMs.

Messages render as plain text only: no HTML, no remote images, links shown as text.

Accessibility target WCAG 2.2 AA: full keyboard use, polite live region for new messages (throttled), 200% text, reduced-motion and high-contrast themes. Orca checks are manual.

Archive: IndexedDB, append-only. Stores `messages` (key repo+id, plus `host_state` present or purged), `cursors` (per repo: highest id, epoch, last sync), `members` snapshot (so offline exports can label senders). First sync pages `after_id=0` in 500-message pages. The client never deletes a message; on an epoch change it keeps its copies and marks them purged. The PWA requests persistent storage. The export dialog shows which ids are held and warns before saving if older history was not downloaded.

## 8. Markdown export

Position 1 is the newest message in the chosen scope, counting only messages the member may see.

| Mode | Input | Result |
| --- | --- | --- |
| Last N | N | positions 1 to N |
| Range | M and N, M at least N | positions N to M, inclusive, so M - N + 1 messages |

A preview shows the count and first and last timestamps before saving. Format: YAML header (`repo, scope, ids, count, exported_at, exported_by, timezone`), then `## YYYY-MM-DD` sections, then per message `**sender** (kind if known) · HH:MM · #id` and the body as a blockquote (so message text cannot create headings). DMs add `→ DM to <handle>` to the header line. Times in the exporting member's time zone by default, with a UTC option. File name: `chatter-<repo>-<date>-<scope>-<first id>-<last id>.md`. The offline export must equal the online export byte for byte.

## 9. Packaging

One web bundle, two shells. PWA: served by the bridge at `/` (same origin), service worker caches the app shell. Electron 38 or later: bundles the assets, calls the bridge cross-origin; the bridge allows exactly one configured origin (`CHATTER_BRIDGE_ORIGINS`). Formats: `.deb` primary, AppImage secondary. Known risk (unverified): Ubuntu 24.04 restricts unprivileged user namespaces, which can break Electron's sandbox for AppImages. Tauri deferred.

## 10. Threat model (short)

With D4 on, any registered member can put text into an agent's terminal; the audit log and revocation make that visible and reversible, and Flan has accepted the residual risk. Other items: token theft (hashed, rotatable, tailnet-only), forged identity header (loopback plus `whois`), accidental public exposure (loopback bind, no Funnel, port outside Funnel's set), Chatter schema drift (pinned columns, refuse on mismatch), script injection (plain-text rendering), handle impersonation (handles checked against agents).

## 11. Tests and milestones

Run `CHATTER_JS=<chatter clone>/dist/bin/chatter.js npm test`. Current state: 30 tests pass (11 unit, 15 against the real Chatter CLI, 4 for the member client). Mutation checks confirmed the tests fail when the `@everyone` rule or DM visibility is broken.

| Milestone | Gate |
| --- | --- |
| M1 Spec | done |
| M2 Bridge | done: contract tests pass against Chatter 0.19.0, including the `@everyone` rejection |
| M3 Client core | two clients exchange messages end to end in headless Chromium |
| M4 Archive and export | an offline export matches the online export byte for byte |
| M5 Packaging | both installers build and the PWA passes the offline end-to-end run |
| M6 Verification on Flan's machines | the manual checklist passes or becomes tracked fixes |
| v1.1 | `/spawn` and `/team` wizards, MCP adapter |

Manual checklist (M6): install Herdr, Chatter, bridge and Tailscale; an outside member's @mention reaches a live agent and is audited; non-admin `@everyone` is rejected; Pop!_OS 24.04 on COSMIC renders natively on Wayland with fractional scaling; Kubuntu on Wayland and X11 with `.deb` and AppImage; desktop notifications; Orca reads new messages and every control works by keyboard; disconnect Tailscale and export; revoke a member.
