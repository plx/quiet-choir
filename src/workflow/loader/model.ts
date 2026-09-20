import type { ExecutionPlan, ExecutionResult } from '../../application/execution.js';
import type { JsonValue } from '../runtime/model.js';
import type { RunRecord } from '../runtime/store.js';
import type { TypecheckDiagnostic, TypecheckPlan } from '../typecheck/model.js';

/** Plain-data instructions for checking and importing a trusted workflow module. */
export interface ValidateWorkflowPlan extends ExecutionPlan {
  readonly kind: 'workflow.validate';
  readonly typecheck: TypecheckPlan;
}

/** Plain-data instructions for starting or resuming a workflow. */
export interface ExecuteWorkflowPlan extends ExecutionPlan {
  readonly kind: 'workflow.execute';
  readonly typecheck: TypecheckPlan;
  readonly runId: string;
  readonly stateDir: string;
  readonly cwd: string;
  readonly resume: boolean;
  readonly input?: JsonValue;
}

/** Plain-data instructions for reading an existing run without importing workflow code. */
export interface InspectWorkflowPlan extends ExecutionPlan {
  readonly kind: 'workflow.inspect';
  readonly runId: string;
  readonly stateDir: string;
}

/** The outcome of a workflow command, without live schemas or loaded modules. */
export type WorkflowCommandResult = ExecutionResult &
  (
    | {
        readonly kind: 'workflow.error';
        readonly ok: false;
        readonly message: string;
        readonly diagnostics: readonly TypecheckDiagnostic[];
      }
    | {
        readonly kind: 'workflow.validate.result';
        readonly ok: true;
        readonly entrypoint: string;
        readonly workflow: {
          readonly name: string;
          readonly version: string;
          readonly fingerprint: string;
        };
      }
    | {
        readonly kind: 'workflow.run.result';
        readonly ok: true;
        readonly run: RunRecord;
      }
  );
