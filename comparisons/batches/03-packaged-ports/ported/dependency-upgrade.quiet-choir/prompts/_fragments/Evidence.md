{% if evidence %}
The workflow searched {{ manifests | join(', ') }} for the package name and found these lines, each
with the two lines after it:

<evidence>
{% for line in evidence %}
{{ line }}
{% endfor %}
</evidence>
{%- if evidenceOmitted +%}

{{ evidenceOmitted }} further lines were left out.
{%- endif %}
{% else %}
The workflow searched {{ manifests | join(', ') }} for the package name and found no line naming it.
{%- endif %}
