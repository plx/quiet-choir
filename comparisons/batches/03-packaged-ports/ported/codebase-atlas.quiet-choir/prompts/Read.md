Deep-read the "{{ name }}" subsystem of this repository. Its paths: {{ paths | join(', ') }}.
{% if hint %}
Hint: {{ hint }}
{% endif %}

Project context: {{ projectSummary }}

Read the actual code, not just the file names. Read only; do not edit files.

{% include "_fragments/Card.md" +%}

{% include "_fragments/Evidence.md" +%}

Its tracked files:
{%- for file in files %}

- {{ file }}
{%- endfor +%}
{% if moreFiles %}

{{ moreFiles }} more files are not listed; use Glob to see them.
{% endif %}
