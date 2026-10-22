{% if standingNotes %}

Standing decisions for this burn-down (apply them; don't re-litigate):
{% for note in standingNotes %}
- {{ note }}
{% endfor %}
{% endif %}
