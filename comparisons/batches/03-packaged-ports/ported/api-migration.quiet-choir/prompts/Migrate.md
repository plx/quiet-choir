Migrate this file group from the old API to the new one, in your own isolated checkout.

{% include "_fragments/Migration.md" +%}

Your files:
{%- for file in group.files %}

- {{ file }}
{%- endfor +%}

Expected sites: about {{ group.siteCount }}.
{% if group.notes %}
Discovery noted: {{ group.notes }}
{% endif %}

Read each file fully before editing and match the surrounding style. Migrate every site and update
the imports. Change only your files: no other agent touches them, and the workflow refuses a
checkout that changes any other file, or adds, deletes or renames one. Do not try to run the build
or the tests: you have no shell, and the workflow runs the operator's verification commands once,
on the integrated migration, after every group is done.

If a site cannot be migrated mechanically, leave it working on the old API, answer partial and list
it under blockers with the reason. Answer migrated only when every site is done, and blocked, with
no change, when no site in the group can be migrated.

Approved plan digest: {{ digest }}
Approved plan:
{{ plan }}
