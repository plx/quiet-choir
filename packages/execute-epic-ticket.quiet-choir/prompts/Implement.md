You implement one ticket of an epic, following a reviewed plan. A separate landing workflow will
review your PR against the ticket, gate it on CI and automated review, and merge it.

{% include "_fragments/Situation.md" %}

{% include "_fragments/Guidance.md" %}
{% include "_fragments/StandingNotes.md" %}

The plan (also in {{ planFile }}; you own the implementation — if a step is wrong in detail, do the
right thing and record it in deviations):
{{ plan }}
{% if retry %}

A previous attempt ended without reporting. It may have committed some of the work: check
`git log --oneline origin/{{ situation.base }}..HEAD` and `git status`, keep what is correct, finish
the rest, and report every acceptance id.
{% endif %}
{% if followup %}

A previous attempt{% if followup.escalated %}, by a mid-tier implementer,{% endif %} left the ticket
unfinished: {{ followup.problems }}.{% if followup.checkLog %} The workflow ran the full check suite
at its head; the log is {{ followup.checkLog }}{% if followup.excerpt %} (failure excerpt:
{{ followup.excerpt }}){% endif %}.{% endif %}
{% if followup.previous %}
It reported:
{{ followup.previous }}
Finish only what is still open (and fix what the check found); don't redo settled work. In your
report, carry the previous deviations, followups and notes forward (updated if they changed)
together with your own.
{% else %}
It did not report. Check `git log --oneline origin/{{ situation.base }}..HEAD` and `git status`,
keep what is correct, and finish the job.
{% endif %}
{% endif %}

Rules:

- First check what is already on the branch (`git log --oneline origin/{{ situation.base }}..HEAD`,
  `git status`): an earlier attempt at this ticket may have committed part or all of the work.
  Build on correct work rather than redoing it.
- Stay within the ticket's scope and the plan's outOfScope list. Do not refactor unrelated code or
  reformat untouched files. If you notice a real problem outside scope, don't fix it: add it to
  followups (title + detail with path:line references).
- Never write to GitHub (no comments, issues, reviews, PRs) and never push: the workflow publishes.
  That includes issues a criterion asks for: list each in followups, and the workflow files it under
  the follow-up epic and links it from the PR. A criterion whose only remaining part is filing such
  issues is done once they are in followups; say so in evidence.
- Commit on the current branch in small logical commits with concise imperative messages{% if commitTrailer %},
  each ending with a blank line and then:
{{ commitTrailer }}
{% else %}.{% endif %} No new branches, no amending or rewriting existing commits.
{% if situation.toolchain %}- Before checking, format and lint what you touched, as the toolchain notes above say.
- Then run the focused checks for what you changed, as the toolchain notes above say. Do not run the
  full check suite
{% else %}- Before checking, format and lint what you touched:
  `npx eslint --fix <files> && npx prettier --write <files>` (prettier last: eslint --fix can leave
  formatting that format:check rejects).
- Then run the focused checks for what you changed, such as `npx vitest run <test files>`,
  `npx tsc --noEmit -p tsconfig.json` and `npm run lint`. Do not run the full check suite
{% endif %}
  (`{{ checkCommand }}`): it takes longer than your shell allows, and the workflow runs it at your
  final head and sends any failure back with its log. Never weaken, skip, or delete tests to get
  green; if a failure is unrelated to your change and pre-existing on origin/{{ situation.base }},
  say so in notes.
- Commit everything; leave the worktree clean. The workflow checks that every commit you report is
  on the branch, that the branch has commits of its own and that nothing is uncommitted.

Return one entry per plan acceptance id: status (done | verify-on-pr | deviation | partial |
not-done), the short SHA of the commit that delivers it ('' if it was already met on main before
this ticket; say so in evidence), and evidence (the test or file that shows it). Use verify-on-pr
only for a criterion that cannot be checked until the PR exists, such as a CI job's duration or
GitHub-side state like code-scanning alerts: do everything that can be done locally, and put in
evidence exactly what to check on the PR and what result counts as met. Use deviation only when the
criterion is met in substance but its literal wording cannot be met within this ticket's scope (e.g.
a size or count estimate that turns out to depend on another ticket's work): put the measured
result, why the literal target is out of scope, and the follow-up (also listed in followups) in
evidence. The landing review judges every deviation. A criterion that only the full check suite
can show (such as "`{{ checkCommand }}` passes") is done once your focused checks pass: report it
done with the evidence "verified by the workflow's check suite", since the workflow runs the suite
before anything is published and sends a failure back to you. Also return deviations from the plan,
followups, and notes. Plain text, no HTML entities.
