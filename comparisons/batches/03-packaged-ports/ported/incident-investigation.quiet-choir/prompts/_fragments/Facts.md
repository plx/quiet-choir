Evidence pool, facts only, from independent collectors:
{%- for fact in evidence %}

- [{{ fact.domain }}{% if fact.oddity %}, odd{% endif %}] {{ fact.fact }} (source: {{ fact.source }}; when: {{ fact.timestamp }})
{%- endfor %}
