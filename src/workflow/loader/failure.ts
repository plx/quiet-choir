import type { RehearsalReport } from './rehearsal.js';
import type { CliErrorCode } from '../runtime/run-errors.js';
import type { JsonValue } from '../runtime/model.js';
import type { RunRecord } from '../runtime/store.js';
import type { TypecheckDiagnostic } from '../typecheck/model.js';

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
