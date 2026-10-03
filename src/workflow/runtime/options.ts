import {
  commonControlFields,
  claudeControlFields,
  codexControlFields,
  validateExtraArgs,
  validateConfig,
  instructionConfig,
  validateClaudeSettings,
  rejectBypass,
} from './agent-controls.js';
import type { ClaudeOptions, CodexOptions } from './model.js';
import { z } from 'zod';

import { retryPolicySchema } from './policy.js';
import { environmentEdits } from './agent-environment.js';
import { resolveIsolation } from './agent-isolation.js';
import { rejectRenamedEffort } from './effort-compat.js';

const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const shared = {
  ...commonControlFields,
  prompt: z.string(),
  profile: z.string().min(1).optional(),
  onError: z.enum(['throw', 'return']).optional(),
  model: z.string().optional(),
  cwd: z.string().optional(),
  timeoutMs: positiveInteger.max(2_147_483_647, 'must not exceed 2147483647ms').optional(),
  idleTimeoutMs: positiveInteger.max(2_147_483_647, 'must not exceed 2147483647ms').optional(),
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

/**
 * Validate built-in Claude or Codex options with the same rules the runtime applies before a
 * checkpoint is created. Throws a descriptive error (redacting environment values) when invalid.
 * Pass `resolved: false` for authored options that profile defaults have not been merged into yet.
 */
export function validateAgentOptions(
  harness: 'claude' | 'codex',
  options: unknown,
  resolved = true,
): void {
  rejectRenamedEffort(`Invalid ${harness} options`, options);
  const result = (harness === 'claude' ? claudeOptionsSchema : codexOptionsSchema).safeParse(
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
    throw new Error(`Invalid ${harness} options: ${details.join('; ')}`);
  }
  const controls = options as ClaudeOptions & CodexOptions;
  environmentEdits(controls.env);
  const isolation = resolveIsolation(controls).isolation;
  validateExtraArgs(harness, controls.extraArgs ?? []);
  if (harness === 'codex') {
    if (
      controls.networkAccess !== undefined &&
      controls.sandbox !== 'workspace-write' &&
      (resolved || controls.sandbox !== undefined)
    )
      throw new Error('networkAccess requires sandbox workspace-write.');
    if (
      (resolved || controls.isolation === 'restricted') &&
      isolation === 'restricted' &&
      controls.harnessProfile !== undefined
    )
      throw new Error(
        'harnessProfile selects a Codex user-config profile, which restricted isolation skips; select inherit or use config.',
      );
    // inherit loads config.toml, which can carry its own instructions; a private home drops it.
    if (controls.instructions === 'none' && isolation === 'inherit')
      throw new Error(
        "instructions 'none' requires restricted isolation; inherit loads CODEX_HOME configuration.",
      );
    validateConfig(
      controls.config ?? {},
      controls.instructions === 'none' ? instructionConfig : {},
    );
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
