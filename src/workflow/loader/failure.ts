import type { NextCommand } from './next-commands.js';
import type { RehearsalReport } from './rehearsal.js';
import type { CliErrorCode } from '../runtime/run-errors.js';
import type { JsonValue } from '../runtime/model.js';
import type { RunRecord } from '../runtime/store.js';
import type { TypecheckDiagnostic } from '../typecheck/model.js';

/**
 * What a failed `workflow start` attempted: the run ID it passed to the runner (also when the
 * failure's top-level `runId` is null because no record exists), the runner's PID (null when it
 * never spawned), the absolute paths of its log (stderr) and result document (stdout), and how it
 * exited (null while it was still running when start gave up). @internal
 */
export interface StartLaunchEvidence {
  readonly runId: string;
  readonly pid: number | null;
  readonly log: string;
  readonly result: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
}

/** Plain-data failure context; rendering and numeric exit policy belong to the CLI. */
export interface WorkflowFailure {
  readonly kind: 'workflow.error';
  readonly rehearsal?: RehearsalReport;
  readonly stack?: string;
  readonly ok: false;
  readonly code: CliErrorCode;
  readonly message: string;
  readonly details: JsonValue;
  readonly stepId: string | null;
  readonly runId: string | null;
  readonly stateDir: string | null;
  readonly run: RunRecord | null;
  readonly diagnostics: readonly TypecheckDiagnostic[];
  /** Runnable follow-ups, built with the invocation's launcher; absent means none. */
  readonly next?: readonly NextCommand[];
  /** Present only on `workflow start` failures after it launched a runner. */
  readonly launch?: StartLaunchEvidence;
}

/** Fill absent failure context explicitly, without synthesizing checkpoint state. @internal */
export function workflowFailure(
  code: CliErrorCode,
  message: string,
  context: Partial<Omit<WorkflowFailure, 'kind' | 'ok' | 'code' | 'message'>> = {},
): WorkflowFailure {
  return {
    kind: 'workflow.error',
    ok: false,
    code,
    message,
    details: null,
    stepId: null,
    runId: null,
    stateDir: null,
    run: null,
    diagnostics: [],
    ...context,
  };
}
