<proposal letter="{{ proposal.letter }}">
Title: {{ proposal.title }}

{{ proposal.summary }}

Components:
{%- for component in proposal.components %}

- {{ component.name }}: {{ component.responsibility }}{% if component.interfaces %}; interfaces: {{ component.interfaces }}{% endif %}
{%- endfor +%}

Data flow: {{ proposal.dataFlow or 'not given' }}

Tradeoffs:
{%- for tradeoff in proposal.tradeoffs %}

- {{ tradeoff }}
{%- endfor +%}

Risks:
{%- for risk in proposal.risks %}

- {{ risk }}
{%- endfor +%}

Migration path: {{ proposal.migrationPath or 'not given' }}
</proposal>