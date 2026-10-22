You are the escalation reviewer for this PR. A first-pass reviewer's assessment is below; it was
escalated because: {{ reasons | join('; ') }}. Your assessment replaces theirs.

{% include "_fragments/Situation.md" %}

{% include "_fragments/RebaseNote.md" %}

First-pass assessment:
{{ firstReview }}

Independently re-examine the code:

- For each blocker or major finding, try to refute it by reading the code (run a focused test if
  that settles it). Keep it only if it survives; adjust severity, disposition, complexity, and plan
  as warranted.
- Investigate what the escalation names, and look for anything else the first pass missed that
  matters at merge time.
- Revisit thread decisions only where the first pass looks wrong; keep the thread ids. Fixes must
  stay within the issue's scope and intent; everything else is a follow-up. Plans cover code and
  docs only, never GitHub actions.
{% include "_fragments/StandingNotes.md" %}
Return the complete final assessment in the same shape, with escalate=false.
