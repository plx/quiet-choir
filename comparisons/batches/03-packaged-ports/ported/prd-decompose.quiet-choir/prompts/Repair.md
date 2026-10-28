Repair this backlog for the coverage gaps below. For each gap, add a ticket or amend the ticket the
gap names:

- A missing requirement gets a new ticket. Number new tickets from {{ next }} on, in order; a new
  ticket's dependsOn may name existing tickets and earlier new ones.
- An under-specified or wrong ticket gets an amendment: its complete new title, description,
  acceptance criteria, estimate and PRD anchors. Its lane, dependencies and sources stay as they
  are.
- Copy every PRD anchor verbatim from the PRD below and mark a skipped stretch with "...". The
  workflow looks for each anchor in the PRD and rejects a patch with one it cannot find.
- Return a revised sequencing paragraph when the new tickets change the milestones, and null when
  the current one still holds.

Return only the additions, the amendments and the sequencing. The workflow applies them and keeps
every other ticket exactly as it is.

{% include "_fragments/Estimates.md" +%}

The current sequencing: {{ sequencing }}

Gaps:
{% for gap in gaps %}
- {{ gap.problem }}{% if gap.ticket %} ({{ gap.ticket }}){% endif %}: "{{ gap.prdRequirement }}" Suggested fix: {{ gap.suggestion }}
{% endfor %}

{% include "_fragments/Tickets.md" +%}

{% include "_fragments/Prd.md" %}
