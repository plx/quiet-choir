<sources>
{%- for source in sources %}


[{{ source.id }}] {{ source.ref }} ({{ source.kind }}, {{ source.credibility }}{% if source.territory == 'local' %}; from this repository{% endif %})
{%- for finding in source.findings %}

- {{ finding.claim }} (support: {{ finding.support }}{% if finding.caveat %}; caveat: {{ finding.caveat }}{% endif %})
{%- endfor %}
{%- for note in source.contradicts %}

- Contradicts: {{ note }}
{%- endfor %}
{%- endfor %}


</sources>
