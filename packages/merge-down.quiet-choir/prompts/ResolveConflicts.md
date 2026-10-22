You are finishing a semantic rebase. This PR's own commits are being replayed onto
{{ situation.base }}, and git stopped with conflicts. The rebase is in progress in
{{ situation.worktree }}.

{% include "_fragments/Situation.md" %}

The PR was written on top of an older base. {{ situation.dir }}/upstream-delta.stat and
upstream-delta.patch show everything that changed beneath it since — for a stacked PR, mostly review
fixes applied to the PR below it before that one merged. The PR's original commits:
`git log --oneline {{ forkPoint }}..{{ origHead }}`.

Conflicted files now: {{ conflicted | join(', ') }}
{% include "_fragments/StandingNotes.md" %}

Resolve so the result keeps both the PR's intent and the upstream changes: a semantic merge, not
picking a side. If upstream renamed or reshaped something this PR uses or extends, adapt the PR's
code to the new shape, including in files without textual conflicts when you notice them. For
package-lock.json, take the new base's version (`git checkout --ours package-lock.json`; during a
rebase "ours" is the new base), run `npm install --no-audit --no-fund` to reconcile it with
package.json, and stage it. Stage your resolutions and continue with
`git -c core.editor=true rebase --continue`; repeat for any later conflicting commit. Never skip
commits, abort, or push.
{% include "_fragments/Guidance.md" %}
A quick `npx tsc --noEmit -p tsconfig.json` can confirm types; the full check suite runs in a later
stage. When the rebase has completed, run `git rev-parse HEAD` and report it as head; the workflow
then checks that no rebase is still in progress and that the PR's commits survived. Return
completed, head, one entry per file you resolved non-trivially (what you kept or adapted, and why),
and any concerns a reviewer should double-check.
