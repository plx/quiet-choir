import { isDeepStrictEqual } from 'node:util';
import { stepHarness } from '../runtime/harness-registry.js';
import { z } from 'zod';
import { filtersMatch } from '../../harnesses/fixture-exec.js';
import {
  parseHarnessFixtures,
  type FixtureExecCall,
  type HarnessFixtures,
} from '../../harnesses/fixture.js';
import type { ErrorKind, JsonValue } from '../runtime/model.js';
import {
  EXEC_SCHEMA_FAILURE_PREFIX,
  SETTLED_PARSED_MAX_BYTES,
  execExitFailureMessage,
} from '../runtime/exec.js';
import { EXEC_TAIL_LIMIT } from '../runtime/exec-error.js';
import type { ExecSummary } from '../runtime/exec-model.js';
import { execResultSchema, execSummarySchema } from '../runtime/exec-schema.js';
import { RunRefusedError } from '../runtime/run-errors.js';
import type { InnerCommand, RunRecord, StepRecord } from '../runtime/store.js';
import { stepErrorKind } from './failure-kind.js';

/**
 * Export saved agent outputs, settled agent failures, absorbed agent failures (steps left `failed`
 * in a completed run by a body try/catch or a settled map item), completed command results and
 * settled or absorbed command failures without importing source, taking ownership, or rewriting a
 * run. Agent failure rules carry the recorded message and, when the failure had a real category,
 * its `kind`. A command failure becomes an ordinary exec rule with its exit code and recorded output
 * tails when the result path can reproduce it (an exit code outside `okExitCodes`, or an `exec.json`
 * schema failure); spawn failures, timeouts, signal kills and output-limit failures get no rule
 * (exec error rules can describe them by hand, but export does not produce them yet), but still set
 * `commands: 'fixture'`. Commands a step callback or a poll observer ran through `context.exec`
 * become exec rules keyed by the parent's ID, from the raw results recorded on the parent (a
 * step's latest settled attempt, a poll-completed wait's terminal observation), with `call` only
 * where the parent ran more than one command that meets the same filters or its recording omitted
 * later commands. No rule pins an attempt.
 * @internal
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
    // A command failure with no rule still sets it, so its replay fails at that step unless a hand-written exec error rule covers it.
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
 * Exec rules for completed commands, for command failures the run settled or absorbed, and for the
 * inner commands a step callback or poll observer ran through `context.exec`, in execution order
 * (a parent's inner rules sit at its position), keyed by full step ID (the parent's for an inner
 * command), full argv and the recorded environment and stdin digests. Environment values and stdin
 * are never read. `considered` is whether the run has any such step or parent, including a failure
 * or inner command that produced no rule: export then still sets `commands: 'fixture'`, so a
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
    .map(([stepId, step]) => ({ seq: step.seq ?? 0, rules: topLevelExecRules(stepId, step) }));
  const parents = Object.entries(run.steps)
    .filter(([, step]) => innerCommandsExported(step))
    .map(([stepId, step]) => ({
      seq: step.seq ?? 0,
      rules: innerExecRules(
        stepId,
        step.innerCommands?.commands ?? [],
        (step.innerCommands?.omitted ?? 0) > 0,
      ),
    }));
  const rules = [...steps, ...parents]
    .sort((a, b) => a.seq - b.seq)
    .flatMap((entry) => entry.rules);
  return { rules, considered: steps.length > 0 || parents.length > 0 };
}

/** The exec rule of one recorded `ctx.exec` step, or none when its failure cannot be reproduced. */
function topLevelExecRules(stepId: string, step: StepRecord): FixtureExecCall[] {
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
    const rule =
      error && execFailureRule(key, summary, { ...error, truncated: step.execError?.truncated });
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
}

/**
 * Whether a step's recorded inner commands are exported: a step that completed, settled a failure
 * or failed (a failure the workflow absorbed, in a completed run), or a wait a poll completed.
 * The record of a wait holds only its terminal observation's commands, so a wait that ended by
 * deadline or signal, a failed wait and an ask export nothing.
 */
function innerCommandsExported(step: StepRecord): boolean {
  const inner = step.innerCommands;
  if (!inner || (inner.commands.length === 0 && (inner.omitted ?? 0) === 0)) return false;
  if (step.kind === 'wait')
    return step.status === 'completed' && pollCompletion.safeParse(step.output).success;
  return (
    step.status === 'completed' || step.status === 'settled-failed' || step.status === 'failed'
  );
}
const pollCompletion = z.object({ by: z.literal('poll') });

