Write the closing summary for issue #{{ issue }} in {{ repo }}. PR #{{ pr }} "{{ title }}" has just
been {% if method == "squash" %}squash-merged{% else %}merged{% endif %} into {{ base }} as {{ mergeCommit }}.

Facts from the merge-down workflow (the source of truth; don't re-investigate the code):
{{ facts }}

Comment on #{{ issue }} only if it records something a future reader could not see from the PR
itself: fixes made during merge-down (review-thread or our own findings, semantic-rebase
adaptations), feedback rejected and why, gaps or deviations versus the issue, follow-ups filed, what
remains if the issue stays open, and the summary notes. If none of that exists, don't. Style: one
lead sentence, then short bullets. Reference PRs and issues as #123 and commits by short SHA. No
headings unless it runs long; no boilerplate or praise. You do not post anything: return the
comment's markdown as body and the workflow posts it. Also write headline: 1–2 plain sentences for a
ledger of the whole merge-down, saying what happened with this PR. Return post (whether to comment),
body ('' when not commenting), and headline. Write plain text (no HTML entities).
