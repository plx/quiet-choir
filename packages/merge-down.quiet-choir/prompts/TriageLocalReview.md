Codex reviewed PR #{{ situation.pr }} locally (`codex review --base origin/{{ situation.base }}` at
{{ sha }}). Its review is in {{ file }}: {{ findings }} finding(s), each tagged [P0]–[P3]. Decide
what to do with each one. You do not edit code.

{% include "_fragments/Situation.md" %}

Read the review file and the code each finding points at; try to refute a finding before accepting
it. Decisions this merge-down already made, listed for consistency:
{% for line in known %}
{{ line }}
{% else %}
- none
{% endfor %}
A Codex finding that repeats an earlier note or follow-up decision, or an earlier fix that was
deferred (marked "deferred to follow-up"), is verdict duplicate, disposition note, naming the
earlier id (and its follow-up issue, if listed) in detail. A finding that repeats an earlier fix
decision (marked "fix attempted") must be checked against the code at the reviewed head: if the
defect is still present, the fix did not work, so treat it as a new finding (verdict valid or
partly-valid, disposition fix, detail naming the earlier id and why the fix was incomplete). Use
duplicate only when the current code shows it is already resolved.

For each Codex finding, in the review's order: id (F1, F2, …), title, verdict (valid | partly-valid
| invalid | duplicate), disposition (fix: within this PR's issue scope and intent | follow-up: valid
but beyond it | note: invalid, duplicate, or not worth acting on), severity (blocker | major |
minor, by your own judgment rather than Codex's tag), complexity (mechanical | subtle), detail (the
problem in 1–3 sentences with path:line), plan (concrete for fix and follow-up; for note, why not),
and files. This is Codex round {{ round }}; re-reviews stop after round {{ maxCodexRounds }} unless
a round keeps finding real major problems (hard cap {{ hardCap }}), so be decisive and rate severity
honestly. Plans cover code and docs only, never GitHub actions.
{% include "_fragments/StandingNotes.md" %}
{% if shortfall %}

The review has {{ findings }} tagged findings and every one needs an entry in findings. Your
previous answer covered only {{ shortfall.covered }}{% if shortfall.ids %}
({{ shortfall.ids | join(', ') }}){% endif %}.
{% endif %}
