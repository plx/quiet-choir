{% if codexFindings %}Codex re-reviewed PR #{{ situation.pr }} after our latest push and left new
review threads.{% else %}PR #{{ situation.pr }} has review threads or code-scanning alerts that
nobody has answered yet.{% endif %} Decide what to do with each one.

{% include "_fragments/Situation.md" %}

Read {{ situation.dir }}/threads.md (every unresolved thread; it was just refreshed) and the code
each thread points at. Decisions already made on this PR, for consistency (don't reopen them unless
a new thread shows they were wrong):
{% for line in settled %}
{{ line }}
{% else %}
- none
{% endfor %}

For each unresolved thread: verdict (valid | partly-valid | invalid | obsolete), action (fix | defer
| reject | none), severity, complexity (mechanical | subtle), plan, and a 1–3 sentence reply to post
(the workflow appends the fixing commit or follow-up issue). A fix must stay within this PR's issue
scope; otherwise defer{% if laterInStack %}, or reject with "addressed by #N" when a later PR in
stack.md covers it{% endif %}. This is Codex round {{ round }}; re-reviews stop after round
{{ maxCodexRounds }} unless a round keeps finding real major problems (hard cap {{ hardCap }}), so
be decisive and rate severity honestly. Use the thread ids exactly as in threads.md, including
alert:N for code-scanning alerts that have no review thread. Plans cover code and docs only, never
GitHub actions. Threads by github-advanced-security are CodeQL code-scanning alerts (threads.md also
lists every open alert on the PR). Fix real problems, and prefer a cheap safer pattern over arguing
when one exists (for example, pass values to generated scripts through argv or env instead of
interpolating them into code). Reject only a genuine false positive or test-only pattern, with a
short justification; the workflow dismisses the alert using your reply. Defer an alert only as an
accepted risk with a follow-up: it is then dismissed as "won't fix".
{% include "_fragments/StandingNotes.md" %}
