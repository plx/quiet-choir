{% if grounding %}
A grounding agent mapped the existing codebase; the spec must fit it:

<grounding>
Existing architecture: {{ grounding.summary }}

Conventions to respect:
{%- for item in grounding.conventions %}

- {{ item }}
{%- else %}
 none reported.
{%- endfor +%}

Integration points:
{%- for item in grounding.integrationPoints %}

- {{ item }}
{%- else %}
 none reported.
{%- endfor +%}

Constraints:
{%- for item in grounding.constraints %}

- {{ item }}
{%- else %}
 none reported.
{%- endfor +%}
</grounding>
{%- else %}
This is a greenfield project: there is no existing codebase to fit or respect.
{%- endif %}
