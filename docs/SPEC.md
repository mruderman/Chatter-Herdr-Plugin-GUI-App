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
| Q1 | Who connects | The admin, other humans, computational members (Thom, Kieran, Ezra on Letta Code; Grace on Prime Agent, who runs in Herdr on production, Flan 2026-10-16) | Decided |
| D4 | Outside members may @mention or DM Herdr agents (text goes into agent terminals) | On for every registered member; admin can switch it off per member. Kept safeguards: admin-only registration, revocation, audit log, Chatter's own sanitizing | Decided |
| D1 | Export scope | `#chat` only by default; a toggle adds the DMs the exporting member can see | Default |
| D2 | v1 scope | Chat, DMs, board, export, `/brief`, `/role`. `/spawn`, `/team` in v1.1 | Default |
| D3 | Multiple repos | Repo switcher built on the repo list | Default |
| D5 | DM privacy | Members see `#chat` and their own DMs; only the admin sees everyone's | Default |
| D6 | Reach | Tailnet only. No Funnel | Default |
| D7 | Client shell | PWA first; same bundle in Electron 38 or later. Tauri deferred | Default |
| D8 | `@everyone` | Admin only, enforced by the bridge (Chatter allows it for anyone, F9) | Default |
| D9 | License | MIT, confirmed by Flan 2026-10-13. `LICENSE` reads "Copyright (c) 2026 Cyan Society" and was not corrected; `package.json` and the README say MIT. The only non-MIT dependencies are `axe-core` and `@axe-core/playwright` (MPL-2.0) and `@playwright/test` (Apache-2.0), all dev-only and not in the shipped bundle (`preact` is MIT) | Decided |
| D10 | Code home | https://github.com/mruderman/Chatter-Herdr-Plugin-GUI-App | Decided |
| D11 | Which Chatter state the bridge serves | **Production:** `baremetalcyansociety`, account `letta`, Herdr `default` session; there is exactly one Herdr server there (Herdr 0.9.3, protocol 22; `ps` shows one `herdr server`, owned by `letta`, and only `/home/letta/.config/herdr` exists; the earlier worry about two servers had no stated reason and does not hold). The bridge serves one state directory via `CHATTER_STATE_DIR`: `/home/letta/.local/state/herdr/plugins/chatter` (verified with `chatter data`, 6 repos). Its Chatter is upstream 0.19.0 at `0edc18f` with local patches in three `dist` files (see section 3). **Testing:** any Herdr on any tailnet machine except `baremetalcyansociety`; development is on `pop-os-laptop` (Herdr 0.9.1, protocol 22) (Flan, 2026-10-13) | Decided |
| D20 | Browsers | Members may use Microsoft Edge, Google Chrome, Firefox or Brave; any one is enough. The client sticks to the common web platform; it is tested in Chromium (Playwright); Firefox only with Flan's approval of a browser download (Flan, 2026-10-13) | Decided |
| D18 | Search | Client-side over the IndexedDB archive; no bridge route (a member can only search what they could see, it works offline, and no regular expression runs on the bridge host). Modes: keyword with "Match case", regular expression, fuzzy later. One pure matcher used by the UI and the tests, scanned in a Web Worker with cancel and a time limit. Highlights are text segments and `<mark>`, never HTML | Decided (Flan, 2026-10-13), part of M4 |
| D19 | Archive scope | `#chat` only by default; the DMs the member can see are kept only if they opt in, as for the export (D1) | Decided (Flan, 2026-10-13), part of M4 |
| D21 | Shared account on production | The bridge runs as `letta`, the same account as the agents' panes, because it must write Chatter's state through the `chatter` CLI and reach Herdr's socket. The bridge's policy (DM privacy, `@everyone`, agent addressing, revocation) governs the HTTP path only: any process running as `letta`, such as an agent with a shell tool, can read every Chatter database and edit the bridge's registry. **Accepted for the MVP**; the bridge is not offered as protection against an agent that has a shell on that host. Not decided, for after the MVP: a separate account for the bridge, with the permissions it would need on Chatter's state and Herdr's socket (section 10) | Decided (Flan, 2026-10-14) |
| D22 | Test isolation | Nothing is tested on `baremetalcyansociety` or on any agent that lives there (Grace, who runs in Herdr there, and the others): no messages, no pane contact, no Herdr or Letta commands, beyond the read-only SSH of D11. Letta tests use the Letta Code CLI's own local backend (`--backend local`) in a dedicated home directory (`~/.chatter-gui-test/letta-home`), never the Letta Desktop client (its "local" backend is production's Letta; Desktop is being deprecated) and never `~/.letta` or `~/.config/Letta`. The agents under test are test agents on this laptop, in throwaway directories, against a throwaway bridge | Decided (Flan, 2026-10-16) |

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

