import { isDeepStrictEqual } from 'node:util';
import { stepHarness } from '../runtime/harness-registry.js';
import { z } from 'zod';
import {
  parseHarnessFixtures,
  type FixtureExecCall,
  type HarnessFixtures,
} from '../../harnesses/fixture.js';
import type { ErrorKind, JsonValue } from '../runtime/model.js';
import { EXEC_SCHEMA_FAILURE_PREFIX, execExitFailureMessage } from '../runtime/exec.js';
import type { ExecSummary } from '../runtime/exec-model.js';
import { execResultSchema, execSummarySchema } from '../runtime/exec-schema.js';
import { RunRefusedError } from '../runtime/run-errors.js';
import type { RunRecord } from '../runtime/store.js';
import { stepErrorKind } from './failure-kind.js';

/**
 * Export saved agent outputs, settled agent failures, absorbed agent failures (steps left `failed`
 * in a completed run by a body try/catch or a settled map item), completed command results and
 * settled or absorbed command failures without importing source, taking ownership, or rewriting a
 * run. Agent failure rules carry the recorded message and, when the failure had a real category,
 * its `kind`. A command failure becomes an ordinary exec rule with its exit code and recorded output
 * tails when the result path can reproduce it (an exit code outside `okExitCodes`, or an `exec.json`
 * schema failure); spawn failures, timeouts, signal kills and output-limit failures get no rule
 * until exec error rules exist (#307), but still set `commands: 'fixture'`. No rule pins an
 * attempt. @internal
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
    // A command failure with no rule still sets it, so its replay fails at that step (#307).
    ...(exec.considered
      ? { ...(exec.rules.length ? { exec: exec.rules } : {}), commands: 'fixture' }
      : {}),
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
 * Exec rules for completed commands and for command failures the run settled or absorbed, in
 * execution order, keyed by full step ID, full argv and the recorded environment and stdin digests.
 * Environment values and stdin are never read. `considered` is whether the run has any such step,
 * including a failure that produced no rule: export then still sets `commands: 'fixture'`, so a
 * replay fails at that step instead of running the real command or synthesizing a success.
 */
function execFixtures(run: RunRecord): {
  readonly rules: FixtureExecCall[];
  readonly considered: boolean;
} {
  const steps = Object.entries(run.steps)
    .filter(
      ([, step]) =>
        step.kind === 'exec' &&
        step.exec !== undefined &&
        (step.status === 'completed' ||
          step.status === 'settled-failed' ||
          step.status === 'failed'),
    )
    .sort((a, b) => (a[1].seq ?? 0) - (b[1].seq ?? 0));
  const rules = steps.flatMap(([stepId, step]): FixtureExecCall[] => {
    const summary = execSummarySchema.parse(step.exec);
    const key = {
      step: stepId,
      ...(Array.isArray(summary.command)
        ? { argvPrefix: summary.command as readonly [string, ...string[]] }
        : {}),
      envSha256: summary.envSha256,
      inputSha256: summary.inputSha256,
    };
    if (step.status === 'settled-failed') {
      const error = step.settledError;
      const rule = error && execFailureRule(key, summary, error);
      return rule ? [rule] : [];
    }
    // A failure the workflow absorbed (try/catch, or a settled map item) leaves the step `failed`
    // in a completed run. The runner records its message in `error`, its kind in the last attempt
    // and its process fields in `execError`; a thrown ExecError keeps no `parsed` there.
    if (step.status === 'failed') {
      const kind = stepErrorKind(step);
      const rule =
        step.execError && kind !== null && step.error !== null
          ? execFailureRule(key, summary, { ...step.execError, kind, message: step.error })
          : undefined;
      return rule ? [rule] : [];
    }
    if (summary.structured) return [{ ...key, json: z.json().parse(step.output) }];
    const result = execResultSchema.parse(step.output);
    return [
      {
        ...key,
        stdout: result.stdout,
        ...(result.stderr === '' ? {} : { stderr: result.stderr }),
        ...(result.code === null || result.code === 0 ? {} : { code: result.code }),
      },
    ];
  });
  return { rules, considered: steps.length > 0 };
}

/** The recorded fields of a command failure that an exec rule can reproduce. */
interface ExecFailure {
  readonly message: string;
  readonly kind: ErrorKind;
  readonly code?: number | null | undefined;
  readonly signal?: string | null | undefined;
  readonly stdoutTail?: string | undefined;
  readonly stderrTail?: string | undefined;
  readonly parsed?: JsonValue | undefined;
}

/**
 * An exec rule that makes `executeCommand` fail the same way again, or undefined when the result
 * path cannot reproduce the failure. Only an exit code outside `okExitCodes` (kind `process`) and an
 * `exec.json` stdout that did not parse or match its schema (kind `schema`) qualify, both with a
 * real exit code and no signal. Spawn failures, timeouts, signal kills, `output-limit` and kinds
 * from a custom process runner need exec error rules (#307).
 *
 * The rule carries the code and the recorded output tails, which are all the workflow saw. When the
 * failure kept `parsed`, the rule uses `json: parsed` unless the tail is complete JSON that parses
 * to it in another layout (pretty-printed output under 1024 characters keeps its bytes), so a
 * truncated tail still reproduces `parsed`, and export, replay and export again give the same rule.
 */
function execFailureRule(
  key: Pick<FixtureExecCall, 'step' | 'argvPrefix' | 'envSha256' | 'inputSha256'>,
  summary: ExecSummary,
  failure: ExecFailure,
): FixtureExecCall | undefined {
  const { code, signal } = failure;
  if (
    signal !== null ||
    typeof code !== 'number' ||
    !Number.isInteger(code) ||
    code < 0 ||
    code > 255
  )
    return undefined;
  const reproducible =
    (failure.kind === 'process' && failure.message === execExitFailureMessage(String(code))) ||
    (failure.kind === 'schema' &&
      summary.structured &&
      failure.message.startsWith(EXEC_SCHEMA_FAILURE_PREFIX));
  if (!reproducible) return undefined;
  const stdout = failure.stdoutTail ?? '';
  const stderr = failure.stderrTail ?? '';
  const { parsed } = failure;
  const output =
    parsed !== undefined && (stdout === JSON.stringify(parsed) || !parsesTo(stdout, parsed))
      ? { json: parsed }
      : { stdout };
  return {
    ...key,
    ...output,
    ...(stderr === '' ? {} : { stderr }),
    ...(code === 0 ? {} : { code }),
  };
}

/** Whether text is JSON that parses to a value deep-equal to `value`; never throws. */
function parsesTo(text: string, value: JsonValue): boolean {
  try {
    return isDeepStrictEqual(JSON.parse(text), value);
  } catch {
    return false;
  }
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
