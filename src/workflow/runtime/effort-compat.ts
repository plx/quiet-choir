import type { z } from 'zod';

// Codex's reasoningEffort was renamed to effort (#341). Live inputs (call options, authored
// profiles and defaults, incoming policy rules) fail with a renamed message; persisted data written
// before the rename (attempt records, saved policy rules, capability manifests) reads the old key
// as effort. The checkpoint bytes themselves are never rewritten.

/** The Codex effort key used before #341. @internal */
export const legacyEffortKey = 'reasoningEffort';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The `codex` block of an authored profile or defaults object, when it has one. @internal */
export function codexBlock(value: unknown): unknown {
  return isRecord(value) ? value['codex'] : undefined;
}

/** Reject a live `reasoningEffort` with a message naming its replacement. @internal */
export function rejectRenamedEffort(where: string, value: unknown): void {
  if (isRecord(value) && Object.hasOwn(value, legacyEffortKey))
    throw new Error(
      `${where}: reasoningEffort was renamed to effort; use effort (accepts none/minimal/low/medium/high/xhigh/max).`,
    );
}

/**
 * Read view of persisted data: move a legacy `reasoningEffort` to `effort`, in place. Returns false
 * when both keys are present, which no runtime ever wrote. @internal
 */
export function renameLegacyEffort(value: unknown): boolean {
  if (!isRecord(value) || !Object.hasOwn(value, legacyEffortKey)) return true;
  if (Object.hasOwn(value, 'effort')) return false;
  const effort = value[legacyEffortKey];
  Reflect.deleteProperty(value, legacyEffortKey);
  Object.assign(value, { effort });
  return true;
}

/** A z.preprocess step for persisted data: a copy with `reasoningEffort` read as `effort`. @internal */
export function legacyEffort(value: unknown, context: z.core.$RefinementCtx): unknown {
  if (!isRecord(value) || !Object.hasOwn(value, legacyEffortKey)) return value;
  const copy = { ...value };
  if (!renameLegacyEffort(copy))
    context.addIssue({
      code: 'custom',
      message: 'Persisted data has both effort and legacy reasoningEffort; expected only one.',
      input: value,
    });
  return copy;
}
