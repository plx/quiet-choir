The workflow integrated a migration and verified it: it ran the operator's verification commands on
the integrated tree and searched the migrated files for the old API. Group what failed into
distinct clusters by root cause, not one entry per failing test, and name the files each cluster
involves. You have no tools; work from the record and the output below. An empty list means
nothing here is a migration failure.

{% include "_fragments/Migration.md" +%}

Groups the migrators changed:
{%- for group in migrated %}

- {{ group.files | join(', ') }} ({{ group.status }}): {{ group.summary }}
{%- endfor +%}
{% if unmigrated %}

Groups left on the old API, whose remaining references are expected:
{%- for group in unmigrated %}

- {{ group.files | join(', ') }} ({{ group.status }}): {{ group.summary }}
{%- endfor +%}
{% endif %}
{% if leftovers %}

The old API still appears in these files, which their migrators reported fully migrated:
{%- for file in leftovers %}

- {{ file }}
{%- endfor +%}
{% endif %}
{% for failure in failures %}

Command {{ loop.index }}, {{ failure.outcome }}: {{ failure.command }}

<output>
{{ failure.output }}
</output>
{% endfor %}
