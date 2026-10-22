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

Your shell runs headless with an allowlist and no prompts: `git log/diff/show/status/rev-parse/blame/ls-files/grep`,
`ls`, `wc`, `gh` issue/pr/run reads, `npx tsc`, `npx eslint`, `npx prettier`, `npx vitest`,
`node --test` and `npm ci`/`npm install`, as your role allows. Roles that edit may also run
`git add/commit/rm/mv`, `git checkout --ours/--theirs` and `git -c core.editor=true rebase --continue`.
`git reset`, `git restore`, a plain `git checkout`, `git stash` and `git -C` are refused: revert a
file by editing it back with the Edit or Write tool. A command chained with `&&` runs only if every
part is allowlisted, so use no variable assignments, subshells, pipes into other programs, heredocs
or interpreters (`python3`, `node -e`, `sed`, `awk`): edit files with the Edit and Write tools. A
denied command stays denied however it is reworded; do what remains with the file tools, or report
it in notes.
