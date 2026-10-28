Survey this repository and partition it into subsystems for a team of readers. Look at the layout
below, the build configuration and the entry points: skim, do not deep-read. A subsystem is a
coherent unit someone could study alone (an API layer, a persistence layer, a worker fleet, a CLI, a
frontend app). Rank each core, supporting or peripheral. Prefer four to eight subsystems and merge
tiny ones; up to {{ maxSubsystems }} are deep-read, core first, and the rest are listed as skipped.

Give each subsystem the repository-relative files or directories it covers, spelled as in the
layout and without globs: the workflow matches them against the tracked files and leaves out a
subsystem that matches none. Write the project summary in three to five sentences: what this
software is and does. Read only; do not edit files.

{% include "_fragments/Evidence.md" +%}

The layout of the {{ fileCount }} tracked files, with the file count of each directory:
{%- for entry in layout %}

- {{ entry.path }}{% if entry.files %} ({{ entry.files }} {% if entry.files == 1 %}file{% else %}files{% endif %}){% endif %}
{%- endfor +%}
{% if omitted %}

{{ omitted }} more entries are not listed; use Glob to see them.
{% endif %}
