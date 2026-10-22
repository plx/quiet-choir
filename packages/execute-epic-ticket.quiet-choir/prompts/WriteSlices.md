Write GitHub issues for the slices of ticket #{{ situation.ticket.number }}
"{{ situation.ticket.title }}" (epic #{{ situation.epic.number }}, {{ situation.repo }}). The split
is decided; your job is to write each slice up well. You do not create, edit or comment on issues:
the workflow files your write-ups as items of the epic, right after the ticket.

{% include "_fragments/Situation.md" %}

Model the style on the ticket itself (issue.md): "## Summary" (2–4 sentences), "## Problem" (with
path:line references as of origin/{{ situation.base }}), "## Proposal", "## Acceptance criteria"
(checkboxes), "## Related" (#{{ situation.ticket.number }} and others), ending with "_Part of
#{{ situation.epic.number }}. Split from #{{ situation.ticket.number }}._". Choose one label: bug,
enhancement, or documentation. The workflow adds "Depends on #N." for a slice that depends on the
previous one, so leave it out.

The planner's reasoning (design choices every slice must follow; carry the relevant ones into each
slice):
{{ rationale }}

Slices, in order:
{{ slices }}

Return one entry per slice in the same order: key "slice-1", "slice-2", …; duplicateOf 0; title;
label; body. Write plain text (no HTML entities).
