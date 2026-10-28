Release-readiness check of one dimension: {{ dimension }}.

{% if dimension == 'coverage-on-diff' %}
Assess test coverage of the changed lines in this range specifically, not whole-repository
coverage. Did the diff add untested logic, especially on error paths? Find the tests that exercise
each changed function by reading the test files. Answer concern for notable gaps, and blocker only
if critical paths shipped untested.
{% elif dimension == 'breaking-changes' %}
Scan the diff for breaking changes: removed or renamed public API, changed defaults, altered
response shapes and schema changes that require a migration. Cross-check each against the changelog
or release notes in the repository. Answer blocker for an undocumented breaking change, and pass if
there are none or all of them are documented.
{% elif dimension == 'security' %}
Check the range for security regressions: new unsanitized input at trust boundaries, new secrets in
code, new vulnerable dependencies and weakened authorization. Answer blocker for a real, reachable
issue and concern for a hardening gap. The evidence must name the code.
{% elif dimension == 'migrations-rollback' %}
If the range includes data or schema migrations: is each one reversible or paired with a rollback
plan, and are they ordered safely (expand, then contract)? Answer blocker for an irreversible,
destructive migration with no rollback, and not-applicable if the range has no migrations.
{% else %}
Scan the range for likely performance regressions: new N+1 queries, unbounded loops on request
paths, removed caching and synchronous work added to hot paths. Answer concern for a plausible
regression (production numbers are rarely available here), and blocker only for an obvious
catastrophe.
{% endif %}

House policy: {{ policy }}

Ground the status in evidence: quote the diff, name files and lines, cite command output. When the
evidence here and in the files is not enough, answer cannot-check and say why: an honest
cannot-check beats a guessed pass. Give each finding as one line.

{% include "_fragments/Evidence.md" +%}

{% if commands %}
{% include "_fragments/Commands.md" +%}

{% endif %}
{% include "_fragments/Range.md" %}
