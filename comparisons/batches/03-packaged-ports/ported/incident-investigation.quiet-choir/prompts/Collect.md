Incident under investigation: {{ incident }}

{% include "_fragments/ReadOnly.md" +%}

{% if domain == 'diffs' %}
Collect change evidence from the pinned window below: every commit touching code plausibly related
to the symptom, plus any commit that is large, rushed (odd hours, "hotfix" or "revert" messages) or
touches shared infrastructure. Read the diffs. Report facts with SHAs and timestamps.
{% elif domain == 'logs' %}
{% if artifacts %}
Collect runtime evidence from: {{ artifacts | join(', ') }}.
{% else %}
Collect runtime evidence from any logs, crash dumps or traces checked into or referenced by this
repository.
{% endif %}
Extract error messages, stack traces, timing patterns and the first-occurrence timestamp of anything
anomalous. If no artifacts exist, say so: report zero facts rather than inferring runtime behavior
from code.
{% elif domain == 'config' %}
Collect configuration and infrastructure evidence from the pinned window below: changes to config
files, environment templates, feature flags, CI/CD definitions, infrastructure as code, and
container or build definitions. Configuration changes are underrepresented in incident stories
precisely because they are quiet, so be thorough. Report facts with sources and timestamps.
{% else %}
Collect dependency evidence from the pinned window below: lockfile changes, version bumps, new or
removed packages, and toolchain updates (runtime versions, compiler flags). For each bump, note
whether it crossed a major version. Report facts with sources and timestamps.
{% endif %}

Report facts only: no interpretation, no story, no suspects. Flag as an oddity anything surprising on
its own terms.

<log>
{{ log }}
</log>
