Draft your slice of a technical spec for the PRD below. Four other drafters write the other lenses
of the same spec, and a merger combines the five, so stay inside yours.

Your lens is {{ lens }}.

{% if lens == 'data-model' %}
Entities, schemas, ownership, lifecycle, consistency requirements, the indexes and queries the PRD
implies, and migrations from the current state. Concrete field names and types. Ignore API shape
and component structure.
{% elif lens == 'api-contracts' %}
Every interface this work exposes or consumes: routes or RPCs with request and response shapes,
error contracts, auth requirements and the versioning stance. Concrete, not "an endpoint for X".
Ignore storage and internals.
{% elif lens == 'architecture' %}
Components and their responsibilities, how data flows between them, where state lives, what runs
where (client, server, worker), and how this attaches to the integration points. Ignore field-level
and route-level detail.
{% elif lens == 'edge-semantics' %}
The behavior spec for the unhappy paths: for each PRD requirement, what happens on invalid input,
permission failure, concurrent edits, partial failure, empty states and limits. This is where
"handle errors gracefully" becomes decidable. Ignore structure.
{% else %}
What it takes to run it: configuration and secrets, feature flags and rollout, observability (the
logs, metrics and alerts this work must emit), performance budgets from the PRD's non-functional
requirements, and third-party integration setup. Ignore application logic.
{% endif %}

Write spec-grade content: an engineer implements from it without inventing names or shapes. Anchor
every section to the PRD requirements it serves. Where you face a choice with genuinely competitive
alternatives that you cannot settle from the PRD and the codebase alone, do not pick silently:
record it in contestedDecisions with its options and its stakes. A decision is load-bearing when
the rest of the spec depends on it and it is expensive to reverse; the workflow may settle the top
load-bearing decision with an independent design tournament. An empty contestedDecisions list is a
valid answer.

{% if grounding %}
Where the grounding map names files, you may read them to reuse existing names and shapes. Read
only; do not edit files.
{% else %}
Read only; do not edit files.
{% endif %}

{% include "_fragments/Grounding.md" +%}

{% include "_fragments/Material.md" +%}

{% include "_fragments/Prd.md" %}
