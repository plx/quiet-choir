A planner concluded that ticket #{{ situation.ticket.number }} of epic #{{ situation.epic.number }}
needs no work ({{ kind }}). Try to prove it wrong.

{% include "_fragments/Situation.md" %}

The planner's evidence: {{ rationale }}

Read issue.md and check every acceptance criterion against the code in the worktree
(origin/{{ situation.base }}). Agree only if each one is demonstrably satisfied (already-done) or
genuinely moot (no-longer-applies). Return agree, the evidence you checked, and any criteria that
remain unmet. You do not edit code.
