Milestones:
{%- for milestone in milestones %}

{{ loop.index }}. {{ milestone.name }}: {{ milestone.capabilityIds | join(', ') }}
   Goal: {{ milestone.goal }}
   Gate: {{ milestone.gate }}
{%- endfor +%}

{% if deferred %}
Deferred beyond the horizon: {{ deferred | join(', ') }}
{%- else %}
Nothing is deferred.
{%- endif %}
