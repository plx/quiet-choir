// Pure rules: what a probe's exit means, when a ticket is worth attacking, its verdict and what a
// human still has to check, the run status, and the counts.
import { FailExit } from '../contracts.js';
import type {
  AcceptanceOutput,
  AttackResult,
  CriterionResult,
  CriterionStatus,
  Graded,
  Run,
  Skipped,
} from '../contracts.js';
import type { Unclaimed } from './backlog.js';
import type { Assessed } from './evidence.js';

/**
 * Exit 0 and exit FailExit are the two verdicts. Any other exit (a crash, a bad import), a
 * timeout, a signal or a command that could not start gave none, so it cannot fail a ticket.
 */
const verdictOf = (run: Run): 'zero' | 'fail' | null =>
  run.failure !== null || run.code === null
    ? null
    : run.code === 0
      ? 'zero'
      : run.code === FailExit
        ? 'fail'
        : null;
export const criterionStatus = (run: Run): CriterionStatus =>
  (({ zero: 'demonstrated', fail: 'failed', none: 'inconclusive' }) as const)[
    verdictOf(run) ?? 'none'
  ];
export const attackOutcome = (run: Run): AttackResult['outcome'] =>
  (({ zero: 'held', fail: 'broke', none: 'inconclusive' }) as const)[verdictOf(run) ?? 'none'];

/** Why a run gave no verdict, for the manual list. */
const noVerdict = (run: Run | null) =>
  run?.failure
    ? `${run.failure.kind}: ${run.failure.message}`
    : `exit ${run?.code ?? 'none'}, not 0 or ${FailExit}`;

/** Upstream attacks only a ticket that earned defending: something shown, nothing failed. */
export const attackable = (criteria: CriterionResult[]) =>
  criteria.some((result) => result.status === 'demonstrated') &&
  !criteria.some((result) => result.status === 'failed');

function manualChecks(
  { criteria, demonstrator }: Assessed,
  attacks: AttackResult[],
  breaker: Graded['breaker'],
  unclaimed: string[],
): string[] {
  const checks = unclaimed.map((item) => `Not transcribed from the backlog: ${item}`);
  if (demonstrator === 'failed')
    checks.push('The demonstrator failed; demonstrate every criterion');
  for (const [index, result] of criteria.entries()) {
    const name = `Criterion ${index + 1}`;
    if (result.status === 'undemonstrable') checks.push(`${name}: ${result.claim ?? ''}`);
    if (result.status === 'inconclusive')
      checks.push(`${name}: the probe gave no verdict (${noVerdict(result.run)})`);
    if (result.status === 'unrun' && demonstrator === 'answered')
      checks.push(`${name}: its probe was not approved`);
  }
  if (breaker === 'failed') checks.push('The breaker failed; attack the feature by hand');
  if (breaker === 'declined') checks.push('The attack probes were not approved');
  for (const attack of attacks)
    if (attack.outcome === 'inconclusive' && attack.severity === 'breaks-criterion')
      checks.push(`Attack without a verdict (${noVerdict(attack.run)}): ${attack.description}`);
  return checks;
}

/**
 * Fail on a failed criterion or a reproduced criterion-breaking attack; unverified when nothing
 * was demonstrated; pending manual when anything is left for a human; pass otherwise.
 */
export function grade(
  assessed: Assessed,
  attacks: AttackResult[],
  breaker: Graded['breaker'],
  unclaimed: string[],
): Graded {
  const { ticket, criteria, demonstrator } = assessed;
  const manual = manualChecks(assessed, attacks, breaker, unclaimed);
  const broken = attacks.some(
    (attack) => attack.outcome === 'broke' && attack.severity === 'breaks-criterion',
  );
  const verdict =
    criteria.some((result) => result.status === 'failed') || broken
      ? 'fail'
      : !criteria.some((result) => result.status === 'demonstrated')
        ? 'unverified'
        : manual.length
          ? 'pass-pending-manual'
          : 'pass';
  const { id, title } = ticket;
  return { id, title, verdict, criteria, attacks, demonstrator, breaker, manual };
}

/** Criterion and attack runs that gave no verdict. */
export const inconclusiveRuns = (tickets: Graded[]) =>
  tickets.reduce(
    (total, ticket) =>
      total +
      ticket.criteria.filter((result) => result.status === 'inconclusive').length +
      ticket.attacks.filter((attack) => attack.outcome === 'inconclusive').length,
    0,
  );

/**
 * A human decline outranks degradation (a failed agent, a rejected or unclaimed transcription, a
 * probe that gave no verdict), which outranks the ticket cap.
 */
export function runStatus(
  declined: boolean,
  tickets: Graded[],
  transcription: { rejected: Skipped[]; unclaimed: Unclaimed[]; deferred: unknown[] },
): AcceptanceOutput['status'] {
  if (declined) return 'declined';
  const failed = tickets.some(
    (ticket) => ticket.demonstrator === 'failed' || ticket.breaker === 'failed',
  );
  const { rejected, unclaimed, deferred } = transcription;
  if (failed || rejected.length || unclaimed.length || inconclusiveRuns(tickets) > 0)
    return 'degraded';
  return deferred.length ? 'limited' : 'complete';
}

/** The counts of the upstream output, which counted pass-pending-manual as passed. */
export const counts = (tickets: Graded[]) => ({
  passed: tickets.filter((ticket) => ticket.verdict.startsWith('pass')).length,
  failed: tickets.filter((ticket) => ticket.verdict === 'fail').length,
  unverified: tickets.filter((ticket) => ticket.verdict === 'unverified').length,
  inconclusive: inconclusiveRuns(tickets),
});
