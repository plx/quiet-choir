Find dead-code candidates in {{ scope }} through one search modality; two other finders search in
different ways, so stay inside yours.

{% if modality == 'exports' %}
Find exported-but-never-imported code: exports no other file imports, public functions and classes
with zero call sites, and package.json dependencies no file requires. Search at the identifier or
AST level, not by eye. Skip anything under ten lines; it is not worth the sweep.
{% elif modality == 'reachability' %}
Find unreachable code by tracing from the entry points: main and index files, route tables, CLI
commands, scheduled jobs and the exported package surface. Report files and large branches that
nothing reachable ever calls, and feature flags that are permanently off.
{% else %}
Find stale artifacts: files whose imports have all migrated elsewhere, files with "-old", "-v1",
"backup" or "deprecated" in the name, commented-out blocks over twenty lines, and configuration keys
nothing reads.
{% endif %}

For each candidate give the identifier, its file, its kind and the evidence that it looks dead. An
empty list is a valid result. Read only; do not edit files.
