import { retryPolicySchema } from '../workflow/runtime/policy.js';
import { agentWorktreeSchema } from '../workflow/runtime/agent-isolation.js';
import { z } from 'zod';
import type { AgentOptions } from '../workflow/runtime/model.js';
import type { HarnessCapabilities, HarnessDefinition } from '../workflow/runtime/harness-model.js';

/** Valid persisted names; package import paths and model-harness names are separate. */
export const harnessNameSchema: z.ZodString = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u);

/**
 * Define a strict, explicit agent integration without modifying the workflow runtime. A literal
 * `capabilityKeys` list is kept as a tuple type, so strict workflows reject those keys at call sites.
 * An omitted list, or explicit `<N, O, C>` type arguments, default `K` to the widened key list, which
 * forbids nothing at type level and leaves the check to the runtime.
 */
export function defineHarness<
  const N extends string,
  O extends AgentOptions,
  const C extends HarnessCapabilities,
  const K extends readonly (keyof O & string)[] = readonly (keyof O & string)[],
>(
  definition: HarnessDefinition<N, O, C, K>,
): HarnessDefinition<
  N,
  O &
    Pick<
      AgentOptions,
      'profile' | 'cwd' | 'onError' | 'retry' | 'timeoutMs' | 'worktree' | 'model'
    >,
  C,
  K
> {
  const metadata = z.strictObject({
    name: harnessNameSchema,
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    capabilities: z.strictObject({
      structuredOutput: z.enum(['native', 'prompted', 'none']),
      effort: z.array(z.string().min(1)).optional(),
      sandbox: z.boolean().optional(),
      sessionResume: z.boolean().optional(),
    }),
    policy: z.array(z.string().min(1)).optional(),
    capabilityKeys: z.array(z.string().min(1)).optional(),
  });
  metadata.parse({
    name: definition.name,
    revision: definition.revision,
    capabilities: definition.capabilities,
    ...(definition.policy === undefined ? {} : { policy: definition.policy }),
    ...(definition.capabilityKeys === undefined
      ? {}
      : { capabilityKeys: definition.capabilityKeys }),
  });
  if (!(definition.options instanceof z.ZodObject))
    throw new Error(`Harness ${definition.name} options must be a Zod object schema.`);
  for (const field of ['access', 'createAdapter', 'probe'] as const)
    if (definition[field] !== undefined && typeof definition[field] !== 'function')
      throw new Error(`Harness ${definition.name} ${field} must be a function.`);
  if (['step', 'sleep', 'exec'].includes(definition.name))
    throw new Error(`Reserved harness name: ${definition.name}.`);
  const runtimeOptions = {
    model: z.string().optional(),
    profile: z.string().min(1).optional(),
    cwd: z.string().optional(),
    onError: z.enum(['throw', 'return']).optional(),
    retry: retryPolicySchema.optional(),
    timeoutMs: z.number().int().positive().max(2_147_483_647).optional(),
    worktree: agentWorktreeSchema.optional(),
  };
  // Extend the author's schema, so object-level refinements survive; author fields keep precedence.
  const declared: Record<string, unknown> = definition.options.shape;
  const options = definition.options
    .safeExtend(
      Object.fromEntries(
        Object.entries(runtimeOptions).filter(([key]) => !Object.hasOwn(declared, key)),
      ),
    )
    .strict();
  const shape: Record<string, unknown> = options.shape;
  if (Object.hasOwn(shape, 'schema'))
    throw new Error(
      `Harness ${definition.name} schema is reserved for the client output contract.`,
    );
  if (!Object.hasOwn(shape, 'prompt'))
    throw new Error(`Harness ${definition.name} options must declare prompt.`);
  for (const key of [...(definition.policy ?? []), ...(definition.capabilityKeys ?? [])])
    if (!Object.hasOwn(shape, key))
      throw new Error(`Harness ${definition.name} refers to unknown option ${key}.`);
  if (definition.capabilityKeys?.includes('profile'))
    throw new Error(
      `Harness ${definition.name} capabilityKeys cannot include profile; profile selects a named profile.`,
    );
  for (const key of definition.policy ?? [])
    if (
      ['prompt', 'cwd', 'profile', 'worktree', 'isolation', 'env', 'model', 'onError'].includes(key)
    )
      throw new Error(`Harness ${definition.name} cannot exclude ${key} from identity.`);
  if (definition.policy?.some((key) => definition.capabilityKeys?.includes(key)))
    throw new Error(
      `Harness ${definition.name} capability controls cannot be excluded from identity.`,
    );
  return {
    ...definition,
    options: options as unknown as z.ZodType<
      O &
        Pick<
          AgentOptions,
          'profile' | 'cwd' | 'onError' | 'retry' | 'timeoutMs' | 'worktree' | 'model'
        >
    >,
  };
}
