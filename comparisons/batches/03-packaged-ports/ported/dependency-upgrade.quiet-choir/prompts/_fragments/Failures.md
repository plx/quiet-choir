Failing commands, with the tail of their output:
{%- for failure in failures %}


Command {{ loop.index }}, {{ failure.outcome }}: {{ failure.command }}

<output>
{{ failure.output }}
</output>
{%- endfor %}
