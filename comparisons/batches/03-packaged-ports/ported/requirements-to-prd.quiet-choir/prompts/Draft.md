Draft a PRD from these extracted requirements. Reply with its sections; the workflow renders them
in this order: problem and context, goals and success metrics, users and jobs, requirements (must
versus should), non-functional requirements, explicitly out of scope, open questions, and
assumptions, followed by a traceability appendix of the findings.

- Trace every requirement and non-functional requirement to the findings it rests on, by id. Do not
  add a requirement no finding supports: a gap is an open question.
- Every inferred finding you rely on must appear in an assumption that cites it. The workflow adds
  any you leave out.
- Present each known conflict as a decision the product owner must make, in the open questions. Do
  not silently pick a side.
- Start the open questions from the unknowns below, and give each question its consequences: what
  the answer decides.
- A goal the material gives no measure for has a null metric; do not invent a number.

{% if product %}
Product context: {{ product }}

{% endif %}
Findings, {{ findings | length }} in all. Each has its lens and confidence tier, and the source where
code found its quote:
{%- for finding in findings %}

- {{ finding.id }} [{{ finding.lens }}, {{ finding.confidence }}{% if finding.source %}, {{ finding.source }}{% endif %}]: {{ finding.point }}{% if finding.quote %} ("{{ finding.quote }}"){% endif %}
{%- endfor +%}

{% if conflicts %}
Known conflicts:
{%- for conflict in conflicts %}

- {{ conflict }}
{%- endfor +%}
{% else %}
The lenses found no conflicts.
{% endif %}

{% if unknowns %}
Unknowns:
{%- for unknown in unknowns %}

- {{ unknown }}
{%- endfor %}
{% else %}
The lenses found no unknowns.
{%- endif %}
