Demonstrate that ticket {{ ticket.id }} ("{{ ticket.title }}") meets its acceptance criteria
against the real implementation in `{{ scope }}`.

{% include "_fragments/Ticket.md" +%}

How to exercise this project: {{ runContext }}

{% include "_fragments/Probe.md" +%}

Answer one entry per criterion, in order. For each, write a probe that exits 0 when the criterion
holds and {{ failCode }} when it does not, and say in claim what it checks. Make the probe produce concrete,
reproducible evidence: the call it made and the value it got, the command it started and its output,
the request and the response. Ground every probe in the implementation you read, never in the
ticket's own description, and make sure it can fail: a probe that passes whatever the code does
demonstrates nothing.

When a criterion needs an environment this checkout lacks, such as a browser, a running service,
credentials or real hardware, set probe to null and say in claim exactly what a human must check.
An honest undemonstrable beats a faked demonstration.
