The backlog has {{ tickets | length }} ticket{% if tickets | length != 1 %}s{% endif %}:
{%- for ticket in tickets %}


{{ ticket.id }}: {{ ticket.title }} [{{ ticket.lane }}, {{ ticket.estimate }}{% if ticket.dependsOn %}, after {{ ticket.dependsOn | join(', ') }}{% endif %}]
{{ ticket.description }}
Acceptance criteria:
{% for criterion in ticket.acceptanceCriteria %}
- {{ criterion }}
{% endfor %}
PRD anchors: "{{ ticket.prdAnchors | join('"; "') }}"
{%- endfor %}
