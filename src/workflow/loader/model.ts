import type { WorktreeCleanResult } from '../runtime/worktree-clean.js';
import type { UnlockedLock } from '../runtime/lock.js';
import type { HarnessFixtures } from '../../harnesses/fixture.js';
import type { RehearsalReport } from './rehearsal.js';
import type { HarnessSelection } from './harness-selection.js';
import type { WorkflowFailure } from './failure.js';
import type { InspectionStatus, RunSummary } from './inspection.js';
import type { AgentLimits } from '../runtime/agent-limiter.js';
import type { RunOwnership } from '../runtime/store.js';
import type { ProfileOverride } from '../runtime/profiles-model.js';
import type { WorkflowDescription } from '../runtime/child-model.js';
import type { ExecutionPlan, ExecutionResult } from '../../application/execution.js';
import type { JsonValue } from '../runtime/model.js';
import type { PolicyOverride } from '../runtime/policy.js';
import type { SuspendedRun } from '../runtime/runner.js';
import type { RunRecord } from '../runtime/store.js';
import type { PendingOperation } from '../runtime/wait-model.js';
import type { AnswerDelivery } from '../runtime/inbox.js';
import type { ForkOptions, ResumeCheck, WorkflowIdentity } from '../runtime/replay-model.js';
import type { TypecheckPlan } from '../typecheck/model.js';

/** Plain-data instructions for checking and importing a trusted workflow module. */
export interface ValidateWorkflowPlan extends ExecutionPlan {
  readonly kind: 'workflow.validate';
  readonly typecheck: TypecheckPlan;
}

/** Discover trusted workflow modules in directories, validating each before publishing metadata. */
export interface ListDefinitionsPlan extends ExecutionPlan {
  readonly kind: 'workflow.list-defs';
  readonly directories: readonly string[];
  readonly refresh?: boolean;
}

/** Resolve a registry name before using the ordinary source-file execution path. */
export interface ExecuteNamedWorkflowPlan extends Omit<ExecuteWorkflowPlan, 'kind' | 'typecheck'> {
  readonly kind: 'workflow.execute-name';
  readonly name: string;
  readonly directories: readonly string[];
}

/** Plain-data instructions for starting or resuming a workflow. */
export interface ExecuteWorkflowPlan extends ExecutionPlan {
  readonly maxChildDepth?: number;
  readonly registryName?: string;
  readonly maxRunCostUsd?: number | null;
  readonly maxRunAgentAttempts?: number | null;
  readonly progress?: boolean;
  readonly kind: 'workflow.execute';
  readonly harness?: HarnessSelection;
  readonly dryRun?: boolean;
  readonly stubSteps?: readonly string[];
  readonly allowHarnessChange?: boolean;
  /** Accept a harness configuration whose digest differs from the one the run last executed with. */
  readonly allowHarnessConfigChange?: boolean;
  readonly agentLimits?: AgentLimits;
  readonly killOrphans?: boolean;
  readonly killGraceMs?: number;
  readonly waitMode?: 'suspend' | 'block';
  readonly notifyCommand?: string;
  readonly typecheck: TypecheckPlan;
  readonly runId: string;
  readonly stateDir: string;
  readonly cwd: string;
  readonly resume: boolean;
  readonly input?: JsonValue;
  readonly policy?: readonly PolicyOverride[];
  readonly profileOverrides?: readonly ProfileOverride[];
  readonly grants?: readonly string[];
  readonly policyReset?: boolean;
  readonly allowModelOverride?: boolean;
  readonly forkFrom?: ForkOptions;
  readonly acceptCodeChange?: boolean;
  readonly strictReplay?: boolean;
}

/** Resume using a checkpoint's stored entrypoint, compiler configuration, and working directory. */
export interface ResumeWorkflowPlan extends Omit<
  ExecuteWorkflowPlan,
  'kind' | 'typecheck' | 'cwd' | 'resume'
> {
  readonly kind: 'workflow.resume';
}

/** Deliver an answer without importing workflow code or acquiring its writer lock. */
export interface AnswerWorkflowPlan extends ExecutionPlan {
  readonly kind: 'workflow.answer';
  readonly runId: string;
  readonly stateDir: string;
  readonly stepId: string;
  readonly value: JsonValue;
  readonly by?: string;
  readonly resume?: boolean;
  readonly harness?: HarnessSelection;
  /** For `resume`: accept a harness configuration different from the run's recorded one. */
  readonly allowHarnessConfigChange?: boolean;
}

