Render the release decision for {{ span }} and write a rationale a release manager can forward.

House policy: {{ policy }}
Hard-block dimensions: {{ blockOn | join(', ') if blockOn else 'none' }}

{% if rule == 'hard-block' %}
The workflow's gate rule allows only no-go: a blocker stands on a hard-block dimension. Explain
why, and list as conditions what must be fixed before the release is gated again.
{% elif rule == 'held' %}
The workflow's gate rule allows conditional-go or no-go: a blocker stands on a dimension that is
not a hard block, or a hard-block dimension could not be verified. Choose conditional-go, with every
condition that must hold before shipping, unless the evidence shows that shipping would be
genuinely wrong.
{% else %}
The workflow's gate rule allows go or conditional-go: no blocker stands. Choose conditional-go when
shipping is fine provided named conditions are met first, such as a concern that needs a follow-up
before release; otherwise choose go.
{% endif %}

{% if blockers %}
Blockers:
{%- for row in blockers %}

- {{ row.dimension }}{% if row.hard %}, a hard block{% endif %}{% if row.source == 'code' %}, from the workflow's own test run{% endif %}{% if row.confirmation == 'unconfirmed' %}, unconfirmed because its confirmer failed{% endif %}: {{ row.evidence }}
{%- for finding in row.findings %}

  - {{ finding }}
{%- endfor %}
{%- endfor +%}

{% endif %}
{% if concerns %}
Concerns, real but not blocking:
{%- for row in concerns %}

- {{ row.dimension }}{% if row.reported == 'blocker' %} (a blocker its confirmer downgraded: {{ row.reasoning }}){% endif %}: {{ row.evidence }}
{%- for finding in row.findings %}

  - {{ finding }}
{%- endfor %}
{%- endfor +%}

{% endif %}
{% if others %}
Other dimensions:
{%- for row in others %}

- {{ row.dimension }}: {{ row.status }}{% if row.reported == 'blocker' %} (a blocker its confirmer cleared: {{ row.reasoning }}){% endif %}. {{ row.evidence }}
{%- for finding in row.findings %}

  - {{ finding }}
{%- endfor %}
{%- endfor +%}

{% endif %}
{% if unverified %}
Nobody could verify these hard-block dimensions: {{ unverified | join(', ') }}.
{% if rule == 'hard-block' %}
Include verifying each one among the conditions for gating the release again.
{% else %}
A conditional-go needs a condition that each one is checked before shipping.
{% endif %}

{% endif %}
{% if rule == 'hard-block' %}
Make every condition specific and checkable. Return the decision, the conditions and the
rationale.
{% else %}
Make every condition specific and checkable; a conditional-go needs at least one. Return the
decision, the conditions and the rationale.
{% endif %}
