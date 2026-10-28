The workflow ran these commands for this dimension; each block ends with the end of its output:
{%- for run in commands +%}

<command outcome="{{ run.outcome }}"{% if run.clipped %} clipped="true"{% endif %}>
<argv>{{ run.argv | join(' ') }}</argv>
{% if run.error %}
<error>{{ run.error }}</error>
{% endif %}
{% if run.stdout %}
<stdout>
{{ run.stdout }}
</stdout>
{% endif %}
{% if run.stderr %}
<stderr>
{{ run.stderr }}
</stderr>
{% endif %}
</command>
{%- endfor %}
