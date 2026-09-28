/** Disjoint token categories, except reasoning which is included in output. Null means unknown. */
export interface TokenCounts {
  /** Input outside the read/write cache categories, when the partition is known. */
  readonly uncachedInput: number | null;
  /** Input read from an existing cache. */
  readonly cacheRead: number | null;
  /** Input written to a cache. */
  readonly cacheWrite: number | null;
  /** All generated tokens, including reasoning. */
  readonly output: number | null;
  /** Reasoning tokens already included in output; never add them again. */
  readonly reasoning: number | null;
}

/** Usage attributed by the harness to one effective model; cost is an estimate. */
export interface ModelUsage extends TokenCounts {
  /** Harness-reported estimate, or null. */
  readonly costUsd: number | null;
}

/** Last durably known state of an agent attempt. */
export type AgentAttemptOutcome = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

/** Sums of reported values; unknown counts describe what these partial sums omit. */
export interface UsageTotals {
  /** Agent attempts in this group, counted once across replays. */
  readonly attempts: number;
  /** Attempts missing at least one of input, output, or cost. */
  readonly incompleteAttempts: number;
  /** Attempts for which no usage measurements were available. */
  readonly unknownUsageAttempts: number;
  /** Attempts without a reported cost; null is never interpreted as free. */
  readonly unknownCostAttempts: number;
  /** Last observed outcomes, including interrupted attempts recovered on resume. */
  readonly outcomes: Readonly<Record<AgentAttemptOutcome, number>>;
  /** Sum of known total-input measurements; null when all are unknown, zero for no attempts. */
  readonly inputTokens: number | null;
  /** Sum of known output measurements, including reasoning. */
  readonly outputTokens: number | null;
  /** Sum of reported estimates; not a bill or estimate for unknown attempts. */
  readonly costUsd: number | null;
  /** Independent sums of known categories; reasoning is already included in output. */
  readonly tokens: TokenCounts;
  /** Number of attempts missing each token category. */
  readonly unknownTokens: Readonly<Record<keyof TokenCounts, number>>;
}

/** Computed run-wide usage, never a separately persisted ledger or replay-sensitive effect. */
export interface UsageSummary extends UsageTotals {
  /** Local helper attempts with explicit usage reports, excluded from agent attempt counts. */
  readonly integrationUsage: UsageTotals;
  /** Reported local usage by StepDefinition.meta.integration (or local when unlabelled). */
  readonly byIntegration: Readonly<Record<string, UsageTotals>>;
  /** Groups by the harness on each attempt, including earlier redefined effects. */
  readonly byHarness: Readonly<Record<string, UsageTotals>>;
  /** Effective-model groups; the '(unknown)' bucket is never inferred from a requested alias. */
  readonly byModel: Readonly<Record<string, UsageTotals>>;
  /** Attempts reconstructed from older step counters, including any whose provider is unknown. */
  readonly legacyAttempts: number;
  /** Attempts with old token semantics, which cannot be safely reinterpreted. */
  readonly legacyTokenAttempts: number;
  /** Legacy fallback can omit work or spend which was never checkpointed. */
  readonly undercounted: boolean;
  /** Human explanations of legacy evidence and partial model attribution. */
  readonly warnings: readonly string[];
}
