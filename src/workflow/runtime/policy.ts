import { z } from 'zod';

import type {
  AttemptPolicy,
  CodexOptions,
  ExecutionPolicy,
  PolicyOverride,
  RetryPolicy,
} from './model.js';
export type { AttemptPolicy, ExecutionPolicy, PolicyOverride } from './model.js';
import { jsonValue } from './json.js';
import { validateStepId } from './identity.js';

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const duration = positive.max(2_147_483_647);
/** Shared retry validation; defaults are resolved by the runtime. @internal */
export const retryPolicySchema = z.strictObject({
  maxAttempts: positive,
  delayMs: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});
const limits = {
  timeoutMs: duration.optional(),
  maxTurns: positive.optional(),
  maxBudgetUsd: z.number().positive().optional(),
  retry: retryPolicySchema.optional(),
};
const effort = z.enum(['minimal', 'low', 'medium', 'high']);
/** Checkpoint and adapter policy validator. @internal */
export const executionPolicySchema = z.strictObject({
  ...limits,
  maxOutputBytes: positive.optional(),
  killGraceMs: duration.optional(),
  binary: z.string().min(1).optional(),
});
/** Shared CLI, runtime, and checkpoint rule validator. @internal */
export const policyOverrideSchema = z
  .strictObject({
    match: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[a-zA-Z0-9_./:*-]+$/u)
      .optional(),
    kind: z.enum(['claude', 'codex', 'step']).optional(),
    ...limits,
    model: z.string().min(1).optional(),
    reasoningEffort: effort.optional(),
  })
  .superRefine((rule, context) => {
    const invalid =
      rule.kind === 'step'
        ? ['timeoutMs', 'maxTurns', 'maxBudgetUsd', 'model', 'reasoningEffort']
        : rule.kind === 'codex'
          ? ['maxTurns', 'maxBudgetUsd']
          : rule.kind === 'claude'
            ? ['reasoningEffort']
            : [];
    for (const key of invalid) {
      if (Reflect.get(rule, key) !== undefined)
        context.addIssue({
          code: 'custom',
          path: [key],
          message: `Does not apply to ${String(rule.kind)} steps`,
        });
    }
  });

/** Validate all rules before workflow effects, including authorization of model changes. @internal */
export function validatePolicy(value: unknown, allowModelOverride: boolean): PolicyOverride[] {
  const parsed = z.array(policyOverrideSchema).safeParse(jsonValue(value));
  if (!parsed.success) throw new Error(`Invalid execution policy: ${parsed.error.message}`);
  if (
    !allowModelOverride &&
    parsed.data.some((rule) => rule.model !== undefined || rule.reasoningEffort !== undefined)
  )
    throw new Error(
      'Model and reasoningEffort policy overrides require allowModelOverride (--allow-model-override).',
    );
  return parsed.data as PolicyOverride[];
}

/** Match a bounded step-ID glob shared by policy and fork invalidation. @internal */
export function matchesStepGlob(pattern: string, id: string): boolean {
  let expression = '^';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern.charAt(i);
    if (char === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') {
        expression += '(?:.*/)?';
        i++;
      } else expression += '.*';
    } else if (char === '*') expression += '[^/]*';
    else expression += char === '.' ? '\\.' : char;
  }
  return new RegExp(`${expression}$`, 'u').test(id);
}

/** Resolve policy without importing any adapter into the core. @internal */
export function resolvePolicy(
  id: string,
  kind: 'claude' | 'codex' | 'step' | 'sleep',
  callSite: Omit<PolicyOverride, 'match' | 'kind'>,
  defaults: ExecutionPolicy,
  overrides: readonly PolicyOverride[],
  matched: Set<number>,
): AttemptPolicy {
  validateStepId(id);
  executionPolicySchema.parse(defaults);
  if (callSite.retry !== undefined && !retryPolicySchema.safeParse(callSite.retry).success)
    throw new Error(
      'Retry policy requires positive integer maxAttempts and a nonnegative finite delayMs.',
    );
  const policy: ExecutionPolicy & { retry: Required<RetryPolicy> } = {
    retry: { maxAttempts: 1, delayMs: 100 },
  };
  const sources: Record<string, string> = {
    'retry.maxAttempts': 'runtime',
    'retry.delayMs': 'runtime',
  };
  let requestedModel: string | null = null;
  let reasoningEffort: CodexOptions['reasoningEffort'] | null = null;
  const applicable = new Set<string>(['retry']);
  if (kind === 'claude' || kind === 'codex') {
    for (const key of ['timeoutMs', 'model', 'maxOutputBytes', 'killGraceMs', 'binary'])
      applicable.add(key);
    for (const key of kind === 'claude' ? ['maxTurns', 'maxBudgetUsd'] : ['reasoningEffort'])
      applicable.add(key);
  }
  const apply = (values: ExecutionPolicy & PolicyOverride, source: string): void => {
    for (const [key, value] of Object.entries(values) as [string, unknown][]) {
      if (value === undefined || !applicable.has(key)) continue;
      if (key === 'retry') {
        for (const [field, limit] of Object.entries(value as RetryPolicy) as [
          string,
          number | undefined,
        ][]) {
          if (limit === undefined) continue;
          Object.assign(policy.retry, { [field]: limit });
          sources[`retry.${field}`] = source;
        }
      } else {
        if (key === 'model') requestedModel = value as string;
        else if (key === 'reasoningEffort')
          reasoningEffort = value as CodexOptions['reasoningEffort'];
        else Object.assign(policy, { [key]: value });
        sources[key] = source;
      }
    }
  };
  apply(defaults, 'harness');
  apply(callSite, 'call-site');
  if (kind !== 'sleep')
    overrides.forEach((rule, index) => {
      if (
        (rule.kind === undefined || rule.kind === kind) &&
        matchesStepGlob(rule.match ?? '**', id)
      ) {
        matched.add(index);
        apply(rule, `override:${String(index)}`);
      }
    });
  return { policy, sources, requestedModel, reasoningEffort };
}
