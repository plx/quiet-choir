Pin the current observable behavior of {{ target.location }} with characterization tests: tests
that capture what the code does now. A later step refactors it ({{ target.refactoring }}), and
these tests are the safety net that proves the refactoring changed nothing.

{% include "_fragments/preserve.md" +%}

Cover the real input and output pairs, the edge cases and the side effects you can observe; the
pressure here is {{ target.pressure }} ({{ target.evidence }}). Put the tests in one new test file
that follows the repository's test conventions, and return its path as the net file. If the tests
need fixtures or golden files, add them as new files too and list each in supportFiles. Add only
new files, and only those: do not edit, move or delete any existing file, source or test. The
workflow refuses a net whose checkout holds a file you did not declare, and the refactor that
follows may touch none of the net's files.

The workflow runs your net file with this command, its repository-relative path appended, and it
must pass against the current, unrefactored code:

{{ command }}
{% if previous %}

Your previous net, {{ previous.netFile }}, failed against the current code. The code is the
specification here, so fix the net, never the code under test: correct the expectations to what the
code actually does, or remove a test you cannot make deterministic and say so in the notes.
{% if previous.failure %}
The command did not finish normally ({{ previous.failure }}).
{% else %}
The command exited with code {{ previous.code }}.
{% endif %}
{% if previous.stdout %}

The end of its standard output:

<stdout>
{{ previous.stdout }}
</stdout>
{% endif %}
{% if previous.stderr %}

The end of its standard error:

<stderr>
{{ previous.stderr }}
</stderr>
{% endif %}

This checkout starts fresh from the current code, so the previous net's files are not in it. Write
the corrected net in full; a file you leave out is gone, and a file you rename leaves no copy
behind. Rewrite a file shown only in part from the code under test rather than copying the part you
see. The previous files were:
{%- for file in previous.files %}


<file path="{{ file.path }}">
{{ file.source }}
</file>
{%- if file.shownBytes %}


(Only the first {{ file.shownBytes }} bytes of {{ file.path }} are shown.)
{%- endif %}
{%- endfor +%}
{% endif %}

You have no shell, so you cannot run the command yourself; the workflow runs it after you return.
If the behavior genuinely cannot be pinned (it needs live external systems, or wall-clock timing or
other nondeterminism you cannot control), answer cannot-pin and say why in the notes. Never fake a
net that passes without pinning anything, and name every behavior the net pins.
