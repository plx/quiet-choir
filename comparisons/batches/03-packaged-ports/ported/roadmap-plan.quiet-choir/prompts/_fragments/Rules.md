The workflow checks these rules before it accepts a plan:

- Respect the dependency graph absolutely: a capability goes in the same milestone as each of its
  dependencies or a later one, never an earlier one.
- Place every capability exactly once: in one milestone, or in deferred when it falls outside the
  horizon. A milestone capability cannot depend on a deferred one.
- Every milestone states a goal, the shippable or demoable thing it achieves, and an exit gate, a
  criterion someone can measure to say the milestone is done.
- Give each milestone a distinct name; use at most twelve milestones.
