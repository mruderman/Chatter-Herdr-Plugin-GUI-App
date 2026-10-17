# M4: archive, export and search

**Status:** full plan, written 2026-10-16, **awaiting Flan's approval in chat; nothing dispatched.** It replaces the outline
of 2026-10-13. Branch `m4-archive` is created from `main` when the deploy-and-verify slice (`deploy-verify`) has merged,
and is deleted when M4 lands. Reference codes: D decisions and Q questions are in `docs/SPEC.md`; the items below that
need Flan are numbered **P1 to P8** with a recommended default, and I apply the default only after the yes.

## 1. What M4 delivers

1. **Archive.** The member's messages kept in the browser (IndexedDB), append-only, so history survives a purge on the host
   and the app opens offline. Per member and per bridge; `#chat` always, DMs only on opt-in (D19).
2. **Export.** One pure Markdown exporter over a message list (SPEC section 8), fed from the live fetch or from the archive,
   so that the offline export equals the online one byte for byte by construction.
3. **Search (D18).** Client-side over the archive: keyword with "Match case", regular expression, fuzzy only if it stays
   small and dependency-free. One pure matcher, scanned in a Web Worker with cancel and a time limit.

Out of scope: any bridge route for search or export (D18); a server-side archive; encryption at rest (P2); the PWA shell and
installers (M5, planned separately); `/spawn`, `/team`, the MCP adapter (v1.1).

## 2. Decisions to confirm (recommended default first; I do not decide these silently)

- **P1. Dependencies: none.** Recommended: no `idb` and no `fake-indexeddb`. A thin in-house IndexedDB adapter (about 100
  lines, promises over requests and transactions) sits behind an `ArchiveStore` interface; the archive's logic is tested on
  an in-memory implementation of that interface in Vitest, and the real adapter is exercised in Chromium by Playwright. This
  keeps the supply chain as it is (`preact` only at runtime). Alternative: pin `idb` (vetted per `docs/dependencies.md`,
  MIT, release at least two weeks old) and add `fake-indexeddb` as a dev dependency; it saves the 100 lines and costs two
  packages. Needs your yes either way for any package.
- **P2. Trust boundary.** The archive is readable without a session (a token is memory-only, and an offline export must work),
  and is not encrypted at rest: the browser profile is the trust boundary. SPEC section 10 says so. Recommended: yes. The
  sign-in view gets an "Open the archive on this device" entry that lists the members who have a local archive here (handle
  and display name, no token).
- **P3. DMs at rest.** Only for a member who opts in (D19); archive keyed per bridge and member; "Sign out and clear local
  history" in Settings; a plain warning about shared machines at the moment of opting in. Recommended: yes to all three.
