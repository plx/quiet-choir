Write a security-audit report in markdown for {{ scope }} at revision {{ revision }}.

Surface summary: {{ summary }}

The findings below survived severity-scaled refutation panels, so do not re-litigate them. Group
them by severity, most severe first. For each, give its impact in one sentence, the attack scenario
and the remediation. Close with the top three systemic patterns you see across the findings, such
as "input validation is ad hoc at every boundary".

Confirmed findings:
{%- for finding in confirmed %}

- {{ finding.severity }}: {{ finding.title }}, at {{ finding.file }}{% if finding.line %}:{{ finding.line }}{% endif %} ({{ finding.lens }} lens, upheld by {{ finding.upheld }} of {{ finding.seats }})
  Evidence: {{ finding.evidence }}
  Attack scenario: {{ finding.attackScenario }}
  Remediation: {{ finding.remediation }}
{%- endfor +%}

{% if undecided %}
These findings were neither confirmed nor refuted, because a skeptic failed. List them in a section
of their own as unverified and needing manual review, without judging them:
{%- for finding in undecided %}

- {{ finding.severity }}: {{ finding.title }}, at {{ finding.file }}{% if finding.line %}:{{ finding.line }}{% endif %} ({{ finding.lens }} lens)
{%- endfor +%}

{% endif %}
{% if undecided or failedLenses or unchecked %}
The audit was incomplete, so the report must say so and must not call the code secure:
{%- if undecided %}

- Findings left unverified by a failed skeptic: {{ undecided | length }}.
{%- endif %}
{%- if failedLenses %}

- Lenses whose sweep failed, so their area is unaudited: {{ failedLenses | join(', ') }}.
{%- endif %}
{%- if unchecked %}

- Lower-ranked findings past the per-lens panel cap, never verified: {{ unchecked }}.
{%- endif +%}

{% endif %}
Return only the markdown.
