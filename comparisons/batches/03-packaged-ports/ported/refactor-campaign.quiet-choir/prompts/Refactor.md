Apply this approved refactoring to {{ target.location }}: {{ target.refactoring }}.
The goal: {{ goal }}. The pressure it relieves: {{ target.pressure }} ({{ target.evidence }}).

{% include "_fragments/preserve.md" +%}

Characterization nets pin the current behavior. The net for this target, {{ netFile }}, pins:
{%- for behavior in behaviors %}

- {{ behavior }}
{%- endfor +%}

The workflow runs every net on your checkout after you return, then the operator's verification
commands. If any fails, your change altered behavior or broke the build, and the workflow discards
it and keeps the nets. Preserving behavior beats completing the refactor: if this refactoring
cannot be done without changing behavior, make no change and answer declined.

Never edit, move or delete a net's files; the workflow discards a change that touches any of them:
{%- for file in protectedFiles %}

- {{ file }}
{%- endfor +%}

Change only what this refactoring needs. You have no shell, so do not try to run the tests; the
workflow runs them, and an independent reviewer then reads your diff and rejects changes that are
behavioral rather than structural.

Approved digest: {{ digest }}
Approved goal and plan:
{{ approved }}
