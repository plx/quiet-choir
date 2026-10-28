Changes, one per summarized commit:
{%- for change in changes %}

- {{ change.sha }} [{{ change.kind }}{% if not change.userVisible %}, not user-visible{% endif %}] {{ change.summary }}{% if change.migrationNote %} Migration: {{ change.migrationNote }}{% endif %}
{%- endfor %}
{%- if missing %}


These commits have no summary, so the notes cannot be complete: {{ missing | join(', ') }}.
Say so in one line and never claim completeness.
{%- endif %}