/**
 * One exec rule per recorded inner command of `parentId` that a replay can reproduce, in recorded
 * order. A rule carries the raw result, so the replayed command goes through the same `okExitCodes`
 * and `exec.json` schema checks and succeeds or fails as it did. A command whose runner gave no
 * result (spawn failure, timeout, cancellation), or whose result had a signal, no exit code or
 * truncated output, gets no rule, because a replayed rule can carry none of those.
 *
 * A rule gets `call` only when another recorded command of the parent also meets its filters (the
 * same argv prefix, or any command for a `{ shell }` rule, with equal digests): it is then 1 plus
 * the number of earlier recorded commands that meet them, which is the call number exec fixture
 * rules count for it. A unique rule stays free of `call`, so it is robust to call counters that
 * restart in a new process. When the recording is incomplete (`incomplete`: the parent's later
 * commands were omitted by a bound), every rule carries `call`, since an omitted command may meet
 * the same filters: pinned, it then fails as unmatched instead of reusing a retained answer.
 */
function innerExecRules(
  parentId: string,
  commands: readonly InnerCommand[],
  incomplete: boolean,
): FixtureExecCall[] {
  return commands.flatMap((entry, index): FixtureExecCall[] => {
    const { result } = entry;
    if (
      result?.signal !== null ||
      result.code === null ||
      result.truncated ||
      result.code < 0 ||
      result.code > 255
    )
      return [];
    const key = {
      step: parentId,
      ...(Array.isArray(entry.command)
        ? { argvPrefix: entry.command as readonly [string, ...string[]] }
        : {}),
      envSha256: entry.envSha256,
      inputSha256: entry.inputSha256,
    };
    const meets = (other: InnerCommand): boolean =>
      filtersMatch(key, other.command, parentId, other.envSha256, other.inputSha256);
    const earlier = commands.slice(0, index).filter(meets).length;
    const shared =
      incomplete || commands.some((other, position) => position !== index && meets(other));
    return [
      {
        ...key,
        ...(shared ? { call: earlier + 1 } : {}),
        stdout: result.stdout,
        ...(result.stderr === '' ? {} : { stderr: result.stderr }),
        ...(result.code === 0 ? {} : { code: result.code }),
      },
    ];
  });
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
  /** Whether the runner cut the captured output; only an exit failure can record it. */
  readonly truncated?: boolean | undefined;
}

/**
 * An exec rule that makes `executeCommand` fail the same way again, or undefined when the result
 * path cannot reproduce the failure. Only an exit code outside `okExitCodes` (kind `process`) and an
 * `exec.json` stdout that did not parse or match its schema (kind `schema`) qualify, both with a
 * real exit code and no signal. Spawn failures, timeouts, signal kills, `output-limit` and kinds
 * from a custom process runner are not exported: exec error rules can describe them by hand, but
 * they carry no signal, output tails or exit code, and export does not produce them yet.
 *
 * The rule carries the code and the recorded output tails, which are all the workflow saw. When the
 * failure kept `parsed`, the rule uses `json: parsed` unless the tail is complete JSON that parses
 * to it in another layout (pretty-printed output under 1024 characters keeps its bytes), so a
 * truncated tail still reproduces `parsed`, and export, replay and export again give the same rule.
 *
 * An `exec.json` failure (kind `process` or `schema`) without `parsed` whose stdout tail fills the
 * tail bound (`EXEC_TAIL_LIMIT`) may have lost its start. For a `schema` failure the surviving
 * suffix can be valid JSON that matches the schema (an unparsable prefix, then more than 1024
 * whitespace characters, then good JSON), and for an exit failure it can be valid JSON that the
 * replay would record as an invented `parsed`. Either way the replay would differ from the source,
 * so no rule is exported and the replay fails at the step instead. A plain `exec` exit failure has
 * no `parsed` and is unaffected.
 *
 * `json: parsed` is replayed as compact JSON, and the runtime keeps `parsed` only when stdout is at
 * most `SETTLED_PARSED_MAX_BYTES` bytes. When the compact form of `parsed` is larger (such as `1e20`
 * values that print longer than they were written), the replay would lose `parsed`, so no rule is
 * exported.
 *
 * An `exec.json` exit failure whose capture was truncated also gets no rule: the runtime keeps no
 * `parsed` for a truncated capture, but a short tail can still be valid JSON that the replay would
 * record as an invented `parsed`. A schema failure cannot be truncated, so it is unaffected.
 *
 * Two more edges are lossy. Output reconstructed from `parsed` uses the checkpoint's sorted key
 * order, so a schema failure's message can list its issues in a different order than the original.
 * A replayed `ExecError` reports `truncated: false` and `durationMs: 0`.
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
  if (summary.structured && failure.truncated === true) return undefined;
  const stdout = failure.stdoutTail ?? '';
  const stderr = failure.stderrTail ?? '';
  const { parsed } = failure;
  if (summary.structured && parsed === undefined && stdout.length >= EXEC_TAIL_LIMIT)
    return undefined;
  let output: { json: JsonValue } | { stdout: string } = { stdout };
  if (parsed !== undefined && (stdout === JSON.stringify(parsed) || !parsesTo(stdout, parsed))) {
    if (Buffer.byteLength(JSON.stringify(parsed), 'utf8') > SETTLED_PARSED_MAX_BYTES)
      return undefined;
    output = { json: parsed };
  }
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
