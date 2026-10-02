import type { CliErrorCode } from '../workflow/runtime/run-errors.js';
import type { WorkflowFailure } from '../workflow/loader/failure.js';
import { summarizeRunResult } from '../workflow/loader/run-result.js';

/**
 * The single numeric exit policy for workflow commands. Exit 75 reports suspension outside this
 * failure table, and `inspect --watch` takes its snapshot exits from `watchExitCodes`. The watch
 * bounds use 79 (the first exit after the sysexits block, free in sh, Node, timeout(1) and xargs)
 * and 66 (EX_NOINPUT: the record the watch reads never appeared). @internal
 */
export const workflowExitCodes = {
  'answer.invalid': 2,
  'answer.conflict': 3,
  'usage.flag': 2,
  'usage.file_not_found': 2,
  'usage.entrypoint': 2,
  'usage.run_id': 2,
  'usage.input_json': 2,
  'usage.input_file': 2,
  'usage.input_schema': 2,
  'usage.resume_requires_run_id': 2,
  'run.exists': 3,
  'run.not_found': 3,
  'run.locked': 3,
  'run.incompatible': 3,
  'run.input_changed': 3,
  'run.unreadable': 3,
  'run.orphans': 3,
  'load.typecheck': 4,
  'load.import': 4,
  'load.definition': 4,
  'workflow.failed': 1,
  'workflow.interrupted': 130,
  'workflow.storage': 74,
  'start.timeout': 124,
  'start.exited': 70,
  'watch.timeout': 79,
  'watch.record_not_created': 66,
} as const satisfies Record<CliErrorCode, number>;

/** A CLI-local carrier for an executor's plain-data failure. @internal */
export class WorkflowCommandError extends Error {
  public constructor(
    public readonly failure: WorkflowFailure,
    public readonly humanExitOnly = false,
  ) {
    super(failure.message);
    this.name = 'WorkflowCommandError';
  }
}

/**
 * Render only observed checkpoint data; a refusal never invents a failed run. With `compact`, a
 * failure without a rehearsal carries a bounded `summary` instead of the whole `run` record.
 * @internal
 */
export function workflowErrorDocument(
  failure: WorkflowFailure,
  options: { readonly compact?: boolean } = {},
): object {
  const compact = options.compact === true && failure.rehearsal === undefined;
  return {
    kind: failure.kind,
    ok: false,
    exitCode: workflowExitCodes[failure.code],
    error: {
      code: failure.code,
      message: failure.message,
      stepId: failure.stepId,
      details: failure.details,
      ...(failure.stack === undefined ? {} : { stack: failure.stack }),
    },
    runId: failure.runId,
    stateDir: failure.stateDir,
    status: failure.run?.status ?? null,
    failedSteps: Object.entries(failure.run?.steps ?? {})
      .filter(([, step]) => step.status === 'failed' || step.status === 'cancelled')
      .map(([id, step]) => ({ id, kind: step.kind, attempts: step.attempts, error: step.error })),
    diagnostics: failure.diagnostics,
    next: failure.next ?? [],
    ...(compact
      ? { summary: failure.run && summarizeRunResult(failure.run, failure.stateDir) }
      : { run: failure.run }),
    ...(failure.rehearsal === undefined ? {} : { rehearsal: failure.rehearsal }),
    ...(failure.launch === undefined ? {} : { launch: failure.launch }),
  };
}

/** Detect the output request even when parsing the rest of argv fails. @internal */
export function requestedJson(argv: readonly string[]): boolean {
  const beforeSeparator = argv.indexOf('--');
  return argv
    .slice(0, beforeSeparator === -1 ? undefined : beforeSeparator)
    .some((arg) => arg === '--json' || arg.startsWith('--json='));
}

/**
 * Detect `--events -` or `--events=-` before a literal `--`, even when parsing the rest of argv
 * fails: stdout then carries only event lines. A path that merely starts with `-` does not count.
 * @internal
 */
export function requestedEventsStdout(argv: readonly string[]): boolean {
  const beforeSeparator = argv.indexOf('--');
  const args = argv.slice(0, beforeSeparator === -1 ? undefined : beforeSeparator);
  return args.some(
    (arg, index) => arg === '--events=-' || (arg === '--events' && args[index + 1] === '-'),
  );
}

/** Detect `--full` even when parsing the rest of argv fails. @internal */
export function requestedFull(argv: readonly string[]): boolean {
  const beforeSeparator = argv.indexOf('--');
  return argv.slice(0, beforeSeparator === -1 ? undefined : beforeSeparator).includes('--full');
}
