Write the opening of an onboarding atlas for this repository from the subsystem cards below. The
workflow renders the system map and one section per subsystem from the cards itself, so do not
repeat them; work from the cards alone.

- overview is the "What this is" section: the project summary below, sharpened, then a short
  paragraph on how the subsystems fit together (where execution enters, how data moves between
  them, which ones the rest depend on). Plain markdown paragraphs, no headings.
- startHere lists the three files a new engineer should read first, chosen from the cards' key
  files, each with one line on why.
{% if unread or skipped %}

Some subsystems have no card ({{ (unread + skipped) | join(', ') }}). Mention them in one sentence
as not covered; do not describe them.
{% endif %}

Project summary: {{ projectSummary }}

<cards>
{{ cards }}
</cards>
