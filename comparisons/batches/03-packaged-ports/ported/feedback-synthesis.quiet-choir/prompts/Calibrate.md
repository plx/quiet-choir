Build the theme vocabulary for tagging a feedback corpus of {{ total }} items. Parallel taggers will
each read one shard of the corpus and bucket every item into these themes, and the workflow adds up
their tags in code, so this vocabulary is what makes the shards comparable: without it, one shard's
"sync issues" and another's "data loss on refresh" never land in the same bucket.
{% if focus %}

Focus: {{ focus }}
Derive themes for the feedback that matches the focus; the taggers set the rest aside.
{% endif %}

The workflow drew this sample of {{ items | length }} items evenly from the beginning, middle and
end of the corpus.
{% if fields %}
Each item shows its {{ fields | join(', ') }} in parentheses before the text.
{% endif %}

{% include "_fragments/Items.md" +%}

Derive 8 to 15 themes that would cover what you see. Give each a stable lowercase slug as its key,
such as sync-reliability, and an inclusion rule precise enough that two different taggers would
bucket the same item the same way. Name a theme for the problem users have, not only the product
area, and keep themes apart where you can: an item carries at most two. Include other as the
catch-all for feedback that fits nothing else.

{% include "_fragments/Untrusted.md" %}
