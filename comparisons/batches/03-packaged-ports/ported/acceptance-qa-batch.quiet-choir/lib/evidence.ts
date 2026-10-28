// Pure assembly: the probe lists a human approves, built from the agents' answers, and the results
// read back from each probe's run, aligned by ticket and position, never by completion order.
import type {
  Attack,
  AttackResult,
  Attacks,
  CriterionResult,
  Graded,
  Plan,
  Run,
  Ticket,
} from '../contracts.js';
import { attackOutcome, criterionStatus } from './policy.js';

/** A settled agent answer, as a settled map returns it. */
type Answer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };
/** What a human approves for one criterion: the criterion, the agent's claim and its probe. */
export type CriterionProbe = {
  ticket: string;
  position: number;
  criterion: string;
  claim: string;
  probe: string;
};
export type AttackProbe = Attack & { ticket: string; attack: number };

/** Every criterion probe of every answered plan; a null probe is an undemonstrable criterion. */
export const criterionProbes = (chosen: Ticket[], plans: Answer<Plan>[]): CriterionProbe[] =>
  chosen.flatMap((ticket, index) => {
    const plan = plans[index];
    if (!plan?.ok) return [];
    return plan.value.criteria.flatMap(({ claim, probe }, position) => {
      const criterion = ticket.acceptanceCriteria[position];
      if (probe === null || criterion === undefined) return [];
      return [{ ticket: ticket.id, position, criterion, claim, probe }];
    });
  });

/** One ticket's criteria as code read them back, before any attack. */
export type Assessed = {
  ticket: Ticket;
  criteria: CriterionResult[];
  demonstrator: Graded['demonstrator'];
};

/** Each ticket's criteria: unrun without a plan or an approved run, else what the run showed. */
export function assess(
  chosen: Ticket[],
  plans: Answer<Plan>[],
  probes: CriterionProbe[],
  runs: Run[],
): Assessed[] {
  return chosen.map((ticket, index) => {
    const plan = plans[index];
    const criteria = ticket.acceptanceCriteria.map((criterion, position): CriterionResult => {
      const entry = plan?.ok ? plan.value.criteria[position] : undefined;
      const at = probes.findIndex(
        (probe) => probe.ticket === ticket.id && probe.position === position,
      );
      const run = runs[at] ?? null;
      const status = !entry
        ? 'unrun'
        : entry.probe === null
          ? 'undemonstrable'
          : run
            ? criterionStatus(run)
            : 'unrun';
      return { criterion, status, claim: entry?.claim ?? null, probe: entry?.probe ?? null, run };
    });
    return { ticket, criteria, demonstrator: plan?.ok ? 'answered' : 'failed' };
  });
}

/** Every attack of every answered breaker, numbered within its ticket. */
export const attackProbes = (targets: Assessed[], proposals: Answer<Attacks>[]): AttackProbe[] =>
  targets.flatMap(({ ticket }, index) => {
    const proposal = proposals[index];
    if (!proposal?.ok) return [];
    return proposal.value.attacks.map((attack, number) => ({
      ...attack,
      ticket: ticket.id,
      attack: number,
    }));
  });

/** One ticket's attacks with what their runs showed; unrun when the list was not approved. */
export const attackResults = (ticket: Ticket, attacks: AttackProbe[], runs: Run[]) =>
  attacks.flatMap((attack, at): AttackResult[] => {
    if (attack.ticket !== ticket.id) return [];
    const { description, severity, probe } = attack;
    const run = runs[at] ?? null;
    return [{ description, severity, probe, outcome: run ? attackOutcome(run) : 'unrun', run }];
  });

/** Skipped when the ticket was not attacked; declined when its attacks were proposed but not run. */
export const breakerStatus = (
  proposal: Answer<unknown> | undefined,
  tried: AttackResult[],
): Graded['breaker'] =>
  !proposal
    ? 'skipped'
    : !proposal.ok
      ? 'failed'
      : tried.some((attack) => attack.outcome === 'unrun')
        ? 'declined'
        : 'answered';
