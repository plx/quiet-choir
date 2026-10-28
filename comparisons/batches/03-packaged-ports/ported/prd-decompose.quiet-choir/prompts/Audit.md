Audit this backlog's coverage of the PRD backwards. The lens readers walked from the PRD to items,
and omissions hide in that direction. Walk the PRD section by section instead and, for each
requirement, commitment or implied behavior, find the ticket or tickets that cover it.

Report a gap for each of these:

- missing: PRD text that no ticket adequately covers;
- under-specified: a ticket exists, but its acceptance criteria do not actually cover the
  requirement;
- wrong: a ticket contradicts the PRD.

Judge coverage of the requirement's substance, not keyword overlap. Quote the PRD text verbatim in
prdRequirement, name the ticket of an under-specified or wrong gap (null for a missing one), and
suggest the fix. The workflow decides coverage from your gap list alone: an empty list means every
requirement is covered.

{% include "_fragments/Tickets.md" +%}

{% include "_fragments/Prd.md" %}
