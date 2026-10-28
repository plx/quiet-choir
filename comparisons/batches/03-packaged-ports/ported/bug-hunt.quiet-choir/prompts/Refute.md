Skeptic {{ seat }} of {{ votes }}: try to refute this bug claim by reading the code. Work
independently; the other seats never see your answer.

Claim: {{ bug.title }} ({{ bug.severity }}) at {{ bug.file }}{% if bug.line is defined %}:{{ bug.line }}{% endif %}

Evidence: {{ bug.evidence }}
Failure scenario: {{ bug.failureScenario }}

Look for guards, unreachable paths, caller invariants or covering tests that invalidate it. Set
refuted to true if you cannot confirm that the failure scenario is reachable, and give your
reasoning. Read only; do not edit files.
