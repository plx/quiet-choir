// Pure rules: merging the modalities' candidates, the cross-check cap, the approved digest and the
// remover's file ownership.
import { createHash } from 'node:crypto';
import type { WorktreeChange } from 'quiet-choir';
import type { Candidate, Swept } from '../contracts.js';

const keyOf = (candidate: Candidate) => `${candidate.file}::${candidate.identifier}`;

/** One entry per file and identifier, counting the modalities that found it. */
export function merge(found: Candidate[][]): Swept[] {
  const byKey = new Map<string, Swept>();
  for (const candidates of found)
    for (const candidate of new Map(candidates.map((c) => [keyOf(c), c])).values()) {
      const previous = byKey.get(keyOf(candidate));
      byKey.set(keyOf(candidate), {
        ...(previous ?? candidate),
        modalities: (previous?.modalities ?? 0) + 1,
      });
    }
  return [...byKey.values()];
}

/** Corroborated candidates win the cross-check slots; the rest are reported, never dropped. */
export function cap(candidates: Swept[], max: number) {
  const ordered = [
    ...candidates.filter((candidate) => candidate.modalities > 1),
    ...candidates.filter((candidate) => candidate.modalities === 1),
  ];
  return { checked: ordered.slice(0, max), unchecked: ordered.slice(max) };
}

/** The SHA-256 of the approved list, in the order the remover receives it. */
export const listDigest = (list: string): string => createHash('sha256').update(list).digest('hex');

/** The remover's change, refused when it touched a file that holds no approved candidate. */
export function ownedChange(change: WorktreeChange | undefined, approved: Swept[]) {
  if (!change) throw new Error('Remover did not produce an isolated receipt');
  const files = new Set(approved.map((candidate) => candidate.file));
  const unexpected = change.files.filter(
    (file) => !files.has(file.path) || file.status === 'renamed',
  );
  if (unexpected.length)
    throw new Error(`Remover exceeded the approved list: ${JSON.stringify(unexpected)}`);
  return change;
}

/** A bounded preview for the approval question; the subject carries the whole list. */
export const preview = (text: string): string =>
  Buffer.from(text).subarray(0, 15_000).toString('utf8');
