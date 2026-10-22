{% if standingNotes %}

Standing decisions for this merge-down (apply them; don't re-litigate):
{% for note in standingNotes %}
- {{ note }}
{% endfor %}
{% endif %}
