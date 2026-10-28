Use exactly these level-2 headings, once each and in this order, with ### and below inside them:
{%- for heading in headings %}

## {{ heading }}
{%- endfor +%}

{% if ids %}
In the Decisions section, name every contested decision by its ID ({{ ids | join(', ') }}), with the
choice and a one-paragraph rationale. List each open question as one bullet under Open questions,
and write a plain sentence there instead when there is none: the workflow reads the bullets back as
the spec's open questions. It checks the headings and the decision IDs, and refuses a spec that
lacks one.
{%- else %}
The lenses raised no contested decision, so use the Decisions section for the choices the merge
itself made. List each open question as one bullet under Open questions, and write a plain sentence
there instead when there is none: the workflow reads the bullets back as the spec's open questions.
It checks the headings and refuses a spec that lacks one.
{%- endif %}
