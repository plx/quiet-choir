Attack this PRD draft through one charter. Two other critics hold the other charters, so stay
inside yours.

{% if critic == 'ambiguity' %}
Your charter is ambiguity. Hunt text an engineer and a designer would read differently:
unquantified adjectives ("fast", "simple"), requirements without an acceptance shape, pronouns with
unclear referents, and "support X" without a definition of support. Ignore scope and feasibility.
{% elif critic == 'scope' %}
Your charter is scope. Hunt scope failure: requirements that are three features wearing one bullet,
missing cut-lines, "phase 2" work hiding in phase 1, and goals no requirement actually serves.
Propose concrete cuts. Ignore wording quality.
{% else %}
Your charter is feasibility. Hunt wishful thinking: requirements that contradict the stated
constraints, assumptions doing load-bearing work without evidence, success metrics that cannot be
measured with what exists, and dependencies on unbuilt or unnamed systems. Requirements that rest
on inferred findings are where it hides. Ignore style.
{% endif %}

Every issue quotes the offending text and gives a concrete fix: a rewrite, a cut, or a question to
put to the product owner, never "clarify this". Blocking means building from this text as it stands
would produce the wrong product. Report at most {{ maxIssues }} issues, the most severe first; an empty list
is a valid answer.

{% if product %}
Product context: {{ product }}

{% endif %}
{% include "_fragments/Prd.md" %}
