# Working agreement: Chatter GUI

**Updated:** 2026-10-09
**Markers:** `✓` settled by Flan · `~` proposed or inferred, unconfirmed · `OPEN` undecided

Rules already in [CLAUDE.md](../CLAUDE.md) (hard rules, branch per milestone, working with Flan) apply and are not repeated here.

## Cadence
- ✓ Mode: run to the M3 gate. Continue through all waves inside M3 scope; ask only when a decision or permission is missing; when one part is blocked, continue the independent rest. Stop when the gate passes or something blocks.
- ✓ A "task" is one task in `docs/plans/m3-client.md`: accepted by the coordinator, committed once, merged into `m3-client`.
- ✓ Execution mode: prefer parallel, at most 3 executors at once. A wave of one task says why in the plan.
- Coordination mode: single coordinator (not asked; no lanes).

## Coordinator
- Designs contracts, assigns, dispatches, verifies, commits and merges into `m3-client`, keeps `docs/STATUS.md`.
- Does not write feature code. May write contracts, docs and verification code.
- Runs the mutation checks itself and reads in full the security-critical code (static serving, admin token display).

## Executor
- Decides alone: implementation inside held paths, test structure, naming.
- Must verify: its own done-when with pasted command output; typecheck; that nothing outside held paths changed.
- Does not commit, merge or push. Leaves the work in its worktree and reports.
- Report: per `docs/executor-context.md` section 8.

## Reviewer
- Scope: the diff, security-critical code first. Read-only. Codex at G0 and G2; otherwise a fresh subagent that wrote none of the code.
- A finding needs file:line evidence and a concrete failure scenario. The coordinator re-verifies it on real source before any change.
- Disagreement: coordinator decides; security or scope questions go to Flan.

## Authority
- Anyone decides alone: minor implementation choices.
- Ask Flan: security, scope or architecture decisions (surface with a recommended default); dependency changes beyond the vetted set; any browser or binary download; pushing; anything touching `main`; anything outward-facing.
- When blocked: stop that task, record it in `docs/STATUS.md`, continue the independent tasks.

## Project rules
- ~ Plan detail: plan points, executor writes the code (inferred from CLAUDE.md's own style).
- ✓ Who executes: Claude subagents in isolated git worktrees (Opus for hard slices, Sonnet for routine ones). Codex reviews read-only at G0 and G2. opencode's free models are excluded unless Flan opts in.
- Plans and specs: `docs/plans/`, `docs/specs/`; `docs/SPEC.md` stays where it is.
- Language: English.
- Commits: short imperative summary in sentence case (matches existing history), body when it helps, then the attribution trailer the harness gives. Nothing is pushed without Flan's go-ahead.
- Progress: per CLAUDE.md "Working with Flan": lead with the answer, separate observed from inferred, use D/F/Q/R codes.
