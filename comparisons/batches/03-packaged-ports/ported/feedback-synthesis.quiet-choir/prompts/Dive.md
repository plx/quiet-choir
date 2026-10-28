Deep-dive the feedback theme {{ theme.theme }}: {{ theme.definition }}
Taggers placed {{ theme.count }} items in it, {{ theme.severe }} of them severe.
{% if focus %}
The synthesis is focused on: {{ focus }}
{% endif %}

{% if omitted %}
These are {{ items | length }} of its items, severe ones first; {{ omitted }} more are not shown.
{% else %}
These are all of its items, severe ones first.
{% endif %}

{% include "_fragments/Items.md" +%}

{% if starters %}
The taggers picked these quotes as representative. They are hints, not the evidence base:
{%- for quote in starters %}

- {{ quote.id }}: "{{ quote.text }}"
{%- endfor +%}

{% endif %}
Read the items, then write the storyline: what is actually happening to these users, the mechanism
rather than a summary, in one paragraph grounded in what they say. Name the affected segments, such
as plan, platform or tenure, only when the items show them, and null otherwise. Give the single
highest-leverage product action as the recommendation. Pick the three to five best quotes, each a
short verbatim excerpt with the ID of the item it comes from; the workflow checks every quote
against its item and drops any that is not verbatim. A tagger may have misfiled an item: leave out those that
do not belong to this theme.

{% include "_fragments/Untrusted.md" %}
