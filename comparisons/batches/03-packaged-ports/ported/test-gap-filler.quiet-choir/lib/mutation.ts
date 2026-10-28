// The mutation mechanics: pure checks on the proposed mutants, and one managed process per mutant
// that heals an interrupted attempt, mutates, runs the test and restores.
import { readFileSync } from 'node:fs';
import type { WorkflowContext } from 'quiet-choir';
import { MutationResult, type Gap, type Mutant } from '../contracts.js';

/**
 * The worker's text, passed with `node -e` so it is part of every check's command identity, as a
 * prompt is part of an agent call's. The file is also in the package fingerprint.
 */
const worker = readFileSync(new URL('../resources/mutation-worker.mjs', import.meta.url), 'utf8');

/** Gaps found by both lenses once, first reason kept. */
export const uniqueGaps = (gaps: Gap[]): Gap[] => [
  ...new Map(gaps.map((gap) => [gap.key, gap])).values(),
];

/** Every mutant has a unique ID and replaces exactly one occurrence with different text. */
export function checkMutants(mutants: Mutant[], pristine: string): void {
  if (new Set(mutants.map((mutant) => mutant.id)).size !== mutants.length)
    throw new Error('Mutant IDs must be unique');
  for (const mutant of mutants)
    if (mutant.before === mutant.after || pristine.split(mutant.before).length !== 2)
      throw new Error(`Invalid mutation anchor: ${mutant.id}`);
}

/** Run one mutant against the operator's test command; the step ID is `check`. */
export const checkMutant = (
  ctx: WorkflowContext,
  request: {
    file: string;
    pristine: string;
    sha256: string;
    mutant: Mutant;
    argv: readonly string[];
  },
) =>
  ctx.exec.json('check', [process.execPath, '--input-type=module', '-e', worker], {
    schema: MutationResult,
    input: JSON.stringify(request),
  });
