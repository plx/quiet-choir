Find test gaps in {{ target }}, the behavior to exercise being: {{ behavior }}.

{% if lens == 'coverage' %}
Work like a coverage tool: read the existing tests and any coverage reports checked into the
repository, and list the functions, branches and failure paths of {{ target }} that no test
references or exercises. Do not claim to have run any tooling.
{% else %}
Find the scariest untested behavior by reading, not by tooling: error and rollback paths,
data-integrity logic, parsing of external input, concurrency, and anything commented "careful" or
with a history of fixes. Then check whether the existing tests exercise it; "tests exist but miss
the failure paths" counts as a gap.
{% endif %}

Give each gap a short stable key and a reason that says what is untested and why that is
dangerous. Prioritize failure paths and concrete behavior. Read only; do not edit files.

<source path="{{ target }}">
{{ source }}
</source>
