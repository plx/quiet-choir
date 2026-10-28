Pick the best milestone sequencing for this project from {{ plans | length }} competing strategies.

{% if priorities %}
Stated priorities; judge against these, not your own taste: {{ priorities }}
{% else %}
No explicit priorities were given; judge on balanced delivery risk and value.
{% endif %}
{% if horizon %}
Horizon: {{ horizon }}
{% else %}
Horizon: none given.
{% endif %}

Score every strategy from 1 to 10 on its fit to the priorities and the horizon, and pick the
winner: a strategy with the top score. Then name the single best idea from a losing strategy worth
grafting into the winner, with the strategy it comes from, or return graft as null when no losing
idea would improve the winner.

Every plan below already respects the dependency graph and places each capability once; the
workflow checked them.
{% for plan in plans %}

Strategy {{ plan.strategy }}. Rationale: {{ plan.rationale }}
{% with milestones = plan.milestones, deferred = plan.deferred %}
{% include "_fragments/Plan.md" +%}
{% endwith %}
{% endfor %}

{% include "_fragments/Capabilities.md" %}
