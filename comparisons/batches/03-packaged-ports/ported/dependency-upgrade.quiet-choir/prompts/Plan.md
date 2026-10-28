Create an upgrade plan for "{{ package }}" from {{ from }} to {{ to }}. You have no tools; work from
the research and the usage map below.

{% include "_fragments/Breaking.md" +%}

{% if usage %}
Our usage:
{%- for site in usage %}

- {{ site.file }} ({{ site.heaviness }}): {{ site.apis | join(', ') }}
{%- endfor +%}
{% else %}
The usage map found no file that uses the package.
{% endif %}

{% if exposure %}
Indirect exposure, as the analyst noted it: {{ exposure }}
{% else %}
The analyst noted no indirect exposure.
{% endif %}

Cross-reference: which breaking changes actually hit our usage? Produce ordered, concrete steps for
the applier: bump the version in the manifest, then each code change, grouped sensibly.

{% if install %}
The applier cannot run the package manager: after it edits the manifest, the workflow runs
`{{ install }}` in each verification checkout, which refreshes the lockfile.
{% else %}
No install command is configured, so the applier changes the manifest and the code only.
{% endif %}

The workflow then runs these verification commands and repairs what they report, for a bounded
number of rounds:
{%- for command in verify %}

- `{{ command }}`
{%- endfor +%}

List every file the upgrade may change: the applier and the fixers are refused any other file, and
the workflow always allows {{ manifests | join(', ') }}. Give riskNotes, where this upgrade is most
likely to break, and testFocus, the areas the verification failures should be read against hardest.

If the intersection is empty, say riskLevel "trivial" with a two-step plan. If the upgrade looks
unwise (for example, half the codebase is on removed APIs), say "reconsider" and explain why in
riskNotes: nothing is then attempted.
