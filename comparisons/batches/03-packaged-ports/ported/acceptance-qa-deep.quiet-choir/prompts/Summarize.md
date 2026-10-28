Write a one-paragraph QA verdict for stakeholders.

The workflow computed the overall verdict from the checks: {{ verdict }}.

Criteria results:
{%- for item in graded %}

- [{{ item.status }}] {{ item.criterion }}{% if item.implied %} (implied){% endif %}
{%- endfor +%}

A status is pass, fail, partial (some sub-checks hold), cannot-verify (needs a running environment),
fail-spirit (passes in letter but not in intent), unchallenged (passed, but its letter-vs-spirit
check failed), unchecked (its checker failed) or skipped (past the workflow's criteria limit).

{% if mustFix %}
Must-fix criteria:
{%- for item in mustFix %}

- {{ item.criterion }}: {{ item.why }}. Evidence: {{ item.evidence }}
{%- endfor +%}

{% endif %}
{% if pendingManual %}
Needs a human or a running environment to confirm:
{%- for item in pendingManual %}

- {{ item.criterion }}: {{ item.why }}
{%- endfor +%}

{% endif %}
Lead with the verdict and why.
{% if verdict == 'not-done' %}
The must-fixes are the failing criteria: be specific and actionable.
{% elif verdict == 'done-pending-manual' %}
Name exactly what needs a human or an environment to confirm.
{% endif %}
Return only the paragraph.
