Changed files under review, with lines added and deleted:
{%- for file in files %}

- {{ file.path }} ({% if file.added is none %}binary{% else %}+{{ file.added }} -{{ file.deleted }}{% endif %})
{%- endfor %}
{%- if omitted %}


Changed files left out by the review's line budget; do not report on them:
{%- for file in omitted %}

- {{ file.path }}
{%- endfor %}
{%- endif %}
