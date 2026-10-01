import { stepHarness } from '../runtime/harness-registry.js';
import { z } from 'zod';
import { parseHarnessFixtures, type HarnessFixtures } from '../../harnesses/fixture.js';
import { RunRefusedError } from '../runtime/run-errors.js';
import type { RunRecord } from '../runtime/store.js';

/**
 * Export saved agent outputs and settled agent failures without importing source, taking ownership,
 * or rewriting a run. @internal
 */
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
          stepHarness(step) !== null &&
          (step.status === 'completed' || step.status === 'settled-failed'),
      )
      .sort((a, b) => (a[1].seq ?? 0) - (b[1].seq ?? 0))
      .map(([stepId, step]) => {
        if (step.status === 'settled-failed')
          return {
            step: stepId,
            harness: stepHarness(step),
            error: fixtureErrorText(stepId, step.settledError),
          };
        const data = result.parse(step.output);
        return { step: stepId, harness: stepHarness(step), output: data.output, usage: data.usage };
      }),
  });
}

/**
 * The fixture error text for a settled failure. FixtureHarness prefixes its rejections with
 * `Step <id>: `, so a message that already carries that prefix is exported without it, which keeps
 * export, replay and export stable. The text is never empty, as the fixture schema requires.
 */
function fixtureErrorText(
  stepId: string,
  settledError: { kind: string; message: string } | undefined,
): string {
  const prefix = `Step ${stepId}: `;
  const message = settledError?.message ?? '';
  const text = message.startsWith(prefix) ? message.slice(prefix.length) : message;
  return text.length > 0 ? text : `Settled ${settledError?.kind ?? 'unknown'} failure`;
}
