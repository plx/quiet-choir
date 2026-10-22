Write the pull request description for ticket #{{ situation.ticket.number }}
"{{ situation.ticket.title }}" (epic #{{ situation.epic.number }}, {{ situation.repo }}).

{% include "_fragments/Situation.md" %}

Facts (the source of truth; don't re-investigate the code beyond what you need to describe it
accurately):

- Plan: {{ plan }}
- Implementer report: {{ report }}
- Diff: {{ stat }}; commits in {{ commitsFile }}; full diff in {{ diffFile }}.
- The workflow ran the full check suite (`{{ checkCommand }}`) at {{ head }}, and it passed.

Style (match this repository's merged PRs, e.g. `gh pr view 97 -R {{ situation.repo }}`): start with
"Closes #{{ situation.ticket.number }}." on its own line, then "Part of #{{ situation.epic.number }}.";
a short paragraph on the problem and what changes; then what changed for users/authors (behavior,
API, CLI, docs), design choices and why, anything deliberately left out (with the ticket that owns
it), and a "Validation" paragraph (what was run and passed). Reference issues as #N and commits by
short SHA. No boilerplate, no praise, no headings unless it runs long. The workflow lists the filed
follow-ups itself, so leave them out.{% if footer %} End with a blank line and then:
{{ footer }}{% endif %}

Return title (default: {{ title }}; keep it under 72 characters) and body (markdown).
