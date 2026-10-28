Fact-check these release notes against the commit range {{ span }}, in both directions. The
summaries below can be wrong too, so check them against the log and the files as well.

1. Claims to commits: every claim must trace to a commit in the range. Flag unsupported or
   exaggerated claims ("rewrote" for a rename, "fixed" for a partial fix).
2. Commits to claims: every breaking change in the range must appear in the notes. Look for removed
   or renamed public API, changed defaults and schema migrations, and flag each omission.
3. Emphasis: flag a serious fix buried under a cosmetic one.

{% include "_fragments/Evidence.md" +%}

<notes>
{{ notes }}
</notes>

{% include "_fragments/Changes.md" +%}

<log>
{{ log }}
</log>

Set approved to true only if you found no problem. Otherwise set it to false and list every problem
in feedback, one per line, each starting with unsupported-claim, omitted-change or wrong-emphasis
and ending with the fix.
