import { stepHarness } from '../runtime/harness-registry.js';
import { z } from 'zod';
import {
  parseHarnessFixtures,
  type FixtureExecCall,
  type HarnessFixtures,
} from '../../harnesses/fixture.js';
import { execResultSchema, execSummarySchema } from '../runtime/exec-schema.js';
import { RunRefusedError } from '../runtime/run-errors.js';
import type { RunRecord } from '../runtime/store.js';

/**
 * Export saved agent outputs, settled agent failures and completed command results without
 * importing source, taking ownership, or rewriting a run. @internal
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
  const exec = execFixtures(run);
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
    // A recorded replay must never fall through to a real command when argv or digests drift.
    ...(exec.length ? { exec, commands: 'fixture' } : {}),
  });
}

/**
 * Exec rules for completed commands in execution order, keyed by full step ID, full argv and the
 * recorded environment and stdin digests. Environment values and stdin are never read.
 */
function execFixtures(run: RunRecord): FixtureExecCall[] {
  return Object.entries(run.steps)
    .filter(([, step]) => step.kind === 'exec' && step.status === 'completed' && step.exec)
    .sort((a, b) => (a[1].seq ?? 0) - (b[1].seq ?? 0))
    .map(([stepId, step]): FixtureExecCall => {
      const summary = execSummarySchema.parse(step.exec);
      const key = {
        step: stepId,
        ...(Array.isArray(summary.command)
          ? { argvPrefix: summary.command as readonly [string, ...string[]] }
          : {}),
        envSha256: summary.envSha256,
        inputSha256: summary.inputSha256,
      };
      if (summary.structured) return { ...key, json: z.json().parse(step.output) };
      const result = execResultSchema.parse(step.output);
      return {
        ...key,
        stdout: result.stdout,
        ...(result.stderr === '' ? {} : { stderr: result.stderr }),
        ...(result.code === null || result.code === 0 ? {} : { code: result.code }),
      };
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
