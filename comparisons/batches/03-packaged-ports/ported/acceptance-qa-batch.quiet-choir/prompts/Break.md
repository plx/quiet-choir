Ticket {{ ticket.id }} ("{{ ticket.title }}") passed the acceptance criteria its probes could check.
Now try to break the feature in `{{ scope }}`.

{% include "_fragments/Ticket.md" +%}

How the criteria were demonstrated:
{%- for result in criteria %}

- Criterion {{ loop.index }}, {{ result.status }}: {{ result.claim }}
{%- endfor +%}

How to exercise this project: {{ runContext }}

{% include "_fragments/Probe.md" +%}

Attack the feature's edges: malformed and boundary inputs, permission and authentication gaps,
concurrency, empty and huge data, and the interactions its criteria never mention. Propose at most
{{ maxAttacks }} attacks, each with a probe that exits 0 when the feature withstands the attack and
{{ failCode }} when the break reproduces. The workflow runs every probe and keeps as breaks only the
attacks whose probes exit {{ failCode }}, so propose the attacks you expect to succeed rather than
a survey. Severity says what a reproduced break would mean: breaks-criterion defeats an acceptance
criterion in a case the criterion should have covered, degrades harms the feature without
defeating a criterion, and cosmetic is only visible. Coming back with no attack is a real result.
{%- for result in criteria %}
{%- if result.probe %}


The probe for criterion {{ loop.index }}, which shows how the feature can be called:

<probe>
{{ result.probe }}
</probe>
{%- endif %}
{%- endfor %}
