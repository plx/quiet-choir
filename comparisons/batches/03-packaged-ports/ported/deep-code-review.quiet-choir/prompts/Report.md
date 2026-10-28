Write a code-review report in markdown for this change: {{ summary }}

The findings below survived adversarial verification, so do not re-litigate them. Order them by
severity, most severe first. For each, say what is wrong, why it matters and a concrete suggested
fix. End with a one-paragraph overall assessment.

Confirmed findings:
{%- for finding in confirmed %}

- {{ finding.severity }}: {{ finding.title }}, at {{ finding.file }}{% if finding.line %}:{{ finding.line }}{% endif %} (raised by {{ finding.dimensions | join(', ') }})
  Evidence: {{ finding.evidence }}
  Failure scenario: {{ finding.failureScenario }}
  Verifier: {{ finding.reasoning }}
{%- endfor +%}

{% if unreviewedDimensions or omitted or unverified or unchecked %}
The review was incomplete, so the assessment must say so and must not call the change clean:
{%- if unreviewedDimensions %}

- Dimensions never reviewed, because their reviewer failed: {{ unreviewedDimensions | join(', ') }}.
{%- endif %}
{%- if omitted %}

- Changed files left out by the line budget, never reviewed: {{ omitted }}.
{%- endif %}
{%- if unverified %}

- Findings whose skeptic failed, so never verified: {{ unverified }}.
{%- endif %}
{%- if unchecked %}

- Lower-ranked findings past the verification cap, never verified: {{ unchecked }}.
{%- endif +%}

{% endif %}
Return only the markdown.
