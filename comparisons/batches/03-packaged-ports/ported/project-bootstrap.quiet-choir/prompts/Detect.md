Decide the tech stack and inventory the existing tooling for a project bootstrap.

Specification: {{ spec }}

{% if stack %}
The stack is specified: {{ stack }}. Use it.
{% else %}
Choose an appropriate, conventional stack; favor boring, well-supported choices.
{% endif %}

Read the repository: what tooling already exists (package manager, linter, test runner, CI
configuration, containers)? List it as existing, because setup must not clobber it. Then list the
bootstrap concerns that are still missing. Read only; do not edit files.

Tracked files at the pinned base commit:

<files>
{{ inventory }}
</files>
