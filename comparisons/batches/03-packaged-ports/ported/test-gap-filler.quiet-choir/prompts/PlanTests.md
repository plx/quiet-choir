Propose a focused new test file, {{ testFile }}, for {{ target }} that covers every selected gap,
failure paths first, and small independent mutants that its assertions should kill. The behavior to
exercise: {{ behavior }}.

Selected gaps:
{%- for gap in gaps %}

- {{ gap.key }}: {{ gap.reason }}
{%- endfor +%}

Follow the repository's existing test structure and naming. Assert outcomes, not merely that nothing
throws. Each mutant replaces one exact before string, which must occur exactly once in the source
below, with a different after string (a flipped condition, a wrong boundary, a swapped branch).
Return the test file's full content and the mutants; do not edit files. The workflow writes the
test, runs the operator's test command, and runs every mutant against it.

<source path="{{ target }}">
{{ source }}
</source>
