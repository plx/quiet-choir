import { z } from 'zod';
import { digest } from './json.js';

import type {
  AgentEnvironment,
  EnvironmentEdits,
  EnvironmentSummary,
} from './agent-environment-model.js';

const name = z
  .string()
  .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/u)
  .refine(
    (key) =>
      ![
        'QUIET_CHOIR_RUN_ID',
        'QUIET_CHOIR_STEP_ID',
        'QUIET_CHOIR_ATTEMPT',
        'QUIET_CHOIR_IDEMPOTENCY_KEY',
      ].includes(key.toUpperCase()),
    'Reserved engine environment name',
  );
const values = z.record(
  name,
  z.string().refine((value) => !value.includes('\0'), 'NUL is unsupported'),
);
/** Shared call/profile environment validator. @internal */
export const agentEnvironmentSchema = z.preprocess(
  (value, context) => {
    // Zod records omit __proto__; reject it before parsing so edits cannot disappear silently.
    if (value !== null && typeof value === 'object') {
      const set: unknown = Reflect.get(value, 'set');
      if (
        Object.hasOwn(value, '__proto__') ||
        (set !== null && typeof set === 'object' && Object.hasOwn(set, '__proto__'))
      )
        context.addIssue({ code: 'custom', message: 'Unsupported environment name __proto__.' });
    }
    return value;
  },
  z.union([z.strictObject({ set: values.optional(), unset: z.array(name).optional() }), values]),
);

/**
 * Normalize either public {@link AgentEnvironment} form into sorted `set` values and `unset` names,
 * without reading the host environment. Throws on reserved or invalid names, NUL values, or a name
 * that is both set and unset.
 */
export function environmentEdits(value: AgentEnvironment | undefined): {
  /** Values to set, sorted by name. */
  set: Record<string, string>;
  /** Names to remove, sorted and deduplicated. */
  unset: string[];
} {
  const parsed = agentEnvironmentSchema.parse(value ?? {});
  const structured = typeof parsed.set === 'object' || Array.isArray(parsed.unset);
  const edits = structured
    ? (parsed as EnvironmentEdits)
    : { set: parsed as Record<string, string> };
  const set = Object.fromEntries(
    Object.entries(edits.set ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  );
  const unset = [...new Set(edits.unset ?? [])].sort();
  if (unset.some((key) => Object.hasOwn(set, key)))
    throw new Error('An environment name cannot appear in both set and unset.');
  return { set, unset };
}

/** Public diagnostics for explicit edits, independent of inherited credentials. @internal */
export function environmentSummary(value: AgentEnvironment | undefined): EnvironmentSummary {
  const edits = environmentEdits(value);
  return { sha256: digest(edits), set: Object.keys(edits.set), unset: edits.unset };
}

/** Persisted explicit environment diagnostics. @internal */
export const environmentSummarySchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  set: z.array(z.string()),
  unset: z.array(z.string()),
});
/** Persisted host names, never host values. @internal */
export const hostEnvironmentSummarySchema = z.object({
  variables: z.array(z.string()),
  scrubbed: z.array(z.string()),
});
