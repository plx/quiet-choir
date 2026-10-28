Repair the "{{ section }}" section of an onboarding atlas. A completeness review found:
{%- for gap in gaps %}

- {{ gap.description }} Repair: {{ gap.repairAction }}
{%- endfor +%}

Research the answer in the repository and return the complete card for this section.
{% if card %}
Correct the current card below where the review says it is wrong, and keep what is right.
{% else %}
The atlas has no such section yet, so write a new card for it.
{% endif %}
Read only; do not edit files.

Project context: {{ projectSummary }}

{% include "_fragments/Card.md" +%}

{% include "_fragments/Evidence.md" +%}
{% if card %}

<card>
{{ card }}
</card>
{% endif %}
