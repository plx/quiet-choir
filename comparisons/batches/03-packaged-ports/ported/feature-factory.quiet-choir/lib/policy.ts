// Pure rules: the children's delegation maps, the records a module's build, review and repair
// leave, and the final status verdict.
import type { MapStepError, Settled } from 'quiet-choir';
import type { FeatureFactoryOutput, Module, ModuleRecord } from '../contracts.js';
import type { Built, Fixed } from './stages.js';

/** Each child's roster entries onto the Reader ceiling; none of them edits. */
export const delegation = {
  decompose: { LensReader: 'Reader', Merger: 'Reader', Critic: 'Reader', Repairer: 'Reader' },
  review: { Scoper: 'Reader', Reviewer: 'Reader', Skeptic: 'Reader', Reporter: 'Reader' },
} as const;

/** The backlog as the output reports it: prd-decompose's verdict and the tickets' outline. */
export const backlogOf = (backlog: {
  status: string;
  tickets: { id: string; title: string; dependsOn: string[] }[];
  sequencing: string | null;
  openQuestions: string[];
  coverage: { gaps: unknown[] } | null;
}): FeatureFactoryOutput['backlog'] => ({
  status: backlog.status,
  tickets: backlog.tickets.map(({ id, title, dependsOn }) => ({ id, title, dependsOn })),
  sequencing: backlog.sequencing,
  openQuestions: backlog.openQuestions,
  gaps: backlog.coverage?.gaps.length ?? 0,
});

/** A module's record from its build outcome, or from why it was skipped or failed. */
export function recordOf(
  module: Module,
  outcome: (Built & { base: string }) | { skipped: string } | { failed: string },
): ModuleRecord {
  const plan = {
    name: module.name,
    foundation: module.isFoundation,
    fileAreas: module.fileAreas,
    tickets: module.ticketIds,
    review: null,
    repair: null,
  };
  const none = { blockers: [], outside: [], base: null, commit: null, files: [] };
  if ('skipped' in outcome) return { ...plan, ...none, build: 'skipped', summary: outcome.skipped };
  if ('failed' in outcome) return { ...plan, ...none, build: 'failed', summary: outcome.failed };
  const { build, summary, blockers, outside, files, commit, base } = outcome;
  return { ...plan, build, summary, blockers, outside, base, commit, files };
}

/** A builder outcome whose tickets later modules may build on. */
export const accepted = (outcome: Built) =>
  outcome.build === 'done' || outcome.build === 'partial' || outcome.build === 'unchanged';

interface ReviewOutput {
  status: 'nothing-to-review' | 'complete' | 'degraded' | 'limited';
  confirmed: unknown[];
  rejected: unknown[];
  unverified: unknown[];
  unchecked: unknown[];
  report: string;
}

/** A module review's summary: the child's counts, or its failure. */
export const reviewOf = (
  review: Settled<ReviewOutput, MapStepError> | undefined,
): NonNullable<ModuleRecord['review']> =>
  review?.ok
    ? {
        status: review.value.status,
        confirmed: review.value.confirmed.length,
        rejected: review.value.rejected.length,
        unverified: review.value.unverified.length,
        unchecked: review.value.unchecked.length,
        report: review.value.report,
      }
    : {
        status: 'failed',
        confirmed: 0,
        rejected: 0,
        unverified: 0,
        unchecked: 0,
        report: review ? review.error.message.slice(0, 500) : 'Review missing',
      };

/** A module repair's record, or the failure of its settled map item. */
export const repairOf = (
  repair: Settled<Fixed, MapStepError> | undefined,
): NonNullable<ModuleRecord['repair']> =>
  repair?.ok
    ? repair.value.record
    : {
        status: 'failed',
        summary: repair ? repair.error.message.slice(0, 500) : 'Repair missing',
        unresolved: [],
        outside: [],
        commit: null,
      };

/** A module that fell short: not built as planned, reviewed incompletely, or left unrepaired. */
const shortfall = (module: ModuleRecord) =>
  !['done', 'unchanged'].includes(module.build) ||
  module.review?.status === 'failed' ||
  module.review?.status === 'degraded' ||
  (module.review !== null && module.review.confirmed > 0 && module.repair?.status !== 'repaired') ||
  Boolean(module.repair?.unresolved.length);

/**
 * The verdict on a published integration: degraded when the backlog was not covered or a module
 * fell short; limited when tickets were deferred or a review hit a cap; otherwise applied.
 */
export function finalStatus(
  backlog: string,
  modules: ModuleRecord[],
  deferred: number,
): 'applied' | 'degraded' | 'limited' {
  if (backlog !== 'covered' || modules.some(shortfall)) return 'degraded';
  if (deferred || modules.some((module) => module.review?.status === 'limited')) return 'limited';
  return 'applied';
}
