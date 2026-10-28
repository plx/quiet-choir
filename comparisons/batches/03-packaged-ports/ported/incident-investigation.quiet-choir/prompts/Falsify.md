Your single job: falsify hypothesis {{ hypothesis.id }}.

{% include "_fragments/ReadOnly.md" +%}

Incident: {{ incident }}
Hypothesis: {{ hypothesis.story }}
Mechanism: {{ hypothesis.mechanism }}
Predictions to attack:
{%- for prediction in hypothesis.predictions %}

- {{ prediction }}
{%- endfor +%}

{% if rivals %}
Rival hypotheses, as context only; do not evaluate them:
{%- for rival in rivals %}

- {{ rival }}
{%- endfor +%}

{% endif %}
{% include "_fragments/Facts.md" +%}

Check each prediction against the repository, logs and configuration. A prediction that fails
falsifies the hypothesis. A prediction you cannot check is untestable: say so rather than assuming
it holds. Answer survives only if every checkable prediction held under a genuine attempt to break
it. Falsifying a hypothesis is a success, not a failure.
