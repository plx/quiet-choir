Fix one failure cluster of a migration, in your own isolated checkout of the integrated tree, which
holds every migrated group.

{% include "_fragments/Migration.md" +%}

The cluster: {{ cluster.description }}
{% if cluster.files %}
Files involved:
{%- for file in cluster.files %}

- {{ file }}
{%- endfor +%}
{% else %}
Identify the files involved from the record below.
{% endif %}

You may change only these files of the approved plan, and only their content:
{%- for file in allowed %}

- {{ file }}
{%- endfor +%}

The workflow refuses a checkout that changes any other file, or adds, deletes or renames one. If
the fix needs another file, leave it alone and say so in your summary. Make the narrowest change
that fixes this cluster: other repairers work on other clusters at the same time. Do not try to run
anything; the workflow integrates the repairs and runs the operator's verification commands again.
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

Approved plan digest: {{ digest }}
Approved plan:
{{ plan }}
