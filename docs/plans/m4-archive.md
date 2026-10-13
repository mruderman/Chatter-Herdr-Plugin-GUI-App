# M4: archive, export and search (outline)

**Status:** outline, written 2026-10-13. **Not approved, nothing dispatched.** The full contract-first plan is written
after the deploy-and-verify slice passes (`docs/plans/deploy-verify.md`), and is approved by Flan in chat before any
task is dispatched. Branch `m4-archive` is created from `main` then and deleted when it lands.

## What M4 delivers
1. **Archive:** the member's messages kept in IndexedDB in the browser, append-only, so history survives a purge on the
   host and the page works offline. Stores `messages` (key repo and id, with `host_state` present or purged), `cursors`
   (per repo: highest id, epoch, last sync) and a `members` snapshot (so an offline export can label senders). SPEC
   section 7.
2. **Export:** one pure exporter over a message list, fed either from the live fetch or from the archive, so that online
   equals offline by construction (the gate test injects `exported_at`). SPEC section 8.
3. **Search (D18):** client-side over the archive; keyword with "Match case", regular expression, fuzzy only if it stays
   simple and dependency-free; one pure matcher; a Web Worker scan with cancel and a time limit; text segments and
   `<mark>`, never HTML; coverage shown ("Searching N messages; older history not downloaded"); scope this repo, this
   conversation or all repos.

## Decided
- D18 search is client-side (Flan, 2026-10-13). D19 the archive keeps `#chat` only by default; the member's visible DMs
  only on opt-in, as for the export (D1).
- Order of work: the `docs/ui-contract.md` sections first (export dialog; search: a mode radio group, a "Match case"
  checkbox, a live "N results" region, full keyboard use), then blind E2E specs written by an agent that reads no UI
  source, then the pure modules, then the UI.
- New code assumes no same-origin shell: a configurable bridge base URL, so Tauri or Electron stays possible later.
- `idb` is vetted and pinned per `docs/dependencies.md` (exact pin, release at least two weeks old, the package checked).

## To settle in the full plan (a recommended default each; Flan confirms)
a. **DMs at rest** (only for members who opt in, D19): key the archive per member; offer "sign out and clear local
   history"; warn on shared machines. Default: yes to all three.
b. **Readable without a session.** Tokens are memory-only and an offline export must work, so the archive can be read
   without a session; the browser profile is the trust boundary and nothing is encrypted at rest. Document it in SPEC
   section 10; the export header's "exported by" comes from a stored snapshot. Default: yes.
c. **Revocation cannot recall history already downloaded.** Say so in SPEC section 10. Default: yes.
d. **On demotion or revocation, purge the archived rows the member can no longer see at the next sign-in** (it bends
   "never delete") or keep them and say so. Default: purge.
e. **The token-hygiene guard** is changed deliberately for IndexedDB content, never exempted silently. Default: yes.
f. **Archive identity.** Key by repo and id, and by a bridge identity so that two bridges (D11) cannot collide if the
   shell ever has one origin; `/healthz` has no instance id today, so the plan decides how to add one. Default: an
   instance id in the bridge state, returned by `/healthz`.
g. **Persistent storage:** request it and show in the export dialog whether it was granted. The archive is bound to the
   page's origin; the runbook says a changed host name or port starts an empty archive.

## Gate (SPEC section 11)
An offline export matches the online export byte for byte; search over a seeded 10,000-message corpus works in each
mode and with the case toggle; a catastrophic expression such as `(a+)+$` cancels and the page stays responsive; a
message holding `<img onerror>` renders as text; a DM between two other members never appears; axe is clean in three
themes; the existing E2E guards stay green.
