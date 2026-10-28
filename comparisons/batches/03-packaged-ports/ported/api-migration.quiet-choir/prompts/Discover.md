Find every call site that must change for this migration, and group the sites into disjoint file
groups. Read only; do not edit files.

{% include "_fragments/Migration.md" +%}

{% if paths %}
Search only these repository paths:
{%- for path in paths %}

- {{ path }}
{%- endfor +%}
{% else %}
Search the whole repository.
{% endif %}

Grep for identifiers, imports and type references, and include indirect uses: re-exports,
wrappers, type-only imports and mocks in tests.
{% if hits %}

Code searched the base commit for {{ terms | join(', ') }} and found them in these tracked files:
{%- for file in hits %}

- {{ file }}
{%- endfor +%}

Put each of these files in a group, or list it under unchanged with the reason it must keep the
old API: the definition itself, kept for compatibility, or a changelog entry that records history.
Files this search missed may still need changes, such as aliased imports.
{% elif terms %}

Code searched the base commit for {{ terms | join(', ') }} and found no tracked file that mentions
them, so look for aliased or indirect uses before concluding there is nothing to migrate.
{% endif %}

Group the sites into DISJOINT file groups: normally one file per group, but when two files must
change atomically (a module and its inseparable test, say), put them in one group. No file may
appear in two groups, because each group is migrated by its own agent in its own checkout. Give
repository-relative paths without a leading ./ and the number of sites in each group, with a note
on anything unusual about them. An empty list of groups is a valid answer.
