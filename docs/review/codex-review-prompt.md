<!-- Codex review prompt template. See docs/review/README.md. Replace __ROUND__, __CHECKOUT__, __COMMIT__ and
     __CHATTER_SRC__, and fill the three sections in angle brackets. Delete this comment. -->
You are reviewing an implemented change against the constraints it claims to satisfy. You work read-only: read files and use read-only git commands (`git log`, `git diff`, `git show`, `grep`). Do not try to run the test suites, install anything or write files; propose mutations in your report instead and the owner will run them.

This is round __ROUND__. Earlier rounds reviewed the branch; their findings were verified, triaged and, where they broke a hard boundary, fixed. You have not seen those rounds and must not rely on them: read the code afresh. Below are what changed since, what is already known and waiting on the owner, and the scope of this round. Aim your effort there, in that order. (For a narrow verification round, add: this round is deliberately narrow, an empty list of findings is a good result, and padding it with style or generic hardening points is not.)

## What is under review
Repository: a frozen checkout of the branch under review, which is your working directory (__CHECKOUT__), a detached HEAD at commit __COMMIT__ (`git rev-parse HEAD`). Scope: the range named in section 1, with the weight below.
The project is "Chatter GUI"; the milestone under review is the one named in section 1. (Project description as of M3: milestone M3 of "Chatter GUI": a zero-dependency Node bridge (`bridge/`) and a new TypeScript web client (`client/`, Preact, Vite) that give every Cyan Society member, human or computational, a graphical group chat over the Chatter plugin for Herdr, reached over a Tailscale tailnet. Read `CLAUDE.md` (hard rules), `docs/SPEC.md` (sections 5, 6, 7, 10 are the contract and threat model), `docs/ui-contract.md` (the UI contract and its section 8 rulings) and the plan of the milestone under review in `docs/plans/` (skim the decisions and findings) first. Chatter's own source is at __CHATTER_SRC__ (read-only reference for how the CLI behaves; do not review it).)

## 1. Changed since the last round: review these first
<Fill in. The range (`git diff A..HEAD -- paths`, with the commits), then one bullet per change: what it claims to do, the files and functions, and what to look for (an interleaving, a path that skips the new check, a hard boundary that the change could break, a test that cannot see the failure). Review the fix, not the old problem.>

## 2. Known, decided or accepted: do not report these again
<Fill in. Numbered, each tagged ACCEPTED, DEFERRED, DECIDED or KNOWN with its evidence, taken from the Debt list and the decisions in docs/STATUS.md. For the KNOWN ones: "if you can show one is worse than described, with a concrete path, report that". End with: "Anything new that touches these areas, or a variant that a known item does not cover, is in scope; the item itself is not.">

## 3. Scope
<Fill in. Either "Out of scope this round: do not widen; read other code only where a changed line depends on it", or "Skimmed or only traced in earlier rounds: read these now" followed by the list.>

## System profile (what makes a finding real here)
- Scale: a handful of members, one bridge process on a tailnet, loopback bind. Nothing here needs to scale; do not raise generic scaling or performance findings.
- Priorities, in order: (1) security and the hard boundaries below; (2) accessibility (WCAG 2.2 AA, full keyboard use, no colour-only signals); (3) sync correctness (ids only rise, a member's view has gaps, resume and reconnect); (4) simplicity.
- Hard boundaries, which must never break: message text renders as plain text only (no HTML, no remote images, links shown as text); a member's token lives in memory only (never in storage, a URL, console output, an error message, the DOM outside the admin's "New token" dialog, or any copy outside the store's closure); the bridge never writes Chatter's SQLite and invokes the `chatter` CLI with an argv array, never a shell; a non-admin's `@everyone` is refused by the bridge and nothing is written; a DM is invisible to a third non-admin member; host paths (`repo_root`, `cwd`) are admin-only; the static route serves only files inside the configured root under a strict CSP; a revoked member's access ends and stops reconnecting; desktop notifications never contain message text.
- The owner is the sole decision-maker for security and scope questions. A finding that needs such a decision should say so.

## What to do
1. Correctness at the cited site. For each finding, quote the code and give a concrete failure path: inputs or interleaving, then the wrong result or crash. No finding without a failure path.
2. Seeded mutations, required, as a list for the owner to run (you cannot write files). For each changed site in section 1, name one or two deliberate one-line defects that would violate what it claims: the file, the exact site, the change, and the named test or E2E spec that should catch it. Be specific about which suite should go red. Prefer the failure modes a careless implementer would produce.
3. Gaps the tests cannot see: ordering between async calls, partial failure, a browser behaviour the tests stub or cannot reach.
4. Profile check. List separately the findings you are raising only from generic best practice that would not matter at this scale.
5. Reverse altitude check. Anything present that is dead code, speculative generality or a comment that no longer matches the code.

Out of scope: style and naming, formatting, file layout preferences, the choice of Preact, Vite or any dependency, Chatter's own code, milestones M4 to M6 (archive and export, packaging, installers), the deferred `/brief` and `/role` commands.

## Output format
Every finding has these fields, in this order:
- **Finding**: what is wrong, at the cited place (file and the quoted code).
- **Failure**: the concrete consequence. Not "risky": say what breaks.
- **Severity**: High, Medium or Low, judged against the system profile. High breaks a hard boundary or the gate; Medium forces rework or a wrong behaviour users can hit; Low is a gap or clarity issue the next reader would resolve correctly anyway. Label honestly; the owner re-checks the label.
- **Fix options**: 1 or 2 directions, not patches. Each names the approach and where it applies in at most two sentences, followed by its cost. No code, no diff. A second option only when it takes a different approach.
- **Recommended**: which option you would take and why, or "owner decides" plus what the decision turns on.

Then the mutation list (item 2), then the profile-check list (item 4), then **Coverage**: the files or areas you examined deeply and those you only skimmed. Do not claim depth you did not spend; the next round is aimed at what you skimmed.
The owner re-verifies every finding on the real source before applying anything, so write the option you would defend, not the one that is easiest to accept.
