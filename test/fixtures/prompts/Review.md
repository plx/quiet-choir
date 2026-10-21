---
description: Review a pull request diff against the issue it claims to close.
---
# Review of #{{ issue.number }}: {{ issue.title }}

You are reviewing a change to {{ repo }}. Report <b>blocking</b> problems first.

{% if threads %}
## Open threads

{% for thread in threads %}
{% include "_fragments/thread.md" %}

{% endfor %}

{% endif %}
## Issue

```json
{{ issue | tojson(indent=2) }}
```

## Diff

    {{ diff | indent(4) }}
