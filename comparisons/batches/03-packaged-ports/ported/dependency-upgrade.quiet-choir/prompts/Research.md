{% if toVersion %}
Research upgrading the package "{{ package }}" to {{ toVersion }}.
{% else %}
Research upgrading the package "{{ package }}" to its latest stable release.
{% endif %}

Use your web search and fetch tools to read the official changelog, the release notes and the
migration guide, and prefer the package's own documentation over blog posts. You cannot read this
repository.

{% include "_fragments/Evidence.md" +%}

Determine the installed major version from the evidence first (say unknown when it shows none),
then enumerate every breaking change between it and the target: what each change breaks and the
official migration hint. Report the exact target version you researched; when the target is a range
or the latest stable release, resolve it to one release. An empty list of breaking changes is a
valid result.
