import { worktreeHandleSchema } from './worktree-schema.js';
import { z } from 'zod';
import { retryPolicySchema } from './policy.js';

const argument = z.string().refine((value) => !value.includes('\0'), 'NUL is not allowed');
/** @internal */
export const commandSchema = z.union([
  z.tuple([argument.min(1)], argument),
  z.strictObject({ shell: argument.min(1) }),
]);
/** @internal */
export const execOptionsSchema = z.strictObject({
  worktree: worktreeHandleSchema.optional(),
  cwd: argument.min(1).optional(),
  env: z
    .record(
      argument
        .min(1)
        .refine(
          (key) => !key.includes('=') && !key.startsWith('QUIET_CHOIR_'),
          'Invalid or reserved environment key',
        ),
      argument,
    )
    .optional(),
  inheritEnv: z.boolean().optional(),
  input: z.string().optional(),
  okExitCodes: z
    .union([z.literal('any'), z.array(z.number().int().min(0).max(255)).min(1)])
    .optional(),
  timeoutMs: z.number().int().positive().max(2_147_483_647).optional(),
  maxOutputBytes: z.number().int().positive().max(2_147_483_647).optional(),
  retry: retryPolicySchema.optional(),
  onError: z.enum(['throw', 'return']).optional(),
  meta: z.record(z.string(), z.json()).optional(),
});
/** Options of a step callback's `context.exec`: no worktree, retry or meta. @internal */
export const stepExecOptionsSchema = execOptionsSchema.omit({
  worktree: true,
  retry: true,
  meta: true,
});
/** Options of a poll observer's `context.exec`, which may also ask for a live run. @internal */
export const pollExecOptionsSchema = stepExecOptionsSchema.extend({
  live: z.boolean().optional(),
});
/** @internal */
export const execResultSchema = z.object({
  code: z.number().int().nullable(),
  signal: z.string().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  durationMs: z.number().nonnegative(),
});
/** @internal */
export const execSummarySchema = z.object({
  command: commandSchema,
  cwd: z.string(),
  envSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  inheritEnv: z.boolean(),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  okExitCodes: z.union([z.literal('any'), z.array(z.number().int())]),
  structured: z.boolean(),
});
/** @internal */
export const execDiagnosticsSchema = z.object({
  code: z.number().int().nullable(),
  signal: z.string().nullable(),
  stdoutTail: z.string().max(1024),
  stderrTail: z.string().max(1024),
  truncated: z.boolean(),
  durationMs: z.number().nonnegative(),
});
