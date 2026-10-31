Synthesize an evidence-based answer to this research question: {{ question }}
{% if context %}
Local context, which the answer must fit: {{ context }}
{% endif %}

Rules: every substantive claim carries a citation, the key of the source it comes from in square
brackets, one key per bracket, as in [S2] or [S1][S4]. Cite only the keys below: the workflow checks
every citation against them and appends the list of sources itself. Where sources disagree, present
the disagreement and say which source is better placed to be right: primary beats secondary beats
anecdotal, and recent beats stale for fast-moving topics. Do not average contradictions into mush.
Distinguish "the evidence shows" from "the evidence suggests" from "no evidence found".

Structure: the direct answer first, in one paragraph; then the evidence; then caveats and what could
not be determined. Return markdown.

{% if gaps %}
A completeness critic found these gaps in an earlier draft, and targeted hunts followed them up:
{%- for gap in gaps %}

- {{ gap.gap }} ({% if gap.source %}new evidence in [{{ gap.source }}]{% elif gap.hunt == 'empty' %}a hunt found nothing{% elif gap.hunt == 'failed' %}its hunt failed{% else %}not hunted{% endif %})
{%- endfor +%}

Address every gap: with the new evidence where a hunt found some, and as an open question where it
did not.

{% endif %}
{% include "_fragments/Evidence.md" +%}

{% include "_fragments/Sources.md" %}
