# AGENTS.md

Brief for non-Claude agents (Codex and others). `CLAUDE.md` is the project brief and applies to you too; this file only points to it, so there is one copy to keep current.

1. Read `CLAUDE.md`, then `docs/STATUS.md` (where we are, the Debt list, what is unverified) and `docs/SPEC.md`.
2. Run the baseline before any change: the commands and the expected counts are in `CLAUDE.md` ("Run the tests"). Real-Chatter tests skip without `CHATTER_JS`, and a skip is not a pass.
3. When reviewing, follow `docs/review/codex-review-prompt.md` and `docs/review/README.md`. Reviews are read-only and a finding needs file and line evidence.

The rules that matter most (the full list is in `CLAUDE.md`):

- Never print, log, commit or echo a token. Tests use throwaway tokens.
- Never write to Chatter's SQLite; writes go through the `chatter` CLI with an argv array, never a shell.
- Never touch the production host `baremetalcyansociety` or its Herdr; test only against a throwaway Herdr (`docs/runbooks/herdr-test-env.md`).
- Scope, security and architecture decisions are Flan's: surface them with a recommended default, do not decide them silently.
- Do not push, merge to `main` or add dependencies without Flan's go-ahead.
