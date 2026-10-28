Codebase context: where an item touches existing code, name the real module.
Tracked files under {% if codebase.path == '.' %}the repository root{% else %}{{ codebase.path }}{% endif %}{% if codebase.omitted %}, the first {{ codebase.files | length }} ({{ codebase.omitted }} more are not listed){% endif %}:

<files>
{{ codebase.files | join('\n') }}
</files>
