# UI contract (M3)

Shared by the shell (T3), the feature views (T5 to T9), the blind E2E specs (T4) and integration (T10). Roles and accessible names below are what tests select on, so they are part of the contract, not styling. Frozen at gate G1; only the coordinator amends it. Source of behaviour: `docs/SPEC.md` §5 to §7.

## 1. Sign-in (when `GET /v1/me` returns 401, or 403 with code `not_registered`)
| Element | Role / label | Behaviour |
|---|---|---|
| Heading | h1 "Sign in" | |
| Token field | label "Access token" (`input type=password`, `autocomplete=off`) | the token lives in memory only; the field is cleared and removed after success |
| Button | button "Sign in" | Enter in the field submits |
| Failure | `alert` | text is the bridge's `error.message`, prefixed "Sign-in failed: ". Shown after a failed attempt, and also on first load for a 403 `not_registered` ("Sign-in failed: your Tailscale login is not registered as a member", with the token form still available); not shown on first load for a plain 401, when nothing has been tried yet. |

## 2. Structure
- First two tab stops, visible on focus: link "Skip to messages", link "Skip to message box".
- `banner` (header), `navigation` "Primary", `main` (one h1 per view: "Chat", "Board", "Members", "Admin"), `navigation` "Conversations" inside the Chat view.
- Header: text "Chatter"; select labelled "Repository" (native `select`, option text is the repo label); `status` named "Connection" with text exactly one of Online, Syncing, Offline, Access revoked; the member as "{display_name} ({handle})" with a kind badge whose text is "Human" or "Computational"; button "Settings".
- Primary navigation: buttons "Chat", "Board", "Members", and "Admin" (admins only). The current one has `aria-current="page"`.

## 3. Chat view
| Element | Role / label | Behaviour |
|---|---|---|
| Conversations | buttons in `navigation` "Conversations": "#chat"; "DM with {handle}"; for an admin looking at a DM not involving them, "DM {a} to {b}" with the two handles in alphabetical order (one button for both directions; no direction is implied) | current has `aria-current="true"`. A DM conversation appears when a message arrives or the member sends one. |
| Feed | `log` named "Messages", `aria-live="off"`, focusable (`tabindex=0`) | oldest first; plain text nodes only |
| Day separator | h3 with the local date | one per local day |
| New marker | `separator` named "New messages" with the same visible text | once, before the first message past the read pointer, only if unread messages existed when the conversation opened |
| Message | contains sender handle, local time (`<time datetime>`) and body | consecutive messages from one sender within 5 minutes share one header. Mentions of the member add the text label "Mentions you"; DMs add "Direct message"; an admin's view of others' DMs adds "Admin view". Never colour alone. |
| History | button "Load older messages" | only when `has_more`; pages with `before_id` |
| Composer | `form` named "Message composer" with: textarea labelled "Message", select labelled "To" (`#chat`, then each active member, then each agent as "{name} (agent)"), button "Send" | Enter sends, Shift+Enter inserts a newline; text is cleared only after a successful send |
| Suggestions | `listbox` named "Mention suggestions"; `option` text "{handle} (Human)", "(Computational)" or "(Agent)" | opens on `@`; ArrowUp/ArrowDown move through options (`aria-activedescendant`); Enter or Tab accepts; Escape closes without losing text. `everyone` is offered to admins only; agents only when `can_address_agents`. The textarea has role `combobox` with `aria-expanded` and `aria-controls` while suggestions are shown. |
| Send error | `alert` named "Send error" | text "Not sent: " plus the bridge's `error.message`; the draft stays in the textarea; nothing appears in the feed |
| Announcements | `status` named "Announcements" (visually hidden) | polite; updated at most once per 3 seconds; one message reads "{sender}: {first 140 characters}", a burst in one conversation reads "{n} new messages in {conversation}", and a burst across several reads "{n} new messages in {k} conversations"; never announces the member's own messages |

## 4. Board, Members, Admin, Settings
| View | Contract |
|---|---|
| Board | h2 sections "Agents", "Tasks", "Open questions", "Notes", "Handoffs"; tasks and agents as `table` with a caption; button "Refresh board"; when `agents_error` is set, a `status` says agents are unavailable and shows the message |
| Members | `list` named "Members" (display name, handle, kind badge "Human" or "Computational") and `list` named "Agents" |
| Admin | h2 "Members" with a `table` named "Members" (columns Handle, Name, Kind, Role, Agents, Status) and per-row buttons "Edit {handle}", "Revoke {handle}", "Rotate token for {handle}"; button "Add member"; h2 "Audit log" with a `table` named "Audit log" (Time, Actor, Action, Detail) |
| Admin dialogs | "Add member", "Edit {handle}", "Revoke {handle}?" (confirm button "Revoke"), "New token for {handle}" (read-only field labelled "Token", buttons "Copy token" and "Done", text "This token is shown once") |
| Settings dialog | select "Theme" (System, Light, Dark, High contrast); button "Enable desktop notifications"; checkbox "Notify me about mentions and direct messages"; button "Close" |

## 5. Dialogs and keyboard
- Every dialog is `role=dialog`, `aria-modal=true`, named. On open, focus moves inside; Tab and Shift+Tab stay inside; Escape closes; focus returns to the control that opened it.
- No custom global shortcuts (they collide with screen readers). Everything works with Tab, Shift+Tab, arrows in lists, Enter, Space and Escape.
- Tab order: skip links, header, primary navigation, conversations, feed, composer.
- A tripwire in the keyboard E2E run fails if any pointer event fires.

## 6. Themes and layout
- `data-theme` on `<html>`: `light`, `dark`, `hc`. The default follows `prefers-color-scheme` and `prefers-contrast: more` or `forced-colors`; the Settings choice overrides it and may be stored (it is not sensitive). `prefers-reduced-motion: reduce` removes all transitions and animations.
- Text contrast 4.5:1, UI components 3:1, focus ring at least 3px and 3:1 against its surroundings, targets at least 24 by 24 CSS px (WCAG 2.2 AA). Layout reflows to 320 CSS px wide; usable at 200% text size.

## 7. Never
Token in a URL, in console output, in `localStorage`, `sessionStorage` or IndexedDB, or in the DOM outside the "New token" dialog. HTML parsed from message text. Remote images or fonts. Inline `style` attributes. The word "bot".
