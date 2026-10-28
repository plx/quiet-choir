Plan the bootstrap of a {{ detected.stack }} project.

Specification: {{ spec }}
Concerns you may plan: {{ allowed | join(', ') }}. Plan each at most once.
Already present, to extend or leave alone but never overwrite: {% if detected.existing %}{{ detected.existing | join(', ') }}{% else %}nothing{% endif %}.
Still missing: {% if detected.missing %}{{ detected.missing | join(', ') }}{% else %}nothing{% endif %}.

Assign each concern the exact files it owns. File sets must be disjoint, because each concern is
applied by its own agent in its own checkout and the results are merged. Give the commands that
prove the finished setup works (install, lint, test, build, and a CI configuration check where one
exists) as argv arrays: each command runs once, without a shell, with the operator's privileges,
after a human approves this exact plan. Read only; do not edit files.
