# M5 option: the PWA slice (outline)

**Status:** outline, written 2026-10-13. **Not approved, nothing dispatched.** Planned together with M4 and run on its
own short-lived branch (`m5-pwa`) after M4's archive exists. No fork and no separate repository: the client is already a
plain web bundle, so the PWA is the base and Electron or Tauri would be wrappers added later, each its own decision. A
native Android app, if ever wanted, is a separate product that shares the bridge API and the UI contract.

## Scope
- A manifest (icons, standalone display) and a service worker for the app shell: network-first for `index.html`,
  versioned assets, and a kill switch. HTTPS tailnet name only.
- The persistent-storage request (shared with M4).
- A phone pass: an emulated-phone Playwright project with touch (320 px, 200% text, 24 px targets, the @-completion list,
  the area of the on-screen keyboard, the search and export dialogs); then a hand check on a real Android device, listed
  as unverified until Flan has done it.
- Notifications: ships **without background push**, labelled a known limit. Web Push is a separate decision for Flan, with
  a recommended default of leaving it for later: it adds an outbound dependency on a vendor push service and keys and
  stored subscriptions on the bridge.

## Gate
The shell loads with the bridge unreachable, the archive stays readable, an export works offline, and the existing E2E
guards stay green. Verified in Chromium; Firefox only with Flan's approval.

## Members are told
No alerts when the page is closed; clearing site data wipes the archive.

## Value check
This is the least valuable piece for an MVP (installable, offline shell, no alerts when closed). It follows deploy and
verify and M4, and can be dropped without harming either.
