import { stepHarness } from '../runtime/harness-registry.js';
import { z } from 'zod';
import {
  parseHarnessFixtures,
  type FixtureExecCall,
  type HarnessFixtures,
} from '../../harnesses/fixture.js';
import type { ErrorKind } from '../runtime/model.js';
import { execResultSchema, execSummarySchema } from '../runtime/exec-schema.js';
import { RunRefusedError } from '../runtime/run-errors.js';
import type { RunRecord } from '../runtime/store.js';
import { stepErrorKind } from './failure-kind.js';

/**
 * Export saved agent outputs, settled agent failures, absorbed agent failures (steps left `failed`
 * in a completed run by a body try/catch or a settled map item) and completed command results
 * without importing source, taking ownership, or rewriting a run. Failure rules carry the recorded
 * message and, when the failure had a real category, its `kind`; they never pin an attempt. @internal
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
          (step.status === 'completed' ||
            step.status === 'settled-failed' ||
            step.status === 'failed'),
      )
      .sort((a, b) => (a[1].seq ?? 0) - (b[1].seq ?? 0))
      .map(([stepId, step]) => {
        if (step.status === 'settled-failed')
          return {
            step: stepId,
            harness: stepHarness(step),
            error: fixtureErrorText(
              stepId,
              step.settledError?.message,
              `Settled ${step.settledError?.kind ?? 'unknown'} failure`,
            ),
            ...exportedKind(step.settledError?.kind),
          };
        // A failure the workflow absorbed leaves the step `failed` in a completed run. It has no
        // settledError: the runner records the latest message in `error` and the kind in the last
        // attempt. The kind is exported like a settled failure's, so a replay takes the same
        // kind-based branch.
        if (step.status === 'failed')
          return {
            step: stepId,
            harness: stepHarness(step),
            error: fixtureErrorText(
              stepId,
              step.error,
              `Failed ${stepErrorKind(step) ?? 'unknown'} failure`,
            ),
            ...exportedKind(stepErrorKind(step)),
          };
        const data = result.parse(step.output);
        return { step: stepId, harness: stepHarness(step), output: data.output, usage: data.usage };
      }),
    // A recorded replay must never fall through to a real command when argv or digests drift.
    ...(exec.length ? { exec, commands: 'fixture' } : {}),
  });
}

/**
 * The optional `kind` field of an exported error rule. `unknown` is what a kindless failure records
 * and a kindless rule replays as `unknown`, so it is left out and kindless exports stay unchanged.
 * `cancelled` is left out too: a replayed `cancelled` HarnessError is fatal, so it would turn an
 * absorbed failure into one that is never retried or settled.
 *
 * A replayed rule always rejects with a `HarnessError` of the exported kind. Failures the runtime
 * classified from other error classes, such as local output validation (`schema`, which originally
 * threw `ZodError` or `SyntaxError`) or plain process or idle-timeout errors, therefore keep their
 * kind but not their error class. Reconstructing the class would need a `FixtureCall` /
 * `FixtureHarness` change, which is left to #147 and #309.
 */
function exportedKind(kind: ErrorKind | null | undefined): { readonly kind?: ErrorKind } {
  return kind === undefined || kind === null || kind === 'unknown' || kind === 'cancelled'
    ? {}
    : { kind };
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
 * The fixture error text for a settled or absorbed failure. FixtureHarness prefixes its rejections
 * with `Step <id>: `, so a message that already carries that prefix is exported without it, which
 * keeps export, replay and export stable. The text is never empty, as the fixture schema requires:
 * a missing, empty or prefix-only message uses `fallback`.
 */
function fixtureErrorText(
  stepId: string,
  message: string | null | undefined,
  fallback: string,
): string {
  const prefix = `Step ${stepId}: `;
  const full = message ?? '';
  const text = full.startsWith(prefix) ? full.slice(prefix.length) : full;
  return text.length > 0 ? text : fallback;
}
