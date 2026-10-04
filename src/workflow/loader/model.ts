import type { WorktreeCleanResult } from '../runtime/worktree-clean.js';
import type { RunRemovalResult } from '../runtime/run-removal.js';
import type { UnlockedLock } from '../runtime/lock.js';
import type { HarnessFixtures } from '../../harnesses/fixture.js';
import type { RehearsalReport } from './rehearsal.js';
import type { HarnessSelection } from './harness-selection.js';
import type { WorkflowFailure } from './failure.js';
import type { InspectionStatus, RunSummary } from './inspection.js';
import type { EventFollowStart } from './event-follow.js';
import type { AgentLimits } from '../runtime/agent-limiter.js';
import type { RunOwnership } from '../runtime/store.js';
import type { ProfileOverride } from '../runtime/profiles-model.js';
import type { WorkflowDescription } from '../runtime/child-model.js';
import type { ExecutionPlan, ExecutionResult } from '../../application/execution.js';
import type { JsonValue } from '../runtime/model.js';
import type { PolicyOverride } from '../runtime/policy.js';
import type { SuspendedRun } from '../runtime/runner.js';
import type { RunRecord } from '../runtime/store.js';
import type { PendingListing } from '../runtime/wait-model.js';
import type { NextCommand } from './next-commands.js';
import type { AnswerDelivery } from '../runtime/inbox.js';
import type { ForkOptions, ResumeCheck, WorkflowIdentity } from '../runtime/replay-model.js';
import type { DurabilityDiagnostic, TypecheckPlan } from '../typecheck/model.js';

/** Plain-data instructions for checking and importing a trusted workflow module. */
export interface ValidateWorkflowPlan extends ExecutionPlan {
  readonly kind: 'workflow.validate';
  readonly typecheck: TypecheckPlan;
  /**
   * How durability lint findings (ADR 0041) affect the result: `'error'` (the default) fails it as
   * `load.typecheck` before import; `'warn'` logs them and validates, as `list-defs` does.
   */
  readonly durabilityLint?: 'error' | 'warn';
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
  /** Sticky wait mode; on resume, omitted means the run's recorded one (`suspend` without one). */
  readonly waitMode?: 'suspend' | 'block';
  /**
   * The wait mode of this execution only: it overrides `waitMode` without replacing the recorded
   * one. Tick resumes every run with `suspend` this way.
   */
  readonly waitModeOnce?: 'suspend' | 'block';
  /**
   * Sticky worktree flags (`--worktree-keep`, and `--worktree-root` as an absolute path), passed as
   * `RunOptions.worktrees` over the definition's `worktrees` field and recorded in the launch policy.
   * On resume, an omitted field is the run's recorded one.
   */
  readonly worktrees?: {
    readonly keep?: 'all' | 'failed' | 'none';
    readonly root?: string;
  };
  /**
   * On resume, replace the kind and fixtures of `harness` with the run's recorded launch policy,
   * keeping its configuration. The CLI sets it when no `--harness` flag was given.
   */
  readonly inheritHarness?: boolean;
  readonly notifyCommand?: string;
  /**
   * Append one compact JSON line per step, phase, log, wait and run event: an absolute file path,
   * or `-` for the executor's `eventsStdout` writer. Per invocation; never saved with the run.
   */
  readonly events?: string;
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
  /** For `resume`: use the run's recorded harness kind and fixtures, as on `workflow.resume`. */
  readonly inheritHarness?: boolean;
  /** For `resume`: the wait mode; omitted means the run's recorded one. */
  readonly waitMode?: 'suspend' | 'block';
  /** For `resume`: accept a harness configuration different from the run's recorded one. */
  readonly allowHarnessConfigChange?: boolean;
  /** For `resume`: the event stream of that execution, as on `workflow.execute`. */
  readonly events?: string;
}

/** Read every waiting question without importing workflow code. */
export interface PendingWorkflowsPlan extends ExecutionPlan {
  readonly kind: 'workflow.pending';
  readonly additionalStateDirs?: readonly string[];
  readonly stateDir: string;
  /** List answered rows and rows of failed, cancelled or completed runs too. */
  readonly all?: boolean;
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
  /**
   * Stop with `watch.timeout` when the run is still running this long after the first successful
   * read. The run is never touched; omitted means no bound.
   */
  readonly timeoutMs?: number;
  /**
   * Retry a missing record (`run.not_found`) until this long after the watch starts, then fail
   * with `watch.record_not_created`. Applies only before the first successful read; omitted means
   * a missing record fails at once.
   */
  readonly waitCreatedMs?: number;
}

