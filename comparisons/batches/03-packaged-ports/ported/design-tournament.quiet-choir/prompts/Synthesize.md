Synthesize the final design document for this brief from the result of a design tournament.

<brief>
{{ brief }}
</brief>
{% if context %}

<context>
{{ context }}
</context>
{% endif %}

An independent panel of {{ judges }} judges scored the proposals on fitness, simplicity,
evolvability and operability. The workflow tallied the scores:
{%- for standing in scoreboard %}

- {{ standing.letter }}, {{ standing.title }} ({{ standing.philosophy }}): {{ standing.avg }} of 40 from {{ standing.votes }} judges
{%- endfor +%}

Proposal {{ winner.letter }} won and is the skeleton of the design, not the whole answer: the
runner-up often got something important more right than the winner did.
{% if winner.tiedWith %}
It tied with {{ winner.tiedWith | join(', ') }} on the average and won on mean fitness or letter
order, so weigh the tied proposals' ideas with particular care.
{% endif %}

{% include "_fragments/Proposal.md" +%}

{% if ideas %}
The judges named the ideas below as the best of the losing proposals. Decide every one by its ID:
graft it into the design where it is compatible, or reject it with one sentence of why.

Ideas:
{%- for candidate in ideas %}

- {{ candidate.id }}, from {{ candidate.from }} ({{ candidate.title }}), named by {{ candidate.judges | length }} of {{ judges }} judges: {{ candidate.idea }}
{%- endfor +%}
{% else %}
No judge named a best idea for a losing proposal, so return an empty grafts list.
{% endif %}
{% if dissent %}

These judges scored the winner far below its panel average. Their objections are signal about a
real weakness: address them in the failure handling or the open questions rather than averaging
them away.

Dissent:
{%- for entry in dissent %}

- Judge {{ entry.judge }} gave it {{ entry.total }} of 40: {{ entry.rationale }}
{%- endfor +%}
{% endif %}

Write the design as markdown with these sections: decision summary, component architecture, data
flow, failure handling, tradeoffs accepted, rejected alternatives, and open questions. Name grafted
ideas where they enter the design, and refer to the other proposals by title. The workflow appends
the scoreboard, your graft decisions and the dissent to the document from its own records, so do
not copy the numbers.

{% include "_fragments/Material.md" +%}

Return the markdown as design, and one grafts entry per idea ID with its decision and reason.
