import { z } from 'zod';
import { parseHarnessFixtures, type HarnessFixtures } from '../../harnesses/fixture.js';
import { RunRefusedError } from '../runtime/run-errors.js';
import type { RunRecord } from '../runtime/store.js';

/** Export saved agent outputs without importing source, taking ownership, or rewriting a run. @internal */
export function fixturesFromRun(run: RunRecord): HarnessFixtures {
  if (run.status !== 'completed')
    throw new RunRefusedError(
      'run.incompatible',
      run.id,
      'Fixture export requires a completed run.',
    );
  const result = z.object({
    output: z.json(),
    usage: z.object({
      inputTokens: z.number().nullable(),
      outputTokens: z.number().nullable(),
      costUsd: z.number().nullable(),
    }),
  });
  return parseHarnessFixtures({
    version: 1,
    unmatched: 'error',
    calls: Object.entries(run.steps)
      .filter(
        ([, step]) =>
          (step.kind === 'claude' || step.kind === 'codex') && step.status === 'completed',
      )
      .sort((a, b) => (a[1].seq ?? 0) - (b[1].seq ?? 0))
      .map(([stepId, step]) => {
        const data = result.parse(step.output);
        return { step: stepId, provider: step.kind, output: data.output, usage: data.usage };
      }),
  });
}
