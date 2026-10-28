A code reviewer claims this defect exists. Your job is to refute it.

Claim: {{ finding.title }} ({{ finding.severity }}, from the {{ finding.dimensions | first }} review)
Location: {{ finding.file }}{% if finding.line %}:{{ finding.line }}{% endif +%}
Evidence: {{ finding.evidence }}
Failure scenario: {{ finding.failureScenario }}

{% include "_fragments/Snapshot.md" +%}

Read the actual code. Check whether the failure scenario can really occur: look for guards the
reviewer missed, callers that make the input impossible, and tests that already cover it. If you
cannot demonstrate that the claim holds against your best refutation attempt, mark it refuted; when
uncertain, refute. If it survives, you may adjust its severity in either direction; otherwise leave
adjustedSeverity null.

{% include "_fragments/Evidence.md" +%}

{% if patch %}
The change to {{ finding.file }}:

<patch>
{{ patch }}
</patch>
{%- else %}
The change does not touch {{ finding.file }}, so there is no patch for it; judge the claim against
the code at the head.
{%- endif %}
