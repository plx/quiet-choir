Tailor an ordered software lifecycle for this goal: {{ goal }}

Inspect the repository and the existing artifacts first. Does a requirements document already
exist? A spec? Code? CI? Skip any stage whose output already exists, and include bootstrap only if
the project has no substantial tooling yet. Use each stage at most once, from this ordered set:
{{ allowed | join(' -> ') }}. A release gate must come before release notes.
{% if artifacts %}

Existing artifacts:
{%- for name, path in artifacts | items %}

- {{ name }}: {{ path }}
{%- endfor +%}
{% endif %}

Return the pruned, ordered plan and a short rationale. Read only; do not edit files.
