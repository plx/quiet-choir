const durationUnits: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Milliseconds for a duration such as 540s, 9m, 250ms or 7d; NaN when the text is not one. Callers
 * apply their own range. @internal
 */
export function parseDuration(value: string): number {
  const match = /^([0-9]+(?:\.[0-9]+)?)(ms|s|m|h|d)$/u.exec(value);
  return match ? Number(match[1]) * (durationUnits[match[2] ?? ''] ?? NaN) : NaN;
}
