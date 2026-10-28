// Pure presentation of an approved list: the SHA-256 of its sorted-key JSON, which the subject
// carries with the list itself, and details a human can read, bounded below the question limit
// with a marker when entries had to be left out.
import { createHash } from 'node:crypto';
import * as std from 'quiet-choir/std';
import type { AttackProbe, CriterionProbe } from './evidence.js';

/** Sorted keys at every depth, so the digest is the same whatever order a value's keys have. */
const sorted = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sorted)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, sorted((value as Record<string, unknown>)[key])]),
        )
      : value;

/** Details stay under the 16 KiB question limit with room for the truncation line. */
const LIMIT = 15_000;
const indent = (text: string) =>
  text
    .trimEnd()
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');

export function approvalOf<T>(list: readonly T[], header: string, render: (entry: T) => string) {
  const digest = createHash('sha256')
    .update(std.exec.json(sorted(list)))
    .digest('hex');
  let details = `${header}\nSHA-256 of the sorted-key JSON list in the subject: ${digest}`;
  let shown = 0;
  for (const entry of list) {
    const block = `\n\n${render(entry)}`;
    if (Buffer.byteLength(details + block) > LIMIT) break;
    details += block;
    shown += 1;
  }
  if (shown < list.length)
    details += `\n\nTruncated: ${shown} of ${list.length} entries shown; the question subject holds the full list (workflow pending --json).`;
  return { digest, details };
}

export const renderProbe = (entry: CriterionProbe) =>
  [
    `${entry.ticket}, criterion ${entry.position + 1}: ${entry.criterion}`,
    `Claim: ${entry.claim}`,
    indent(entry.probe),
  ].join('\n');

export const renderAttack = (entry: AttackProbe) =>
  [
    `${entry.ticket}, attack ${entry.attack + 1} (${entry.severity}): ${entry.description}`,
    indent(entry.probe),
  ].join('\n');