/**
 * Print or follow a run's compact event lines, derived from its persisted record without importing
 * workflow code. Lines go to the executor's `onEventLine` writer.
 */
export interface EventsWorkflowPlan extends ExecutionPlan {
  readonly kind: 'workflow.events';
  readonly runId: string;
  readonly stateDir: string;
  /** Keep polling until the run is terminal; otherwise print the current lines once. */
  readonly follow: boolean;
  /**
   * `end` (follow only) prints nothing from the first read, `all` prints the whole record first,
   * and `afterExecution` prints only entries of later executions and, when following, waits for a
   * terminal status of one of them.
   */
  readonly start: EventFollowStart;
  /** Polling interval while following. */
  readonly intervalMs: number;
  /** As on `workflow.watch`: stop with `watch.timeout` this long after the first read. */
  readonly timeoutMs?: number;
  /** As on `workflow.watch`: wait this long for a missing record before `watch.record_not_created`. */
  readonly waitCreatedMs?: number;
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
 * Plain-data request to remove one saved run and its worktree caches without importing workflow
 * code (`workflow rm`). `force` also removes a running, suspended or waiting run but never
 * overrides a held lock; `refs` also deletes pinned refs; `dryRun` takes no lock and writes
 * nothing, and reports the verdict a removal would meet.
 */
export interface RemoveWorkflowPlan extends ExecutionPlan {
  readonly kind: 'workflow.rm';
  readonly runId: string;
  readonly stateDir: string;
  readonly force: boolean;
  readonly refs: boolean;
  readonly dryRun: boolean;
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

/**
 * Plain-data request to end a live local run as `cancelled`: verify that its lock owner is a live
 * process on this host with the recorded birth identity, leave a cancel request bound to that
 * owner's lock token, signal it, and wait up to `timeoutMs` for the run to end. `force` sends a
 * second signal when the same owner is still there at the deadline.
 */
export interface CancelWorkflowPlan extends ExecutionPlan {
  readonly kind: 'workflow.cancel';
  readonly runId: string;
  readonly stateDir: string;
  readonly force: boolean;
  /** Milliseconds to wait for the run to end after each signal: an integer from 1 to 2147483647. */
  readonly timeoutMs: number;
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
    | (RunRemovalResult & { readonly kind: 'workflow.rm.result'; readonly ok: true })
    | {
        readonly kind: 'workflow.unlock.result';
        readonly ok: true;
        readonly runId: string;
        readonly stateDir: string;
        readonly forceRemote: boolean;
        /** Every lock found, primary first; empty when the run was not locked. */
        readonly locks: readonly UnlockedLock[];
      }
    | {
        readonly kind: 'workflow.cancel.result';
        readonly ok: true;
        readonly runId: string;
        readonly stateDir: string;
        /**
         * The run's saved terminal status: `cancelled` when the cancel took effect, `completed` or
         * `failed` when the run ended first, or the status it already had (with no signal sent).
         */
        readonly status: 'completed' | 'failed' | 'cancelled';
        /** SIGINTs sent to the owner: 0 for a run that had already ended, 2 only under `force`. */
        readonly signalsSent: 0 | 1 | 2;
        /** The verified owner that was signalled, or null when no signal was sent. */
        readonly owner: {
          readonly pid: number;
          readonly host: string;
          readonly osStartTime: string;
        } | null;
      }
    | WorkflowFailure
    | {
        readonly kind: 'workflow.pending.result';
        readonly ok: true;
        readonly pending: readonly (PendingListing & { readonly next: readonly NextCommand[] })[];
        /** Rows the default filter left out; always 0 under `all`. */
        readonly hidden: number;
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
        /** Durability lint diagnostics; always empty on success, since findings fail validation. */
        readonly diagnostics: readonly DurabilityDiagnostic[];
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

/** One validated definition, as `list-defs` caches and lists it: a validate result without `diagnostics`. */
export type ValidatedWorkflow = Omit<
  Extract<WorkflowCommandResult, { readonly kind: 'workflow.validate.result' }>,
  'diagnostics'
>;
