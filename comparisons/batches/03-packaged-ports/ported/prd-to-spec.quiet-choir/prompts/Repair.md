Repair the technical spec below. Two independent audits, one for implementability and one for
fidelity to the PRD, found these gaps:
{%- for gap in gaps %}

- {{ gap.audit }}, at {{ gap.where }}: {{ gap.problem }} Fix: {{ gap.fix }}
{%- endfor +%}

Fix each gap in place. Where a fix needs the product owner, add it to Open questions instead of
guessing. Keep every other part of the spec as it is.
{% if settled %}
Decision {{ settled }} was settled by an independent design tournament: keep its outcome.
{% endif %}

{% include "_fragments/Structure.md" +%}

{% include "_fragments/Material.md" +%}

<spec>
{{ spec }}
</spec>

{% include "_fragments/Prd.md" +%}

Return the complete revised spec markdown as spec.
