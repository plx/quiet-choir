A criterion was marked pass: every one of its sub-checks held. Check whether it passes in spirit or
only in letter.

{% include "_fragments/Delivered.md" +%}

Criterion: {{ criterion }}
Claimed-passing evidence, per sub-check:
{%- for check in checks %}

- {{ check.check }}: {{ check.evidence }}
{%- endfor +%}

{% if commands %}
The workflow ran the operator's check commands on this snapshot, in a separate checkout, and the
checker saw the same results:
{% include "_fragments/Commands.md" +%}

{% else %}
The operator selected no check commands, so nothing was run.

{% endif %}
Look for the narrow pass: hardcoded to satisfy the check, works only for the happy example,
satisfies the words while missing the intent, passes because a guard is disabled or a test is
skipped or never asserts the case. Read the code the evidence cites and the code around it, and the
command output it quotes. Answer honest only if a user relying on this criterion would actually be
served; when it is not, name the gotcha, the narrow way it passes.
