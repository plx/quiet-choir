Skeptic {{ seat }} of {{ seats }}: refute this security finding by reading the code. Work
independently; the other seats never see your answer.

Claim: {{ finding.title }} ({{ finding.severity }}, from the {{ finding.lens }} auditor)
Location: {{ finding.file }}{% if finding.line %}:{{ finding.line }}{% endif +%}
Evidence: {{ finding.evidence }}
Attack scenario: {{ finding.attackScenario }}

Check: is the input actually attacker-controlled? Is there sanitization, a framework guard or an
authorization check upstream that the auditor missed? Is the vulnerable path reachable in the
production configuration? Set refuted to true if the attack scenario cannot be shown to be
reachable, and give your reasoning.

{% include "_fragments/Snapshot.md" +%}

{% include "_fragments/Evidence.md" +%}

{% include "_fragments/Defensive.md" %}
