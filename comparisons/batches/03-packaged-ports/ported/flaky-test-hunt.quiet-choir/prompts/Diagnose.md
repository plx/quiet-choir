Diagnose why this test is flaky. The workflow ran it {{ stress.runs }} times at commit {{ commit }}
and it failed {{ stress.failures }} of them: this is a measurement, not a rumor.

Test: {{ suspect.test }}
File: {{ suspect.file }}
Command: {{ stress.argv | join(' ') }}
Why it was suspected:
{%- for item in suspect.evidence %}

- {{ item.modality }}: {{ item.evidence }}
{%- endfor +%}

Runs, in order:
{%- for run in stress.outcomes %}

- {{ run.outcome }}{% if run.code is not none %}, exit {{ run.code }}{% endif %}{% if run.durationMs is not none %}, {{ run.durationMs }} ms{% endif %}
{%- endfor +%}

{% if stress.medianPassMs is not none and stress.medianFailMs is not none %}
Median duration: {{ stress.medianPassMs }} ms passing, {{ stress.medianFailMs }} ms failing.

{% endif %}
{% if residue %}
The stress runs left these changes in the checkout, which can carry state from one run into the
next:
{%- for line in residue %}

- {{ line }}
{%- endfor +%}

{% endif %}
{% if stress.sample %}
Output of the first failing run:

<failure>
{{ stress.sample }}
</failure>

{% endif %}
Read the test and the code under test. Name the mechanism and tell the causal story: which
interleaving, state or timing makes it fail only sometimes. "Timing" or "flaky" is not a diagnosis.
Mechanisms:

- shared-state: state that leaks between tests or runs, such as module caches, globals, files or
  databases.
- timing-timeout: a fixed timeout or wait racing a path whose duration varies.
- async-race: an interleaving of concurrent work, such as an unawaited promise or a callback that
  can land before or after an assertion.
- external-dependency: a network service, port or tool outside the test's control.
- random-data: unseeded randomness that sometimes produces a failing input.
- resource-exhaustion: ports, file descriptors, memory or disk running out under load.
- test-order-dependence: the test passes or fails depending on what ran before it.
- clock-dependence: the real clock, a time zone or a date boundary.
- unknown: none of the above fits the evidence; say what evidence is missing.

Propose a real fix that removes the mechanism; retry-wrapping is acceptable only when the
dependency is genuinely external. List every file the fix changes, the test file included when it
changes: a human approves exactly those files.

{% include "_fragments/ReadOnly.md" %}
