Repository {{ situation.repo }}. Epic #{{ situation.epic.number }} "{{ situation.epic.title }}"; this
run works on its ticket #{{ situation.ticket.number }} "{{ situation.ticket.title }}". The ticket's
branch {{ situation.branch }} is checked out in the dedicated git worktree {{ situation.worktree }},
based on origin/{{ situation.base }}, which is your working directory. Work only there: run `git`,
`npx` and `npm run` commands from it as they are (no `cd`, no `git -C`), and use absolute paths with
file tools. Never touch other checkouts or branches, and never push. Files:
{{ situation.dir }}/issue.md (the ticket and its comments), {{ situation.dir }}/epic.md (the epic and
a table of every ticket with its status: use it to see what neighbouring tickets own){% if situation.planFile %},
{{ situation.planFile }} (the implementation plan){% endif %}.

Your shell runs headless with an allowlist and no prompts: `git log/diff/show/status/rev-parse/blame/ls-files/grep`,
`ls`, `wc`, `gh issue view/list`, `gh pr view/list`, `gh run view`, `npx tsc`, `npx eslint`,
`npx prettier`, `npx vitest` and `node --test`, as your role allows. Roles that edit may also run
`git add/commit/rm/mv`, `npm ci`/`npm install` and `npm run build`, `npm run typecheck`,
`npm run lint` and `npm run packages:rehearse`. `git push`, `git reset`, `git restore`,
`git checkout`, `git stash`, `git rebase` and `git -C` are refused: revert a file by editing it back
with the Edit or Write tool. A command chained with `&&` runs only if every part is allowlisted, so
use no `cd`, variable assignments, subshells, pipes into other programs, heredocs or interpreters
(`python3`, `node -e`, `sed`, `awk`): edit files with the Edit and Write tools. A denied command
stays denied however it is reworded; do what remains with the file tools, or report it in notes.
