import { z } from 'zod';
import { codexEffortValues } from './agent-controls.js';
import type { ResolvedProfile, ProfileOverride } from './profiles-model.js';
import { retryOnSchema } from './step-error.js';

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
  on: z.array(retryOnSchema).optional(),
});
const limits = {
  timeoutMs: duration.optional(),
  maxTurns: positive.optional(),
  maxBudgetUsd: z.number().positive().optional(),
  retry: retryPolicySchema.optional(),
};
const effort = z.enum(codexEffortValues);
const streaming = {
  maxRetainedBytes: positive.max(2_147_483_647).optional(),
  maxStreamBytes: positive.optional(),
  maxTranscriptBytes: positive.min(128).optional(),
  transcripts: z.enum(['on', 'on-failure', 'off']).optional(),
};
/** Checkpoint and adapter policy validator. @internal */
export const executionPolicySchema = z.strictObject({
  ...limits,
  ...streaming,
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
    kind: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,31}$/u)
      .refine((name) => name !== 'sleep', 'Sleep does not accept execution overrides.')
      .optional(),
    maxOutputBytes: positive.max(2_147_483_647).optional(),
    ...streaming,
    ...limits,
    model: z.string().min(1).optional(),
    reasoningEffort: effort.optional(),
  })
  .superRefine((rule, context) => {
    const invalid =
      rule.kind === 'step'
        ? ['timeoutMs', 'maxTurns', 'maxBudgetUsd', 'model', 'reasoningEffort', 'maxOutputBytes']
        : rule.kind === 'exec'
          ? ['maxTurns', 'maxBudgetUsd', 'model', 'reasoningEffort']
          : rule.kind === 'codex'
            ? ['maxTurns', 'maxBudgetUsd']
            : rule.kind === 'claude'
              ? ['reasoningEffort']
              : [];
    if (rule.kind === 'step' || rule.kind === 'exec') invalid.push(...Object.keys(streaming));
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
  kind: string,
  callSite: {
    readonly [K in keyof Omit<PolicyOverride, 'match' | 'kind'>]?: PolicyOverride[K] | undefined;
  },
  defaults: ExecutionPolicy,
  overrides: readonly PolicyOverride[],
  matched: Set<number>,
  profile?: ResolvedProfile,
  profileOverrides: readonly ProfileOverride[] = [],
): AttemptPolicy {
  const agent = !['step', 'sleep', 'exec'].includes(kind);
  validateStepId(id);
  executionPolicySchema.parse(defaults);
  if (callSite.retry !== undefined && !retryPolicySchema.safeParse(callSite.retry).success)
    throw new Error(
      'Retry policy requires positive integer maxAttempts, a nonnegative finite delayMs, and valid error kinds in on.',
    );
  const policy: AttemptPolicy['policy'] = {
    retry: { maxAttempts: 1, delayMs: 100 },
  };
  const sources: Record<string, string> = {
    'retry.maxAttempts': 'runtime',
    'retry.delayMs': 'runtime',
  };
  if (agent) {
    Object.assign(policy, { transcripts: 'on', maxTranscriptBytes: 64 * 1024 * 1024 });
    sources['transcripts'] = 'runtime';
    sources['maxTranscriptBytes'] = 'runtime';
  }
  let requestedModel: string | null = null;
  let reasoningEffort: CodexOptions['reasoningEffort'] | null = null;
  const applicable = new Set<string>(['retry']);
  if (agent) {
    for (const key of [
      'timeoutMs',
      'model',
      'maxOutputBytes',
      'killGraceMs',
      'binary',
      ...Object.keys(streaming),
    ])
      applicable.add(key);
    for (const key of kind === 'codex' ? ['reasoningEffort'] : ['maxTurns', 'maxBudgetUsd'])
      applicable.add(key);
  }
  if (kind === 'exec') {
    applicable.add('timeoutMs');
    applicable.add('maxOutputBytes');
  }
  const apply = (
    values: {
      readonly [K in keyof (ExecutionPolicy & PolicyOverride)]?:
        (ExecutionPolicy & PolicyOverride)[K] | undefined;
    },
    source: string,
  ): void => {
    if (agent && values.maxOutputBytes !== undefined && values.maxRetainedBytes === undefined) {
      Object.assign(policy, { maxRetainedBytes: values.maxOutputBytes });
      sources['maxRetainedBytes'] = source;
    }
    for (const [key, value] of Object.entries(values) as [string, unknown][]) {
      if (value === undefined || !applicable.has(key)) continue;
      if (key === 'retry') {
        for (const [field, limit] of Object.entries(value as RetryPolicy) as [
          string,
          RetryPolicy[keyof RetryPolicy] | undefined,
        ][]) {
          if (limit === undefined) continue;
          Object.assign(policy.retry, { [field]: limit });
          sources[`retry.${field}`] = source;
        }
      } else {
        if (key === 'model') requestedModel = value as string;
        else if (key === 'reasoningEffort')
          reasoningEffort = value as CodexOptions['reasoningEffort'];
        else {
          Object.assign(policy, { [key]: value });
          if (key === 'maxRetainedBytes') {
            Object.assign(policy, { maxOutputBytes: value });
            sources['maxOutputBytes'] = source;
          }
        }
        sources[key] = source;
      }
    }
  };
  apply(defaults, kind === 'exec' ? 'runtime' : 'harness');
  if (profile) apply(profile, `profile:${profile.name}`);
  apply(callSite, 'call-site');
  if (profile)
    profileOverrides.forEach((rule, index) => {
      if (rule.profile === '*' || rule.profile === profile.name)
        apply(rule, `profile-override:${String(index)}`);
    });
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
  if (agent && policy.maxRetainedBytes !== undefined) {
    Object.assign(policy, { maxOutputBytes: policy.maxRetainedBytes });
    sources['maxOutputBytes'] = sources['maxRetainedBytes'] ?? 'harness';
  }
  return {
    policy,
    sources,
    requestedModel,
    reasoningEffort,
    ...(profile ? { profile: profile.name } : {}),
  };
}
