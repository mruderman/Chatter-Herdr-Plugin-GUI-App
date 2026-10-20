# Exploratory GUI pass (V5 of the deploy-and-verify slice)

> **All ten findings are fixed** (T17 to T23, 2026-10-14 to 2026-10-18): 1 and 7 at `a69d030`, 10 at `99cc611`, 9 at `5daccbe` and `baa5277`, 2 and 3 at `07eaabe`, 4, 6 and 8 at `b416f50`, 5 at `14fa891`. Each failing reproduction moved from `client/e2e-pending/` into `client/e2e/` as a guard (the specs keep their `explore-N-` names), and the pending-spec setup (`client/e2e-pending/`, `playwright.pending.config.ts`, `npm run e2e:pending`) was removed on 2026-10-20 because nothing is pending any more. The text below is the pass as it was found.


A member's-eye look at the built web client in a real browser, against a throwaway deployment with test data only, to find
what the scripted specs do not. Nothing was fixed here: each finding is described, reproduced twice, labelled, and (when it is
not cosmetic) written as a Playwright spec that fails on the current code for the reason named. Date 2026-10-13; commit
`f9cf2e32eb82` (branch `dv-v5`, from `deploy-verify`), a clean tree built with `deploy/build-client.sh` (the `client/dist`
`index.html` sha256 was `4a1ab6dc3c83...`).

**Browser:** the built-in browser pane of the Claude desktop app (Chromium 152, Linux, time zone America/Tijuana, 1024 x 768,
`prefers-color-scheme: dark`), driven through `mcp__Claude_Browser__*`; two tabs, each a different member (the token lives in
the tab's memory). BrowserOS neo was not needed. The pane was hidden (not on screen) for the whole pass, which is why
screenshots lag one frame behind the page; state was read from the DOM, the accessibility tree and the network and console
readers instead. Only throwaway test tokens were typed, only into this local build; no real site, mail or account was opened.

## 1. Running the throwaway deployment

```sh
deploy/build-client.sh                                   # client/dist, from the lockfile, check:dist
export CHATTER_JS=~/src/chatter/dist/bin/chatter.js      # the real Chatter CLI; no Herdr (HERDR_BIN_PATH names nothing)
mkdir -p $SCRATCH/universe $SCRATCH/run && chmod 700 $SCRATCH
TMPDIR=$SCRATCH/universe node --no-warnings deploy/exploratory/serve-throwaway.mjs --out $SCRATCH/run
```

It prints one line: the URL (`http://127.0.0.1:<port>/`), the pid, how many messages it seeded, and the path of the token file.
**Tokens go only to `$SCRATCH/run/tokens.json`** (created mode 600, never printed). `SIGTERM` or `SIGINT` stops it, deletes the
universe (it lives under `TMPDIR`), the token file and its copy of the client. Seeding takes about 70 s (one Chatter process
per filler message).

- **Serves a copy** of `client/dist` (`$SCRATCH/run/dist`), so rebuilding the client (every `npm run e2e` does) cannot change
  the page under the browser.
- **The world:** admin `flan`; humans `hana` and `ivo` (`ivo` may not address agents); computational `kai`; the agent `codex`;
  `gone` (revoked after the seed) and a token of `kai` that a rotation has replaced (`kai_stale`), for the refused sign-ins; two
  repositories (`repo` with 301 messages over six days, `sidecar` with three). A board with three tasks (one a title of
  markup), two open questions, two notes and a handoff; an audit log with the registry changes and the pushes.
- **Awkward messages**, all posted through the bridge's own API so that its policy decided each: `<img src=x onerror=...>` and
  an `<img src="/probe-img.png">`, `<script>` and `<script src="/probe-script.js">` (a parsed tag would leave a request for the
  probe path), markup and entities, a 135-character and a 2000-character word, a 1,000-character URL, URLs of every scheme,
  emoji (skin tone, ZWJ family, flags, keycap), Arabic and Hebrew, mixed text, a right-to-left override (U+202E),
  markdown characters, newlines and leading spaces, an `@mention` of each member and of the agent, `@Hana` with a capital, an
  `@everyone` of the admin (and `@everyoneX`, `@codX`), messages whose text is a label ("Mentions you", "Direct message",
  "Admin view", "New messages"), a 7,980-unit emoji message and a 4,000-character one.
  Shapes the pass looks for: same sender 4 and 6 minutes apart, three minutes apart across local midnight, and across UTC
  midnight. DMs: hana-kai (four), flan-hana, ivo-hana, kai-flan. Read pointers: flan at the end, hana three short of it,
  kai halfway, ivo none.
- **Decision: the timestamps.** Chatter stamps `created_at` itself, which would put 300 messages inside a minute. After each write the
  script rewrites that row's `created_at` in the scratch Chatter database (`UPDATE messages SET created_at ...`), before any
  browser connects. The precedent is `bridge/test/helpers.js` `seedAgent`, which also writes a scratch Chatter database. Ids,
  bodies and the file's identity (the bridge's "epoch") are untouched. It is a test-data device; the bridge's rule (never write
  Chatter's SQLite) is not touched. Filler messages are written through the Chatter CLI as the member (bypassing the 20-a-minute
  limit), the awkward ones through the API (so the policy ran).
