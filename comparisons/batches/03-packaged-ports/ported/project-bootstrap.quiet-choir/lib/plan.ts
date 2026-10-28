// Pure rules over the plan: a canonical digest that survives checkpoint key reordering, disjoint
// ownership, and a setter's receipt checked against the files its concern owns.
import { createHash } from 'node:crypto';
import type { JsonValue, WorktreeChange } from 'quiet-choir';
import type { ConcernPlan, Plan } from '../contracts.js';

/** Sorted-key JSON: checkpoint transport may reorder object keys, while array order is semantic. */
export function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key] ?? null)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** The SHA-256 a human approves and every setter receives. */
export const planDigest = (plan: Plan): string =>
  createHash('sha256').update(canonical(plan)).digest('hex');

/** Each concern appears once and no two concerns own the same file. */
export function checkPlan(plan: Plan): void {
  const names = plan.concerns.map((concern) => concern.name);
  const paths = plan.concerns.flatMap((concern) => concern.files);
  if (new Set(names).size !== names.length || new Set(paths).size !== paths.length)
    throw new Error('Plan requires unique concerns and disjoint file ownership');
}

/** A setter's isolated change, refused when it touched a file its concern does not own. */
export function ownedChange(change: WorktreeChange | undefined, concern: ConcernPlan) {
  if (!change) throw new Error('Setter did not produce an isolated receipt');
  const unexpected = change.files.filter(
    (file) => !concern.files.includes(file.path) || file.status === 'renamed',
  );
  if (unexpected.length)
    throw new Error(`Setter exceeded approved file ownership: ${JSON.stringify(unexpected)}`);
  return change;
}

/** A bounded preview for the approval question; the subject carries the whole plan. */
export const preview = (text: string): string =>
  Buffer.from(text).subarray(0, 15_000).toString('utf8');
