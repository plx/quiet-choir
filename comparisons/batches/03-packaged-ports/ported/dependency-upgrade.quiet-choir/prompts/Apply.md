Execute the approved upgrade plan for "{{ package }}" ({{ from }} -> {{ to }}) in your isolated
checkout.

Work through the steps in order. Change the version of {{ package }} in the manifest and make the
code changes the plan calls for, following the repository's conventions for its package manager and
lockfile format. Change only the files the plan lists; renaming a file is refused.
{% if install %}
Do not edit the lockfile by hand: the workflow runs `{{ install }}` after you, which refreshes it
from the manifest.
{% else %}
No install command is configured, so leave the lockfile alone unless the plan lists it.
{% endif %}

Do not try to run the build or the tests: the workflow verifies your checkout with the operator's
commands and repairs what fails. Report what you did.

Approved plan digest: {{ digest }}
Approved plan:
{{ plan }}
