Stress-test this milestone plan before we commit to it: the {{ strategy }} strategy's sequencing of
the capabilities decomposed from the spec at the end. Hunt the ways roadmaps fail, and report each
problem you find as one of these kinds:

- hidden-dependency: the spec implies a dependency the graph does not list, and the milestones
  violate it;
- unbalanced-critical-path: one milestone secretly gates everything, or the critical path piles
  into one milestone while the others wait;
- risk-piled-late: high-risk work sits in the last milestone, where a bad discovery can no longer
  be absorbed;
- milestone-not-shippable: a milestone ends without anything a user or stakeholder can use or see;
- gate-unmeasurable: an exit gate nobody could measure or check.

Name the milestones or capabilities each problem concerns in its detail, and give each a concrete
fix. The workflow already checked that the plan respects the listed dependencies and places every
capability once, so look past those. A sound plan gets an empty list: do not invent problems.

{% include "_fragments/CriticalPath.md" +%}

{% include "_fragments/Plan.md" +%}

{% include "_fragments/Capabilities.md" +%}

<spec>
{{ spec }}
</spec>
