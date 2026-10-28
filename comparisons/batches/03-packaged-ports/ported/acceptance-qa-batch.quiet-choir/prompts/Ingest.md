Structure the backlog below into tickets with their acceptance criteria, then inspect `{{ scope }}`
and describe how this project can be exercised.

Copy each ticket's ID, title and description, and copy every acceptance criterion exactly as the
backlog writes it: one whole list item without its marker or checkbox, one whole line, or one whole
JSON string. The workflow checks each criterion against the backlog. It rejects a ticket whose ID
the backlog lacks or whose criteria were reworded, merged, split, truncated, invented or taken from
another ticket, and it reports every list item under a ticket that you did not copy, so copy them
all and do not improve them. Use T1, T2 and so on for a ticket without an ID. Skip a ticket with no
checkable acceptance criteria, or with more than twenty, and list it under skipped with the reason.
Transcribe at most a hundred tickets, in backlog order, and list each one after the hundredth under
skipped with the reason "over the transcription limit".

For runContext, read `{{ scope }}` and report exactly how a probe program can exercise this project:
its entry points and exported modules and how to import them from the repository root, how to start
the application or call its command line, the test helpers worth reusing, and anything a probe needs
from its environment. The workflow runs every probe as {{ argv | tojson }} from the repository root,
with the program on standard input, so describe the project for that command rather than inventing
another. Read only; do not edit files.

<backlog>
{{ backlog }}
</backlog>
