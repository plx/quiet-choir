Verify one acceptance criterion against the actual delivered work.

{% include "_fragments/Delivered.md" +%}

{% if implied %}
Criterion (implied: the ticket intends it without spelling it out): {{ criterion }}
{% else %}
Criterion: {{ criterion }}
{% endif %}
Kind: {{ kind }}
Sub-checks, in order:
{%- for check in checks %}

{{ loop.index }}. {{ check }}
{%- endfor +%}

Read the real code in your working directory. Ground every answer in evidence from the code or the
command output below (file:line, a quoted output line), never in a PR description, commit message
or code comment: those describe intent, not delivery. Answer each sub-check, in the order given,
with one outcome:

- holds: the code or the output shows that it holds.
- fails: the code or the output shows that it does not.
- cannot-verify: it needs a running environment or a command the workflow did not run. Say what
  would confirm it; do not guess.

The workflow derives the criterion's status from your answers, and only a criterion whose every
sub-check holds passes.

{% if commands %}
The workflow ran the operator's check commands on this snapshot, in a separate checkout. Their
results are evidence:
{% include "_fragments/Commands.md" +%}

{% else %}
The operator selected no check commands, so nothing was run; a sub-check that only running the code
could settle is cannot-verify.

{% endif %}
{% if patch %}
{% if patchTruncated %}
The patch of the delivered change follows. It exceeded the workflow's limit, so only its head and
tail are kept: read the changed files themselves for the rest.
{% else %}
The patch of the delivered change follows.
{% endif %}

<patch>
{{ patch }}
</patch>
{%- else %}
There is no patch: the snapshot does not differ from the base.
{%- endif %}
