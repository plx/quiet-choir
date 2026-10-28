Fix one failure cluster caused by upgrading "{{ package }}" from {{ from }} to {{ to }}, in your
isolated checkout of the integrated upgrade.

The cluster: {{ cluster.description }}

You own these files and may change only them:
{%- for file in cluster.files %}

- {{ file }}
{%- endfor +%}

Fix forward: adopt the new API rather than pinning the package back. Other fixers work on other
clusters, in other files, at the same time. A checkout that changes any other file is refused; if
the fix needs another file, leave it alone and say so in your summary. Do not try to run anything:
the workflow integrates the fixes and runs the verification commands again.

{% include "_fragments/Breaking.md" +%}

{% include "_fragments/Failures.md" +%}

Approved plan digest: {{ digest }}
Approved plan:
{{ plan }}
