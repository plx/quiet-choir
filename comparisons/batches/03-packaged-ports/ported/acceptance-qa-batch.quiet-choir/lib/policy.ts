// Pure rules: which transcribed tickets are admitted, what a probe's exit means, when a ticket is
// worth attacking, its verdict, the run status, and the digest of an approved probe list.
import { createHash } from 'node:crypto';
import * as std from 'quiet-choir/std';
import type { Assessed } from './evidence.js';
import type {
  AcceptanceOutput,
  AttackResult,
  CriterionResult,
  CriterionStatus,
  Graded,
  Run,
  Skipped,
  Ticket,
} from '../contracts.js';

const normalize = (text: string) => text.replace(/\s+/gu, ' ').trim();

/** The texts a criterion may be quoted from: the backlog, and every string in it when it is JSON. */
function sources(content: string): string[] {
  const texts = [normalize(content)];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') texts.push(normalize(value));
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  try {
    walk(JSON.parse(content));
  } catch {
    // Markdown or plain text: the normalized backlog is the only source.
  }
  return texts;
}

/**
 * Tickets whose criteria all appear verbatim (up to whitespace) in the backlog, first ID wins. A
 * reworded criterion would change what the verdict is about, so its ticket is rejected, not fixed.
 */
export function admit(tickets: Ticket[], content: string) {
  const texts = sources(content);
  const seen = new Set<string>();
  const admitted: Ticket[] = [];
  const rejected: Skipped[] = [];
  for (const ticket of tickets) {
    const reworded = ticket.acceptanceCriteria.find(
      (criterion) => !texts.some((text) => text.includes(normalize(criterion))),
    );
    if (seen.has(ticket.id))
      rejected.push({ id: ticket.id, reason: 'Duplicate ticket ID; the first is checked' });
    else if (reworded !== undefined)
      rejected.push({ id: ticket.id, reason: `Criterion not in the backlog: ${reworded}` });
    else admitted.push(ticket);
    seen.add(ticket.id);
  }
  return { admitted, rejected };
}

/** Exit 0 demonstrates, another exit code fails, and no exit code (timeout, signal) proves nothing. */
export const criterionStatus = (run: Run): CriterionStatus =>
  run.failure !== null || run.code === null
    ? 'inconclusive'
    : run.code === 0
      ? 'demonstrated'
      : 'failed';
export const attackOutcome = (run: Run): AttackResult['outcome'] =>
  run.failure !== null || run.code === null ? 'inconclusive' : run.code === 0 ? 'held' : 'broke';

/** Upstream attacks only a ticket that earned defending: something shown, nothing failed. */
export const attackable = (criteria: CriterionResult[]) =>
  criteria.some((result) => result.status === 'demonstrated') &&
  !criteria.some((result) => result.status === 'failed');

function manualChecks(
  criteria: CriterionResult[],
  attacks: AttackResult[],
  demonstrator: Graded['demonstrator'],
  breaker: Graded['breaker'],
): string[] {
  const checks =
    demonstrator === 'failed' ? ['The demonstrator failed; demonstrate every criterion'] : [];
  for (const [index, result] of criteria.entries()) {
    const name = `Criterion ${index + 1}`;
    if (result.status === 'undemonstrable') checks.push(`${name}: ${result.claim ?? ''}`);
    if (result.status === 'inconclusive')
      checks.push(`${name}: the probe ended without an exit code (${result.run?.failure ?? ''})`);
    if (result.status === 'unrun' && demonstrator === 'answered')
      checks.push(`${name}: its probe was not approved`);
  }
  if (breaker === 'failed') checks.push('The breaker failed; attack the feature by hand');
  if (breaker === 'declined') checks.push('The attack probes were not approved');
  for (const attack of attacks)
    if (attack.outcome === 'inconclusive' && attack.severity === 'breaks-criterion')
      checks.push(`Attack without an exit code: ${attack.description}`);
  return checks;
}

/**
 * Fail on a failed criterion or a reproduced criterion-breaking attack; unverified when nothing
 * was demonstrated; pending manual when anything is left for a human; pass otherwise.
 */
export function grade(
  { ticket, criteria, demonstrator }: Assessed,
  attacks: AttackResult[],
  breaker: Graded['breaker'],
): Graded {
  const manual = manualChecks(criteria, attacks, demonstrator, breaker);
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

/** A human decline outranks agent failures, which outrank the ticket cap. */
export function runStatus(
  declined: boolean,
  tickets: Graded[],
  rejected: Skipped[],
  deferred: unknown[],
): AcceptanceOutput['status'] {
  if (declined) return 'declined';
  const failed = tickets.some(
    (ticket) => ticket.demonstrator === 'failed' || ticket.breaker === 'failed',
  );
  if (failed || rejected.length) return 'degraded';
  return deferred.length ? 'limited' : 'complete';
}

/** The counts of the upstream output, which counted pass-pending-manual as passed. */
export const counts = (tickets: Graded[]) => ({
  passed: tickets.filter((ticket) => ticket.verdict.startsWith('pass')).length,
  failed: tickets.filter((ticket) => ticket.verdict === 'fail').length,
  unverified: tickets.filter((ticket) => ticket.verdict === 'unverified').length,
});

/** Sorted keys at every depth: results come back from the checkpoint with their keys reordered. */
const sorted = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sorted)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, sorted((value as Record<string, unknown>)[key])]),
        )
      : value;

/** The approved list as sorted-key JSON: its SHA-256 and a bounded preview for the question. */
export function approvalOf(list: unknown[]) {
  const text = std.exec.json(sorted(list));
  return {
    digest: createHash('sha256').update(text).digest('hex'),
    preview: Buffer.from(text).subarray(0, 15_000).toString('utf8'),
  };
}
