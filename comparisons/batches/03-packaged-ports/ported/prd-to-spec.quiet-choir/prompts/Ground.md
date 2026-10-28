Ground an upcoming technical spec in the code that exists, not the code we wish existed. Read the
PRD below for what is being planned, then map the codebase{% if codebase.path != '.' %} under {{ codebase.path }}{% endif %}:

- summary: the existing architecture, in one paragraph;
- conventions: the patterns new code must respect (error handling, naming, layering);
- integrationPoints: where this work will attach to existing code, naming the files;
- constraints: realities the PRD may not know about (framework limits, load-bearing tech debt,
  performance walls).

Report the map only; do not design anything. Read only; do not edit files.

Tracked files under {% if codebase.path == '.' %}the repository root{% else %}{{ codebase.path }}{% endif %}{% if codebase.omitted %}, the first {{ codebase.files | length }} ({{ codebase.omitted }} more are not listed){% endif %}:

<files>
{{ codebase.files | join('\n') }}
</files>

{% include "_fragments/Material.md" +%}

{% include "_fragments/Prd.md" %}
