Before editing, read {{ situation.worktree }}/AGENTS.md, {{ situation.worktree }}/CONTRIBUTING.md,
and any AGENTS.md/CLAUDE.md in directories you touch, and follow them. In particular: behavior
changes need tests; public exports need TypeDoc comments; guides, both physical skill copies
(plugins/agents/… and plugins/claude/…), examples/patterns and the matching Workflow Lab Batch 02
port must stay consistent with code changes; observable changes get a CHANGELOG.md entry under
"Unreleased"; cross-cutting design choices get an ADR in docs/decisions/.
