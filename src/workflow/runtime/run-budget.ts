import { brandError, isBranded } from './error-brand.js';
import { z } from 'zod';
import { clockNow, MAX_EPOCH_MS, systemClock } from './clock.js';
import { latestRateLimits, windowStop, windowStopDescription } from './rate-limit.js';
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
    const flag = budgetFlags[stop.metric];
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

/** Own admission reservations and drain refusals without cancelling paid work. @internal */
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
    const usage = summarizeUsage(this.#record);
    const values: RunBudgetPolicy = {
      maxRunAgentAttempts: this.#attempts,
      maxRunCostUsd: (usage.costUsd ?? 0) + (usage.integrationUsage.costUsd ?? 0),
    };
    for (const metric of ['maxRunAgentAttempts', 'maxRunCostUsd'] as const) {
      const limit = this.#policy[metric];
      const observed = values[metric] ?? 0;
      if (limit === null || observed < limit) continue;
      return this.#latch({ stepId, metric, limit, observed, at: new Date().toISOString() });
    }
    const windowLimit = this.#policy.maxWindowUtilization ?? null;
    if (windowLimit === null) return undefined;
    // Per harness: a Codex admission is never refused by Claude's windows.
    const reports = latestRateLimits(Object.entries(this.#record.steps));
    const report = Object.hasOwn(reports, harness) ? reports[harness] : undefined;
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

  #latch(stop: RunBudgetStop): RunBudgetExceededError {
    this.#record.budgetStop = stop;
    this.#error = new RunBudgetExceededError(this.#record.id, stop, this.#wakeAt);
    // Only queued limiter requests listen to this signal. Active invocations keep their scope signal.
    this.#queued.abort(this.#error);
    return this.#error;
  }

  public enter(): () => void {
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
