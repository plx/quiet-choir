Independently confirm that the refactoring of {{ target.location }} ({{ target.refactoring }})
preserved behavior. The goal was: {{ goal }}. Every characterization net already passed on the
refactored code, because the workflow ran them; your job is the diff. Confirm that its changes are
structural, not behavioral.

{% include "_fragments/preserve.md" +%}

The nets prove only what they pin, so look hardest at what they do not: changed error types or
messages, a different evaluation order or side-effect order, changed defaults, edge cases handled
differently, altered exports or signatures, and floating-point or ordering differences. Answer
structural false if any change could alter observable behavior, and name it in your reasoning.

The refactor changed these files; the workflow checked that no net file is among them:
{%- for file in files %}

- {{ file }}
{%- endfor +%}

A weakened test hides a behavior change from the verification commands. Treat a change to an
existing test, test fixture or test configuration as behavioral unless it is a mechanical follow-up
of this refactoring, such as an updated import path or a renamed symbol.

The net {{ netFile }} pins:
{%- for behavior in behaviors %}

- {{ behavior }}
{%- endfor +%}

<net path="{{ netFile }}">
{{ netSource }}
</net>
{% if netShownBytes %}

The net above is truncated to its first {{ netShownBytes }} bytes.
{% endif %}
{% if shownBytes %}

The diff below is truncated to its first {{ shownBytes }} bytes. Judge only what you can see, and
answer structural false if that is not enough to tell.
{% endif %}

<diff>
{{ diff }}
</diff>
