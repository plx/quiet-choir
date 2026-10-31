You cannot run anything yourself: read the code, then write probes, which the workflow runs after a
human approves them. Each probe runs alone as {{ argv | tojson }} with the program on standard input,
from the repository root of a fresh checkout pinned at commit {{ base }}.
{% if prepare %}
Before each probe the workflow runs these commands in its checkout: {{ prepare | tojson }}.
{% else %}
Nothing is installed or built in the checkout beyond what that commit holds.
{% endif %}
A probe has at most {{ seconds }} seconds; one that runs longer reads as broken.
{% if variables %}
It sees only these environment variables: {{ variables | join(", ") }}.
{% else %}
It sees no environment variables beyond the workflow's own.
{% endif %}

Its exit code is the verdict, and only two codes count: 0 for the passing outcome and {{ failCode }}
for the failing one. Any other exit, an uncaught exception, a failed import, a timeout or a signal
reads as a broken probe that a human must check, never as a failure. So test the behavior
explicitly and call the exit yourself: compare the value you got with the one you expect, print
both, and choose the exit code. Do not let an assertion library or a thrown error stand in for
exit {{ failCode }}, and never catch and hide a failure.

A probe must not depend on another probe, on files outside the checkout, or on the network unless
the behavior under test needs it, and writes scratch files only under the system temporary
directory. Keep each probe short enough for a human to read. Do not edit files.