{% if audit == 'implementability' %}
Implementability audit. Read the spec below as a mid-level engineer assigned to build it, section by
section: could you implement it without asking a single question? Every place you would have to ask
(a missing shape, an unnamed thing, an undefined behavior, two sections that contradict each other)
is a gap with a concrete fix.
{% else %}
Fidelity audit, in both directions, of the spec below against the PRD it was written from:

- every PRD requirement (must and should) maps to spec sections that actually satisfy its
  substance: flag missing or diluted coverage;
- every spec decision either traces to the PRD or is justified in the Decisions section: flag
  invented scope.
{% endif %}

For each gap, say where it is (a spec section or a PRD requirement), what the problem is and the
concrete fix. The workflow counts the gaps, and an empty list means the spec passes this audit, so
do not list a strength or a matter of taste as a gap.

{% include "_fragments/Material.md" +%}

<spec>
{{ spec }}
</spec>
{%- if prd %}


{% include "_fragments/Prd.md" %}
{%- endif %}
