Repository {{ situation.repo }}, PR #{{ situation.pr }} "{{ situation.title }}"
({{ situation.url }}){% if situation.issue %}, which implements issue #{{ situation.issue.number }}
"{{ situation.issue.title }}"{% else %}, which has no linked issue{% endif %}. The PR is checked
out, rebased onto {{ situation.base }}, in the dedicated git worktree {{ situation.worktree }}
(local branch {{ situation.branch }}), which is your working directory. Work only there: run `git`
and `npx` commands from it as they are (no `cd`, no `git -C`), and use absolute paths with file
tools. Never touch other checkouts or branches, and never push. Files describing the PR are in
{{ situation.dir }}: body.md (description), issue.md (issue and its comments), own.stat / own.diff /
commits.txt (the PR's changes against {{ situation.base }}), threads.md (unresolved review threads),
stack.md (later PRs stacked on this one){% if situation.upstreamDelta %}, upstream-delta.stat /
upstream-delta.patch (what changed beneath the PR since it was written){% endif %}.
