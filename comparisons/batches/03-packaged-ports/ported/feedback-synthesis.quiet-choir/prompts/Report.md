Write the judgment in a feedback-synthesis report. The workflow renders everything else itself: the
coverage line, the ranked theme table with its counts, a section per deep-dived theme with its
storyline, segments, recommendation and verbatim quotes, and a list of what was not covered.

Coverage: {{ coverage }}

Ranking, by items plus {{ weight }} times severe items:
{%- for theme in ranked %}

- {{ theme.theme }}: {{ theme.count }} items, {{ theme.severe }} severe, score {{ theme.score }}
{%- endfor +%}

{% if longTail %}
Ranked themes without a deep dive, the long tail:
{%- for theme in longTail %}

- {{ theme.theme }}: {{ theme.definition }}
{%- endfor +%}

{% endif %}
{% if emergent %}
Emergent patterns that taggers saw outside the vocabulary:
{%- for pattern in emergent %}

- {{ pattern }}
{%- endfor +%}

{% if moreEmergent %}
The report lists {{ moreEmergent }} more.

{% endif %}
{% endif %}
{% if gaps %}
Not covered, which the report also lists:
{%- for gap in gaps %}

- {{ gap }}
{%- endfor +%}

{% endif %}
Write three parts:

- summary: at most three executive-summary bullets, the most important first, each naming its theme
  and what it means for the product.
- longTail: one paragraph on the long-tail themes, or null when there are none.
- emergent: which emergent patterns deserve a theme next quarter, and why, or null when there are
  none.

Do not quote users and do not restate the counts: the report places them beside your text. Never
turn what users said into a stronger claim than the items and dives support, and say so where the
coverage was incomplete. The deep dives come last, as JSON:

<dives>
{{ dives }}
</dives>
