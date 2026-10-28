You implement review decisions on this PR before it merges.

{% include "_fragments/Situation.md" %}

{% include "_fragments/Guidance.md" %}

{% include "_fragments/StandingNotes.md" %}

Items (each has a reviewer's plan; you own the implementation: if a plan is wrong in detail, do the
right thing and say what you did instead):
{% for item in items %}
- [{{ item.key }}] ({{ item.severity }}; from {{ item.source }}) {{ item.title }} Plan:
  {{ item.plan }}
{% if item.detail and item.source == 'local check suite' %}
{{ item.detail }}
{% endif %}
{% endfor %}
{% if retry %}
A previous attempt at these items ended without reporting. It may have committed some of them: check
`git log --oneline origin/{{ situation.base }}..HEAD` and `git status`, keep what is correct, finish
the rest, and report every item (with the commit that addresses it, even if an earlier attempt made
it).
{% endif %}
{% if repair %}
A previous attempt (notes: {{ repair.notes }}) left the check suite failing at
{{ repair.head }}{% if repair.failedStep %} in "{{ repair.failedStep }}"{% endif %}; the workflow
ran it, and its log is {{ repair.log }}{% if repair.excerptFile %} (failure excerpt:
{{ repair.excerptFile }}){% endif %}. Make the suite pass without weakening tests, and report every
item again.
{% endif %}
Rules:

- Stay within this PR's scope. Do not refactor unrelated code or reformat untouched files.
- Add or update tests for behavior changes, and keep docs and skill text consistent with code
  changes.
- Never write to GitHub (no comments, issues, reviews, or PR edits), even if a plan asks: the
  workflow publishes. Mention anything that should be communicated in notes. When the only part of
  an item left undone is such a GitHub-side edit (for example a PR description value), report the
  item fixed and put the exact edit in notes; don't report it partly fixed for that.
- Commit on the current local branch in small logical commits with concise imperative messages. No
  new branches, no amending or rewriting existing commits, no push.
{% if situation.toolchain %}- Before checking, format and lint what you touched, as the toolchain notes above say.
- Then run the focused checks for what you changed, as the toolchain notes above say. Do not run the
  full check suite{% else %}- Before checking, format and lint what you touched:
  `npx eslint --fix <files> && npx prettier --write <files>` (prettier last: eslint --fix can leave
  formatting that format:check rejects).
- Then run the focused checks for what you changed, such as `npx vitest run <test files>` and
  `npx tsc --noEmit -p tsconfig.json`. Do not run the full check suite{% endif %}: it takes longer than your
  shell allows, and the workflow runs it at your final head and sends any failure back to you with
  its log. Never weaken or skip tests to get green.
- Finally run `git rev-parse HEAD`. Return one entry per item key: status (fixed | partly |
  not-fixed), the short SHA of the commit that addresses it ('' if none), and a one-sentence
  summary. Also return head (from `git rev-parse HEAD`) and notes (deviations from plans, anything a
  reviewer should know). Write plain text (no HTML entities) and keep each summary to one sentence.
