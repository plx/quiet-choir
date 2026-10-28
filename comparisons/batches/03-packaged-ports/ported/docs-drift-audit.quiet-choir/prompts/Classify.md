Classify the documentation of this repository for a drift audit, which decomposes each doc into
checkable claims and verifies them against the code at commit {{ base }}.

The workflow listed these docs, each with up to three of its headings:
{%- for doc in docs %}

- {{ doc.path }}{% if doc.headings %}: {{ doc.headings | join(" / ") }}{% endif %}
{%- endfor +%}

For each doc give its audience (end users, contributors, operators, ...) and a priority:

- high: wrong claims here actively hurt readers, such as install instructions, quick starts and
  command or configuration references;
- medium: guides and how-tos that readers follow less literally;
- low: design notes, proposals and decision records;
- skip: generated files and release history; history does not drift.

Classify every listed doc once, from its path and headings. The audit reads the docs you rank
highest first and may stop before the low ones, so the priority decides what gets checked.
