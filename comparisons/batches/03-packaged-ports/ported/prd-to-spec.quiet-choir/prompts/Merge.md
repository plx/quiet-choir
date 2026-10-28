Merge the lens drafts below into one coherent technical spec for the PRD.

Resolve overlaps between lenses: one canonical name per concept. Decide every contested decision
yourself in the Decisions section: reversible choices need a decision, not a committee.
{% if settled %}
Decision {{ settled.id }} was settled by an independent design tournament: adopt the tournament's
result below as authoritative, and say so in that decision's rationale.
{% endif %}

{% include "_fragments/Structure.md" +%}

Drafts:
{%- for section in sections %}


<draft lens="{{ section.lens }}">
### {{ section.heading }}

Serves: {{ section.prdAnchors | join('; ') }}

{{ section.content }}
</draft>
{%- endfor +%}

Contested decisions:
{%- for decision in decisions %}

- {{ decision.id }} ({{ decision.stakes }}, raised by {{ decision.lenses | join(', ') }}): {{ decision.decision }} Options: {{ decision.options | join(' | ') }}
{%- else %}
 none.
{%- endfor +%}
{% if settled %}

<tournament decision="{{ settled.id }}">
{{ settled.design }}
</tournament>
{% endif %}

{% include "_fragments/Grounding.md" +%}

{% include "_fragments/Material.md" +%}

{% include "_fragments/Prd.md" +%}

Return the complete spec markdown as spec.
