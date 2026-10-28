Apply only concern {{ concern.name }} of the approved bootstrap plan below.

You own exactly these files: {{ concern.files | join(', ') }}. Create or extend only them; preserve
everything already in a file you extend, and edit nothing else. Use conventional, current
configuration for the stack. Do not run install, build or test commands: the workflow runs the
approved verification commands once, after every concern is integrated.

Concern detail: {{ concern.detail }}

Approved plan digest: {{ digest }}
Approved plan:
{{ plan }}
