{% if ticket.description %}
Description: {{ ticket.description }}

{% endif %}
Acceptance criteria:
{%- for criterion in ticket.acceptanceCriteria %}

{{ loop.index }}. {{ criterion }}
{%- endfor %}
