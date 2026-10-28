Critique this research answer for completeness and evidential honesty.

{% include "_fragments/Question.md" +%}

<answer>
{{ answer }}
</answer>

The answer cites sources by key. These are the sources it had, with their findings:

{% include "_fragments/Sources.md" +%}

{% if unknown %}
The workflow checked the citations, and these cited keys match no source: {{ unknown | join(', ') }}.
Every claim that cites one is unsupported.

{% endif %}
{% if unswept %}
These sweeps failed, so their territory was never searched: {{ unswept | join(', ') }}.

{% endif %}
{% if deferred %}
Leads found but never read, past the depth cap; one may be the right document for a hunt:
{%- for lead in deferred %}

- {{ lead.ref }} ({{ lead.kind }}, {{ lead.credibility }}): {{ lead.promise }}
{%- endfor +%}

{% endif %}
Hunt for claims with no citation, claims whose cited source's findings do not support them, obvious
source types never consulted (such as the official changelog for a version-sensitive claim), parts
of the question left unanswered, and claims that rest on one source and need corroboration. For
each gap, write a targeted hunt instruction: a specific search or a specific document to read, not
"do more research". Return at most {{ maxGaps }} gaps. Only the first {{ huntCap }} are hunted, so
put the most important first.

{% if context %}
Give each gap a territory. A web hunt searches and fetches pages but cannot read this repository; a
local hunt reads this repository at the pinned commit but has no web access. Choose local only when
the gap is about this repository's own code or configuration.
{% else %}
There is no local context, so every hunt searches the web: give each gap the territory web.
{% endif %}

Return an empty list when no gap is worth a hunt: that is the verdict that the answer is adequate.