Production's Chatter (verified read-only over SSH, 2026-10-13): upstream 0.19.0 at commit `0edc18f` (`marcvermeeren/chatter`), the same commit the tests ran against, plus uncommitted local patches in `dist/src/team.js` (the truncation notice of a delivery says how much was cut, and a terminal submission no longer sets `read_at`), `dist/src/board.js` and `dist/src/tui.js` (alternate screen), and absolute paths in `herdr-plugin.toml`. `chatter` on `letta`'s PATH is a symlink to that checkout's `bin/chatter`, which runs `node --no-warnings --experimental-sqlite dist/bin/chatter.js`. Node there is 22.22.1 (`node:sqlite` needs no flag from 22.13). A copy of the laptop's Chatter with exactly those three files patched (all four hashes equal production's) passes the 215 bridge tests.

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
| `GET /v1/repos` | (a failure of Chatter answers 502 `chatter_error` with the fixed text "Chatter could not list the repositories", as `/healthz` does: what Chatter printed goes to the operator's log, never into an answer) `{repos:[{key, label, repo_root (admin only), orphan, messages, last_activity, epoch, last_read_id}]}` |
| `GET /v1/repos/{key}/messages?after_id&before_id&limit` | `{repo, epoch, messages, has_more, max_id}`; at most 500; oldest first |
| `GET /v1/repos/{key}/conversations` | `{repo, conversations:[{a, b, last_id, last_at}]}`: one entry per pair of participants (`a` and `b` as stored, unordered) of the direct messages the caller may see under the visibility of `/messages` (never the per-recipient mention copies; a member only the pairs they are in, the admin every pair), `last_id` and `last_at` being the pair's newest visible message; newest first; no message text, so it reveals nothing that paging `/messages` back would not (V5 finding 9) |
| `POST /v1/repos/{key}/messages` | body `{to:"#chat"\|handle, body}` returns 201 `{id, pushed, warnings, mentioned_members, delivery}`; refusals write nothing: 400, 401 (the sender was revoked while the send waited), 403 `everyone_admin_only` and `agents_not_allowed`, 409 `ambiguous_recipient`, 429; a send that Chatter fails answers 422 `chatter_refused` with a fixed text (the detail goes to the operator's log), and `warnings` carries only the two texts Chatter 0.19.0 writes for a post |
| `GET /v1/repos/{key}/stream` | server-sent events: `hello {epoch, max_id}`, `message` (id = message id), `bye {reason}` (`epoch`, `error`, `revoked`, `token_rotated`); resume with `Last-Event-ID` or `?after_id` |
| `GET /v1/repos/{key}/board` | `{agents, agents_error, tasks, notes, questions, handoffs}`; for a non-admin each agent row keeps only the non-path keys (no `repo_root`, no `cwd`), as `/v1/repos` hides `repo_root` from non-admins (F15), and `agents_error` is the fixed text "Chatter could not list agents", because the detail can name host paths |
| `POST /v1/repos/{key}/read` | body `{up_to_id}`; pointer only moves forward |
| `/v1/members` (admin) | `GET` list; `POST` add (computational members get a token); `PATCH /{h}` (validated as add is: 400 `bad_kind`, `bad_role`, `bad_request` for an empty patch or an empty display name, 409 `login_taken`, 409 `last_admin`; an empty login means none); `DELETE /{h}` revoke; `POST /{h}/token` rotate. Each change and its audit entry are one transaction, so a 500 from these routes means that nothing changed (the CLI's commands are one transaction with their audit entry too); `can_address_agents` must be a boolean; a body that is not a JSON object is 400 `bad_request` |
| `GET /v1/audit` (admin) | pushes into agents, `@everyone`, registry changes |

Message shape: `{id, from, to, body, kind, ref_id, created_at (ISO 8601, UTC, "Z"), mentions:[handles], everyone}`.

Sync rules:
- Ids only rise. A member's view has gaps (other people's DMs are invisible), so clients track `after_id` cursors and never infer a purge from a gap.
- `epoch` changes if a repo's database is deleted and recreated; the stream then sends `bye {reason:"epoch"}`.
- Streams poll the database every 500 ms. Before each batch is delivered, and every fourth tick for an idle stream, the watcher reads the registry again: a stream ends with `revoked` when its member is no longer active and with `token_rotated` when the bearer token it was opened with is no longer one of the member's live tokens (a tailnet-identity stream has no token), and every stream sees its member's current role, so a demoted admin stops receiving other members' DMs. This holds whichever process changed the registry: through the API the streams close at once, from the CLI within about 2 s.

## 6. Members, authentication, policy

- Registry fields: handle (`^[a-z0-9][a-z0-9_-]{0,31}$`, not `everyone`), display name, kind (human or computational), role (admin or member), `can_address_agents`, status, Tailscale login, timestamps.
- A handle may not match any Herdr agent name, live or departed.
- Humans: Tailscale identity header, trusted only from loopback and only when `tailscale whois` on `X-Forwarded-For` returns the same login. Computational members: bearer token (`cb_` plus 256 random bits), stored as SHA-256, shown once, rotatable, revocable.
- Every decision that follows an `await` is made with the member read again at that point, by the rule a stream follows: the member must still be active and, for a bearer request, the token must still be one of theirs, whichever process changed the registry. That covers the reads (history, conversations, repo list, board, directory, read pointer), each page of a stream's replay, a send (twice) and every registry change, whose acting admin is checked, as the first statement of its transaction, to be still active and still an admin. A member who is no longer entitled gets the door's 401, or 403 for an admin who was demoted.
- Policy, checked before any CLI call and again inside the repo lock, from the registry as it stands then (a send that waited while its sender was revoked answers 401, and a role or `can_address_agents` change made meanwhile applies): members cannot use `@everyone` (rejected with `everyone_admin_only`, nothing written); mentioning or DMing a Herdr agent needs `can_address_agents`; DM recipients must be an active member or a known agent; message at most 8,000 characters, no NUL; 20 sends per minute per member. The limit counts admitted sends: it is taken before the repo lock, so that one member cannot queue unlimited sends behind it, and a send that is then refused when it is decided again inside the lock keeps its slot.
- Chatter takes a name it does not know exactly as the one roster name it is the start of (a unique, case-insensitive prefix), and reads a mention case-sensitively, so a capital letter ends the token (`@everyoneX` is `@everyone`, `@codX` is `@cod`). The policy therefore fails closed: a mention counts under both readings (as Chatter reads it and as written, whole and lower-cased), and a handle that is the start of the name of a non-departed agent of the repo counts as addressing that agent (403 `agents_not_allowed` for a member who may not). A direct message to an agent counts as addressed to it only if its name is exactly one of the repo's non-departed agents: a name that is only offered by the directory (an agent of another repo, or a departed one) but is the start of a roster name is refused with 409 `ambiguous_recipient`, because Chatter would deliver it to the roster agent. A direct message to a member whose handle is the start of an agent's name is refused with 409 `ambiguous_recipient` too, for an admin as well, because Chatter would deliver it to the agent. So is a direct message to any name that is not exactly on the repo's roster and is the start of the sender's own handle (a member's handle, or an agent name that only the directory offers), because Chatter would take it for the sender. Live Herdr agents that are not registered with Chatter match by prefix too and are invisible to the bridge.
- Every push into an agent terminal, every `@everyone` and every registry change goes to the audit log.
- The UI says "member" and shows kind as a badge; it never says "bot".

## 7. Client (milestone M3) and archive (M4)

Chat feed: group by sender within 5 minutes, day separators, a "new" marker from the read pointer, mention highlight plus a text label (never colour alone), DMs labelled, @-completion over members and agents, repo switcher, board (read-only), `/brief` and `/role` as text commands, member list with kind badges, admin panel for members and the audit log, a connection badge (online, syncing, offline), desktop notifications for mentions and DMs.

Messages render as plain text only: no HTML, no remote images, links shown as text. A send the bridge accepted can still carry `warnings`, `delivery` or a queued push; the client shows them as a dismissible polite status beside the composer ("Send notice"), in the bridge's own words for the two warning forms it lets through and in a fixed sentence for an agent no session took.

Accessibility target WCAG 2.2 AA: full keyboard use, polite live region for new messages (throttled), 200% text, reduced-motion and high-contrast themes. Orca checks are manual.

Archive: IndexedDB, append-only. Stores `messages` (key repo+id, plus `host_state` present or purged), `cursors` (per repo: highest id, epoch, last sync), `members` snapshot (so offline exports can label senders). First sync pages `after_id=0` in 500-message pages. The client never deletes a message; on an epoch change it keeps its copies and marks them purged. The PWA requests persistent storage. The export dialog shows which ids are held and warns before saving if older history was not downloaded.

Search (M4, D18): over the archive in the browser, never over a bridge route. Keyword search with a "Match case" checkbox and regular-expression search ship first; fuzzy only if it stays simple and needs no dependency Flan has not approved. One pure matcher module is used by the UI and by the tests, and the scan runs in a Web Worker (the CSP already allows `worker-src 'self'`) with cancel and a time limit, so a catastrophic expression such as `(a+)+$` cancels and the page stays responsive. An invalid expression shows a message, never an exception. Matches are highlighted by splitting the text into segments around `<mark>`, never by HTML. The results region says how much was searched ("Searching N messages; older history not downloaded") and labels messages purged on the host. Scope: this repo, with options for this conversation or all repos. Opening a result in the live feed is deferred. The UI contract section (mode radio group, the checkbox, a live "N results" region, full keyboard use) is written before the E2E specs.

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

With D4 on, any registered member can put text into an agent's terminal; the audit log and revocation make that visible and reversible, and Flan has accepted the residual risk. Other items: token theft (hashed, rotatable, tailnet-only), forged identity header (loopback plus `whois`), accidental public exposure (loopback bind, no Funnel, port outside Funnel's set), Chatter schema drift (pinned columns, refuse on mismatch), script injection (plain-text rendering), handle impersonation (handles checked against agents). The directory the bridge serves the client from (`CHATTER_BRIDGE_STATIC_DIR`) is operator-owned: anyone who can write to it already controls the page every member runs, so the static server checks that a request resolves inside it but does not defend against a path swapped for a symlink while the request runs. In the planned deployment (a systemd user unit) the bridge runs as the operator's own user, and so do the agents in Herdr's panes (accepted by Flan 2026-10-14 as D21; checked 2026-10-13 on production: the only account with a Herdr server is `letta`, and the bridge has to be an account that can write Chatter's state through the `chatter` CLI and reach Herdr's socket, so it runs as `letta` too; that panes run as the server's user is inferred, not observed): such an agent is inside the operator's boundary for the same reason, because the bridge's policy governs what members can do through the API, not what a host process can do. Computational members that connect over HTTP (Q1) have no host access and are held to the policy.

## 11. Tests and milestones

Run `CHATTER_JS=<chatter clone>/dist/bin/chatter.js npm test`. Current state (end of M3): 215 bridge tests pass against the real Chatter CLI, none skipped; the client has 1463 unit tests and 29 end-to-end specs (`npm --prefix client test`, `npm --prefix client run e2e`). Mutation checks confirmed the tests fail when the `@everyone` rule or DM visibility is broken.

| Milestone | Gate |
| --- | --- |
| M1 Spec | done |
| M2 Bridge | done: contract tests pass against Chatter 0.19.0, including the `@everyone` rejection |
| M3 Client core | done: two clients exchange messages end to end in headless Chromium against a real bridge and Chatter; a DM is invisible to a third member; a non-admin's `@everyone` is refused with a visible error; the main flow works by keyboard alone; axe reports nothing serious in three themes |
| Deploy and verify (between M3 and M4) | done (2026-10-18): a repeatable build and runbook, and a real-Herdr smoke on a test host with every item recorded as pass, fail or blocked (`docs/plans/deploy-verify.md`); Letta Code and Prime Agent unverified by decision |
| M4 Archive and export, with search | an offline export matches the online export byte for byte; search over a seeded 10,000-message corpus works in each mode and with the case toggle, a catastrophic regular expression cancels and the page stays responsive, a message holding `<img onerror>` renders as text, a DM between two other members never appears, and axe is clean in three themes |
| M5 Packaging | both installers build and the PWA passes the offline end-to-end run |
| M6 Verification on Flan's machines | the manual checklist passes or becomes tracked fixes |
| v1.1 | `/spawn` and `/team` wizards, MCP adapter |

Manual checklist (M6): install Herdr, Chatter, bridge and Tailscale; an outside member's @mention reaches a live agent and is audited; non-admin `@everyone` is rejected; Pop!_OS 24.04 on COSMIC renders natively on Wayland with fractional scaling; Kubuntu on Wayland and X11 with `.deb` and AppImage; desktop notifications; Orca reads new messages and every control works by keyboard; disconnect Tailscale and export; revoke a member.