- **Control file** `$SCRATCH/run/control.txt`: append lines, the script polls it every 250 ms and empties it; answers go to
  `control.log` (never a token). `stop` (graceful, a `bye shutdown` on every stream), `drop` (every connection cut with no
  goodbye), `start` (same port, same state), `post <handle> <#chat|handle> <text>` (written through Chatter as that member; refuses
  an `@everyone` of anyone but the admin), `status`.

## 2. Coverage, item by item

| Item | Result |
|---|---|
| Sign-in: a bad token, a revoked token, a replaced (stale) token | Pass. Each: "Sign-in failed: token is invalid or revoked", the typed text kept, the field refocused, the alert re-announced (a new node). The first-load 401 draws no alert (contract). |
| Sign-in: a good token, by keyboard alone | Pass. Focus is in the field on load; Enter submits; focus lands on the app root; the next Tab is "Skip to messages". |
| Which views were done by keyboard alone | Sign-in, the Tab order of Chat, the primary navigation (Enter on Board and Members), the `@` list, Shift+Enter, Enter to send, the Settings dialog, and the Revoke and Rotate confirmations (Tab to the button, Enter). **Not** by keyboard alone: the Add member form (filled with `form_input` and a ref click), the Board and Members content beyond navigating to them, the repository select and the "To" select (`form_input`). |
| Chat view | Findings 1, 4, 5, 6, 7, 8, 9. Conversations, mouse and keyboard: pass. |
| Board view (member and admin) | Pass. Task titles of markup render as text; a non-admin's board has no host path. Cosmetic C3. |
| Members view | Pass. The revoked member is not listed. |
| Admin view: add a member, the one-time token dialog, rotate, revoke, the audit table | Pass, with finding 2 (rotating one's own token). The dialog holds the token in a read-only `textarea` (`autocomplete=off`, `spellcheck=false`); closed with Escape the token is nowhere (DOM, form values, local and session storage); focus returns to "Add member"; the revoke and rotate confirmations start on Cancel; focus goes to the row's Edit button after a revoke; the audit table shows the registry changes, the pushes, `@everyone`, and the actor of a rotation. |
| Settings: theme, notifications | Pass. Theme persists (`localStorage` key `chatter.theme`, not sensitive) across a reload. Notifications: the pane reports permission `denied`, so the button is disabled with its explanation; nothing was granted. |
| Feed with ~300 messages: scrolling, "Load older messages", the new-messages marker, day headings, grouping | Day headings, grouping (4 min joined, 6 min split, split by midnight, joined across UTC midnight), the marker and paging: pass, except findings 4, 5, 9 and 1. Reading the feed to its end moves the read pointer; a reload shows no marker for what was read. |
| Long words, URLs, emoji, markdown, RTL text, the HTML message as plain text | Pass: no horizontal overflow at 1024 or 320 px; no `img`, `script`, `a`, `style` or `iframe` in the log; the probe paths were never requested; `document.title` unchanged; the U+202E message is isolated (the next message reads normally); links are text. The 140-character announcement cuts by code point (no lone surrogate). Findings 8 (RTL direction) and C-notes. |
| Composer: `@` completion by keyboard, "To" select, DMs, `@everyone` as a non-admin, a very long message, Enter and Shift+Enter, paste | `@` list, arrows, Enter accepts; Shift+Enter inserts a newline; Enter sends; the draft stays on every refusal; "8,001 characters; the limit is 8,000." appears at the limit and the bridge's 413 text is shown; a first DM through "To" creates and selects the conversation; a restricted member's `@codex` is refused in the bridge's words. Findings 3, 4, 6, 10. Paste was a programmatic insert (`insertFromPaste`), not the OS clipboard. |
| Themes (System, Light, Dark, High contrast) and reduced motion | The four choices work and look right in Settings and in the feed. Reduced motion: **not emulated** (the pane cannot set media features); the stylesheet holds the `prefers-reduced-motion: reduce` rule (`transition: none`, `animation` removed), read by script. |
| 320 px wide and 200% text | 320 px: no horizontal scroll in Chat, Admin, Board or Members with all 307 messages loaded; wide tables sit in 288 px scroll regions. 200% **text** (root font-size 200% at 1024 and 320 px): reflows, no horizontal scroll. Browser **zoom** was not available in the pane. |
| Connection badge while the bridge stops and restarts | `drop`: Offline within 3 s; a send says "Not sent: could not reach the bridge" and keeps the draft; `start`: Online, the two messages written meanwhile arrive in order. `stop` (graceful): Offline at once, Online 13 s after the restart (the backoff). "Syncing" is not shown while reconnecting; the contract reserves it for loading. |
| The read pointer after a reload | Pass for one conversation. The pointer is one per repository: a DM that arrives while the member reads `#chat` is counted as read (C5, known). |
| Console and network | No CSP violation, no uncaught error, nothing from another origin, no token or message text in any URL (the requests were listed and read). The console shows the browser's own red "Failed to load resource" line for every 4xx the page asks for on purpose (first-load 401, a refused send), cosmetic C1. |
| Focus order and visible focus | Skip links, repository, Settings, the primary navigation, conversations, as in the contract; the focus ring is 3 px solid; dialogs trap Tab, close on Escape and return focus to the opener. Activation by Enter produced clicks with `detail` 0 and no pointer events. |
| Page title and landmarks | Landmarks: banner, navigation "Primary", main, navigation "Conversations" (labelled by its heading), form "Message composer", statuses "Connection" and "Announcements". The title is "Chatter" in every view: cosmetic C2. |
| Hard boundaries of `CLAUDE.md` | Plain text: pass. Token in memory only: pass (page, storage, URLs, console, network; after a reload the sign-in view returns). A non-admin's `@everyone`: refused, nothing written (message count unchanged at 308). A DM invisible to a third member: pass (ivo's list and `GET messages`; the admin sees "DM hana to kai" read-only with "Admin view"). Host paths admin-only: pass (`/v1/repos` and `/board` as hana). Revoked access ends: pass (stream "Access revoked", sign-in and API refused), see finding 3 and C7. No message text in notifications: pass by `explore-11-notification-text.spec.ts` and by reading `notifier.ts`; not seen on a screen (permission denied in the pane). |

