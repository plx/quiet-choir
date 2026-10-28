{% for command in commands %}
{% if not loop.first %}

{% endif %}
<command index="{{ loop.index }}" argv={{ command.argv | tojson }}{% if command.code is not none %} exit="{{ command.code }}"{% endif %}{% if command.failure %} failure="{{ command.failure }}"{% endif %}{% if command.truncated %} truncated="true"{% endif %}>
{{ command.output }}
</command>
{%- endfor %}
