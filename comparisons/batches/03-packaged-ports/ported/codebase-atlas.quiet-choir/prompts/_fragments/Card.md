Produce a card for a new team member:

- purpose: two to four sentences on what it is for;
- keyFiles: the files that matter, each with its role, as repository-relative paths of tracked
  files (the workflow checks every path and leaves out any that does not exist);
- entryPoints: where execution enters it;
- dependsOn: other subsystems by the names below, and external services by their plain names;
- dataFlows: how data moves through it, in one short paragraph;
- gotchas: non-obvious invariants, footguns, historical scars, things that would surprise someone
  editing this next week. Gotchas are the most valuable field: dig for them.
{%- if others %}


Other sections, by name: {{ others | join(', ') }}.
{%- endif %}
