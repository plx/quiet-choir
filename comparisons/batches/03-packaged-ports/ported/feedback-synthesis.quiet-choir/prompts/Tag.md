Tag every feedback item in shard {{ shard }} of {{ shards }} against a fixed theme vocabulary. Other
taggers read the other shards with the same vocabulary and the workflow adds up all the tags in
code, so consistency matters more than nuance: apply each inclusion rule as it is written.

Vocabulary (use only these keys):
{%- for theme in vocabulary %}

- {{ theme.key }}: {{ theme.definition }}
{%- endfor +%}

{% if focus %}
Focus: {{ focus }}
Mark an item that does not match the focus offFocus true, with no themes and severity none; it is
set aside, not counted. Mark every other item offFocus false.
{% else %}
There is no focus filter: mark every item offFocus false.
{% endif %}

Tag each item exactly once, by its ID, with one or two themes; use other only when no theme fits.

{% include "_fragments/Severity.md" +%}

For each theme, give up to three quotes from your shard: the most representative items, not the
most colorful. A quote is a short verbatim excerpt of one item, a sentence or two copied exactly,
with that item's ID and a theme you tagged it with; the workflow drops any quote that is not.
Report the patterns stuck in other that deserve their own theme next run as emergent.

{% include "_fragments/Items.md" +%}

{% include "_fragments/Untrusted.md" %}
