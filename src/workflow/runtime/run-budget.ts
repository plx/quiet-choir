import { brandError, isBranded } from './error-brand.js';
import { z } from 'zod';
import type { RunRecord } from './record.js';
import { summarizeUsage } from './usage-summary.js';

/** Sticky operator limits, outside workflow and effect identity. Null means unlimited. */
export interface RunBudgetPolicy {
  /** Stop new agent attempts after this much reported cost; already admitted calls may overshoot. */
  readonly maxRunCostUsd: number | null;
  /** Maximum locally admitted agent attempts across all executions, including unknown usage. */
  readonly maxRunAgentAttempts: number | null;
}

/** Saved explanation of the most recent operator stop; cleared when a new execution starts. */
export interface RunBudgetStop {
  /** Agent effect which was refused, without adding a new attempt. */
  readonly stepId: string;
  /** Limit that prevented admission. */
  readonly metric: keyof RunBudgetPolicy;
  /** Configured threshold. */
  readonly limit: number;
  /** Reported cost or admitted attempt count at refusal. */
  readonly observed: number;
  /** Refusal timestamp, not an estimate of when spending crossed the threshold. */
  readonly at: string;
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

  /** Construct an actionable refusal without implying a hard billing ceiling. */
  public constructor(runId: string, stop: RunBudgetStop) {
    const flag =
      stop.metric === 'maxRunCostUsd' ? '--max-run-cost-usd' : '--max-run-agent-attempts';
    super(
      `Run ${runId}: ${stop.metric} limit ${String(stop.limit)} reached (${String(stop.observed)} recorded); refused agent step ${stop.stepId}. Active attempts were allowed to finish. Resume with a higher ${flag} value or ${flag} off; completed calls replay without new spend.`,
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
});

/** Own admission reservations and drain refusals without cancelling paid work. @internal */
export class RunBudget {
  readonly #record: RunRecord;
  readonly #policy: RunBudgetPolicy;
  readonly #queued = new AbortController();
  readonly #idle = new Set<() => void>();
  #attempts: number;
  #active = 0;
  #error: RunBudgetExceededError | undefined;

  public constructor(record: RunRecord, policy: RunBudgetPolicy) {
    this.#record = record;
    this.#policy = policy;
    this.#attempts = summarizeUsage(record).attempts;
  }
  public get enabled(): boolean {
    return this.#policy.maxRunCostUsd !== null || this.#policy.maxRunAgentAttempts !== null;
  }
  public get signal(): AbortSignal {
    return this.#queued.signal;
  }
  public get error(): RunBudgetExceededError | undefined {
    return this.#error;
  }

  public check(stepId: string): RunBudgetExceededError | undefined {
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
      const stop: RunBudgetStop = { stepId, metric, limit, observed, at: new Date().toISOString() };
      this.#record.budgetStop = stop;
      this.#error = new RunBudgetExceededError(this.#record.id, stop);
      // Only queued limiter requests listen to this signal. Active invocations keep their scope signal.
      this.#queued.abort(this.#error);
      return this.#error;
    }
    return undefined;
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
