import { brandError, isBranded } from './error-brand.js';
import { z } from 'zod';
import { clockNow, MAX_EPOCH_MS, systemClock } from './clock.js';
import { RateLimitTracker, windowStop, windowStopDescription } from './rate-limit.js';
import type { RunRecord } from './record.js';
import { summarizeUsage } from './usage-summary.js';
import type { WorkflowClock } from './wait-model.js';

/** Sticky operator limits, outside workflow and effect identity. Null means unlimited. */
export interface RunBudgetPolicy {
  /** Stop new agent attempts after this much reported cost; already admitted calls may overshoot. */
  readonly maxRunCostUsd: number | null;
  /** Maximum locally admitted agent attempts across all executions, including unknown usage. */
  readonly maxRunAgentAttempts: number | null;
  /**
   * Refuse a new agent attempt while the admitting harness's latest recorded subscription window
   * (`diagnostics.rateLimit`) reports at least this utilization, 0 to 1. When every exceeded window
   * has a known reset the run suspends until then; otherwise it fails like the other caps. Absent
   * (older records) or null means unlimited.
   */
  readonly maxWindowUtilization?: number | null;
}

/** Saved explanation of the most recent operator stop; cleared when a new execution starts. */
export interface RunBudgetStop {
  /** Agent effect which was refused, without adding a new attempt. */
  readonly stepId: string;
  /** Limit that prevented admission. */
  readonly metric: keyof RunBudgetPolicy;
  /** Configured threshold. */
  readonly limit: number;
  /** Reported cost, admitted attempt count or window utilization (which may exceed 1) at refusal. */
  readonly observed: number;
  /** Refusal timestamp, not an estimate of when spending crossed the threshold. */
  readonly at: string;
  /** For `maxWindowUtilization`: the harness whose report closed the gate. */
  readonly harness?: string;
  /** For `maxWindowUtilization`: the native name of the exceeded window, such as `seven_day`. */
  readonly window?: string;
  /** For `maxWindowUtilization`: the window's reset in Unix epoch seconds as reported, or null. */
  readonly resetsAt?: number | null;
}

const budgetFlags: Readonly<Record<keyof RunBudgetPolicy, string>> = {
  maxRunCostUsd: '--max-run-cost-usd',
  maxRunAgentAttempts: '--max-run-agent-attempts',
  maxWindowUtilization: '--max-window-utilization',
};

/** The CLI flag of the cap behind a run-budget stop, for messages and recovery hints. @internal */
export function runBudgetFlag(metric: keyof RunBudgetPolicy): string {
  return budgetFlags[metric];
}

/** A latched operator stop, delivered only after admitted agent attempts drain. */
export class RunBudgetExceededError extends Error {
  static {
    brandError(this, 'RunBudgetExceededError');
  }

  /** Recognize an instance from any quiet-choir module instance, such as a CLI workflow's own import. */
  public static override [Symbol.hasInstance](value: unknown): value is RunBudgetExceededError {
    return isBranded(this, value);
  }

  /** Stable machine-readable classification. */
  public readonly code = 'QUIET_CHOIR_RUN_BUDGET';
  /** Run whose next attempt was refused. */
  public readonly runId: string;
  /** Persistable refusal evidence. */
  public readonly stop: RunBudgetStop;

  /**
   * Construct an actionable refusal without implying a hard billing ceiling. `wakeAt` is the epoch
   * millisecond reset of a `maxWindowUtilization` stop, or null when the run cannot wait for it.
   */
  public constructor(runId: string, stop: RunBudgetStop, wakeAt: number | null = null) {
    const flag = runBudgetFlag(stop.metric);
    const reached =
      stop.metric === 'maxWindowUtilization'
        ? windowStopDescription(stop, wakeAt)
        : `${stop.metric} limit ${String(stop.limit)} reached (${String(stop.observed)} recorded)`;
    super(
      `Run ${runId}: ${reached}; refused agent step ${stop.stepId}. Active attempts were allowed to finish. Resume with a higher ${flag} value or ${flag} off; completed calls replay without new spend.`,
    );
    this.name = 'RunBudgetExceededError';
    this.runId = runId;
    this.stop = stop;
  }
}

/** Validate serialized policy before creating or importing a workflow. @internal */
export const runBudgetSchema = z.object({
  maxRunCostUsd: z.number().nonnegative().nullable(),
  maxRunAgentAttempts: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  // Optional, so records written before the gate read unchanged and reads never fill it in.
  maxWindowUtilization: z.number().min(0).max(1).nullable().optional(),
});

/**
 * Own admission reservations and drain refusals without cancelling paid work. @internal
 *
 * Admission cost does not grow with the step map under the window gate alone (#378). The gate reads
 * the `latestRateLimits` projection from a {@link RateLimitTracker} seeded by one scan of the record
 * on the first window check, folded per step in O(that step's attempts) as admitted attempts settle,
 * and rescanned only when a step that holds a harness's latest report is rewritten so that the
 * report no longer stands (see {@link RunBudget.observe}). The answer equals `latestRateLimits` over
 * the record, except for timing: a new report counts once its attempt has settled and been saved
 * (the runner observes the step on release and before a retry's backoff), as a resumed run would
 * see it, where a full scan also read an in-flight attempt's unsaved report. A seed or rescan while
 * an attempt runs still reads it, ranked by its start, and its settlement replaces it.
 *
 * The cost total is not cached; `check` sums it only while `maxRunCostUsd` is set. It includes
 * integration usage that local steps report through `reportUsage`, which settles outside admission
 * and so has no release to fold it in; it depends on legacy fallbacks and on the order floats are
 * summed in; and `stop.observed` must equal the cost that inspect and run results report.
 */
