The range {{ span }}: {{ count }} commit(s), oldest first.

{% if log.clipped %}
The log is clipped to its first {{ log.text | length }} of {{ log.chars }} characters.
{% endif %}
<log>
{{ log.text }}
</log>

{% if patch.clipped %}
The patch is clipped to its first {{ patch.text | length }} of {{ patch.chars }} characters. Its stat
summary comes first; read the changed files for what the excerpt leaves out.
{% endif %}
<patch>
{{ patch.text }}
</patch>
