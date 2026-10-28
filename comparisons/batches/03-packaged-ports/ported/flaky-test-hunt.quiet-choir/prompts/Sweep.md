Find flaky-test suspects in {{ scope }} from one evidence source; other finders work from different
evidence, so stay inside yours. Report suspects only: the workflow stress-runs every suspect itself,
so suspicion is cheap and a wrong guess costs one stress run.

{% if modality == 'history' %}
The workflow read the messages and changed files of the last {{ history.scanned }} commits for you;
you have no shell to read more of the history.

{% if history.mentions %}
Commits whose message mentions a flake, a retry, a skip or a quarantine:
{%- for commit in history.mentions %}

- {{ commit.sha }} {{ commit.date }} "{{ commit.subject }}"{% if commit.files %}: {{ commit.files | join(', ') }}{% if commit.unlistedFiles %} and {{ commit.unlistedFiles }} more{% endif %}{% endif %}{% if commit.body %} (message: {{ commit.body }}){% endif %}
{%- endfor +%}

{% if history.unlistedMentions %}
{{ history.unlistedMentions }} more such commits are not listed.

{% endif %}
{% for commit in history.mentions if commit.patch %}
{% if loop.first %}
Their changes to test files, where they made any:

{% endif %}
<patch commit="{{ commit.sha }}">
{{ commit.patch }}
</patch>

{% endfor %}
{% else %}
No commit message mentions a flake, a retry, a skip or a quarantine.

{% endif %}
{% if history.churn %}
Test files changed in more than one of the last {{ history.scanned }} commits:
{%- for file in history.churn %}

- {{ file.path }}: {{ file.changes }} commits
{%- endfor +%}

{% endif %}
{% if history.mentions %}
Use the messages and diffs to name the test each commit deflaked, retried, skipped or quarantined,
and read the files a commit touched where its diff is missing or cut.

{% endif %}
{% if history.churn %}
In the churning files, look for tests that keep changing without a behavior change, and for skip or
only markers and retry annotations that are still present.

{% endif %}
If none of this points at a specific test, return an empty list.
{% elif modality == 'smells' %}
Grep the test code for flake smells: sleeps and arbitrary waits, real-clock time or "now"
comparisons, unseeded randomness, real network, filesystem or ports, order-dependent shared
fixtures, race-prone async patterns (unawaited promises, fire-and-forget), generous custom
timeouts, and retry annotations already present. Name the specific smell for each suspect.
{% else %}
{% if artifacts.paths %}
The workflow found these tracked CI and test artifacts:
{%- for path in artifacts.paths %}

- {{ path }}
{%- endfor +%}

{% if artifacts.unlisted %}
{{ artifacts.unlisted }} more are not listed.

{% endif %}
{% else %}
The workflow found no tracked CI configuration, test report or quarantine list by name.

{% endif %}
Find suspects in CI and test artifacts: CI configuration with retry settings, JUnit or other report
XML, workflow logs checked into the repository, quarantine lists and test-results directories. If no
artifact names a test, return an empty list; do not guess.
{% endif %}

For each suspect give the test name exactly as the test runner sees it (the operator's single-test
command receives it), its file relative to the working directory, and your evidence. Report at most
{{ limit }} suspects, the best evidenced first. The workflow runs only tracked files that match the
operator's test-file globs ({{ testFiles | join(', ') }}) and rejects any other file unrun, so name
the test file itself, not a helper, a script or a CI step. An empty list is a valid result.

{% include "_fragments/ReadOnly.md" %}