export class RunBudget {
  readonly #record: RunRecord;
  readonly #policy: RunBudgetPolicy;
  readonly #clock: WorkflowClock;
  readonly #queued = new AbortController();
  readonly #idle = new Set<() => void>();
  #attempts: number;
  #active = 0;
  #error: RunBudgetExceededError | undefined;
  #wakeAt: number | null = null;
  // Only with the window gate set; undefined until the first window check and after invalidation.
  #rateLimits: RateLimitTracker | undefined;

  /** `clock` decides which recorded rate-limit windows have expired. */
  public constructor(
    record: RunRecord,
    policy: RunBudgetPolicy,
    clock: WorkflowClock = systemClock,
  ) {
    this.#record = record;
    this.#policy = policy;
    this.#clock = clock;
    this.#attempts = summarizeUsage(record).attempts;
  }
  public get enabled(): boolean {
    return (
      this.#policy.maxRunCostUsd !== null ||
      this.#policy.maxRunAgentAttempts !== null ||
      (this.#policy.maxWindowUtilization ?? null) !== null
    );
  }
  /**
   * Epoch milliseconds at which the latched `maxWindowUtilization` stop's window resets, or null
   * when nothing latched, another cap latched, or the reset is unknown.
   */
  public get wakeAt(): number | null {
    return this.#wakeAt;
  }
  public get signal(): AbortSignal {
    return this.#queued.signal;
  }
  public get error(): RunBudgetExceededError | undefined {
    return this.#error;
  }

  /** Latch a refusal when a cap is reached; `harness` selects the rate-limit report to read. */
  public check(stepId: string, harness: string): RunBudgetExceededError | undefined {
    if (this.#error) return this.#error;
    for (const metric of ['maxRunAgentAttempts', 'maxRunCostUsd'] as const) {
      const limit = this.#policy[metric];
      if (limit === null) continue;
      const observed = metric === 'maxRunAgentAttempts' ? this.#attempts : this.#cost();
      if (observed < limit) continue;
      return this.#latch({ stepId, metric, limit, observed, at: new Date().toISOString() });
    }
    const windowLimit = this.#policy.maxWindowUtilization ?? null;
    if (windowLimit === null) return undefined;
    // Per harness: a Codex admission is never refused by Claude's windows.
    this.#rateLimits ??= this.#seedRateLimits();
    const report = this.#rateLimits.get(harness);
    const stop = windowStop(report, windowLimit, clockNow(this.#clock), MAX_EPOCH_MS);
    if (!stop) return undefined;
    this.#wakeAt = stop.wakeAt;
    return this.#latch({
      stepId,
      metric: 'maxWindowUtilization',
      limit: windowLimit,
      observed: stop.observed,
      at: new Date().toISOString(),
      harness,
      window: stop.window,
      resetsAt: stop.resetsAt,
    });
  }

  #cost(): number {
    const usage = summarizeUsage(this.#record);
    return (usage.costUsd ?? 0) + (usage.integrationUsage.costUsd ?? 0);
  }

  #seedRateLimits(): RateLimitTracker {
    const tracker = new RateLimitTracker();
    for (const [stepId, step] of Object.entries(this.#record.steps))
      tracker.observeStep(stepId, step);
    return tracker;
  }

  /**
   * Fold `stepId`'s attempts, as the record holds them now, into the window gate's projection.
   * The runner calls it after an admitted attempt settles (through `enter`'s release, before a
   * retry's backoff, and after a success's completion save, ahead of any transcript discard that
   * delays the release) and after it rewrites a recorded step's kind, harness or request (redefinition
   * and legacy migration). When a report the step held no longer stands, the projection is dropped
   * and the next window check rescans the record once. A no-op until the first window check.
   */
  public observe(stepId: string): void {
    const tracker = this.#rateLimits;
    if (!tracker) return;
    const steps = this.#record.steps;
    if (!tracker.observeStep(stepId, Object.hasOwn(steps, stepId) ? steps[stepId] : undefined))
      this.#rateLimits = undefined;
  }

  #latch(stop: RunBudgetStop): RunBudgetExceededError {
    this.#record.budgetStop = stop;
    this.#error = new RunBudgetExceededError(this.#record.id, stop, this.#wakeAt);
    // Only queued limiter requests listen to this signal. Active invocations keep their scope signal.
    this.#queued.abort(this.#error);
    return this.#error;
  }

  /** Reserve an admitted attempt of `stepId`; the release observes the settled step. */
  public enter(stepId: string): () => void {
    this.#attempts++;
    this.#active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active--;
      if (this.#active === 0) {
        for (const resolve of this.#idle) resolve();
        this.#idle.clear();
      }
      this.observe(stepId);
    };
  }

  public async refuse(): Promise<never> {
    if (!this.#error) throw new Error('Budget refusal requires a latched limit.');
    if (this.#active > 0)
      await new Promise<void>((resolve) => {
        this.#idle.add(resolve);
      });
    throw this.#error;
  }
}
