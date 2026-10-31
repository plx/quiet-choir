Revise this PRD to address the critics' issues, and reply with the complete revised PRD.

Apply every fix you can make without new information from the product owner. Where a fix needs
their input, add a precise question to the open questions, with the decision's consequences,
instead of guessing. Keep the assumptions honest: anything you decide unilaterally goes there,
citing no finding. Keep tracing every requirement to the findings in the appendix, by id; the
workflow again adds an assumption for any inferred finding you rely on without one.

{% include "_fragments/Caps.md" +%}

Issues, {{ issues | length }} in all, most severe first:
{%- for issue in issues %}

- {{ issue.severity }}, from the {{ issue.critic }} critic: {{ issue.problem }} Fix: {{ issue.fix }}
{%- endfor +%}

{% include "_fragments/Prd.md" %}