/** Read every waiting question without importing workflow code. */
export interface PendingWorkflowsPlan extends ExecutionPlan {
  readonly kind: 'workflow.pending';
  readonly additionalStateDirs?: readonly string[];
  readonly stateDir: string;
}

/** Read-only run-level compatibility inspection after checking/importing trusted source. */
export interface CheckResumePlan extends ExecutionPlan {
  readonly kind: 'workflow.check-resume';
  readonly typecheck: TypecheckPlan;
  readonly runId: string;
  readonly stateDir: string;
  readonly cwd: string;
  readonly acceptCodeChange?: boolean;
}

/** Plain-data instructions for reading an existing run without importing workflow code. */
export interface InspectWorkflowPlan extends ExecutionPlan {
  readonly kind: 'workflow.inspect';
  readonly runId: string;
  readonly stateDir: string;
}

/** Export completed run outputs as portable fixture rules. */
export interface ExportFixturesPlan extends ExecutionPlan {
  readonly kind: 'workflow.fixtures';
  readonly runId: string;
  readonly stateDir: string;
}

/** Read-only monitoring, with live output supplied to the executor separately. */
export interface WatchWorkflowPlan extends ExecutionPlan {
  readonly kind: 'workflow.watch';
  readonly runId: string;
  readonly stateDir: string;
  readonly intervalMs: number;
}

/** Enumerate checkpoints without loading workflow modules. */
export interface ListWorkflowsPlan extends ExecutionPlan {
  readonly kind: 'workflow.list';
  readonly all?: boolean;
  readonly additionalStateDirs?: readonly string[];
  readonly stateDir: string;
  readonly status?: InspectionStatus;
}

/** Plain-data request to remove only one run’s managed worktree caches and optional refs. */
export interface CleanWorkflowPlan extends ExecutionPlan {
  readonly kind: 'workflow.clean';
  readonly runId: string;
  readonly stateDir: string;
  readonly refs?: boolean;
}

/**
 * Plain-data request to clear an abandoned lock of one run without importing workflow code.
 * `forceRemote` asserts that a foreign recorded host is this machine under an old name or is gone.
 */
export interface UnlockWorkflowPlan extends ExecutionPlan {
  readonly kind: 'workflow.unlock';
  readonly runId: string;
  readonly stateDir: string;
  readonly forceRemote: boolean;
}

/** The outcome of a workflow command, without live schemas or loaded modules. */
export type WorkflowCommandResult = ExecutionResult &
  (
    | {
        readonly kind: 'workflow.list-defs.result';
        readonly ok: true;
        readonly definitions: readonly ValidatedWorkflow[];
      }
    | (WorktreeCleanResult & { readonly kind: 'workflow.clean.result'; readonly ok: true })
    | {
        readonly kind: 'workflow.unlock.result';
        readonly ok: true;
        readonly runId: string;
        readonly stateDir: string;
        readonly forceRemote: boolean;
        /** Every lock found, primary first; empty when the run was not locked. */
        readonly locks: readonly UnlockedLock[];
      }
    | WorkflowFailure
    | {
        readonly kind: 'workflow.pending.result';
        readonly ok: true;
        readonly pending: readonly PendingOperation[];
      }
    | {
        readonly kind: 'workflow.answer.result';
        readonly ok: true;
        readonly delivery: AnswerDelivery;
      }
    | {
        readonly kind: 'workflow.fixtures.result';
        readonly ok: true;
        readonly fixtures: HarnessFixtures;
      }
    | {
        readonly kind: 'workflow.list.result';
        readonly ok: true;
        readonly stateDir: string;
        readonly runs: readonly RunSummary[];
        readonly warnings: readonly string[];
      }
    | {
        readonly kind: 'workflow.validate.result';
        readonly ok: true;
        readonly entrypoint: string;
        readonly workflow: WorkflowDescription & {
          readonly fingerprint: string;
          readonly identity?: WorkflowIdentity;
        };
      }
    | {
        readonly kind: 'workflow.check-resume.result';
        readonly ok: true;
        readonly check: ResumeCheck;
      }
    | {
        readonly kind: 'workflow.run.result';
        readonly ok: true;
        readonly run: RunRecord &
          Partial<Pick<SuspendedRun, 'pending' | 'resumeCommand' | 'warnings'>>;
        readonly ownership?: RunOwnership;
        readonly summary?: RunSummary;
        readonly rehearsal?: RehearsalReport;
      }
  );

/** One validated definition, shared by validate and registry results. */
export type ValidatedWorkflow = Extract<
  WorkflowCommandResult,
  { readonly kind: 'workflow.validate.result' }
>;
