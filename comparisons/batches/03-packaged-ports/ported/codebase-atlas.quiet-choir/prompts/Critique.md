Audit this onboarding atlas of commit {{ commit }} for completeness against the actual repository.
What would a new engineer still be missing? Check for subsystems present in the code but absent
from the atlas, dependency edges that are wrong, entry points that do not match reality, and
load-bearing configuration or infrastructure the atlas ignores. Read the repository to check each
claim; do not edit files.

Name the section each gap concerns: an existing section exactly as listed below, to correct it, or
the name of a new section, for a missing subsystem or ignored infrastructure. Give each gap a
repairAction a reader agent could execute. An empty list means the atlas is complete. End with a
one-line verdict.

Sections: {{ sections | join(', ') }}.
{% if skipped %}
Skipped by the deep-read cap (expected, still worth listing): {{ skipped | join(', ') }}.
{% endif %}
{% if unread %}
No card because the reader failed: {{ unread | join(', ') }}.
{% endif %}
{% if unmatched %}
Surveyed, but matching no tracked file: {{ unmatched | join(', ') }}.
{% endif %}
{% if uncovered %}

Tracked files that no surveyed subsystem covers, by top-level entry:
{%- for entry in uncovered %}

- {{ entry.area }} ({{ entry.files }} {% if entry.files == 1 %}file{% else %}files{% endif %})
{%- endfor +%}
{% endif %}

{% include "_fragments/Evidence.md" +%}

<atlas>
{{ atlas | trim }}
</atlas>
