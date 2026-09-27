import type { AgentUsage } from './model.js';
import type { RunRecord, StepRecord } from './record.js';
import { measurement, normalizeUsage, usageObject } from './usage.js';
import type { AgentAttemptOutcome, UsageTotals, UsageSummary, TokenCounts } from './usage-model.js';

interface Entry {
  readonly harness: string;
  readonly outcome: AgentAttemptOutcome;
  readonly usage: AgentUsage | null;
  readonly legacy: boolean;
}

function legacyUsage(step: StepRecord, attempt: number): AgentUsage | null {
  const failed = step.failedAttempts?.find((value) => value.attempt === attempt);
  if (failed) return failed.usage === null ? null : normalizeUsage(failed.usage);
  if (attempt !== step.attempts || step.status !== 'completed') return null;
  const usage = usageObject(step.output)?.['usage'];
  return usage == null ? null : normalizeUsage(usage);
}

/**
 * Kind under which a legacy attempt (no recorded request) ran, following redefinitions instead of
 * the latest kind. Undefined means ambiguous: an older runtime did not record the earlier kind or
 * how many attempts preceded the redefinition. @internal
 */
export function legacyAttemptKind(
  step: StepRecord,
  attempt: number,
): StepRecord['kind'] | undefined {
  for (const redefinition of step.redefinitions ?? []) {
    if (redefinition.attempts === undefined) return undefined;
    if (redefinition.attempts >= attempt) return redefinition.kind;
  }
  return step.kind;
}

function entries(run: RunRecord): { values: Entry[]; ambiguous: number } {
  const values: Entry[] = [];
  let ambiguous = 0;
  for (const step of Object.values(run.steps)) {
    if (step.reusedFrom) continue;
    const history = new Map(step.attemptHistory?.map((attempt) => [attempt.attempt, attempt]));
    for (let n = 1; n <= step.attempts; n++) {
      const attempt = history.get(n);
      let harness: string | undefined;
      if (attempt?.request) harness = attempt.request.harness;
      else if (attempt?.request === undefined) {
        const kind = legacyAttemptKind(step, n);
        // Possibly paid work of unknown harness: never charged, but reported as undercounting.
        if (kind === undefined) ambiguous++;
        else if (kind === 'claude' || kind === 'codex') harness = kind;
        else if (kind === 'agent') harness = step.harness;
      }
      if (!harness) continue;
      values.push({
        harness,
        outcome:
          attempt?.status ??
          (n === step.attempts && step.status === 'completed'
            ? 'completed'
            : step.failedAttempts?.some((entry) => entry.attempt === n)
              ? 'failed'
              : 'interrupted'),
        usage:
          attempt?.usage === undefined
            ? legacyUsage(step, n)
            : attempt.usage === null
              ? null
              : normalizeUsage(attempt.usage),
        legacy: attempt?.usage === undefined,
      });
    }
  }
  return { values, ambiguous };
}

const categories = ['uncachedInput', 'cacheRead', 'cacheWrite', 'output', 'reasoning'] as const;
function totals(values: readonly Entry[]): UsageTotals {
  const sum = (select: (usage: AgentUsage) => unknown): number | null => {
    const known = values.flatMap((entry) => {
      const value = entry.usage && measurement(select(entry.usage));
      return value === null ? [] : [value];
    });
    return known.length || values.length === 0
      ? measurement(known.reduce((total, value) => total + value, 0))
      : null;
  };
  const outcomes = { running: 0, completed: 0, failed: 0, cancelled: 0, interrupted: 0 };
  for (const entry of values) outcomes[entry.outcome]++;
  return {
    attempts: values.length,
    incompleteAttempts: values.filter(
      ({ usage }) =>
        usage?.inputTokens == null || usage.outputTokens === null || usage.costUsd === null,
    ).length,
    unknownUsageAttempts: values.filter(
      ({ usage }) => !usage || usage.completeness === 'unavailable',
    ).length,
    unknownCostAttempts: values.filter(({ usage }) => usage?.costUsd == null).length,
    outcomes,
    inputTokens: sum((usage) => usage.inputTokens),
    outputTokens: sum((usage) => usage.outputTokens),
    costUsd: sum((usage) => usage.costUsd),
    tokens: Object.fromEntries(
      categories.map((key) => [key, sum((usage) => usage.tokens?.[key])]),
    ) as unknown as TokenCounts,
    unknownTokens: Object.fromEntries(
      categories.map((key) => [
        key,
        values.filter(({ usage }) => usage?.tokens?.[key] == null).length,
      ]),
    ) as Record<keyof TokenCounts, number>,
  };
}

/**
 * Sum every locally recorded agent attempt once, including failures and earlier executions.
 * Fork-reused results are excluded. Unknown measurements remain explicit and legacy fallback warns.
 */
export function summarizeUsage(run: RunRecord): UsageSummary {
  const { values: all, ambiguous } = entries(run);
  const integrations = new Map<string, Entry[]>();
  for (const step of Object.values(run.steps)) {
    if (step.reusedFrom) continue;
    for (const attempt of step.attemptHistory ?? []) {
      if (!attempt.integration) continue;
      const group = integrations.get(attempt.integration) ?? [];
      group.push({
        harness: attempt.integration,
        outcome: attempt.status,
        usage: attempt.usage ?? null,
        legacy: false,
      });
      integrations.set(attempt.integration, group);
    }
  }
  const harnesses = new Map<string, Entry[]>();
  const models = new Map<string, Entry[]>();
  const add = (map: Map<string, Entry[]>, key: string, entry: Entry): void => {
    const list = map.get(key) ?? [];
    list.push(entry);
    map.set(key, list);
  };
  for (const entry of all) {
    add(harnesses, entry.harness, entry);
    const perModel = Object.entries(entry.usage?.byModel ?? {});
    if (perModel.length) {
      for (const [name, usage] of perModel)
        add(models, name, {
          ...entry,
          usage: normalizeUsage({
            inputTokens: [usage.uncachedInput, usage.cacheRead, usage.cacheWrite].every(
              (value) => value !== null,
            )
              ? (usage.uncachedInput ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
              : null,
            outputTokens: usage.output,
            costUsd: usage.costUsd,
            tokens: usage,
          }),
        });
    } else {
      const effective = entry.usage?.model?.effective;
      add(models, effective?.length === 1 ? (effective[0] ?? '(unknown)') : '(unknown)', entry);
    }
  }
  const legacyAttempts = all.filter((entry) => entry.legacy).length + ambiguous;
  const legacyTokenAttempts = all.filter(
    ({ usage }) =>
      usage && !usage.tokens && (usage.inputTokens !== null || usage.outputTokens !== null),
  ).length;
  return {
    ...totals(all),
    integrationUsage: totals([...integrations.values()].flat()),
    byIntegration: Object.fromEntries(
      [...integrations].map(([name, group]) => [name, totals(group)]),
    ),
    byHarness: Object.fromEntries([...harnesses].map(([name, group]) => [name, totals(group)])),
    byModel: Object.fromEntries([...models].map(([name, group]) => [name, totals(group)])),
    legacyAttempts,
    legacyTokenAttempts,
    undercounted: legacyAttempts > 0,
    warnings: [
      ...(legacyAttempts
        ? [
            'Legacy step counters cannot recover uncheckpointed attempts; reported totals may undercount.',
          ]
        : []),
      ...(legacyTokenAttempts
        ? [
            'Legacy token counts retain harness-specific semantics; they are not normalized session totals.',
          ]
        : []),
      ...(models.has('(unknown)')
        ? [
            'Some usage has no effective model identity; requested models are not assumed effective.',
          ]
        : []),
    ],
  };
}
