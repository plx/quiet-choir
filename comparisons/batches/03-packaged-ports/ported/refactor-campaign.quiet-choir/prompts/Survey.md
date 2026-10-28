Find refactoring targets in {{ scope }}. The goal: {{ goal }}.

Choose targets by measurable pressure, not by aesthetic preference:

- complexity: high cyclomatic complexity or deeply nested branching
- duplication: N near-identical sites
- coupling: high fan-in or fan-out across modules
- long-method: a function far longer than its neighbours
- primitive-obsession: raw strings, numbers or tuples standing in for a missing type
- god-object: one module or class that owns unrelated responsibilities

For each target give its location (a file, or file:function), the pressure, the evidence (the
actual number or count: the cyclomatic count, the duplicate sites, the fan-in and fan-out) and how
well the existing tests exercise it now: well-tested, thinly-tested or untested. Untested code is
not excluded, because its behavior is pinned with new characterization tests before anyone touches
it, but say so honestly.

Report at most twelve targets, one per location. An empty list is a valid result. Read only; do not
edit files.
