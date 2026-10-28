Merge these work items from five specialized readings of one PRD into a deduplicated backlog.

Ticket identity is a judgment call: two lenses describing the same work use different words
("handle upload failure" and "show retry UI on failed upload"), so read for what the work is rather
than matching words. Items describing the same work become one ticket: union their acceptance
criteria and list every merged item's id in sources. The workflow carries the PRD anchors of a
ticket's sources onto it, so every item below should end up in the sources of some ticket.

- Number the tickets T1, T2, ... in list order, and list a ticket only after every ticket it depends
  on: dependsOn may name only earlier tickets. Foundations come before the stories that need them;
  instrumentation can trail its feature.
- Give each ticket a lane: feature, edge-cases, non-functional, infra-migration or instrumentation.
- Split any XL item: a ticket is at most L.
- Write the sequencing paragraph: the milestone grouping and what gates each milestone. The
  workflow computes the dependency waves and the critical path from your dependsOn edges and
  estimates.
- Carry forward the open questions below, deduplicated, and add any the merge itself raises.

{% include "_fragments/Estimates.md" +%}

{% if questions %}
Open questions from the lenses:
{% for question in questions %}
- {{ question }}
{% endfor %}
{% else %}
The lenses raised no open questions.
{% endif %}

Items, {{ items | length }} in all:
{%- for item in items %}


{{ item.id }} [{{ item.lens }}, {{ item.estimate }}]: {{ item.title }}
{{ item.description }}
{% if item.acceptanceCriteria %}
Acceptance criteria:
{% for criterion in item.acceptanceCriteria %}
- {{ criterion }}
{% endfor %}
{% endif %}
PRD anchor: "{{ item.prdAnchor }}"
{%- endfor %}
