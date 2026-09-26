import { z } from 'zod';

import type { HarnessRequest } from './model.js';

const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const shared = {
  prompt: z.string(),
  model: z.string().optional(),
  cwd: z.string().optional(),
  timeoutMs: positiveInteger.max(2_147_483_647, 'must not exceed 2147483647ms').optional(),
};

/** Validate explicit Claude options without supplying CliHarness defaults. */
export const claudeOptionsSchema: z.ZodType = z.object({
  ...shared,
  tools: z.array(z.string()).optional(),
  allowedTools: z.array(z.string()).optional(),
  maxTurns: positiveInteger.optional(),
  maxBudgetUsd: z.number().positive().optional(),
});

/** Validate explicit Codex options without supplying CliHarness defaults. */
export const codexOptionsSchema: z.ZodType = z.object({
  ...shared,
  sandbox: z.enum(['read-only', 'workspace-write']).optional(),
  reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
  skipGitRepoCheck: z.boolean().optional(),
  structuredOutput: z.enum(['strict', 'compat']).optional(),
});

/** Shared validation used before checkpoint creation and before direct adapter invocations. @internal */
export function validateAgentOptions(provider: HarnessRequest['provider'], options: unknown): void {
  const result = (provider === 'claude' ? claudeOptionsSchema : codexOptionsSchema).safeParse(
    options,
  );
  if (!result.success) {
    const details = result.error.issues.map((issue) => {
      let value: unknown = options;
      for (const key of issue.path)
        value = value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined;
      const rendered = typeof value === 'string' ? JSON.stringify(value) : String(value);
      return `${issue.path.map(String).join('.') || 'options'}: ${issue.message} (got ${rendered})`;
    });
    throw new Error(`Invalid ${provider} options: ${details.join('; ')}`);
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
