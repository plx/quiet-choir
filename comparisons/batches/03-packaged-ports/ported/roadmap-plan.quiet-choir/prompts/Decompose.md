Decompose the spec below into capabilities: coherent, independently plannable units bigger than a
ticket and smaller than the whole product, such as an auth system, a billing flow or a search
feature. A roadmap will group them into shippable milestones, so each should be something a team
can plan, build and finish as a unit.

For each capability give:

- an id, numbered C1, C2, ... in list order;
- a name, and a one- or two-sentence summary of what it delivers;
- a size, S, M, L or XL, relative to the other capabilities;
- its hard dependencies in dependsOn, the real graph: what literally cannot start until what
  finishes. "Would be nicer after" is not a dependency; leave soft orderings to the sequencing;
- its technical risk: unknowns, novel technology, outside dependencies, not business importance;
- its value: what users or the business get when it ships.

Risk and value are separate axes. Three sequencing strategies will trade them off differently, so
rate each on its own. The graph is what makes sequencing an analysis instead of a guess: the
workflow checks that every dependency names another listed capability and that the dependencies
form no cycle, and it computes the critical path from your sizes.

Return at most {{ maxCapabilities }} capabilities; merge the smallest into their neighbours if the spec
holds more. If the spec describes nothing to build, return an empty list.

{% if path %}
The spec, read from {{ path }}:
{% else %}
The spec:
{% endif %}

<spec>
{{ spec }}
</spec>