## 3. Findings

Final tree: `npm test` 247 pass, 0 skipped. `npm --prefix client run e2e`: 40 specs, **30 passed** (the 29 existing, one of them the
`test.fail()` canary in `smoke.spec.ts`, plus `explore-11`) and **10 failed, all of them the `explore-1` to `explore-10` specs of
this pass**, each failing on the assertion it names. `npm --prefix client run typecheck` is clean. Run them alone with
`CHATTER_JS=... npm --prefix client run e2e -- explore-`.

No hard boundary of `CLAUDE.md` was found broken. Checked in the pane: plain-text rendering, the token kept out of the page,
storage, URLs and console, a non-admin's `@everyone`, a DM invisible to a third member, host paths admin-only, revoked access
ending. Checked by `explore-11-notification-text.spec.ts` (passes, by design: it certifies the boundary in a real browser) and by
reading `features/notify/notifier.ts`: no message text in notifications (the notification is `new api("<handle> <phrase>",
{ body: "Repository: <label>", tag })`; it was not seen on a screen, since the pane's permission is denied). Each finding below was
reproduced twice (the first time in the pane, the second in the pane or by the spec, as stated). Spec failure lines are the ones
printed on the final tree.

**1. A long feed makes the page scroll thousands of pixels into blank space.** **FIXED 2026-10-14 (`a69d030`).** *Usability.*
Did: opened Chat with 300 messages. Expected: the page ends at the composer. Happened: `document.documentElement.scrollHeight`
9707 against 1029 for the body; scrolling past the composer shows an empty page (second reproduction: 9238 against 1029).
Cause: each message that continues a group carries `<time class="visually-hidden">`, `position: absolute`, and the log is
`position: static` with `overflow: auto`, so those elements are not contained by it and each stretches the page by its place in
the log. Repro: any member, a channel with enough messages for the log to scroll.
Spec `client/e2e/explore-1-feed-page-scroll-void.spec.ts` (was in `e2e-pending/`): `Expected: < 100  Received: 7242` ("pixels the page scrolls beyond the
bottom of the composer, the last thing on it").

**2. Rotating your own token destroys the new token.** **FIXED 2026-10-18 (`07eaabe`).** *Defect against the UI contract* (section 4: the "New token for
{handle}" dialog, "This token is shown once"; section 8: the confirmation warns about one's own account).
Did: signed in with a token as an admin, Admin, "Rotate token for me", Rotate (twice, with two admins). Expected: the dialog
shows the new token for copying. Happened: the dialog is on screen 57 ms (a mutation log: dialog at 4931 ms, a 401 on the
member-list reload at 4934 ms, the Sign in view at 4988 ms with "Sign-in failed: token is invalid or revoked"). The bridge ends the
old token's stream at once (`bye token_rotated`), the next requests answer 401, and the shell replaces the whole app. The new
token existed only in the dialog, so a token-signed-in admin is locked out; the only way back is the CLI
(`chatter-bridge token rotate`). Inferred from `bridge/src/server.js`, not run: an admin signed in through the tailnet identity
(a stream with `credential` null, which only the member's status can end) would not lose the session.
Spec `explore-2-self-rotate-token-lost.spec.ts`: `Error: the "New token" dialog was replaced by the Sign in view; the one-time
token is lost ... element(s) not found`.

**3. A revoked member's Send does nothing and says nothing.** **FIXED 2026-10-18 (`07eaabe`).** *Usability* (a silent failure; the contract's "Send error" text is
"Not sent: " plus the bridge's message, and here no request is made, so the contract does not strictly cover it).
Did: revoked a signed-in member from the admin tab (twice, a computational member and an admin); typed a message and pressed
Enter. Expected: the "Send error" alert. Happened: the Connection status reads "Access revoked", but the box and Send stay
enabled, no request is made and no alert appears; the draft stays (`state/store.ts`, `send()` returns `false` for a revoked
session without setting `sendError`). Related, by design (store comment: "everything stays readable"): the tab keeps showing every
message it had loaded, DMs included, until it is reloaded.
Spec `explore-3-revoked-send-silent.spec.ts`: `Error: a send that goes nowhere must say so: no "Send error" alert appeared ...
element(s) not found`.

**4. The first message of a new DM is marked "New messages".** **FIXED 2026-10-18 (`b416f50`).** *Usability.*
Did: as `ivo` (pointer 0) and as `flan`, chose another member in "To" and sent a first message. Expected: nothing is new for the
sender. Happened: the conversation opens with the "New messages" separator above the member's own message (the marker is the
first message past the read pointer, and the member's own message is always newer than it; `fixMarker` in `state/store.ts`).
Spec `explore-4-own-message-new-marker.spec.ts`: `Error: a "New messages" separator above Ann's own message ... Expected: 0
Received: 1`.

**5. "Load older messages" in a DM can load a page and show nothing.** **FIXED 2026-10-18 (`14fa891`).** *Usability.*
Did: as `hana` after a reload, opened "DM with kai" (a DM from four days ago), pressed "Load older messages"; again as the admin on
"DM hana to kai". Expected: something visible changes. Happened: the button pages the whole repository (100 messages of every
conversation), so the first press (here) fetched a page with none of this DM: the view is identical, the button stays, nothing
says what happened; the DM's old message appeared on the second press and the button went away after the third (both runs).
Spec `explore-5-load-older-no-visible-change.spec.ts`: `Error: one press of "Load older messages" in a DM fetched a page of
other conversations; the view did not change ... element(s) not found`.

**6. After sending while scrolled up, the member's message is out of view.** **FIXED 2026-10-18 (`b416f50`).** *Usability.*
Did: scrolled the feed up, sent a message (twice: with the log 3,000 px from the end, and in the spec with the wheel). Expected: the
sent message is visible as confirmation. Happened: the composer clears, the feed stays (5,845 px from the end); there is no "jump
to latest". The reading-position rule (only a reader at the bottom follows) is right for others' messages, not for the member's own send.
Spec `explore-6-send-leaves-own-message-out-of-view.spec.ts`: `the member's own message is out of view: the feed stayed where it
was ... Expected: in viewport  Received: viewport ratio 0`.

**7. The message box starts below the fold on ordinary windows.** *Usability.* **FIXED 2026-10-14 (`a69d030`).**
Did: opened Chat at 1024 x 768 (the pane) and at 1280 x 720 (the spec). Expected: write without scrolling the page. Happened: the
box starts at about y 830 of 768 (and below 720 at 1280 x 720); `.feed__log` is `clamp(12rem, 60vh, 48rem)` under a header, a
navigation bar and the conversation list, so the page needs about 1,350 px of window to show the box. Compose-and-read-the-latest
needs a page scroll each time.
Spec `explore-7-composer-below-fold.spec.ts`: `the message box starts below the bottom of a 720 px window ... Expected: in
viewport  Received: viewport ratio 0`.

**8. A message written in Hebrew or Arabic is laid out left to right.** **FIXED 2026-10-18 (`b416f50`).** *Usability.*
Did: posted pure Hebrew and Arabic messages (live, as a member). Expected: right to left (a closing "!" or "?" at the left end of
the line, text against the right edge). Happened: `.message__body` has no `dir`, computed direction `ltr`, the text sits against the left
edge and the trailing punctuation lands on the wrong end. `dir="auto"` on the body is the standard remedy and keeps it a text node.
Spec `explore-8-rtl-message-direction.spec.ts`: `distance of the Hebrew text from the right edge of its box (computed direction:
ltr, from the left edge: 0 px) ... Expected: < 4  Received: 781`.

**9. A DM older than the newest page has no entry in the list of conversations.** *Usability.* **FIXED 2026-10-18 (`5daccbe`, `baa5277`).**
Found by writing spec 5 (its first version timed out clicking a "DM with bob" button that was not on the page), then reproduced by
spec 9 on a clean bridge; the pane could not make the situation, because every pair in the seeded world has a recent DM. The list is built from the messages loaded, which are the newest 100 of the repository; a member whose only exchange
with someone is older has no "DM with X" button, and nothing hints that "Load older messages" in the channel would add one.
Spec `explore-9-old-dm-not-listed.spec.ts`: `Ann has a private conversation with Bob, but no button for it is on the list ...
element(s) not found`.

**10. The bridge's warnings and delivery status are dropped.** *Usability.* **FIXED 2026-10-16 (`99cc611`).**
Did: sent `@nobodyhere ...` as a member and a DM to `codex`. Expected: the sender learns that nobody was notified (or that the
agent's message is queued). Happened: a normal successful send. The API answers 201 with `warnings: ["mention @nobodyhere2 matches
no agent in this repo - not pushed"]` and, for the DM, `delivery: "queued"`; the client parses both (`api/guards.ts`) and
`store.send()` resolves a bare boolean. A mistyped agent name looks delivered.
Spec `explore-10-send-warnings-not-shown.spec.ts`: `the bridge warned that nobody was notified; the page showed nothing ...
element(s) not found`.

**Noted, no spec.** C1 to C3 are cosmetic. C4 to C8 are not cosmetic, but each follows the contract or a recorded decision
(`docs/ui-contract.md`, `docs/STATUS.md`, a comment in `state/store.ts`), so they are observations for Flan, not defects against
the contract; say so if one should have a spec.
- C1. The console shows the browser's red "Failed to load resource: 401" for the first-load `/v1/me` probe and for each refusal.
- C2. The page title is "Chatter" in every view and state (sign-in, Chat, Board, Admin).
- C3. The Board prints raw status words (`in_progress`) and the word "none" for an empty role or branch.
- C4. The "To" select offers every agent of the directory, including to `ivo`, who may not address agents (the contract lists
  them), and agents that do not exist in the selected repository.
- C5. (Known, `docs/STATUS.md`: one read pointer per repo.) A DM that arrives while the member reads `#chat` is passed by the
  pointer once a later channel message is read; opened afterwards it shows no marker, and the list has no unread cue. Reproduced:
  pointer 316 against a DM of id 315.
- C6. A member who has never read (pointer 0) opens at the oldest message of the newest 100 with the marker there; the real first
  unread is further back.
- C7. There is no sign-out or lock control: the token stays in the tab's memory until the page is reloaded or closed.
- C8. Reconnection after a restart took 13 s to show Online (the backoff); the badge says Offline throughout.

## 4. Not checked, and why

- Screen readers, Firefox and Safari (Flan's, manual), and a real operating-system notification on a screen (the pane's
  permission is `denied`; I did not change it). What the page passes to `Notification` was checked (spec 11); how an operating
  system shows it was not.
- Reduced motion and forced colours as media features (the pane cannot emulate them; the stylesheet rule was read), browser zoom
  (200% of text was set through the root font size), the OS clipboard (paste was a synthetic input event; "Copy token" was not pressed so that no
  token reaches a clipboard history).
- Tailscale-identity sign-in (a different bridge mode, covered by `tailnet-identity.spec.ts`), delivery into a Herdr pane (V3),
  agents' use of the skill (V4).

## 5. Decisions and disclosures (for the coordinator)

- **Direct writes to scratch Chatter databases** (a decision the plan did not make; the rule is "never write Chatter's SQLite"
  for the bridge): `serve-throwaway.mjs` rewrites `created_at` after each seeded message, and specs 1, 5, 6 and 9 insert channel rows
  with `INSERT INTO messages` into their own private universe. Precedent: `bridge/test/helpers.js` `seedAgent`. Nothing touches a real
  Chatter state.
- **A scratch helper outside the repository** (`$SCRATCH/v5/reissue.mjs`, since deleted) issued a token through the bridge's `Store` for
  the throwaway `flan` and a spare admin, with no audit entry, to recover from finding 2's lockout and to repeat it.
- **One `chatter help --all`** was run once with the shell's default environment before the throwaway existed (it only reads);
  `~/.local/state/herdr/plugins/chatter` and `~/.config/herdr` were checked unchanged. Every other Chatter call went through the
  throwaway's `host.run` with its own state directory.
- **Throwaway tokens were in the session transcript**: the token file was read once (the pane needs the text typed), one token was read out
  of the New token dialog, and pane screenshots of that dialog sit in the tool's own result folder under `~/.claude/projects/`. They
  belong to a universe that no longer exists. No token is in this repository, this document or the report.
- `client/test-results/` (traces of the failing specs, which can hold Authorization headers of those dead private bridges) is git-ignored
  (`client/.gitignore`).
- `npm ci` (inside `deploy/build-client.sh`) printed "1 high severity vulnerability": `source-map-js` 1.0.0 to 1.2.1 (GHSA-68fv-2mgg-jv7q,
  event-loop DoS through crafted source maps), a build-time transitive dependency; `npm audit --omit=dev` reports 0. Not acted on (the
  coordinator owns dependencies).

## 6. Tooling notes for the next run

- The pane's `screenshot` returns the previous frame while the pane is hidden: take two, or read the DOM. `left_click` by coordinate
  missed once after a scroll; clicking by `ref` was reliable. `resize_window` 320 px switches to a phone user agent.
- Reading the token file puts the tokens into the session transcript. A helper that fills the field without showing it would be
  better, but the pane has no such tool.
- The seeding is slow only because of the Chatter processes; `tokens.json` holds `kai_stale` and `gone_revoked` on purpose.
