Settle one load-bearing decision for the technical spec of the PRD in the context: {{ decision.decision }}

Options on the table (you may propose others):
{%- for option in decision.options %}

- {{ option }}
{%- endfor +%}

The rest of the spec depends on this choice, and it is expensive to reverse. The design must fit the
existing codebase the context describes and serve the PRD's requirements.
