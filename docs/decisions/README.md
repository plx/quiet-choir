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