- **P4. Revocation and demotion.** Revocation cannot recall history already downloaded (said in SPEC section 10). On a
  demotion or revocation the next sign-in purges the archived rows the member can no longer see (it bends "the client never
  deletes a message", and I would say so in the SPEC). Recommended: purge, and show "Removed from this device: N messages
  you can no longer see".
- **P5. The token-hygiene guard** (the test that no token reaches page, storage, URLs, console or network) is widened on
  purpose to IndexedDB: a test asserts no token-shaped string and no token's prefix is in any store. Recommended: yes.
- **P6. Archive identity.** Key by bridge instance id, member handle and repo key, so two bridges cannot collide if the shell
  ever has one origin (D11). `/healthz` has no instance id today: the bridge generates a random one on first start, keeps
  it in its state directory and returns it from `/healthz` and `/v1/me`. A small bridge task (T26). Recommended: yes.
- **P7. Persistent storage.** Ask for it (`navigator.storage.persist()`), and show in the export dialog and Settings whether
  it was granted, with the quota used. The archive is bound to the origin: a changed host name or port starts an empty
  archive (the runbook says so). Recommended: yes.
- **P8. Search results open a read-only context view** (the message and the five before and after it, from the archive),
  not a jump inside the live feed, because the feed holds only the newest page. Recommended: yes; jump-to-feed is Debt.

## 3. Contract (what the tasks are held to)

### 3.1 Archive (SPEC section 7, as decided)
- Database name `chatter-archive` per origin. Stores: `messages` (key `[bridge, member, repo, id]`; value the message as the API
  gave it plus `host_state: "present" | "purged"`), `cursors` (key `[bridge, member, repo]`; highest id held, epoch, last
  sync time, `complete` when the history was fetched back to the first message), `members` (snapshot of the directory, so an
  offline export can label senders and the exporter), `meta` (opt-in flags, schema version).
- **Sync.** A first sync pages `after_id=0` in pages of 500 until `has_more` is false; later syncs continue from the cursor;
  new messages arrive from the stream (the store already merges them) and are appended. Ids only rise and a member's view
  has gaps (other people's DMs), so nothing is inferred from a gap. `hello {epoch}` differing from the cursor's epoch: keep
  every held row, re-sync from 0, and mark held rows the host no longer returns as `purged`.
- **Never deletes**, except P4's purge of rows the member may no longer see, and the member's own "clear local history".
- **Plain text only**: bodies are stored and rendered as text; nothing is ever put in with `innerHTML`.

### 3.2 Export (SPEC section 8, unchanged)
- `exportMarkdown(messages, options)` is pure: options carry `repo`, `scope`, `mode` (`last` N or `range` M..N), `timezone`
  (`local` or `utc`), `exportedAt`, `exportedBy`, `members` (for kind labels). The caller injects `exportedAt`; the
  exporter never reads a clock. Output as SPEC section 8, bodies as blockquotes (every line prefixed `> `, so no heading or
  list can form), file name `chatter-<repo>-<date>-<scope>-<first id>-<last id>.md`.
- Dialog: scope (`#chat`, and with opt-in each conversation), mode and numbers, time zone, a preview (count, first and last
  timestamp, and "N of these ids are not held on this device: older history was not downloaded" with a button to download
  it first), then Save. Works with no session from the archive (P2).
- **Gate property:** for the same ids the online export (live fetch) and the offline export (archive) are byte-identical
  with the same injected `exportedAt`.

### 3.3 Search (D18)
- `matchMessages(messages, query)` is pure and total: query `{text, mode: "keyword" | "regex", matchCase, scope}`; returns
  `{results: [{id, conversation, from, at, segments: [{text, match}]}], error?}`. An invalid expression returns an `error`
  string, never throws. Keyword mode treats the text literally (regular-expression characters have no meaning).
- A Web Worker (`worker-src 'self'` is already in the CSP) scans in chunks and posts progress; the page sets a time limit
  (default 2 s, shown) and a Cancel button; `(a+)+$` on a long line must cancel and leave the page responsive. Results
  render as text segments around `<mark>`, never as HTML.
- UI: a search field, a mode radio group, a "Match case" checkbox, a scope select (this conversation, this repository, all
  repositories on this device), a polite live region "N results" and "Searched M messages; older history not downloaded" when
  the cursor is not `complete`; full keyboard use; Escape cancels.

### 3.4 UI contract
`docs/ui-contract.md` gets sections for: the export dialog, the search view, the archive and storage block in Settings
(opt-in for DMs, clear local history, persistence status), and the sign-in view's offline-archive entry. Written first (T21).

## 4. Tasks, waves and who does them

Executors are Claude subagents in git worktrees (Opus for the hard, security-relevant slices, Sonnet otherwise), at most 3 at a
time, disjoint paths, red first; I read every production diff and run my own mutations before merging, as for M3.

| Wave | Task | Who | Holds (edit) | Done when |
| --- | --- | --- | --- | --- |
| 0 | **T21 contract**: ui-contract sections 3.4, SPEC sections 7 and 10 (P2 to P6), the plan's data model as a type file `client/src/archive/types.ts` | me | `docs/ui-contract.md`, `docs/SPEC.md`, `client/src/archive/types.ts` | Flan has read the contract; no code yet |
| 1 | **T22 blind E2E**: Playwright specs for export, search and the archive written from the contract only, by an agent that reads no UI source; they fail red because the UI does not exist | Sonnet | `client/e2e/m4-*.spec.ts`, harness additions in `client/e2e/harness/` | every spec fails for the reason it names; the harness can seed a 10,000-message corpus and go offline |
| 1 | **T23 exporter**: the pure exporter and its tests (SPEC section 8 cases: last N, range inclusive at both ends, DMs, time zones, empty scope, hostile bodies such as `# heading`, `---`, `<img onerror>`) | Sonnet | `client/src/export/**` | tests red first; property test: the exporter is deterministic and equal for any ordering of the same ids |
| 1 | **T24 matcher and worker**: the pure matcher, the chunked scan, the worker wrapper with time limit and cancel; ReDoS cases | Sonnet | `client/src/search/**` | 10,000-message scan under the limit in keyword mode; `(a+)+$` cancels; invalid expression gives `error`; segments never contain HTML semantics |
| 1 | **T26 bridge instance id** (P6): random id in the state directory, in `/healthz` and `/v1/me`; the client's types and fake follow | Sonnet | `bridge/src/{store,server}.js`, `bridge/test/**`, `client/src/api/**`, `client/src/state/fake*.ts`, `docs/SPEC.md` section 5 row | new tests; the id is stable across restarts and differs between two states |
| 2 | **T25 archive store and sync**: the `ArchiveStore` interface, the in-memory and IndexedDB implementations, sync, epoch handling, purge, per-member keying, DM opt-in, clear history | Opus | `client/src/archive/**`, `client/src/state/**` where the store calls it | logic tests on the in-memory store; a real-Chromium spec for the IndexedDB adapter; the token-hygiene test over IndexedDB (P5); mutations on keying and purge |
| 3 | **T27 export UI**, **T28 search UI**, **T29 archive and Settings UI** (opt-in, clear history, persistence, offline-archive entry on sign-in) | Sonnet x3 | disjoint feature directories under `client/src/features/{export,search,archive}` | the T22 specs pass; axe clean in three themes |
| 4 | **Verification**: my mutations (below), `docs/review/final-check.py` extended with the M4 gate specs, **G3: one Codex adversarial round** on the diff (archive privacy at rest, the worker, export injection), fixes only for hard-boundary breaks | me, Codex | the review tooling | the M4 gate of SPEC section 11 passes; STATUS current |

Wave 1 runs three executors at once (T22, T23, T24; T26 follows or runs when one finishes). Wave 2 needs the interface from T21
and T23's types. Wave 3 needs T25.

## 5. Gate (SPEC section 11) and my mutations

The gate: an offline export matches the online export byte for byte; search over a seeded 10,000-message corpus works in
each mode and with the case toggle; `(a+)+$` cancels and the page stays responsive; a message holding `<img onerror>`
renders as text (in the feed, in search results and in the export); a DM between two other members never appears in the
archive, search or export of a third; axe is clean in three themes; the existing E2E guards stay green.

My mutations, each of which must turn a named test red: drop the injected `exportedAt` (equality breaks); render a search
segment through HTML; remove the worker's time limit; key the archive without the member handle (a second member on the same
browser sees the first one's DMs); skip the P4 purge; keep DMs without the opt-in; store a token in `meta`; let `keyword`
mode interpret regular-expression characters; mark nothing `purged` on an epoch change.

## 6. Risks and what stays unverified

- IndexedDB, Workers and persistent storage in Firefox and Safari (D20 tests Chromium only); quota behaviour on a full disk.
- A 10,000-message export "under 5 seconds" is a proposed target (SPEC section 1), measured in Chromium only.
- The browser profile is the trust boundary (P2): anyone with the profile reads the archive; the runbook and SPEC say so.
- Revocation cannot recall history already downloaded (P4).
- The in-memory store and the IndexedDB adapter can drift; one shared conformance suite runs both when Chromium is available.

## 7. Estimate (rough)

Nine executor tasks in four waves, one Opus-heavy (T25), one Codex round. Order of magnitude: the same as M3's client slice
without its review rounds. Nothing here touches production.
