Apply the flaky-test fixes below, which a human approved after the workflow measured each flake and
a diagnostician named its mechanism. Fix the mechanism itself: do not add retries, longer timeouts
or skips unless the plan says the dependency is genuinely external.

Work through the plan in order. Every fix must change at least one of the files it lists, and you
may change only the files the plan lists: a fix left untouched stops publication, and renaming or
moving a file, or changing any other file, is refused. Do not try to run the tests: the workflow
re-stresses each fixed test {{ fixRuns }} times in a fresh checkout of your change and publishes the
fixes only if every run passes.
{% if verifying %}
The operator's verification commands must pass in another fresh checkout of your change too.
{% endif %}

Approved plan digest: {{ digest }}
Approved plan:
{{ plan }}
