Read the PRD below through one lens and extract the work items visible through it. Four other
readers have the other lenses, so stay inside yours: distinct charters make five readers produce
five different item sets instead of five copies of the happy path.

Your lens is {{ lens }}.

{% if lens == 'stories' %}
User-facing capability, sliced into shippable stories: each story is "a user can now do X". Ignore
infrastructure, error handling and metrics; other lenses own those.
{% elif lens == 'edges' %}
Everything that goes wrong: invalid input, permission denied, empty states, conflicts, offline and
timeout, partial failure, concurrent edits, abuse. One item per distinct failure the product must
handle gracefully, and define what graceful means each time.
{% elif lens == 'non-functional' %}
Performance targets, scale assumptions, security and privacy requirements, accessibility,
internationalization and compliance. Only what the PRD states or clearly implies: flag a vague one
("fast") as an open question rather than inventing a number.
{% elif lens == 'foundations' %}
What must exist before the stories can build: schema changes, migrations, new services or queues,
feature flags, third-party integrations, backfill jobs. Include a teardown or rollback item where a
migration implies one.
{% else %}
How we know it works: analytics events with their triggers, success-metric dashboards from the
PRD's goals, alerts, and A/B scaffolding if the PRD implies an experiment. If the PRD names a
success metric, there must be an item that makes it measurable.
{% endif %}

Every item carries a prdAnchor: a short verbatim quote of the PRD sentence or heading it traces to.
The workflow looks for each quote in the PRD and sets aside any item whose quote it cannot find, so
copy the words exactly and mark a skipped stretch with "...". If you cannot anchor an item, put it
in openQuestions instead. Write acceptance criteria as testable statements. An empty item list is a
valid answer when the PRD says nothing through your lens.

{% include "_fragments/Estimates.md" +%}

{% if codebase %}
{% include "_fragments/Codebase.md" +%}

{% endif %}
{% include "_fragments/Prd.md" %}
