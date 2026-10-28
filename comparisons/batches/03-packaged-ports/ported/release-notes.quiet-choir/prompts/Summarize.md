Summarize these {{ shas | length }} commits for release notes. The workflow split the range into
disjoint slices; this slice is, oldest first: {{ shas | join(' ') }}.

Judge each commit by its diff, not its message: messages drift, and "fix typo" can sit on a
400-line change. Return one item per SHA, and only SHAs from this slice. For each, classify the kind
(feature, fix, breaking, performance, deprecation or internal), write what changed as the diff
shows it, and set userVisible honestly: internal refactors are not release-notes material for most
audiences. For breaking changes and deprecations, write the migration note from the diff; otherwise
set it to null.

{% include "_fragments/Evidence.md" +%}

<patch>
{{ patch }}
</patch>
