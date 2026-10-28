// Data contracts: the input and output schemas and the structured agent results.
import { z } from 'quiet-choir';

export const Sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
export const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const Path = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      value
        .split('/')
        .every((part) => part !== '..' && part !== '.' && part !== '' && part !== '.git') &&
      !value.includes('\0'),
    'Use a repository-relative path without dot segments or .git',
  );
export const Argv = z.tuple([z.string().min(1)]).rest(z.string());

export const Concern = z.enum(['foundation', 'tooling', 'tests', 'ci', 'docs']);
export type Concern = z.infer<typeof Concern>;
const ConcernPlan = z.object({
  name: Concern,
  detail: z.string().min(1),
  files: z.array(Path).min(1).max(30),
});
export type ConcernPlan = z.infer<typeof ConcernPlan>;
export const Plan = z.object({
  concerns: z.array(ConcernPlan).min(1).max(5),
  verifyCommands: z.array(Argv).min(1).max(8),
});
export type Plan = z.infer<typeof Plan>;
/** The planner may only plan the concerns the operator allowed, each at most once. */
export const PlanFor = (allowed: Concern[]) =>
  Plan.extend({
    concerns: z
      .array(ConcernPlan.extend({ name: z.enum(allowed) }))
      .min(1)
      .max(allowed.length),
  });

export const Detected = z.object({
  stack: z.string().min(1).describe('The chosen or detected stack, with versions where knowable'),
  existing: z.array(z.string()).describe('Tooling already present, which setup must not clobber'),
  missing: z.array(Concern),
});
export const Applied = z.object({ summary: z.string() });

export const Check = z.object({
  argv: Argv,
  code: z.number().int().nullable(),
  truncated: z.boolean().nullable(),
  failure: z.string().nullable(),
});
export type Check = z.infer<typeof Check>;

export const BootstrapInput = z.object({
  spec: z
    .string()
    .min(1)
    .describe('Project specification or a repository-relative specification path'),
  stack: z.string().min(1).optional().describe('Stack to use instead of detecting one'),
  concerns: z
    .array(Concern)
    .min(1)
    .max(5)
    .default(['foundation', 'tooling', 'tests', 'ci', 'docs']),
});

export const BootstrapOutput = z.object({
  status: z.enum(['declined', 'verification-failed', 'applied']),
  stack: z.string(),
  plan: Plan,
  approvedDigest: Digest,
  appliedDigest: Digest.nullable(),
  commit: Sha.nullable(),
  verification: z.array(Check),
});
