import type { CliErrorCode } from '../workflow/runtime/run-errors.js';
import type { WorkflowFailure } from '../workflow/loader/failure.js';

/** The single numeric exit policy for workflow commands. Exit 75 is reserved for suspension. @internal */
export const workflowExitCodes = {
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

/** Render only observed checkpoint data; a refusal never invents a failed run. @internal */
export function workflowErrorDocument(failure: WorkflowFailure): object {
  return {
    kind: failure.kind,
    ok: false,
    exitCode: workflowExitCodes[failure.code],
    error: {
      code: failure.code,
      message: failure.message,
      stepId: failure.stepId,
      details: failure.details,
    },
    runId: failure.runId,
    stateDir: failure.stateDir,
    status: failure.run?.status ?? null,
    failedSteps: Object.entries(failure.run?.steps ?? {})
      .filter(([, step]) => step.status === 'failed' || step.status === 'cancelled')
      .map(([id, step]) => ({ id, kind: step.kind, attempts: step.attempts, error: step.error })),
    diagnostics: failure.diagnostics,
    run: failure.run,
  };
}

/** Detect the output request even when parsing the rest of argv fails. @internal */
export function requestedJson(argv: readonly string[]): boolean {
  const beforeSeparator = argv.indexOf('--');
  return argv.slice(0, beforeSeparator === -1 ? undefined : beforeSeparator).includes('--json');
}
