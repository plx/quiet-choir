<items>
{%- for item in items %}

[{{ item.id }}]{% if item.fields %} ({{ item.fields }}){% endif %} {{ item.text }}
{%- endfor %}

</items>
