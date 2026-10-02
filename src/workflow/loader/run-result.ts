import type { RunRecord } from '../runtime/store.js';
import { summarizeUsage } from '../runtime/usage-summary.js';
import type { JsonValue } from '../runtime/model.js';
import { rootCauseSummary, type RootCauseSummary } from './failure-kind.js';
import { countSteps, type RunSummary } from './inspection.js';

/** At most this many warnings appear in a compact run result; one overflow note follows. */
const maxWarnings = 20;

/**
 * Bounded projection of a run record for the `--json` output of `workflow execute`, `resume` and
 * `answer --resume`. The full record stays behind `--full` and `workflow inspect`. @internal
 */
export interface RunResultSummary {
  readonly runId: string;
  readonly stateDir: string | null;
  readonly status: RunRecord['status'];
  /** The run's output exactly as recorded, or null before completion. */
  readonly output: JsonValue;
  readonly usage: {
    /** Sum of reported cost estimates; null when no attempt reported one. */
    readonly costUsd: number | null;
    readonly attempts: number;
    /** True when the cost or attempt totals may be low: legacy evidence or unknown measurements. */
    readonly undercounted: boolean;
  };
  readonly counts: RunSummary['counts'];
  /** The first failure with its classified kind; the kind is null for a body failure. */
  readonly rootCause: RootCauseSummary | null;
  readonly warnings: readonly string[];
}

/** A record as the runner returns it, possibly carrying the invocation's warnings. */
type ResultRun = RunRecord & { readonly warnings?: readonly string[] | undefined };

function resultWarnings(run: ResultRun): readonly string[] {
  const all = [
    ...new Set(
      run.warnings ?? [
        ...(run.policyWarnings ?? []),
        ...(run.replayWarnings ?? []),
        ...(run.harnessWarnings ?? []),
        ...(run.worktreeWarnings ?? []),
        ...(run.waitWarnings ?? []),
      ],
    ),
  ];
  return all.length <= maxWarnings
    ? all
    : [
        ...all.slice(0, maxWarnings),
        `${String(all.length - maxWarnings)} more warnings; use --full or workflow inspect`,
      ];
}

/**
 * Project a record to a small, constant-shape result: identity, status, output, usage headline,
 * step counts, root cause and warnings. Synchronous and tolerant of legacy records, because a
 * forced interruption renders it on the way out. @internal
 */
export function summarizeRunResult(run: ResultRun, stateDir: string | null): RunResultSummary {
  const usage = summarizeUsage(run);
  return {
    runId: run.id,
    stateDir,
    status: run.status,
    output: run.output,
    usage: {
      costUsd: usage.costUsd,
      attempts: usage.attempts,
      undercounted: usage.undercounted || usage.incompleteAttempts > 0,
    },
    counts: countSteps(run),
    rootCause: rootCauseSummary(run),
    warnings: resultWarnings(run),
  };
}
