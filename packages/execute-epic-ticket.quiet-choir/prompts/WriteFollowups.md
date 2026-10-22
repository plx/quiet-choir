Write up follow-up issues noticed while implementing ticket #{{ situation.ticket.number }}
"{{ situation.ticket.title }}" of epic #{{ situation.epic.number }} in {{ situation.repo }}. They are
out of that ticket's scope and will be filed under {% if followupEpic %}follow-up epic
#{{ followupEpic }}{% else %}a new follow-up epic, "{{ followupEpicTitle }}"{% endif %}. You do not
create, edit or comment on issues: the workflow files your write-ups.

{% include "_fragments/Situation.md" %}

For each item, first look for an existing open issue that already covers it
(`gh issue list -R {{ situation.repo }} --state open --search "<keywords>"`); if one does, set
duplicateOf to its number and leave body ''. Otherwise write the issue in the style of the ticket
itself: "## Summary" (2–4 sentences), "## Problem" (path:line references as of
origin/{{ situation.base }}), "## Proposal", "## Acceptance criteria" (checkboxes), "## Related"
(#{{ situation.ticket.number }} and others). The workflow appends the line "_Part of #EPIC. Found
while implementing #{{ situation.ticket.number }}._", so leave it out. Choose one label: bug,
enhancement, or documentation.

Items:
{% for item in items %}

### [{{ item.key }}] {{ item.title }}

{{ item.detail }}
{% endfor %}

Return one entry per item with key {{ keys | join(', ') }}; duplicateOf is 0 when there is no
duplicate. Write plain text (no HTML entities).
