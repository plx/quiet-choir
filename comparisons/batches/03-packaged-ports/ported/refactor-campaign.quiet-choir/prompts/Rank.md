Rank these refactoring targets by payoff against risk, and select at most {{ maxTargets }}, best
first. For each selected target name the specific refactoring: a named technique such as extract
function, replace conditional with polymorphism, introduce parameter object or move function,
never "clean up".

Untested code is higher risk: its behavior must first be pinned by new characterization tests, and
whatever those tests miss can change unnoticed. Weight that accordingly. Select nothing if no
target is worth its risk.

Targets:
{%- for target in targets %}

- {{ target.location }}: {{ target.pressure }}, {{ target.testability }}. {{ target.evidence }}
{%- endfor %}
