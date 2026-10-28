Group this backlog into at most {{ max }} implementation module{% if max != 1 %}s{% endif %}.
Each module is built by its own agent in its own isolated checkout, and the workflow merges the
results, so the grouping is what makes parallel builders safe.

Rules:

- Every module owns explicit file areas: repository directories or files, without glob
  characters. No two areas may overlap, and a builder may change nothing outside its own, so put
  shared scaffolding (schemas, types, configuration, migrations) into a foundation module that the
  others build on.
- Foundations build one after another, in the order you list them; then every other module builds
  in parallel on top of all the foundations. A ticket may depend only on tickets in its own module
  or in a foundation that builds before it, never on another feature module.
- Place every ticket exactly once: in one module, or in deferred with the reason it fits no module
  this run, such as the module limit or a dependency you deferred. Do not drop any id.

Read the repository to choose areas that match its layout. Read only; do not edit files.

Tickets, in dependency order:
{%- for ticket in tickets %}

- {{ ticket.id }}: {{ ticket.title }} [{{ ticket.lane }}, {{ ticket.estimate }}{% if ticket.dependsOn %}, after {{ ticket.dependsOn | join(', ') }}{% endif %}]
  {{ ticket.description }}
{%- endfor +%}

{% if sequencing %}
Sequencing notes: {{ sequencing }}
{% else %}
Sequencing notes: none.
{% endif %}
{% if openQuestions %}

Open questions the backlog leaves unresolved; keep the tickets they touch flexible:
{%- for question in openQuestions %}

- {{ question }}
{%- endfor +%}
{% endif %}

{% if omitted %}
Files tracked at the base commit, the first {{ files | length }} ({{ omitted }} more are not listed):
{% else %}
Files tracked at the base commit:
{% endif %}

<files>
{{ files | join('\n') }}
</files>
