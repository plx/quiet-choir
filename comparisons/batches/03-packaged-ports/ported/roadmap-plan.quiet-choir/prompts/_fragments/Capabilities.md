Capabilities, with size, technical risk, value and the capabilities each depends on:
{%- for capability in capabilities %}

- {{ capability.id }} {{ capability.name }} [{{ capability.size }}, risk {{ capability.risk }}, value {{ capability.value }}{% if capability.dependsOn %}; after {{ capability.dependsOn | join(', ') }}{% endif %}]: {{ capability.summary }}
{%- endfor %}
