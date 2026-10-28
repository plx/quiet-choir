{% if breaking %}
Known breaking changes:
{%- for item in breaking %}

- {{ item.change }}; breaks {{ item.affects }}.{% if item.migrationHint %} Migration: {{ item.migrationHint }}{% endif %}
{%- endfor %}
{% else %}
The research found no breaking change between the installed and the target version.
{%- endif %}
