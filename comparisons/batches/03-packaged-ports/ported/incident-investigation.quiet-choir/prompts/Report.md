Write the incident-investigation report in markdown for this incident: {{ incident }}

The workflow derived the confidence from the verdicts' structure: {{ confidence }}.

{% include "_fragments/Facts.md" +%}

Verdicts:
{%- for hypothesis in judged %}

- {{ hypothesis.id }}: {{ hypothesis.story }} {% if hypothesis.verdict %}=> {{ hypothesis.verdict.verdict }}: {{ hypothesis.verdict.reasoning }}{% else %}=> unchallenged (its falsifier failed){% endif %}
{%- endfor +%}

Structure:

1. Timeline: merge the evidence timestamps into an ordered narrative from first cause to detection.
{% if confidence == 'high' %}
2. Root cause: the surviving hypothesis, stated as the finding, with its verified predictions as
   proof.
{% elif confidence == 'medium' %}
2. Root cause: the surviving hypothesis, with the caveat that no rival was affirmatively falsified.
{% elif confidence == 'split' %}
2. Root cause: the surviving hypotheses and the specific evidence that would discriminate between
   them; do not pick a favorite.
{% else %}
2. Root cause: say plainly that every hypothesis was falsified, untestable or unchallenged, and list
   the evidence that is missing.
{% endif %}
3. Falsified explanations: each dead hypothesis and what killed it, so the next investigator does
   not walk the same dead ends.
4. Prevention: two to four concrete changes that would have prevented this or caught it sooner.

Cite evidence sources throughout.
