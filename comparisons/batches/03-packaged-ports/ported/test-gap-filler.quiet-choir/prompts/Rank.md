Rank these test gaps by blast radius: if this code silently broke, how bad and how invisible would
the damage be? Select the keys of the highest-risk gaps, at most {{ maxGaps }}, each once.

Gaps:
{%- for gap in gaps %}

- {{ gap.key }}: {{ gap.reason }}
{%- endfor %}
