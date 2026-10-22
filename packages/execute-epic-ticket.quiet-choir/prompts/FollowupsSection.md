Follow-ups filed under #{{ epic }}:

{% for item in items %}
- #{{ item.number }}{% if item.title %} {{ item.title }}{% endif %}

{% endfor %}
