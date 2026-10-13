# Review tooling

The scripts and the prompt used for M3's adversarial review (G2) and its closing check. They were first written in a
session scratchpad under `/tmp` and lost once, so they live here. They are verification code: they change tracked
files temporarily and always restore them.

| File | What it does |
| --- | --- |
| `mutate-client.py` | Applies one seeded defect at a time to a client file and runs vitest; a defect that leaves every test green is a gap. |
| `mutate-bridge.py` | The same for the bridge, with `node --test`. |
| `final-check.py` | The closing check of a milestone: typecheck, client tests, root tests, build, `check:dist`, E2E, then the three gate mutations of `CLAUDE.md` (each must turn its named spec red). |
| `codex-review-prompt.md` | The template of the read-only Codex review prompt. |
| `examples/` | One small config for each mutation runner. |

All three scripts need `CHATTER_JS` (a built Chatter checkout, `dist/bin/chatter.js`); without it the real-Chatter
tests skip, and a skip is not a pass.

## The review loop (what M3 did)

1. Freeze the code under review: `git worktree add --detach .claude/worktrees/g2-roundN <commit>`. Codex reads that
   checkout, so later merges cannot move what it reads.
2. Fill the template (`__ROUND__`, `__CHECKOUT__`, `__COMMIT__`, `__CHATTER_SRC__`, and its three sections: what changed,
   what is already known, the scope) and run
   `codex exec -s read-only -C <checkout> --ephemeral -o out.md - < prompt.md`. Codex cannot run tests, so it proposes
   findings and seeded mutations; the coordinator runs them.
3. Triage. Re-verify every finding on the real source and reproduce what can be reproduced (a throwaway script against a
   real bridge over real Chatter: `bridge/test/helpers.js` `makeEnv`). A finding needs file and line evidence and a concrete
   failure path. Label it honestly; Codex's labels ran a level high.
4. Fix only what breaks a hard boundary of `CLAUDE.md` (plain-text rendering, token in memory only and never printed,
   a non-admin's `@everyone` refused, a DM invisible to a third member, host paths admin-only, revoked access ends, no
   message text in notifications). Everything else goes to the Debt list in `docs/STATUS.md` with its evidence.
5. Each fix is a task for an executor: tests first, each seen red on the untouched code, then the fix. The coordinator
   reads the production diff, runs the checks and its own mutations, and only then merges.
6. Stop rule: another round runs only if the last one reproduced a hard-boundary break. A round that keeps widening
   (new areas each time) will not converge; keep later rounds to the code the last fixes changed.

## Mutation sweeps: rules learned the hard way

- **Read the baseline first.** The runner prints it; it must be all green. One sweep was void because the runner passed a
  directory to `node --test` and its own baseline failed, so every "caught" meant nothing.
- **Never run a sweep while E2E runs or an executor works in the same tree**: a mutated file would be built or read.
- **A mutation has to look like the code it stands for.** An extra statement with no arguments was invisible to a test
  that counts statements by their arguments.
- **Mutating one of two identical files** (the member client and its skill copy) is caught by the identity test, not by the
  behaviour tests; mutate the copy the tests execute and run only the behaviour test file.
- A survivor is either a gap (write the test) or an equivalent mutant (two guards that mask each other: remove both). Say
  which, with the reason.
- The scripts restore each file in a `finally`; check `git status` and for `*.mutbak` files afterwards.
