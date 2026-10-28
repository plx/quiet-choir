A release-gate assessor flagged a blocker on dimension {{ dimension }}. Confirm whether it truly
should stop the release.

Assessor's evidence: {{ evidence }}
{% if findings %}
Findings:
{%- for finding in findings %}

- {{ finding }}
{%- endfor +%}
{% endif %}

House policy: {{ policy }}

Verify it against the actual code, the patch and any command output below: is it real, reachable
and in scope for this release? A pre-existing issue that this range did not introduce, or a
documented and accepted risk, is not a blocker. Answer confirmed only if shipping with this is
genuinely wrong; otherwise answer concern for a real problem that should not block, or
not-a-problem.

{% include "_fragments/Evidence.md" +%}

{% if commands %}
{% include "_fragments/Commands.md" +%}

{% endif %}
{% include "_fragments/Range.md" %}
