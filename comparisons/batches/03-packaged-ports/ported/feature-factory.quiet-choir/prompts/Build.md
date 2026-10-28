Implement the "{{ module.name }}" module of the approved feature plan below.

{% include "_fragments/Ownership.md" +%}

{% if builtOn %}
Your checkout already holds the foundations built before you: {{ builtOn | join(', ') }}. Build on
them rather than editing them.
{% else %}
Your checkout is the base commit; nothing of this plan is built yet.
{% endif %}

Tickets, in order:
{%- for ticket in tickets %}

- {{ ticket.id }}: {{ ticket.title }}
  {{ ticket.description }}
  Acceptance criteria:
{%- for criterion in ticket.acceptanceCriteria %}

  - {{ criterion }}
{%- endfor %}
{%- endfor +%}

{% if module.notes %}
The planner's notes: {{ module.notes }}

{% endif %}
Satisfy each ticket's acceptance criteria and match the codebase's existing conventions.

{% include "_fragments/Checkout.md" +%}

Report honestly: partial with blockers beats a hollow done, and blocked means none of your edits
should be integrated.

Approved plan digest: {{ digest }}
Approved plan:
{{ plan }}
