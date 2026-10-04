# Architecture decision records

Use a short architecture decision record (ADR) for choices that materially constrain future work.
Name records with a four-digit sequence and a concise slug, for example
`0001-workflow-state-persistence.md`.

Each record should contain:

1. **Status** — proposed, accepted, superseded, or rejected.
2. **Context** — the forces and constraints behind the decision.
3. **Decision** — the chosen approach.
4. **Consequences** — expected benefits, costs, and follow-up work.

Keep superseded records in place and link them to the decision that replaces them. The history is
part of the documentation.

## Decisions

- [0001: Structure CLI commands as plan-execute adapters](0001-plan-execute-cli.md)
- [0002: External TypeScript workflows with local durable steps](0002-durable-external-workflows.md)
- [0003: Separate workflow outcomes from checkpoint failures](0003-checkpoint-failure-precedence.md)
- [0004: Own workflow operations until drained](0004-operation-ownership.md)
- [0005: Separate step identity from execution policy](0005-step-identity-and-policy.md)
- [0006: Explicit reuse after workflow code changes](0006-code-change-recovery.md)
- [0007: Explicit durable failure outcomes](0007-durable-failure-outcomes.md)
- [0008: Scope map cancellation and journal settled items](0008-scoped-fan-out.md)
- [0009: Compose explicit leaves with stable scope prefixes](0009-scoped-step-ids.md)
- [0010: Resolve named agent capabilities before effects](0010-agent-profiles-and-grants.md)
- [0011: Own typed harness arguments and verify native contracts](0011-harness-controls-and-contracts.md)
- [0012: Bound agent admission across each run](0012-agent-admission.md)

- [0013: Bound process cleanup and retain child ownership across runner death](0013-process-ownership.md)

- [0014: Preserve saved state through the CLI error boundary](0014-scriptable-cli-errors.md)

- [0015: Observe runs without changing effect identity](0015-observe-runs-without-changing-effect-identity.md)

- [0016: Rehearse workflows through fixture harnesses and a pure native planner](0016-workflow-rehearsal.md)

- [0017: Infer from schemas and normalize values at durable boundaries](0017-schema-first-values.md)

- [0018: Suspend at quiescence for external question answers](0018-durable-questions.md)

- [0019: Journal changes in private per-project run directories](0019-journal-storage-and-project-state.md)

- [0020: Resolve external readiness in one durable wait](0020-durable-waits-and-tick.md)

- [0021: Keep deterministic commands and file effects in the durable core contract](0021-durable-commands-and-files.md)

- [0022: Runtime-owned worktree isolation](0022-runtime-owned-worktree-isolation.md)

- [0023: Resolve restricted harness configuration before identity](0023-restricted-harness-configuration.md)

- [0024: Stream native output through runtime-owned attempt evidence](0024-stream-attempt-evidence.md)

- [0025: Attempt usage and run admission budgets](0025-attempt-usage-and-run-budgets.md)

- [0026: Inline children and definition registry](0026-inline-children-and-definition-registry.md)

- [0027: Typed harness registry and integration helpers](0027-typed-harness-registry-and-integration-helpers.md)

- [0028: Brand public errors across module instances](0028-brand-public-errors-across-module-instances.md)

- [0029: Persist external interruptions as resumable suspensions](0029-persist-interruptions-as-resumable-suspensions.md)

- [0030: Publish, release and recover run locks by rename](0030-rename-published-run-locks.md)

- [0031: Private CODEX_HOME for instruction-free Codex calls](0031-private-codex-home-for-instruction-free-calls.md)

- [0032: Interprocess worktree administration lock](0032-interprocess-worktree-administration-lock.md)

- [0033: Redact free-form controls from public capability manifests](0033-redact-free-form-controls-from-public-manifests.md)

- [0034: Compact results for the run commands, the full record behind --full](0034-compact-run-command-results.md)

- [0035: Sticky launch policy in the run's launch metadata](0035-sticky-launch-policy.md)

- [0036: Detached start reports a run only when its runner owns the record](0036-detached-start.md)

- [0037: A compact JSONL event stream behind --events](0037-compact-event-stream.md)

- [0038: A code-free event follower derived from the run record](0038-code-free-event-follower.md)

- [0039: Cancel a live run through a token-bound request](0039-cancel-a-live-run-through-a-token-bound-request.md)

- [0040: Grade harness versions against a tested range](0040-grade-harness-versions-against-a-tested-range.md)

- [0041: Static durability lint at load time](0041-static-durability-lint.md)

- [0042: Idle deadlines and tool-use diagnostics from the attempt stream](0042-idle-deadlines-and-tool-use-diagnostics.md)

- [0043: Checked harness-kit declarations and shared adapter helpers](0043-checked-harness-kit-declarations-and-adapter-helpers.md)

- [0044: gh-backed, complete-or-throw GitHub reads](0044-gh-backed-github-reads.md)

- [0045: Head-pinned GitHub waits with pluggable reviewers](0045-head-pinned-github-waits.md)

- [0046: Reconciled GitHub writes](0046-reconciled-github-writes.md)

- [0047: Pull request writes and a head-pinned merge](0047-pull-request-writes-and-head-pinned-merge.md)

- [0048: An epic snapshot and a pure next-ticket selector](0048-epic-snapshot-and-next-ticket-selector.md)

- [0049: Remove a run while holding its legacy guard](0049-guard-held-run-removal.md)

- [0050: Select runs for prune conservatively](0050-select-runs-for-prune-conservatively.md)

- [0051: Remove stale project roots by rmdir only](0051-remove-stale-project-roots-by-rmdir.md)

- [0052: A run-record schema revision that writers refuse to outrun](0052-run-record-schema-revision.md)

- [0053: Suspend on the subscription-window gate until the window resets](0053-window-utilization-gate-suspends-until-reset.md)

- [0054: Bound call-site Claude directories by declared profile roots](0054-bounded-call-site-adddirs.md)
