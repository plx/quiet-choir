import {
  commonControlFields,
  claudeControlFields,
  codexControlFields,
  validateExtraArgs,
  validateConfig,
  validateClaudeSettings,
  rejectBypass,
} from './agent-controls.js';
import type { ClaudeOptions, CodexOptions } from './model.js';
import { z } from 'zod';

import type { HarnessRequest } from './model.js';
import { retryPolicySchema } from './policy.js';
import { environmentEdits } from './agent-environment.js';
import { resolveIsolation } from './agent-isolation.js';

const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const shared = {
  ...commonControlFields,
  prompt: z.string(),
  profile: z.string().min(1).optional(),
  onError: z.enum(['throw', 'return']).optional(),
  model: z.string().optional(),
  cwd: z.string().optional(),
  timeoutMs: positiveInteger.max(2_147_483_647, 'must not exceed 2147483647ms').optional(),
  retry: retryPolicySchema.optional(),
};

/** Validate explicit Claude options without supplying CliHarness defaults. */
export const claudeOptionsSchema: z.ZodType = z.strictObject({
  ...shared,
  ...claudeControlFields,
  tools: z.array(z.string()).optional(),
  allowedTools: z.array(z.string()).optional(),
  maxTurns: positiveInteger.optional(),
  maxBudgetUsd: z.number().positive().optional(),
});

/** Validate explicit Codex options without supplying CliHarness defaults. */
export const codexOptionsSchema: z.ZodType = z.strictObject({
  ...shared,
  sandbox: z.enum(['read-only', 'workspace-write']).optional(),
  ...codexControlFields,
  skipGitRepoCheck: z.boolean().optional(),
  structuredOutput: z.enum(['strict', 'compat']).optional(),
});

/** Shared validation used before checkpoint creation and before direct adapter invocations. @internal */
export function validateAgentOptions(
  provider: HarnessRequest['provider'],
  options: unknown,
  resolved = true,
): void {
  const result = (provider === 'claude' ? claudeOptionsSchema : codexOptionsSchema).safeParse(
    options,
  );
  if (!result.success) {
    const details = result.error.issues.map((issue) => {
      const path = issue.path.map(String).join('.') || 'options';
      if (issue.code === 'unrecognized_keys')
        return `${path}: Unrecognized key(s) ${issue.keys.map((key) => JSON.stringify(key)).join(', ')}`;
      let value: unknown = options;
      for (const key of issue.path)
        value = value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined;
      const rendered =
        issue.path[0] === 'env'
          ? '<redacted>'
          : typeof value === 'string'
            ? JSON.stringify(value)
            : String(value);
      return `${path}: ${issue.message} (got ${rendered})`;
    });
    throw new Error(`Invalid ${provider} options: ${details.join('; ')}`);
  }
  const controls = options as ClaudeOptions & CodexOptions;
  environmentEdits(controls.env);
  const isolation = resolveIsolation(controls).isolation;
  validateExtraArgs(provider, controls.extraArgs ?? []);
  if (provider === 'codex') {
    if (controls.effort !== undefined && controls.reasoningEffort !== undefined)
      throw new Error('Set effort or reasoningEffort, never both.');
    if (
      controls.networkAccess !== undefined &&
      controls.sandbox !== 'workspace-write' &&
      (resolved || controls.sandbox !== undefined)
    )
      throw new Error('networkAccess requires sandbox workspace-write.');
    validateConfig(controls.config ?? {});
  } else {
    if (
      (resolved || controls.isolation === 'restricted') &&
      isolation === 'restricted' &&
      controls.strictMcpConfig === false
    )
      throw new Error(
        'restricted isolation requires strictMcpConfig; select inherit to load other MCP sources.',
      );
    validateClaudeSettings(controls.settings ?? {});
    rejectBypass(controls.agents ?? {});
    rejectBypass(controls.settings ?? {});
  }
}

/** Copy data descriptors while omitting undefined top-level options and the live output schema. @internal */
export function optionData(options: object, structured: boolean): object {
  const descriptors = Object.getOwnPropertyDescriptors(options);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor | undefined;
    if (
      (structured && key === 'schema') ||
      (descriptor && 'value' in descriptor && descriptor.value === undefined)
    )
      Reflect.deleteProperty(descriptors, key);
  }
  return Object.create(Object.getPrototypeOf(options) as object | null, descriptors) as object;
}
