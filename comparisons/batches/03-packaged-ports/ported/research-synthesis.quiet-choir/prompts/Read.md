Deep-read one source for this research question.

{% include "_fragments/Question.md" +%}

Source: {{ lead.ref }} ({{ lead.kind }}, {{ lead.credibility }}; found by {{ lead.modalities | join(', ') }})
Expected: {{ lead.promise }}

{% if commit %}
This is a file in this repository, checked out for you at commit {{ commit }}. You have its file
tools and no web tools.
{% else %}
Fetch it with WebFetch, or find it with WebSearch. You have no access to local files.
{% endif %}

{% include "_fragments/Findings.md" +%}

{% include "_fragments/Untrusted.md" %}
