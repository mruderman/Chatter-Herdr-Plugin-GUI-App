# Team: Chatter GUI

Source of labor approved by Flan on 2026-10-09: Claude subagents write the code; Codex reviews read-only; opencode's free models are excluded unless Flan opts in. A swap stays inside this approval; anything else goes back to Flan.

## Assignments
| Role | Who | Model | Notes |
|------|-----|-------|-------|
| Coordinator, contracts, gates | This session | Sonnet 5.5 | does not write feature code |
| Executor, hard slices (T1, T2, T4, T5, T8) | Claude subagent in its own worktree | Opus | security-, contract- or accessibility-heavy |
| Executor, routine slices (T0, T3, T6, T7, T9) | Claude subagent in its own worktree | Sonnet | checklist-driven against the UI contract |
| Blind E2E author (T4) | A subagent that writes none of the UI | Opus | works from SPEC and `docs/ui-contract.md` only |
| Adversarial reviewer (G0, G2) | Codex CLI 0.162.1, read-only sandbox | account default | different model family from the authors; sends the files it reads to OpenAI |
| Fallback reviewer | Fresh Opus subagent that wrote none of the code | Opus | only if Codex has no quota; tell Flan |

## Observed capability
| Agent | Does well | Failed at | Last used |
|-------|-----------|-----------|-----------|
| Codex CLI 0.162.1 | ping with `--sandbox read-only` answered "ok", exit 0; weekly window 4.0% used (2026-10-09 20:02 local) | prints an unrelated MCP transport error for `127.0.0.1:9010` on stderr; harmless | 2026-10-09, ping only |
| Claude subagent, `isolation: worktree` | launches in the background and notifies this session | worktrees are built from `main`, not from the coordinator's branch, so docs committed on `m3-client` were missing until fast-forwarded | 2026-10-09, Wave 0 |

## Undecided
- Whether Codex's read-only sandbox lets it run `git diff` and read a worktree outside its `--cd`: unverified until G0.
- `agy` and `kiro-cli` are absent on this machine (the plugin's roster file describes another one); not used.
