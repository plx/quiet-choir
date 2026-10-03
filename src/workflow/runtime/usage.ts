import { z } from 'zod';
import type { AgentUsage, JsonValue } from './model.js';
import { jsonValue } from './json.js';

import type { TokenCounts } from './usage-model.js';

/** Return a finite, nonnegative number, or null so missing and invalid values stay unknown. */
export function measurement(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Return the value as a plain record, or undefined for arrays, null and non-objects. */
export function usageObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Normalize a token partition without inventing zeros. @internal */
export function tokenCounts(value: unknown): TokenCounts {
  const data = usageObject(value);
  return {
    uncachedInput: measurement(data?.['uncachedInput']),
    cacheRead: measurement(data?.['cacheRead']),
    cacheWrite: measurement(data?.['cacheWrite']),
    output: measurement(data?.['output']),
    reasoning: measurement(data?.['reasoning']),
  };
}

/** Sum measurements, returning null when the list is empty or any measurement is unknown. */
export function knownSum(values: readonly (number | null)[]): number | null {
  return values.length && values.every((value) => value !== null)
    ? measurement(values.reduce<number>((total, value) => total + value, 0))
    : null;
}

/**
 * Normalize harness-reported usage into {@link AgentUsage}, independently from effect identity.
 * JSON-compatible extra fields survive; malformed fields become null with a diagnostic. When
 * given, `requested` is recorded as `model.requested` in place of any value the harness reported.
 */
export function normalizeUsage(value: unknown, requested?: string | null): AgentUsage {
  const source = usageObject(value) ?? {};
  const data: Record<string, JsonValue> = {};
  const warnings: string[] = [];
  for (const [key, field] of Object.entries(source)) {
    if (field === undefined) continue;
    try {
      Object.defineProperty(data, key, {
        value: jsonValue(field, `Usage ${key}`, { canonical: false }),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    } catch {
      Object.defineProperty(data, key, {
        value: null,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      warnings.push(`Usage ${key} was not JSON-compatible; recorded as null.`);
    }
  }
  const metrics = {
    inputTokens: measurement(data['inputTokens']),
    outputTokens: measurement(data['outputTokens']),
    costUsd: measurement(data['costUsd']),
  };
  for (const field of ['inputTokens', 'outputTokens', 'costUsd'] as const)
    if (data[field] !== undefined && data[field] !== null && metrics[field] === null)
      warnings.push(`Usage ${field} was not a finite nonnegative number; recorded as null.`);
  const model = usageObject(data['model']);
  const effective = Array.isArray(model?.['effective'])
    ? model['effective'].filter((name): name is string => typeof name === 'string')
    : null;
  const byModel = usageObject(data['byModel']);
  const hasMeasurements =
    Object.values(metrics).some((metric) => metric !== null) ||
    Object.values(tokenCounts(data['tokens'])).some((metric) => metric !== null) ||
    Object.values(byModel ?? {}).some(
      (model) =>
        measurement(usageObject(model)?.['costUsd']) !== null ||
        Object.values(tokenCounts(model)).some((metric) => metric !== null),
    );
  return {
    ...data,
    ...metrics,
    ...(data['tokens'] === undefined
      ? {}
      : { tokens: { ...usageObject(data['tokens']), ...tokenCounts(data['tokens']) } }),
    ...(byModel === undefined
      ? {}
      : {
          byModel: Object.fromEntries(
            Object.entries(byModel).map(([name, raw]) => [
              name,
              {
                ...usageObject(raw),
                ...tokenCounts(raw),
                costUsd: measurement(usageObject(raw)?.['costUsd']),
              },
            ]),
          ),
        }),
    ...(requested === undefined && model === undefined
      ? {}
      : {
          model: {
            requested:
              requested === undefined
                ? typeof model?.['requested'] === 'string'
                  ? model['requested']
                  : null
                : requested,
            effective,
          },
        }),
    completeness: hasMeasurements ? 'reported' : 'unavailable',
    ...(warnings.length ? { normalizationWarnings: warnings } : {}),
  };
}

/** Frozen identity contract from before rich usage; never widen for diagnostic fields. @internal */
export const usageIdentitySchema = z.object({
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  costUsd: z.number().nullable(),
});

/** Runtime-only normalization; not converted to JSON Schema or hashed. @internal */
export const agentUsageSchema = z.unknown().transform((value) => normalizeUsage(value));
