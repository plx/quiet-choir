Items:
{% for item in items %}
  {% if item.bold %}
  - <b>{{ item.name }}</b> & co
  {% else %}
  - {{ item.name }}
  {% endif %}
{% endfor %}
Done.

