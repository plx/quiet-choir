import {
  HarnessRegistry,
  harnessOptions,
  type HarnessAdapters,
  type HarnessConfigurations,
} from './harness-registry.js';
import type { HarnessDeclaration, WorkflowHarnesses } from './harness-model.js';
import type { WorkflowDeclaration } from './child-model.js';
import {
  RunBudget,
  RunBudgetExceededError,
  runBudgetSchema,
  type RunBudgetPolicy,
} from './run-budget.js';
import { windowSuspensionMessage } from './rate-limit.js';
import { RunChildren } from './children.js';
import { checkedDefinition, describeWorkflow } from './definition.js';
import { agentUsageSchema, normalizeUsage } from './usage.js';
import { legacyAttemptKind } from './usage-summary.js';
import { mergeOptionsSchema, mergeResultSchema } from './worktree-schema.js';
import { randomUUID } from 'node:crypto';
import { deriveAgentSessionId } from './agent-session.js';
import { agentDiagnosticsSchema } from './agent-stream-schema.js';
import { agentResultIdentitySchema, legacyAgentResultSchema } from './agent-result-schema.js';
import type {
  AgentDiagnostics,
  AgentProgress,
  AgentTranscriptWriter,
} from './agent-stream-model.js';
import { RunWorktrees, type WorktreeLease } from './worktrees.js';
import { effectiveWorktreePolicy } from './worktree-policy.js';
import {
  WorktreeRehearsal,
  canSynthesizeIsolation,
  canSynthesizeMerge,
  type RehearsalWorktreeEvent,
} from './worktree-rehearsal.js';
import { isolationIdentity } from './worktree-identity.js';
import { resolveIsolation } from './agent-isolation.js';
import { environmentEdits } from './agent-environment.js';
import {
  resolveWorktree,
  worktreeChangeSchema,
  worktreeHandleSchema,
  worktreeCreateSchema,
  type ResolvedWorktree,
} from './worktree-schema.js';
import type {
  WorktreePolicy,
  MergeOptions,
  MergeResult,
  WorktreeChange,
  WorktreeHandle,
} from './worktree-model.js';
import type {
  ReadFileOptions,
  ReadFileResult,
  WriteFileResult,
  WriteFileOptions,
} from './file-model.js';
import {
  filePath,
  fileDigest,
  snapshotFile,
  replaceFile,
  readFileOptionsSchema,
  writeFileOptionsSchema,
  readFileResultSchema,
  writeFileResultSchema,
} from './files.js';
import { executeCommand, prepareExec, processRequest } from './exec.js';
import { execIdentityKey, type InternalExecIdentity } from './exec-identity.js';
import { execResultSchema, pollExecOptionsSchema, stepExecOptionsSchema } from './exec-schema.js';
import { createStepExec, type StepExecDependencies, type StepExecHandle } from './step-exec.js';
import { ExecError } from './exec-error.js';
import type {
  Command,
  ExecOptions,
  ExecResult,
  ExecFunction,
  ExecStepError,
  ExecSummary,
  ProcessRunner,
} from './exec-model.js';
import { prepareLegacyReplay } from './legacy.js';
import { RunActivity } from './activity.js';
import { FileRunStore, type RunStore } from './run-store.js';
import { RunQuestions } from './questions.js';
import { observePoll, type AnyPollSource } from './poll-command.js';
import { clockNow, systemClock } from './clock.js';
import type {
  WorkflowClock,
  PendingOperation,
  WaitSources,
  WaitOutcome,
  PollOptions,
  CommandPollOptions,
  PollOutcome,
  SignalOutcome,
  DeadlineOutcome,
} from './wait-model.js';
import { pendingOperations } from './inbox.js';
import { approvalSchema, workflowLaunchSchema } from './question-schema.js';
import type { AskOptions, WorkflowLaunch } from './question-model.js';
import { RunObservations, errorStack, requestSummary } from './observability.js';
import type { PhaseInfo, PhaseOptions, RequestSummary, RunEvent } from './observability-model.js';
import {
  acceptedReplayRefusal,
  disposableRunCopy,
  isPreflightProbe,
  preflightProbeOptions,
  preflightRunOptions,
} from './accepted-replay-preflight.js';
import {
  findAcceptedReplayDivergence,
  isValidRunId,
  ReplayDivergenceError,
  ReplaySkippedError,
  runIdMessage,
  RunInterruptedError,
  RunRefusedError,
  StepIdentityChangedError,
  WorkflowInputError,
  WorkflowRunError,
} from './run-errors.js';
import { missingRunError, unreadableRunError } from './read-required-run.js';
import type { ProcessSupervisor } from '../../processes/supervisor.js';
import { OrphanProcessesError } from './process-registry.js';
import type { HarnessInvocation, HarnessMetadata, InstructionSource } from './model.js';
import {
  resolveAgentLimiter,
  type AgentLimiter,
  type AgentPermit,
  type AgentLimits,
  type AgentLimiterSnapshot,
} from './agent-limiter.js';
import { snapshotImages } from './images.js';
import { idleTimeoutError, profileLimitError } from './profile-diagnostics.js';
import {
  resolveCapabilities,
  publicCapabilityManifest,
  grantsSchema,
  profileGrantDigest,
  requireGrant,
  resolveProfileCall,
  validateProfileOverrides,
} from './profiles.js';
import type { ProfileOverride, ResolvedProfile } from './profiles-model.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve } from 'node:path';
import {
  canonicalCwd,
  compareResume,
  workflowSnapshot,
  type WorkflowCodeOptions,
} from './compatibility.js';
import { oldFormatMessage, recordedEngine } from './engine.js';
import { loadFork, pinnedFork, reuseCandidate, validateFork } from './fork.js';
import type { ForkOptions, ResumeCheck } from './replay-model.js';
import { schemaJson } from './schema.js';

import { z } from 'zod';

import { CheckpointError, checkpointError, errorCode, withCheckpointErrors } from './checkpoint.js';
import { resolveStateDir } from './paths.js';
import { launchPolicyFlags, workflowArgv, type CommandLauncher } from './commands.js';
import {
  agentIdentity,
  stepIdentity,
  validateStepId,
  duplicateStepId,
  stepId,
  type StepIdentity,
} from './identity.js';
import {
  agentLimitKeys,
  resolvePolicy,
  matchesStepGlob,
  validatePolicy,
  type AttemptPolicy,
  type PolicyOverride,
} from './policy.js';
import { OperationTracker } from './tracking.js';
import { optionData, validateAgentOptions } from './options.js';
import { HarnessError, boundedResponse, harnessEvidence } from './harness-error.js';
import { CancelledError, FailureOrigins } from './fan-out.js';
import { createMap, settledMapChange } from './map.js';
import { ExecutionScopes } from './scopes.js';
import { NameScopes } from './names.js';
import { bindContext } from './context.js';
import { execFailureFields, stepError, errorKind } from './step-error.js';
import { ConfigurationError, GrantRequiredError } from './configuration-error.js';
import { chooseRecoveryHint, type RecoveryCause } from './recovery-hint.js';
import { harnessConfigRefusal } from './harness-config-decision.js';
import { classifyAttemptFailure } from './attempt-failure.js';
import {
  decideReplay,
  forkReuseValid,
  healedDependents,
  legacyKind,
  replayRefusalMessage,
  type ReplayInput,
} from './replay-decision.js';
import { digest, jsonValue } from './json.js';
import { recordWarnings } from './record-warnings.js';
import type {
  AgentClient,
  ErrorMode,
  EffectResult,
  Settled,
  AgentOptions,
  AgentResult,
  AgentUsage,
  ClaudeOptions,
  CodexOptions,
  Harness,
  HarnessRequest,
  HarnessRequestInput,
  JsonValue,
  JsonInput,
  StepContext,
  StepDefinition,
  WorkflowContext,
  WorkflowDefinition,
} from './model.js';
import {
  hasTerminalOutcomes,
  instructionSourceSchema,
  isTerminalStep,
  refuseRecordSchemaDrift,
  SUPPORTED_SCHEMA_REVISION,
  type RunRecord,
  type StepRecord,
  type AttemptRecord,
  withProjectInstructions,
} from './store.js';

export { ConfigurationError } from './configuration-error.js';

/** Unawaited notifications: step transitions follow persistence; admission events are live. */
export type WorkflowEvent = {
  /** Inline child frame, or null/absent for the root workflow. */
  readonly frame?: string | null;
  /** Bounded native activity for live agent.progress events. */
  readonly progress?: AgentProgress;
  /** Native model, or null when unknown. */
  readonly model?: string | null;
  /** Native CLI version, or null when unknown. */
  readonly cliVersion?: string | null;
  /** Attempt outcome after local output validation. */
  readonly outcome?: 'completed' | 'failed' | 'cancelled';
  /** Extensible bounded native evidence on agent.finished. */
  readonly diagnostics?: AgentDiagnostics;
  /** The step's warnings (such as `no-tool-use`) on a completed agent.finished, when any. */
  readonly warnings?: readonly string[];
  /** Reported usage on step.completed and live agent.finished; do not sum across event types. */
  readonly usage?: AgentUsage;
  /** Observed native session, or predicted Claude ID on early live notifications; absent on replay. */
  readonly sessionId?: string | null;
  /** ISO notification time. */
  readonly at: string;
  /** Body execution number within the run. */
  readonly execution: number;
  /** Observational phase, when known. */
  readonly phase?: string | null;
  /** Expected phase step count. */
  readonly total?: number | null;
  /** User-supplied log data. */
  readonly data?: JsonValue;
  /** An earlier execution already persisted this occurrence. */
  readonly replayed?: boolean;
  /** Provider requesting or receiving admission, present on agent events. */
  readonly harness?: string;
  /** Reserved slots by harness, present on agent events. */
  readonly inFlight?: AgentLimiterSnapshot['inFlight'];
  /** Waiting requests at this notification; immediate admission can report zero. */
  readonly queued?: number;
  /** Zero at the request notification; monotonic queue duration on admission. */
  readonly waitedMs?: number;
  /** Replay divergence diagnosis, when relevant. */
  readonly message?: string;
  /** Terminal or later recorded steps not yet visited before a live effect. */
  readonly skippedStepIds?: readonly string[];
  /** Failed step whose recovery could change a previously observed branch. */
  readonly healedStepId?: string;
  /** Owning execution. */
  readonly runId: string;
  /** Total persisted attempts for this effect. */
  readonly attempt: number;
} & (
  | {
      /** Full durable effect ID. */
      readonly stepId: string;
      /** Step transition or live admission notification. */
      readonly type:
        | 'step.started'
        | 'step.waiting'
        | 'wait.opened'
        | 'step.completed'
        | 'step.replayed'
        | 'step.failed'
        | 'step.cancelled'
        | 'step.settled'
        | 'step.redefined'
        | 'step.superseded'
        | 'step.reused'
        | 'replay.divergence'
        | 'agent.queued'
        | 'agent.admitted'
        | 'agent.started'
        | 'agent.progress'
        | 'agent.finished';
    }
  | {
      /** Root effect for a failed run, or the wait ID for `wait.tolerated`; otherwise null. */
      readonly stepId: string | null;
      /**
       * Run lifecycle, phase, or log notification, or `wait.tolerated` after a poll error that
       * `onError` tolerated was saved.
       */
      readonly type: RunEvent['type'];
    }
  | {
      /** Child lifecycle notifications refer to their frame rather than a leaf effect. */
      readonly stepId: null;
      /**
       * Inline invocation lifecycle after its frame checkpoint. `child.settled` reports an
       * `onError: 'return'` frame whose failure was saved as its outcome (a settled success reports
       * `child.completed`). `child.superseded` follows `run.completed` for each unfinished frame the
       * completed run no longer invoked. `child.redefined` precedes `child.started` when an
       * unfinished frame was invoked under a changed name, version, input or schemas; its message
       * names the replaced and the new identity.
       */
      readonly type:
        | 'child.started'
        | 'child.redefined'
        | 'child.completed'
        | 'child.failed'
        | 'child.settled'
        | 'child.superseded';
    }
);

/** A completed run with its output type inferred from the workflow definition. */
export type WorkflowRun<TOutput> = RunRecord & {
  /** Successful, durably committed completion. */
  readonly status: 'completed';
  /** Final validated output, inferred from the workflow schema. */
  readonly output: TOutput;
  /**
   * The record's persisted policy, replay, harness, worktree and wait warnings plus
   * invocation-only cleanup warnings, returned after a persisted completion and when a completed
   * run is re-read.
   */
  readonly warnings?: readonly string[];
};

/** A run released its ownership while waiting for external answers. */
export type SuspendedRun = RunRecord & {
  /** Durable external wait, not a workflow failure. */
  readonly status: 'suspended';
  /** A suspended run has no workflow output. */
  readonly output: null;
  /** Self-describing question presentation and answer commands. */
  readonly pending: readonly PendingOperation[];
  /** Resume argument vector, or null for embedded runs without a stored entrypoint. */
  readonly resumeCommand: readonly string[] | null;
  /** Invocation and replay diagnostics. */
  readonly warnings?: readonly string[];
};

/** The runner either completes or releases ownership for an external wait. */
export type WorkflowResult<TOutput> = WorkflowRun<TOutput> | SuspendedRun;

/** Narrow a result where suspension is unexpected; never call this inside a workflow body. */
export function assertCompleted<T>(result: WorkflowResult<T>): asserts result is WorkflowRun<T> {
  if (result.status !== 'completed')
    throw new Error(
      `Run ${result.id} is suspended with ${String(result.pending.length)} pending waits.`,
    );
}

/** Explicit dependencies and execution policy for a workflow run. */
export interface RunOptions extends WorkflowCodeOptions {
  /** Sticky inline nesting limit, default 8; root depth is zero and zero prohibits new children. */
  readonly maxChildDepth?: number;
  /** Sticky reported-cost threshold for new agent attempts; null clears it. In-flight calls can overshoot. */
  readonly maxRunCostUsd?: number | null;
  /** Sticky cap on locally admitted agent attempts across resumes; null clears it. */
  readonly maxRunAgentAttempts?: number | null;
  /**
   * Sticky subscription-window gate, 0 to 1; null clears it. A new agent attempt is refused while
   * its harness's latest recorded rate-limit window reports at least this utilization; the run then
   * suspends until the window resets, or fails when the reset is unknown (ADR 0053).
   */
  readonly maxWindowUtilization?: number | null;
  /**
   * Runtime-owned checkout cache and dependency provisioning policy. Each field that is not
   * undefined replaces the same field of the root definition's `worktrees`.
   */
  readonly worktrees?: WorktreePolicy;
  /**
   * Process integration for durable exec and worktree Git operations; the core never spawns. Under
   * `rehearsal` it serves only the read-only `git rev-parse` that resolves a synthesized base;
   * every other Git command is refused before it reaches the runner.
   */
  readonly processRunner?: ProcessRunner;
  /**
   * Process integration for `ctx.exec` and `ctx.exec.json` effects only, including `guardFile`'s
   * helper commands; defaults to `processRunner`. Worktree Git operations always use
   * `processRunner`. The CLI sets it to answer commands from fixture exec rules, and under
   * `--dry-run` to the rehearsal's synthesizing runner.
   */
  readonly execRunner?: ProcessRunner;
  /** Wall clock and cancellable timer used by now, waits, and legacy sleeps. */
  readonly clock?: WorkflowClock;
  /** Suspend when quiescent by default; block keeps waits in this process. Waits due within one second stay live. */
  readonly waitMode?: 'suspend' | 'block';
  /** Optional storage implementation; defaults to private local journal files. */
  readonly store?: RunStore;
  /** Optional entrypoint metadata supplied by the CLI or embedder for resume by ID. */
  readonly launch?: WorkflowLaunch;
  /**
   * Program words that start the emitted `resumeCommand`, each `answerCommand` and the
   * `workflow unlock` command in a `run.locked` refusal's message and `details.next`, such as
   * `[process.execPath, '/abs/bin/run.js']`. Defaults to `['quiet-choir']`. Emitted commands are
   * computed per call and never saved in the record.
   */
  readonly commandLauncher?: CommandLauncher;
  /** Stop identity-confirmed children of a dead/released owner before acquiring its lock. */
  readonly killOrphans?: boolean;
  /** Orphan recovery TERM grace, defaults to 3000ms; configure live calls on CliHarness separately. */
  readonly killGraceMs?: number;
  /** Optional live ownership controller for an embedder's second-signal handler. */
  readonly processSupervisor?: ProcessSupervisor;
  /** Run-wide live invocation cap, limits, or shared limiter. Omission uses defaultAgentLimits(). Not sticky or part of identity. */
  readonly agentLimit?: number | AgentLimits | AgentLimiter;
  /** Sticky named limit rules, appended on resume; policyReset clears them as well. */
  readonly profileOverrides?: readonly ProfileOverride[];
  /** Authorize elevated profiles by name, access class (write/exec), or all; saved across resumes. */
  readonly grants?: readonly string[];
  /** Required stable identifier. Reuse it with resume to continue an execution. */
  readonly runId: string;
  /** Runs container; defaults to QUIET_CHOIR_STATE_DIR, legacy run discovery, or project-specific XDG state. */
  readonly stateDir?: string;
  /** Workflow working directory; defaults to process.cwd(). */
  readonly cwd?: string;
  /** Untrusted input, validated by the workflow schema. Resume uses saved input when omitted. */
  readonly input?: unknown;
  /** Resume an existing run; new execution refuses to overwrite an existing run. */
  readonly resume?: boolean;
  /** Harness integration. Local-only workflows do not need this dependency. */
  readonly harness?: Harness;
  /** Named adapters take precedence over the legacy catch-all and declared factories. */
  readonly adapters?: HarnessAdapters;
  /** Per-harness operator configuration supplied only to declared adapter factories. */
  readonly harnessConfigurations?: HarnessConfigurations;
  /** Explicitly accept replaying outputs recorded under a different harness kind, including forks. */
  readonly allowHarnessChange?: boolean;
  /**
   * SHA-256 digest of the CLI harness configuration this execution uses, recorded as
   * `harness.configDigest`. When it is supplied on resume and the run last executed under the same
   * harness kind with a different recorded digest, the resume is refused with `run.incompatible`
   * unless {@link RunOptions.allowHarnessConfigChange} is set. Omit it when the configuration is
   * unknown, such as with an embedder's own {@link Harness}: nothing is checked and the field is
   * left out of the record.
   */
  readonly harnessConfigDigest?: string;
  /** Explicitly accept resuming under a `harnessConfigDigest` different from the recorded one. */
  readonly allowHarnessConfigChange?: boolean;
  /** Live rehearsal hooks. Requires a harness whose kind is dry-run; local callbacks otherwise run normally. */
  readonly rehearsal?: {
    /**
     * Replace a selected local callback, file effect or poll observer (by step or wait ID);
     * undefined means execute the original. A replaced poll completes with the output.
     */
    readonly localStep?: (
      stepId: string,
      schema: JsonValue,
    ) =>
      | {
          /** Replacement output, still parsed by the original local-step schema. */
          readonly output: JsonValue;
        }
      | undefined;
    /** Observe original schemas for diagnostics unavailable in JSON Schema. */
    readonly onSchema?: (stepId: string, schema: z.ZodType) => void;
    /**
     * Observe a synthesized worktree effect. A fresh isolated agent call is reported before its
     * harness is invoked; a merge of unchanged changes is reported when it completes.
     */
    readonly onWorktree?: (
      event:
        | {
            /** A fresh isolated agent call planned without a worktree. */
            readonly kind: 'isolation';
            /** Fully qualified step ID. */
            readonly stepId: string;
            /** Attempt number. */
            readonly attempt: number;
            /** The base commit a real run would pin, or forty zeros outside a Git working tree. */
            readonly base: string;
            /**
             * `resolved` by a read-only `git rev-parse`, `recorded` by an earlier attempt of a
             * resumed run, or a `placeholder` outside a Git working tree.
             */
            readonly baseSource: 'resolved' | 'recorded' | 'placeholder';
            /** Absolute placeholder directory the call is planned in; it is never created. */
            readonly cwd: string;
          }
        | {
            /** A merge of unchanged changes, answered with the no-op integration. */
            readonly kind: 'merge';
            /** Fully qualified step ID. */
            readonly stepId: string;
            /** Attempt number. */
            readonly attempt: number;
            /** The target's current commit, or forty zeros outside a Git working tree. */
            readonly commit: string;
            /** Number of merged inputs. */
            readonly inputs: number;
            /** The merge target kind. */
            readonly target: 'ref' | 'checkout' | 'branch';
            /** `resolved` by a read-only `git rev-parse`, or a `placeholder`. */
            readonly baseSource: 'resolved' | 'placeholder';
          },
    ) => void;
  };
  /** Cancellation signal, forwarded to all active effects. */
  readonly signal?: AbortSignal;
  /** Create a new run, reusing completed effects from an immutable source snapshot. */
  readonly forkFrom?: ForkOptions;
  /**
   * Explicitly accept only source/schema changes on resume; local callback identity still applies.
   * The changed body first replays once on a disposable copy of the run, with every unfinished
   * effect synthesized. If it meets a changed completed or settled-failed step, the resume rejects
   * with a bare {@link StepIdentityChangedError}; if it finishes without revisiting a completed
   * step, settled map or completed or settled child frame, with a bare {@link ReplaySkippedError}.
   * Either way the run is left unchanged. Top-level code outside effects therefore runs one extra
   * time.
   */
  readonly acceptCodeChange?: boolean;
  /** Fail before a live effect when earlier terminal steps have not been visited. */
  readonly strictReplay?: boolean;
  /** Sticky rules appended to saved overrides; later matching values win. */
  readonly policy?: readonly PolicyOverride[];
  /** Discard saved rules before applying this invocation's rules. */
  readonly policyReset?: boolean;
  /** Authorize new model/effort overrides; saved authorization stays with sticky rules. */
  readonly allowModelOverride?: boolean;
  /** Unawaited observer; synchronous throws and promise rejections cannot affect execution. */
  readonly onEvent?: (event: WorkflowEvent) => void | Promise<void>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Record an honored run-signal abort on `record`. A marked {@link RunInterruptedError} is a
 * resumable suspension that is due at `now` and keeps `staleRecovery` (ADR 0029); any other reason,
 * such as a `workflow cancel` request bound to this execution's lock (ADR 0039), cancels the run.
 */
function recordHonoredAbort(record: RunRecord, reason: unknown, now: number): void {
  if (reason instanceof RunInterruptedError) {
    record.status = 'suspended';
    record.error = null;
    record.rootCause = null;
    record.interruptedBy = { reason: message(reason), at: new Date().toISOString() };
    record.nextWakeAt = now;
    return;
  }
  record.status = 'cancelled';
  record.error = message(reason);
  record.rootCause = { stepId: null, error: message(reason), errorKind: null, effect: null };
}

async function waitUntil(
  timestamp: number,
  signal: AbortSignal,
  clock: WorkflowClock = systemClock,
): Promise<void> {
  signal.throwIfAborted();
  let remaining = timestamp - clockNow(clock);
  while (remaining > 0) {
    await clock.sleep(Math.min(remaining, 2_147_483_647), signal);
    remaining = timestamp - clockNow(clock);
  }
}

/** Await shared `work`, but stop waiting (without cancelling it) once `signal` aborts. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      reject(signal.reason as Error);
    };
    signal.addEventListener('abort', abort, { once: true });
    void work.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort);
    });
  });
}

/** Transcript close/discard deadline once the invocation settled; matches the process drain scale. */
const transcriptSettleMs = 2000;
/** Step version that identifies ctx.now; see the `now` implementation before changing it. */
const NOW_STEP_VERSION = 'now/1';

/**
 * Bound a transcript close/discard so a writer stalled behind a never-settling write cannot hold
 * run ownership forever. On timeout, rejects with code `QUIET_CHOIR_TRANSCRIPT_STALLED`.
 */
function boundedTranscript(
  writer: AgentTranscriptWriter,
  action: 'close' | 'discard',
): Promise<void> {
  const pending = Promise.resolve().then(() => writer[action]());
  // A close that settles after the deadline must not surface later as an unhandled rejection.
  pending.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        Object.assign(
          new Error(
            `Transcript ${action} did not settle within ${String(transcriptSettleMs)}ms of the invocation ending.`,
          ),
          { code: 'QUIET_CHOIR_TRANSCRIPT_STALLED' },
        ),
      );
    }, transcriptSettleMs);
  });
  return Promise.race([pending, deadline]).finally(() => {
    clearTimeout(timer);
  });
}

/** Describe the boundary that aborted `signal`; callers must only pass an aborted signal. */
function cancellationError(signal: AbortSignal, cause: unknown): CancelledError {
  if (signal.reason instanceof CancelledError)
    return new CancelledError(signal.reason.cancelledBy, cause, signal.reason.scope);
  // Only the run controller aborts with another reason: a checkpoint failure or strict replay.
  return new CancelledError(null, cause, 'run');
}

/**
 * Resolve the first observed session ID and never let a later one overwrite it; returns a value
 * the caller assigns back, always a string or explicit null (never left undefined) once anything
 * is observed. A later, differing ID is not discarded: it is recorded as a diagnostic so the
 * evidence survives.
 */
function preserveFirstSessionId(
  record: { sessionId?: string | null; diagnostics?: AgentDiagnostics },
  observed: string | null | undefined,
): string | null {
  const current = record.sessionId;
  if (current === undefined) return observed ?? null;
  if (observed != null && current != null && observed !== current)
    record.diagnostics = { ...record.diagnostics, finalSessionId: observed };
  return current;
}

/**
 * Merge adapter diagnostics over earlier attempt diagnostics, keeping a known `cliVersion` or
 * `model` (for example from version discovery) when the adapter reports it as null (#109).
 */
function mergeDiagnostics(
  prior: AgentDiagnostics | undefined,
  next: AgentDiagnostics | undefined,
): Record<string, JsonValue> {
  const merged: Record<string, JsonValue> = { ...prior, ...next };
  for (const key of ['cliVersion', 'model'])
    if (merged[key] === null && prior?.[key] != null) merged[key] = prior[key];
  return merged;
}

/** Whether an agent call could use a tool: Claude with an explicitly empty tool list cannot. */
function exposesTools(harness: string, options: { readonly tools?: unknown }): boolean {
  return !(harness === 'claude' && Array.isArray(options.tools) && options.tools.length === 0);
}

/** Run or resume a workflow with local, at-least-once durable effects. Throws after saving failures. */
export async function runWorkflow<
  TInput,
  TOutput,
  TProfile extends string,
  H extends readonly HarnessDeclaration[],
  TStrict extends boolean,
  TChildren extends readonly WorkflowDeclaration[],
  TName extends string,
>(
  definition: WorkflowDefinition<TInput, TOutput, TProfile, H, TStrict, TChildren, TName>,
  options: RunOptions,
): Promise<WorkflowResult<TOutput>>;
/**
 * Run or resume a workflow with explicit `<Input, Output, Profile, Harnesses>` type arguments. The
 * definition's strictness, children and name widen to the {@link WorkflowDefinition} defaults; the
 * runtime still applies them.
 */
export async function runWorkflow<
  TInput,
  TOutput,
  TProfile extends string,
  H extends readonly HarnessDeclaration[],
>(
  definition: WorkflowDefinition<TInput, TOutput, TProfile, H>,
  options: RunOptions,
): Promise<WorkflowResult<TOutput>>;
export async function runWorkflow<
  TInput,
  TOutput,
  TProfile extends string,
  H extends readonly HarnessDeclaration[],
  TStrict extends boolean,
  TChildren extends readonly WorkflowDeclaration[],
  TName extends string,
>(
  definition: WorkflowDefinition<TInput, TOutput, TProfile, H, TStrict, TChildren, TName>,
  options: RunOptions,
): Promise<WorkflowResult<TOutput>> {
  if (!isValidRunId(options.runId)) throw new Error(runIdMessage);
  if (!definition.name.trim() || !definition.version.trim())
    throw new Error('Workflow name and version must be nonempty.');
  if (options.launch) workflowLaunchSchema.parse(options.launch);
  const registry = new HarnessRegistry(options);
  registry.definitions(definition);
  let harnessKind = registry.kind(checkedDefinition(definition));
  if (typeof harnessKind !== 'string' || !harnessKind.trim() || harnessKind.length > 100)
    throw new Error('Harness kind must be a nonempty string of at most 100 characters.');
  // 'none' marks a run with no agent outputs, which any harness may adopt without authorization.
  if (options.harness && harnessKind === 'none')
    throw new Error("Harness kind 'none' is reserved for runs without a harness adapter.");
  if (options.rehearsal !== undefined && harnessKind !== 'dry-run')
    throw new Error('Rehearsal hooks require a dry-run harness.');
  if (
    options.harnessConfigDigest !== undefined &&
    !/^[a-f0-9]{64}$/u.test(options.harnessConfigDigest)
  )
    throw new Error('harnessConfigDigest must be a lowercase hex SHA-256 digest.');
  const incomingBudget = runBudgetSchema.partial().parse({
    ...(options.maxRunCostUsd === undefined ? {} : { maxRunCostUsd: options.maxRunCostUsd }),
    ...(options.maxRunAgentAttempts === undefined
      ? {}
      : { maxRunAgentAttempts: options.maxRunAgentAttempts }),
    ...(options.maxWindowUtilization === undefined
      ? {}
      : { maxWindowUtilization: options.maxWindowUtilization }),
  });
  const incomingChildDepth = z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional()
    .parse(options.maxChildDepth);
  checkedDefinition(definition);
  if (definition.children !== undefined) describeWorkflow(definition);
  const limiter = resolveAgentLimiter(options.agentLimit);
  const capabilities = resolveCapabilities(definition);
  const incomingProfiles = validateProfileOverrides(options.profileOverrides ?? [], capabilities);
  const incomingGrants = grantsSchema.parse(jsonValue(options.grants ?? []));
  for (const grant of incomingGrants)
    if (!['write', 'exec', 'all'].includes(grant) && !Object.hasOwn(capabilities.profiles, grant))
      throw new Error(`Unknown grant: ${grant}.`);
  const incomingPolicy = validatePolicy(options.policy ?? [], options.allowModelOverride ?? false);
  if (options.forkFrom !== undefined && options.resume)
    throw new Error('forkFrom creates a new run and cannot be combined with resume.');
  if (options.acceptCodeChange && !options.resume)
    throw new Error('acceptCodeChange requires resume.');
  const fork = options.forkFrom === undefined ? undefined : validateFork(options.forkFrom);
  const cwd = await canonicalCwd(options.cwd);
  const clock = options.clock ?? systemClock;
  if (typeof clock.now !== 'function' || typeof clock.sleep !== 'function')
    throw new Error('Workflow clock requires now and sleep methods.');
  clockNow(clock);
  if (options.waitMode !== undefined && !['suspend', 'block'].includes(options.waitMode))
    throw new Error('waitMode must be suspend or block.');
  const stateDir = options.store?.stateDir ?? resolveStateDir(options);
  if (
    options.store?.stateDir !== undefined &&
    options.stateDir !== undefined &&
    resolveStateDir(options) !== options.store.stateDir
  )
    throw new Error('RunOptions.stateDir must match the bound RunStore stateDir.');
  const snapshot = workflowSnapshot(definition, options);
  const { fingerprint } = snapshot;
  if (
    options.killGraceMs !== undefined &&
    (!Number.isSafeInteger(options.killGraceMs) ||
      options.killGraceMs < 1 ||
      options.killGraceMs > 2_147_483_647)
  )
    throw new Error('killGraceMs must be an integer from 1 to 2147483647.');
  const storage = await (options.store ?? new FileRunStore(stateDir))
    .open(options.runId, {
      ...options,
      cwd,
      probeOwner: options.rehearsal === undefined,
    })
    .catch(async (cause: unknown) => {
      if (cause instanceof RunRefusedError || options.signal?.aborted) throw cause;
      if (errorCode(cause) !== undefined)
        throw await checkpointError(
          'lock',
          stateDir,
          options.runId,
          cause,
          `Could not acquire run ${options.runId} lock`,
        );
      throw unreadableRunError({ stateDir, runId: options.runId }, cause);
    });
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort(new CancelledError(null, options.signal?.reason));
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const { signal } = controller;
  const checkpointProblems: CheckpointError[] = [];
  let savedFailure: RunRecord | undefined;
  async function executeOwned(): Promise<WorkflowResult<TOutput>> {
    let existing: RunRecord | undefined;
    try {
      existing = await storage.read();
    } catch (error) {
      // FileRunStore refuses a record this build cannot fully read before any write.
      if (error instanceof RunRefusedError) throw error;
      throw unreadableRunError({ stateDir, runId: options.runId }, error);
    }
    if (existing && !options.resume)
      throw new RunRefusedError(
        'run.exists',
        options.runId,
        `Run ${options.runId} already exists; use resume or choose a new run ID.`,
        { stateDir },
      );
    if (!existing && options.resume)
      throw await missingRunError({ stateDir, runId: options.runId });
    if (existing && ![1, 6, 7].includes(existing.formatVersion))
      throw new RunRefusedError(
        'run.incompatible',
        options.runId,
        oldFormatMessage(existing.formatVersion),
        { formatVersion: existing.formatVersion },
      );
    // A custom RunStore's record gets the same schema-revision refusal as FileRunStore's.
    if (existing) refuseRecordSchemaDrift(existing);
    const forkStateDir =
      fork === undefined
        ? undefined
        : await canonicalCwd(fork.stateDir === undefined ? stateDir : resolve(cwd, fork.stateDir));
    if (fork?.runId === options.runId && forkStateDir === (await canonicalCwd(stateDir)))
      throw new RunRefusedError(
        'run.incompatible',
        options.runId,
        'A fork must use a different target checkpoint.',
      );
    let forkSource =
      fork && forkStateDir ? await loadFork(fork.runId, forkStateDir, definition.name) : undefined;
    if (!registry.configured(checkedDefinition(definition)))
      harnessKind = existing?.harness?.kind ?? forkSource?.harness?.kind ?? harnessKind;
    function requireHarnessChange(source: RunRecord | undefined): void {
      // Unlabelled legacy records remain resumable: their historical adapter cannot be inferred.
      // A source that never had an adapter holds no agent outputs, so any harness may adopt it.
      const harnessLess = source?.harness?.kind === 'none' && !source.harness.previousKinds.length;
      if (
        source?.harness &&
        !harnessLess &&
        source.harness.kind !== harnessKind &&
        !options.allowHarnessChange
      )
        throw new RunRefusedError(
          'run.incompatible',
          options.runId,
          `Run ${source.id} used harness ${source.harness.kind}; ${harnessKind} requires --allow-harness-change to reuse its outputs.`,
          { previousKind: source.harness.kind, requestedKind: harnessKind },
        );
    }
    requireHarnessChange(existing);
    requireHarnessChange(forkSource);
    // A kind change is governed by allowHarnessChange alone. Records without a digest (older ones,
    // or an execution with an unknown configuration) stay resumable and adopt the supplied one.
    // Forks are new runs and record their own digest. Tick applies the same rule before it counts
    // a stale recovery, so the rule lives in harness-config-decision.ts.
    const configRefusal = harnessConfigRefusal({
      runId: options.runId,
      previous: existing?.harness,
      requestedKind: harnessKind,
      requestedConfigDigest: options.harnessConfigDigest,
      allowHarnessConfigChange: options.allowHarnessConfigChange ?? false,
    });
    if (configRefusal)
      throw new RunRefusedError(
        'run.incompatible',
        options.runId,
        configRefusal.message,
        configRefusal.details,
      );
    function parseInput(raw: unknown): TInput {
      try {
        return definition.input.parse(raw);
      } catch (cause) {
        if (!(cause instanceof z.ZodError)) throw cause;
        let details: JsonValue;
        try {
          details = jsonValue(cause.issues);
        } catch {
          details = cause.issues.map((issue) => ({
            code: issue.code,
            message: issue.message,
            path: issue.path.map((part) => (typeof part === 'symbol' ? String(part) : part)),
          }));
        }
        throw new WorkflowInputError(details, cause);
      }
    }
    const suppliedInput = options.input === undefined ? undefined : parseInput(options.input);
    let compatibility: ResumeCheck | undefined;
    if (existing) {
      compatibility = compareResume(definition, options, cwd, existing);
      if (!compatibility.compatible)
        throw new RunRefusedError(
          compatibility.changed.length === 1 && compatibility.changed[0] === 'input'
            ? 'run.input_changed'
            : 'run.incompatible',
          options.runId,
          compatibility.message,
          jsonValue(compatibility),
        );
    }
    const allowModelOverride =
      options.allowModelOverride ??
      (options.policyReset ? false : (existing?.allowModelOverride ?? false));
    const policy = validatePolicy(
      [...(options.policyReset ? [] : (existing?.policy ?? [])), ...incomingPolicy],
      allowModelOverride,
    );
    const profileOverrides = validateProfileOverrides(
      [...(options.policyReset ? [] : (existing?.profileOverrides ?? [])), ...incomingProfiles],
      capabilities,
    );
    const grants = [...new Set([...(existing?.grants ?? []), ...incomingGrants])];
    const grantedProfiles = { ...(existing?.grantedProfiles ?? {}) };
    for (const grant of incomingGrants) {
      const role = capabilities.profiles[grant];
      if (Object.hasOwn(capabilities.profiles, grant) && role)
        grantedProfiles[grant] = profileGrantDigest(role);
    }
    for (const name of capabilities.requiredGrants) {
      const role = capabilities.profiles[name];
      if (role) requireGrant(role, grants, grantedProfiles);
    }
    const matchedPolicy = new Set<number>();
    const input =
      options.input === undefined
        ? parseInput(existing ? existing.input : forkSource?.input)
        : (suppliedInput as TInput);
    const savedInput = jsonValue(input, 'Workflow input');
    // The body gets a noncanonical JSON copy of the once-parsed input: schema field order without
    // undefined members, and no second pass through non-idempotent schema overwrites.
    const bodyInput = jsonValue(input, 'Workflow input', { canonical: false }) as TInput;
    const legacyReplay = existing?.formatVersion === 1;
    const migrating = existing !== undefined && existing.formatVersion !== 7;
    const engine = recordedEngine();
    const engineChanged =
      existing !== undefined &&
      (existing.engine?.quietChoir !== engine.quietChoir ||
        existing.engine.node !== engine.node ||
        existing.engine.zod !== engine.zod ||
        existing.engine.tsx !== engine.tsx);
    // #215: every gate above has passed and nothing has touched `existing` yet. An accepted replay
    // that would meet a changed completed step, or skip a completed step, settled map or child
    // frame (#216), is found on a disposable copy of the record read under this lock, and refused
    // before the acceptance is recorded. The probe's own nested run
    // carries rehearsal hooks, as does a dry run, which is already a disposable copy.
    if (options.acceptCodeChange && existing && options.rehearsal === undefined) {
      let copy: Awaited<ReturnType<typeof disposableRunCopy>> | undefined;
      let change: StepIdentityChangedError | ReplaySkippedError | undefined;
      try {
        copy = await disposableRunCopy(existing, stateDir);
        await runWorkflow(definition, {
          ...preflightRunOptions(options),
          ...preflightProbeOptions(copy.stateDir),
        });
      } catch (error) {
        change = findAcceptedReplayDivergence(error);
      } finally {
        // A temporary directory left behind must not fail the real run.
        await copy?.dispose().catch(() => undefined);
      }
      if (options.signal?.aborted) {
        // The copy may hold an interrupted or cancelled record; the abort belongs to the real run.
        // It ends this execution as the body's catch would (suspended for a marked interruption,
        // otherwise cancelled), but the acceptance stays unrecorded: the fingerprint, codeChanges,
        // output and steps are as they were. A format-1 record cannot be saved without the
        // migration that adopts the changed workflow, so it stays untouched.
        const reason: unknown = options.signal.reason;
        if (existing.formatVersion !== 1) {
          existing.formatVersion = 7;
          existing.seq ??= 0;
          existing.engine = engine;
          existing.schemaRevision = SUPPORTED_SCHEMA_REVISION;
          // A cancellation leaves no stale marker from an earlier interruption.
          delete existing.interruptedBy;
          recordHonoredAbort(existing, reason, clockNow(clock));
          delete existing.recoveryHint;
          if (existing.status === 'cancelled') {
            const finishedAt = new Date().toISOString();
            for (const frame of Object.values(existing.children ?? {}))
              if (frame.status === 'running' || frame.status === 'suspended') {
                frame.status = 'cancelled';
                frame.finishedAt = finishedAt;
                frame.error ??= existing.error;
              }
            const recoveryHint = chooseRecoveryHint({
              cause: recoveryCause([reason], existing),
              rehearsal: false,
              recordedWork:
                Object.keys(existing.steps).length > 0 ||
                Object.keys(existing.maps ?? {}).length > 0,
              allTerminal: hasTerminalOutcomes(existing),
              sourceChanged: (compatibility?.changed.length ?? 0) > 0,
              runId: existing.id,
            });
            if (recoveryHint !== undefined) existing.recoveryHint = recoveryHint;
          }
          // The lifecycle record the body's catch would add: an execution entry that ends with the
          // abort and its run event. Neither stays in memory, nor reaches onEvent, unless saved.
          const suspended = existing.status === 'suspended';
          const prior = {
            executions: existing.executions?.slice(),
            events: existing.events?.slice(),
            eventCounts: existing.eventCounts,
            phase: existing.phase,
            errorStack: existing.errorStack,
          };
          const ended = new RunObservations(
            existing,
            () => Promise.resolve(),
            () => undefined,
          ).lifecycle(suspended ? 'run.suspended' : 'run.cancelled', suspended ? null : reason);
          existing.updatedAt = new Date().toISOString();
          const context = `Could not save run ${existing.id}`;
          try {
            await storage.append(existing, { context });
            savedFailure = structuredClone(existing);
            try {
              void Promise.resolve(
                options.onEvent?.({
                  ...ended,
                  message: suspended
                    ? `Run interrupted; resumable: ${message(reason)}`
                    : (existing.error ?? ''),
                  attempt: 0,
                  runId: existing.id,
                }),
              ).catch(() => {
                /* Observers do not own outcomes. */
              });
            } catch {
              /* Observers cannot invalidate persisted work. */
            }
          } catch (error) {
            Object.assign(existing, prior);
            checkpointProblems.push(
              error instanceof CheckpointError
                ? error
                : await checkpointError('save', stateDir, existing.id, error, context),
            );
          }
        }
        throw reason;
      }
      // Before savedFailure is set: the caller gets this bare error and the record is untouched.
      if (change) throw acceptedReplayRefusal(change, options.runId);
    }
    if (existing && legacyReplay) prepareLegacyReplay(existing);
    if (existing) {
      existing.formatVersion = 7;
      existing.seq ??= 0;
      existing.engine = engine;
      // Stamped only in memory: the revision reaches disk with the next real save.
      existing.schemaRevision = SUPPORTED_SCHEMA_REVISION;
    }
    const mergedBudget = runBudgetSchema.parse({
      maxRunCostUsd: null,
      maxRunAgentAttempts: null,
      maxWindowUtilization: null,
      ...(options.policyReset ? {} : existing?.runBudget),
      ...incomingBudget,
    });
    // New and resumed records always carry every cap, as an explicit null when unlimited.
    const runBudget: RunBudgetPolicy = {
      ...mergedBudget,
      maxWindowUtilization: mergedBudget.maxWindowUtilization ?? null,
    };
    const maxChildDepth =
      incomingChildDepth ?? (options.policyReset ? undefined : existing?.maxChildDepth) ?? 8;
    registry.preflight(checkedDefinition(definition), existing ?? forkSource, null);
    {
      // Recorded child frames are preflighted against their own steps by RunChildren, which keeps
      // adapter-free replay of terminal calls. Every declared child the source never reached still
      // needs its adapters before any root effect, on resume and fork as on a fresh run. Recording
      // is tracked per declaration path: a child reached under one parent, or a dynamic child with
      // the same identity, says nothing about the same declaration elsewhere in the tree.
      const frames = (existing ?? forkSource)?.children ?? {};
      const recorded = new Set<string>();
      for (const frame of Object.values(frames)) {
        const path: [string, string][] = [];
        const seen = new Set<object>();
        let current: (typeof frames)[string] | undefined = frame;
        while (current?.declared && !seen.has(current)) {
          seen.add(current);
          path.unshift([current.workflow.name, current.workflow.version]);
          if (current.parent === null) {
            recorded.add(JSON.stringify(path));
            break;
          }
          current = Object.hasOwn(frames, current.parent) ? frames[current.parent] : undefined;
        }
      }
      // Walk declaration paths only while they stay recorded; the first unrecorded path makes its
      // whole declared subtree unrecorded, so that subtree is preflighted once per definition.
      const pending = (definition.children ?? []).map((child) => ({
        child,
        path: [[child.name, child.version]],
      }));
      const unrecorded: NonNullable<typeof definition.children>[number][] = [];
      while (pending.length) {
        const next = pending.pop();
        if (!next) break;
        if (!recorded.has(JSON.stringify(next.path))) {
          unrecorded.push(next.child);
          continue;
        }
        for (const child of next.child.children ?? [])
          pending.push({ child, path: [...next.path, [child.name, child.version]] });
      }
      const preflighted = new Set<object>();
      while (unrecorded.length) {
        const child = unrecorded.pop();
        if (!child || preflighted.has(child)) continue;
        preflighted.add(child);
        registry.preflight(child, undefined, null);
        unrecorded.push(...(child.children ?? []));
      }
    }
    if (
      existing?.status === 'completed' &&
      !options.acceptCodeChange &&
      !legacyReplay &&
      !Object.keys(existing.children ?? {}).length
    ) {
      const output = jsonValue(definition.output.parse(existing.output), 'Workflow output', {
        canonical: false,
      });
      if (
        migrating ||
        engineChanged ||
        incomingChildDepth !== undefined ||
        Object.keys(incomingBudget).length ||
        incomingPolicy.length ||
        incomingProfiles.length ||
        incomingGrants.length ||
        options.policyReset ||
        options.allowModelOverride !== undefined
      ) {
        existing.runBudget = runBudget;
        existing.maxChildDepth = maxChildDepth;
        existing.profileOverrides = profileOverrides;
        existing.grants = grants;
        existing.grantedProfiles = grantedProfiles;
        existing.policy = policy;
        existing.allowModelOverride = allowModelOverride;
        existing.policyWarnings = [];
        existing.updatedAt = new Date().toISOString();
        await storage.append(existing, { context: 'Could not save completed run metadata' });
      }
      const warnings = recordWarnings(existing);
      return {
        ...existing,
        status: 'completed',
        output: output as TOutput & JsonValue,
        ...(warnings.length ? { warnings } : {}),
      };
    }
    const now = new Date().toISOString();
    const record: RunRecord = existing ?? {
      formatVersion: 7,
      schemaRevision: SUPPORTED_SCHEMA_REVISION,
      seq: 0,
      engine,
      rootCause: null,
      maps: {},
      id: options.runId,
      workflow: { name: definition.name, version: definition.version, ...snapshot },
      cwd,
      input: savedInput,
      output: null,
      status: 'running',
      error: null,
      steps: {},
      createdAt: now,
      updatedAt: now,
    };
    record.runBudget = runBudget;
    record.maxChildDepth = maxChildDepth;
    delete record.budgetStop;
    for (const step of Object.values(record.steps))
      for (const attempt of step.attemptHistory ?? []) {
        // Legacy entries follow the kind they ran under; an ambiguous one is left untouched.
        const legacyKind =
          attempt.request === undefined ? legacyAttemptKind(step, attempt.attempt) : undefined;
        if (
          attempt.status === 'running' &&
          (attempt.integration ||
            attempt.request ||
            legacyKind === 'agent' ||
            legacyKind === 'claude' ||
            legacyKind === 'codex')
        ) {
          attempt.status = 'interrupted';
          attempt.error ??=
            'Agent attempt ended without a durable outcome; usage may be incomplete.';
        }
      }
    const budget = new RunBudget(record, runBudget, clock);
    const sessionSalt = (record.sessionSalt ??= randomUUID());
    if (options.launch) record.launch = structuredClone(options.launch);
    const priorHarness = record.harness ?? forkSource?.harness;
    record.harness = {
      kind: harnessKind,
      previousKinds: [
        ...new Set([
          ...(priorHarness?.previousKinds ?? []),
          ...(priorHarness && priorHarness.kind !== 'none' && priorHarness.kind !== harnessKind
            ? [priorHarness.kind]
            : []),
        ]),
      ],
      ...(options.harnessConfigDigest === undefined
        ? {}
        : { configDigest: options.harnessConfigDigest }),
    };
    if (options.acceptCodeChange && compatibility && compatibility.changed.length > 0) {
      (record.codeChanges ??= []).push({
        at: now,
        from: record.workflow.fingerprint,
        to: fingerprint,
        files: [...compatibility.files],
        components: [...compatibility.changed],
      });
      record.workflow = { name: definition.name, version: definition.version, ...snapshot };
    }
    if (legacyReplay)
      record.workflow = { name: definition.name, version: definition.version, ...snapshot };
    if (fork && forkSource && forkStateDir) {
      record.forkedFrom = {
        runId: fork.runId,
        stateDir: forkStateDir,
        sourceDigest: digest(forkSource),
        fingerprint: forkSource.workflow.fingerprint,
        reuse: fork.reuse ?? 'prefix',
        invalidate: [...(fork.invalidate ?? [])],
        differences: [...compareResume(definition, { ...options, input }, cwd, forkSource).changed],
        at: now,
        cursor: 0,
        reuseClosed: false,
      };
    } else if (record.forkedFrom) forkSource = await pinnedFork(record.forkedFrom);
    const replayWarnings = (record.replayWarnings = record.forkedFrom?.warning
      ? [record.forkedFrom.warning]
      : []);
    delete record.recoveryHint;
    const previousTerminal = Object.entries(record.steps)
      .filter(([, step]) => isTerminalStep(step) && step.legacyIdentity === undefined)
      .map(([id, step]) => ({ id, seq: step.seq ?? 0 }));
    // Committed settled maps join the pre-live skip check; their seq shares the step counter.
    const previousTerminalMaps = Object.entries(record.maps ?? {})
      .filter(
        ([, journal]) =>
          journal.status === 'completed' ||
          journal.items.some((item) => item.status === 'completed'),
      )
      .map(([id, journal]) => ({ id, seq: journal.seq ?? 0 }));
    let nextSeq =
      [...Object.values(record.steps), ...Object.values(record.maps ?? {})].reduce(
        (highest, entry) => Math.max(highest, entry.seq ?? 0),
        0,
      ) + 1;
    // The run's settlement counter: each terminal step settlement increments it, and each live
    // launch is stamped with its current value (ADR 0007). Derived like nextSeq, so the record
    // format is unchanged; any later launch reads at least every persisted stamp.
    let settlements = Object.values(record.steps).reduce(
      (highest, step) =>
        Math.max(highest, step.launchStamp ?? 0, step.settleStamp ?? 0, step.failureStamp ?? 0),
      0,
    );
    // Stamps taken when the body requests an effect, before any awaited preparation; read and
    // removed when the effect reaches its record.
    const launchStamps = new Map<string, number>();
    const takeLaunchStamp = (id: string): number => {
      const stamp = launchStamps.get(id) ?? settlements;
      launchStamps.delete(id);
      return stamp;
    };
    const settle = (step: StepRecord): number => {
      settlements += 1;
      step.settleStamp = settlements;
      return settlements;
    };
    // What earlier executions observed; the healed check must not see this run's relaunches.
    const priorSequence = Object.entries(record.steps).map(([id, step]) => ({
      id,
      seq: step.seq ?? 0,
      launchStamp: step.launchStamp,
    }));
    const healed = new Set<string>();
    let strictHealedDivergence: ReplayDivergenceError | undefined;
    let divergenceReported = false;
    record.profileOverrides = profileOverrides;
    record.grants = grants;
    record.grantedProfiles = grantedProfiles;
    record.capabilities = publicCapabilityManifest(capabilities);
    record.policy = policy;
    record.allowModelOverride = allowModelOverride;
    record.policyWarnings = [];
    const warnUnmatched = (): void => {
      record.policyWarnings = policy.flatMap((rule, index) =>
        matchedPolicy.has(index)
          ? []
          : [
              `Policy override ${String(index)} (${rule.kind ?? 'any kind'} ${rule.match ?? '**'}) matched no visited step.`,
            ],
      );
    };
    const activity = new RunActivity();
    function save(context = `Could not save run ${record.id}`, durable = true): Promise<void> {
      const finish = activity.begin();
      record.updatedAt = new Date().toISOString();
      return storage
        .append(record, { context, durable })
        .catch(async (error: unknown) => {
          const failure =
            error instanceof CheckpointError
              ? error
              : await checkpointError('save', stateDir, record.id, error, context);
          if (!checkpointProblems.includes(failure)) checkpointProblems.push(failure);
          controller.abort(failure);
          throw failure;
        })
        .finally(finish);
    }
    async function trySave(): Promise<boolean> {
      try {
        await save();
        return true;
      } catch {
        return false;
      }
    }
    const used = new Set<string>();
    const operations = new OperationTracker();
    const scopes = new ExecutionScopes(signal);
    const names = new NameScopes();
    const origins = new FailureOrigins();
    const visitedMaps = new Set<string>();
    const maps = (record.maps ??= {});
    // `effect` is the call-site effect kind (the harness for an agent call), or null for a scope,
    // phase, map or child operation; a failure before the step has a record reports it.
    function launch<T>(
      id: string,
      effect: string | null,
      work: () => T | PromiseLike<T>,
      waiting = false,
    ): Promise<T> {
      const effectOperation = effect !== null;
      // Synchronous with the body's request, so a same-tick sibling's later failure stamps after it.
      if (effectOperation) launchStamps.set(id, settlements);
      const finish =
        effectOperation && !waiting
          ? activity.begin()
          : () => {
              activity.touch();
            };
      activity.touch();
      return operations.launch(
        id,
        async () => {
          try {
            if (closed) throw new Error('Workflow is closed; await all workflow operations.');
            if (effectOperation) validateStepId(id, names.describe(id));
            return await work();
          } catch (error) {
            if (
              effectOperation &&
              origins.find(error).stepId === null &&
              !(error instanceof CancelledError) &&
              !(error instanceof CheckpointError)
            ) {
              origins.markFatal(error);
              origins.remember(error, id, effect);
            }
            throw error;
          } finally {
            finish();
          }
        },
        scopes.owners,
        waiting ? () => !questions.waiting(id) : undefined,
      );
    }
    const inEffect = new AsyncLocalStorage<true | 'poll'>();
    let closed = false;
    let observationsClosed = false;
    const notify = (event: WorkflowEvent): void => {
      try {
        void Promise.resolve(options.onEvent?.(structuredClone(event))).catch(() => {
          /* Observers do not own outcomes. */
        });
      } catch {
        /* Observers cannot invalidate persisted work. */
      }
    };
    const observations: RunObservations = new RunObservations(
      record,
      save,
      (event, replayed) => {
        notify({ ...event, message: event.message ?? '', attempt: 0, runId: record.id, replayed });
      },
      () => children.frame,
    );
    const children: RunChildren = new RunChildren({
      definition: checkedDefinition(definition),
      capabilities,
      grants,
      pins: grantedProfiles,
      overrides: profileOverrides,
      cwd,
      maxDepth: maxChildDepth,
      preflight: (owner, frame) => {
        registry.preflight(owner, existing ?? forkSource, frame);
      },
      record,
      names,
      scopes,
      operations,
      origins,
      used,
      visitedMaps,
      isCheckpointFailure: (error) => checkpointProblems.includes(error as CheckpointError),
      replayed: (id, step) => {
        replayedStep(id, step);
      },
      isInEffect: () => !!inEffect.getStore(),
      context: () => context,
      launch: (id, work, effect) => launch(id, effect, work),
      save,
      isolatePhase: (body) => observations.isolate(body),
      emit: (type, id, child) => {
        const replaced = type === 'child.redefined' ? child.redefinitions?.at(-1) : undefined;
        notify({
          type,
          frame: id,
          stepId: null,
          at: new Date().toISOString(),
          execution: observations.execution.n,
          runId: record.id,
          attempt: 0,
          message: `${replaced ? `${replaced.workflow.name}@${replaced.workflow.version} -> ` : ''}${child.workflow.name}@${child.workflow.version}: ${child.status}`,
        });
      },
    });
    const emit = (
      type: Exclude<WorkflowEvent['type'], RunEvent['type'] | `child.${string}`>,
      id: string,
      step: StepRecord,
      details: Partial<Omit<WorkflowEvent, 'type' | 'runId' | 'stepId' | 'attempt'>> = {},
    ): void => {
      notify({
        type,
        at: new Date().toISOString(),
        execution: observations.execution.n,
        runId: record.id,
        stepId: id,
        attempt: step.attempts,
        phase: step.phase ?? null,
        frame: step.frame ?? children.frame,
        ...details,
      });
    };

    const emitAdmission = (
      type: 'agent.queued' | 'agent.admitted',
      id: string,
      step: StepRecord,
      harness: string,
      waitedMs: number,
    ): void => {
      try {
        emit(type, id, step, { harness, waitedMs, ...limiter.snapshot() });
      } catch {
        /* Custom diagnostics must not leak or invalidate an invocation slot. */
      }
    };

    async function budgetAdmission(
      id: string,
      step: StepRecord,
      harness: string,
      signal: AbortSignal,
    ): Promise<{ permit: AgentPermit; finish: () => void }> {
      const refuse = (): Promise<never> => {
        origins.markFatal(budget.error);
        return budget.refuse();
      };
      if (budget.check(id, harness)) return refuse();
      const admission = limiter.acquire(harness, AbortSignal.any([signal, budget.signal]));
      emitAdmission('agent.queued', id, step, harness, 0);
      let permit: AgentPermit;
      try {
        permit = await admission;
      } catch (error) {
        if (budget.error) return refuse();
        throw error;
      }
      if (budget.check(id, harness)) {
        permit.release();
        return refuse();
      }
      // Reserve the attempt synchronously before any journal await admits a competing caller.
      return { permit, finish: budget.enter() };
    }

    // Attribute a step record to the currently active child frame, so summarizeChildren() and
    // frame-scoped events agree with the frame code runs under today, even for a step whose
    // identity/output were recorded under a different frame (a root scope refactored into a
    // child, or the reverse). Returns whether the persisted frame changed.
    function attributeFrame(step: StepRecord): boolean {
      const frame = children.frame;
      if ((step.frame ?? null) === frame) return false;
      if (frame !== null) step.frame = frame;
      else delete step.frame;
      return true;
    }

    async function beforeLive(id: string, step: StepRecord): Promise<void> {
      attributeFrame(step);
      if (strictHealedDivergence) {
        controller.abort(strictHealedDivergence);
        throw strictHealedDivergence;
      }
      if (!divergenceReported) {
        const skipped = previousTerminal
          .filter((previous) => previous.seq < (step.seq ?? 0) && !used.has(previous.id))
          .map((previous) => previous.id);
        const skippedMaps = previousTerminalMaps
          .filter((previous) => previous.seq < (step.seq ?? 0) && !visitedMaps.has(previous.id))
          .map((previous) => previous.id);
        if (skipped.length || skippedMaps.length) {
          divergenceReported = true;
          const unvisited = [
            ...(skipped.length ? [`earlier terminal steps (${skipped.join(', ')})`] : []),
            ...(skippedMaps.length
              ? [`earlier committed settled maps (${skippedMaps.join(', ')})`]
              : []),
          ].join(' and ');
          const warning = `Replay divergence before live step ${id}: ${unvisited} have not been visited. Order is a concurrency heuristic; restore the replay path or fork a new run.`;
          replayWarnings.push(warning);
          const failure = options.strictReplay
            ? new ReplayDivergenceError('before-live', warning)
            : undefined;
          if (failure) controller.abort(failure);
          await save();
          emit('replay.divergence', id, step, { message: warning, skippedStepIds: skipped });
          if (failure) throw failure;
        }
      }
    }

    // The root definition's policy, overlaid field by field by RunOptions (the CLI's flags).
    const worktreePolicy = effectiveWorktreePolicy(definition.worktrees, options.worktrees);
    const worktrees = new RunWorktrees(
      record,
      options.processRunner,
      worktreePolicy,
      save,
      processInvocation,
      signal,
      options.rehearsal !== undefined,
    );
    // Dry-run synthesizes fresh isolation and unchanged merges with read-only rev-parse only. The
    // accepted-replay probe synthesizes every Git effect and gets no runner, so it runs no Git.
    const probe = isPreflightProbe(options.rehearsal);
    const rehearsalWorktrees =
      options.rehearsal === undefined
        ? undefined
        : new WorktreeRehearsal(
            record,
            probe ? undefined : options.processRunner,
            worktreePolicy,
            save,
            processInvocation,
            signal,
            probe,
          );
    const notifyWorktree = (event: RehearsalWorktreeEvent): void => {
      try {
        options.rehearsal?.onWorktree?.(event);
      } catch {
        /* An observer cannot change the rehearsal. */
      }
    };

    /** Worktree isolation an effect runs inside; `agent` marks an agent call. */
    interface EffectIsolation {
      readonly value: ResolvedWorktree;
      readonly cwd: string;
      readonly agent?: boolean;
    }

    /** Named inputs of one durable effect; omitted optional fields take the defaults below. */
    interface EffectSpec<T, TMode extends ErrorMode> {
      readonly id: string;
      readonly kind: StepRecord['kind'];
      readonly schema: z.ZodType<T>;
      readonly execution: AttemptPolicy;
      readonly action: (
        context: StepContext,
        step: StepRecord,
        attempt: AttemptRecord,
        releaseAfterSave: (release: () => void) => void,
        transcript: AgentTranscriptWriter | undefined,
        reservedPermit?: AgentPermit,
      ) => Promise<T> | T;
      /** Identity input recorded for the step; omitted means null. */
      readonly dependencies?: JsonInput;
      /** Sleep deadline in clock milliseconds; omitted means null. */
      readonly wakeAt?: number | null;
      /** Agent request diagnostics; omitted means null. */
      readonly request?: RequestSummary | null;
      /**
       * Phase to record. Omitted means `observations.phase` at effect() entry; an explicit null
       * (a phase captured as null when the operation was called) is recorded as null.
       */
      readonly phase?: PhaseInfo | null;
      readonly identity?: StepIdentity;
      readonly local?: StepDefinition<T>;
      readonly onError?: TMode;
      readonly legacyDependencies?: JsonValue;
      /** The schema original format-one hashed for this effect; omitted means `schema`. */
      readonly legacySchema?: z.ZodType;
      readonly exec?: ExecSummary;
      /** Inspection labels of an exec; a local step's labels come from `local.meta`. */
      readonly meta?: Readonly<Record<string, JsonValue>>;
      readonly isolation?: EffectIsolation;
      /**
       * Under rehearsal, the effect is synthesized instead of touching Git: a fresh isolated agent
       * call, or a merge of unchanged changes; under the accepted-replay probe, every Git effect.
       * Omitted means false.
       */
      readonly rehearsalSynthesized?: boolean;
    }

    async function effect<T, TMode extends ErrorMode = 'throw'>(
      spec: EffectSpec<T, TMode>,
    ): Promise<EffectResult<T, TMode>> {
      // Rebind first, before any await, so the phase default reads observations.phase at entry.
      const { id, kind, schema, execution, action, local, onError, legacyDependencies, isolation } =
        spec;
      // The call-site label a failure reports: the harness for an agent step, otherwise its kind.
      const effectLabel = (kind === 'agent' ? spec.request?.harness : undefined) ?? kind;
      const launchStamp = takeLaunchStamp(id);
      // Captured with the ID's naming context: sibling named-map items are independent for fork reuse.
      const mapItems = names.items;
      const requestedIdentity = spec.identity;
      const observedExec = spec.exec;
      const wakeAt = spec.wakeAt === undefined ? null : spec.wakeAt;
      const observedRequest = spec.request === undefined ? null : spec.request;
      const observedPhase = spec.phase === undefined ? observations.phase : spec.phase;
      // Key presence, not undefined: a plain-JS step without input must still fail jsonValue().
      const dependencies = 'dependencies' in spec ? spec.dependencies : null;
      const signal = scopes.signal;
      const labels = spec.meta ?? local?.meta;
      const meta =
        labels === undefined
          ? undefined
          : z.record(z.string(), z.json()).parse(jsonValue(labels, `Step ${id} metadata`));
      const value = (output: T): EffectResult<T, TMode> =>
        (onError === 'return' ? { ok: true, value: output } : output) as EffectResult<T, TMode>;
      const replay = (step: StepRecord): EffectResult<T, TMode> =>
        step.status === 'settled-failed'
          ? ({ ok: false, error: structuredClone(step.settledError) } as EffectResult<T, TMode>)
          : value(
              jsonValue(schema.parse(structuredClone(step.output)), `Step "${id}" output`, {
                canonical: false,
              }) as T,
            );
      if (closed) throw new Error('Workflow is closed; await all workflow operations.');
      if (inEffect.getStore())
        throw new Error(
          "Nested durable steps are unsupported; compose steps in the workflow body, or run a non-durable command with the callback's context.exec.",
        );
      signal.throwIfAborted();
      validateStepId(id, names.describe(id));
      if (used.has(id)) throw duplicateStepId(id, names.describe(id));
      if (record.children?.[id])
        throw new Error(`Step ${id} collides with a recorded child frame.`);
      used.add(id);
      scopes.step(id);
      const { maxAttempts, delayMs } = execution.policy.retry;
      let identity: StepIdentity;
      let stepFingerprint: string;
      try {
        const savedDependencies = jsonValue(dependencies, `Step "${id}" dependencies`);
        if (onError !== undefined && onError !== 'throw' && onError !== 'return')
          throw new Error('onError must be throw or return.');
        if (
          local &&
          (typeof local.run !== 'function' ||
            (local.version !== undefined &&
              (typeof local.version !== 'string' || !local.version.trim())))
        )
          throw new Error(
            'Local effects require a run callback and, when supplied, a nonempty string version.',
          );
        if (
          local?.identity !== undefined &&
          ((local.identity as unknown) !== 'version' ||
            typeof local.version !== 'string' ||
            !local.version.trim())
        )
          throw new Error(
            "Version-identified local effects require identity: 'version' and a nonempty string version.",
          );
        identity =
          requestedIdentity ??
          stepIdentity({
            kind,
            onError: onError ?? 'throw',
            input: savedDependencies,
            schema: schemaJson(schema),
            ...(local
              ? {
                  // Built-in helpers are named by an explicit version; public steps keep
                  // callback-plus-version identity (durability.md, ADR 0005).
                  ...(local.identity === 'version'
                    ? {}
                    : { callback: Function.prototype.toString.call(local.run) }),
                  version: local.version ?? null,
                  cwd,
                  ...(local.worktree === undefined
                    ? {}
                    : { worktree: isolationIdentity(local.worktree) }),
                }
              : {}),
          });
        stepFingerprint = digest(identity);
      } catch (cause) {
        throw new Error(`Step ${id}: ${message(cause)}`, { cause });
      }
      const prior = Object.hasOwn(record.steps, id) ? record.steps[id] : undefined;
      const forkedFrom = record.forkedFrom;
      const replayInput: ReplayInput = {
        id,
        kind,
        prior,
        identity,
        fingerprint: stepFingerprint,
        onError,
        request: observedRequest,
        // Lazy: a terminal legacy agent step must be refused before anything computes it, and a
        // user schema may lack a JSON Schema form. An agent hashes its frozen format-one wrapper,
        // never the runtime result schema, whose usage normalization is a transform.
        legacyFingerprint: () =>
          digest({
            kind: legacyKind(kind, observedRequest),
            dependencies: legacyDependencies ?? jsonValue(dependencies),
            schema: schemaJson(spec.legacySchema ?? schema),
            retry: {
              maxAttempts: local?.retry?.maxAttempts ?? 1,
              delayMs: local?.retry?.delayMs ?? 100,
            },
          }),
        forkedFrom: forkedFrom !== undefined,
        // Called at most once, only when decideReplay reaches fork reuse. Prefix reuse reads the
        // copies already in record.steps, so a reused copy is inserted before the next await.
        forkCandidate: () =>
          forkedFrom &&
          reuseCandidate(
            forkedFrom,
            forkSource,
            id,
            kind,
            stepFingerprint,
            (sourceStep) =>
              forkReuseValid(
                kind,
                onError,
                sourceStep,
                (output) => schema.safeParse(structuredClone(output)).success,
              ),
            { launchStamp, mapItems, target: record.steps },
          ),
        rehearsal: options.rehearsal !== undefined,
        isolated: isolation !== undefined,
        rehearsalSynthesized: spec.rehearsalSynthesized === true,
        strictHealedDivergence: strictHealedDivergence !== undefined,
      };
      const decision = decideReplay(replayInput);
      let outcome = decision.outcome;
      if (decision.migrateLegacy && prior) {
        prior.kind = kind;
        if (kind === 'agent' && observedRequest) {
          prior.harness = observedRequest.harness;
          prior.revision = observedRequest.revision ?? 1;
        }
        prior.fingerprint = stepFingerprint;
        prior.identity = identity;
        prior.seq = nextSeq++;
        delete prior.legacyIdentity;
        await save();
        // A concurrent effect may have recorded a strict healed divergence during the save.
        outcome = decideReplay({
          ...replayInput,
          strictHealedDivergence: strictHealedDivergence !== undefined,
        }).outcome;
      }
      if (outcome.kind === 'refuse') {
        const { refusal } = outcome;
        if (refusal.reason !== 'strict-healed-divergence')
          throw refusal.reason === 'rehearsal-git'
            ? new ConfigurationError(replayRefusalMessage(id, refusal))
            : refusal.reason === 'terminal-redefined'
              ? new StepIdentityChangedError(replayRefusalMessage(id, refusal), {
                  stepId: id,
                  components: refusal.changed,
                  status: refusal.status,
                })
              : new Error(replayRefusalMessage(id, refusal));
        // decideReplay refuses this way only while a divergence is recorded.
        if (strictHealedDivergence) {
          controller.abort(strictHealedDivergence);
          throw strictHealedDivergence;
        }
      }
      if (outcome.kind === 'replay' && prior) {
        const output = replay(prior);
        if (attributeFrame(prior)) await save();
        emit('step.replayed', id, prior);
        return output;
      }
      const wasFailed = prior?.status === 'failed';
      // Captured before this execution can mutate the prior record.
      const priorFailureStamp = prior?.failureStamp;
      if (outcome.kind === 'reuse-fork' && forkedFrom) {
        const { candidate } = outcome;
        const copied: StepRecord = {
          ...structuredClone(candidate),
          seq: nextSeq++,
          // The source run's stamps belong to its own clock; stamp the copy in this run.
          launchStamp,
          reusedFrom: {
            runId: forkedFrom.runId,
            stateDir: forkedFrom.stateDir,
            stepId: id,
            fingerprint: stepFingerprint,
            at: new Date().toISOString(),
          },
        };
        delete copied.failureStamp;
        settle(copied);
        attributeFrame(copied);
        Object.defineProperty(record.steps, id, {
          value: copied,
          enumerable: true,
          configurable: true,
          writable: true,
        });
        await save();
        emit('step.reused', id, copied);
        return replay(copied);
      }
      const redefined = outcome.kind === 'redefine';
      const step: StepRecord = prior ?? {
        kind,
        ...(meta === undefined ? {} : { meta }),
        ...(kind === 'agent' && observedRequest
          ? { harness: observedRequest.harness, revision: observedRequest.revision ?? 1 }
          : {}),
        fingerprint: stepFingerprint,
        status: 'running',
        attempts: 0,
        output: null,
        error: null,
        wakeAt,
        identity,
        seq: nextSeq++,
        attemptHistory: [],
        phase: observedPhase?.title ?? null,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        request: observedRequest,
        errorStack: null,
      };
      await beforeLive(id, step);
      const agent = kind === 'agent' || kind === 'claude' || kind === 'codex';
      for (let attempt = 1; ; attempt++) {
        signal.throwIfAborted();
        // Captured before budget admission: a saturated limiter's queue wait is part of the
        // attempt's and step's persisted timing, not just the work after admission clears.
        const attemptStartedAt = new Date().toISOString();
        const attemptStarted = performance.now();
        let admitted: Awaited<ReturnType<typeof budgetAdmission>> | undefined;
        try {
          // A redefined step is admitted under the harness it is about to run, not the prior one.
          const admittingHarness =
            kind === 'agent' && observedRequest ? observedRequest.harness : (step.harness ?? kind);
          admitted =
            agent && budget.enabled
              ? await budgetAdmission(id, step, admittingHarness, signal)
              : undefined;
        } catch (cause) {
          // A queued first attempt leaves no record; a queued retry must not stay 'failed'.
          if (
            attempt === 1 ||
            !signal.aborted ||
            cause instanceof RunBudgetExceededError ||
            signal.reason instanceof CheckpointError
          )
            throw cause;
          const cancelled = cancellationError(signal, cause);
          origins.remember(cancelled, id, effectLabel);
          step.status = 'cancelled';
          step.cancelledBy = cancelled.cancelledBy;
          step.error = cancelled.message;
          step.errorStack = errorStack(cancelled);
          step.finishedAt = new Date().toISOString();
          settle(step);
          if (await trySave()) emit('step.cancelled', id, step);
          throw cancelled;
        }
        try {
          if (attempt === 1) {
            step.launchStamp = launchStamp;
            if (redefined) {
              (step.redefinitions ??= []).push({
                fingerprint: step.fingerprint,
                identity: step.identity ?? {},
                redefinedAt: new Date().toISOString(),
                kind: step.kind,
                attempts: step.attempts,
              });
              step.kind = kind;
              if (kind === 'agent' && observedRequest) {
                step.harness = observedRequest.harness;
                step.revision = observedRequest.revision ?? 1;
              }
              step.fingerprint = stepFingerprint;
              step.identity = identity;
              step.wakeAt = wakeAt;
              step.output = null;
              step.error = null;
              step.status = 'running';
              delete step.settledError;
              delete step.worktree;
              delete step.merge;
            }
            Object.defineProperty(record.steps, id, {
              value: step,
              enumerable: true,
              configurable: true,
              writable: true,
            });
            if (redefined) {
              await save();
              emit('step.redefined', id, step);
            }
          }

          step.attempts++;
          step.status = 'running';
          step.error = null;
          delete step.warnings;
          step.errorStack = null;
          step.phase = observedPhase?.title ?? null;
          step.request = observedRequest;
          if (observedExec) step.exec = structuredClone(observedExec);
          else delete step.exec;
          delete step.execError;
          step.startedAt = attemptStartedAt;
          step.finishedAt = null;
          step.durationMs = null;
          delete step.cancelledBy;
          const attemptRecord: AttemptRecord = {
            ...structuredClone(execution),
            attempt: step.attempts,
            fingerprint: stepFingerprint,
            execution: observations.execution.n,
            durationMs: null,
            usage: null,
            errorStack: null,
            request: structuredClone(observedRequest),
            ...(observedExec ? { exec: structuredClone(observedExec) } : {}),
            startedAt: step.startedAt,
            finishedAt: null as string | null,
            status: 'running',
            error: null as string | null,
          };
          if (step.harness === 'claude' || kind === 'claude')
            attemptRecord.requestedSessionId = deriveAgentSessionId(sessionSalt, id, step.attempts);
          (step.attemptHistory ??= []).push(attemptRecord);
          await save(undefined, kind === 'sleep' || agent);
          let lease: WorktreeLease | undefined;
          let transcript: AgentTranscriptWriter | undefined;
          // Close once: a stalled close already waited its full deadline on the success path.
          let transcriptClosed = false;
          const transcriptFailure = async (cause: unknown): Promise<never> => {
            const failure =
              cause instanceof CheckpointError
                ? cause
                : await checkpointError(
                    'save',
                    stateDir,
                    record.id,
                    cause,
                    `Could not write transcript for step ${id}`,
                  );
            if (!checkpointProblems.includes(failure)) checkpointProblems.push(failure);
            controller.abort(failure);
            throw failure;
          };
          const recordTranscript = (): void => {
            if (!transcript) return;
            attemptRecord.transcript = transcript.snapshot();
            attemptRecord.diagnostics = {
              ...attemptRecord.diagnostics,
              transcript: jsonValue(attemptRecord.transcript),
            };
          };
          const releases: (() => void)[] = [];
          try {
            try {
              signal.throwIfAborted();
              emit('step.started', id, step);
              const result = await inEffect.run(true, async () => {
                let reporting = true;
                const context: Omit<StepContext, 'exec'> = {
                  reportUsage: (usage) => {
                    if (
                      !reporting ||
                      kind !== 'step' ||
                      attemptRecord.status !== 'running' ||
                      closed
                    )
                      throw new Error(
                        `Step ${id}: usage must be reported inside its active local callback.`,
                      );
                    attemptRecord.usage = normalizeUsage(usage);
                    attemptRecord.integration =
                      typeof meta?.['integration'] === 'string'
                        ? meta['integration'].slice(0, 100) || 'local'
                        : 'local';
                  },
                  signal,
                  cwd,
                  idempotencyKey: `${record.id}/${id}`,
                  attempt: step.attempts,
                };
                if (isolation && rehearsalWorktrees) {
                  // decideReplay refused every unsynthesized isolation under rehearsal; only the
                  // accepted-replay probe reaches here with isolation on a handle.
                  const synthesized = await rehearsalWorktrees.isolate(
                    id,
                    isolation.value,
                    isolation.cwd,
                    context,
                    step,
                    attemptRecord,
                  );
                  lease = synthesized.lease;
                  notifyWorktree(synthesized.event);
                } else if (isolation)
                  lease = await worktrees.prepare(
                    id,
                    isolation.value,
                    isolation.cwd,
                    context,
                    step,
                    attemptRecord,
                  );
                signal.throwIfAborted();
                if (agent && execution.policy.transcripts !== 'off') {
                  try {
                    if (!storage.transcript)
                      throw new Error(
                        'RunStore must implement transcript storage or use policy transcripts: "off".',
                      );
                    transcript = await storage.transcript(
                      id,
                      step.attempts,
                      step.harness ?? kind,
                      execution.policy.maxTranscriptBytes ?? 64 * 1024 * 1024,
                    );
                    recordTranscript();
                    await save();
                  } catch (error) {
                    return transcriptFailure(error);
                  }
                }
                // Inner commands share the attempt signal and stop when the callback settles.
                const actionCwd = lease ? lease.cwd : cwd;
                const innerExec = stepExec({
                  owner: { kind: 'step', id },
                  cwd: actionCwd,
                  attempt: step.attempts,
                  signal,
                  options: stepExecOptionsSchema,
                  active: () => !closed,
                });
                try {
                  return await action(
                    { ...context, cwd: actionCwd, exec: innerExec.exec },
                    step,
                    attemptRecord,
                    (release) => {
                      releases.push(release);
                    },
                    transcript,
                    admitted?.permit,
                  );
                } finally {
                  reporting = false;
                  await innerExec.close(
                    new Error(`Step ${id}: its callback settled; inner command terminated.`),
                  );
                }
              });
              if (transcript) {
                transcriptClosed = true;
                await boundedTranscript(transcript, 'close').catch(transcriptFailure);
                recordTranscript();
              }
              // A resolved, valid result is durable work even if cancellation arrived meanwhile.
              // The scope still rejects its next launch.
              const output = schema.parse(result);
              step.output = jsonValue(output, `Step "${id}" output`);
              if (lease) {
                const activeLease = lease;
                const { base, commit, ref, files } = await inEffect.run(true, () =>
                  activeLease.capture(),
                );
                const change = { base, commit, ref, files };
                if (isolation?.agent)
                  step.output = jsonValue(
                    schema.parse({ ...output, worktree: change }),
                    `Step "${id}" output`,
                  );
              }
            } catch (caught) {
              let cause: unknown = caught;
              if (transcript) {
                if (!transcriptClosed)
                  try {
                    await boundedTranscript(transcript, 'close').catch(transcriptFailure);
                  } catch (failure) {
                    // A storage failure cannot become a retry or a settled fallback.
                    cause = failure;
                  }
                recordTranscript();
              }
              lease?.failed();
              // ADR 0007 rules live in attempt-failure.ts; this runs after the transcript-close block,
              // which may have replaced cause with a storage failure.
              const classification = classifyAttemptFailure({
                cause,
                aborted: signal.aborted,
                checkpointProblem: checkpointProblems.includes(cause as CheckpointError),
                retryOn: execution.policy.retry.on,
                attempt,
                maxAttempts,
                onError,
              });
              const error = classification.scoped ? cancellationError(signal, cause) : cause;
              origins.remember(error, id, effectLabel);
              const outcome = stepError(error, step.attempts);
              step.status = classification.status;
              if (error instanceof CancelledError) step.cancelledBy = error.cancelledBy;
              step.error = outcome.message;
              step.errorStack = errorStack(error);
              attemptRecord.errorStack = step.errorStack;
              attemptRecord.errorKind = outcome.kind;
              attemptRecord.status = classification.status;
              step.finishedAt = attemptRecord.finishedAt = new Date().toISOString();
              step.durationMs = attemptRecord.durationMs = Math.max(
                0,
                Math.round(performance.now() - attemptStarted),
              );
              attemptRecord.error = step.error;
              if (cause instanceof ExecError) {
                step.execError = structuredClone(cause.diagnostics);
                attemptRecord.execError = structuredClone(cause.diagnostics);
              }
              const evidence = harnessEvidence(cause);
              if (agent && cause instanceof z.ZodError)
                attemptRecord.validationIssues = jsonValue(cause.issues) as JsonValue[];
              if (evidence) {
                if (evidence.usage !== null)
                  attemptRecord.usage = normalizeUsage(
                    evidence.usage,
                    observedRequest?.model ?? null,
                  );
                attemptRecord.diagnostics = mergeDiagnostics(
                  attemptRecord.diagnostics,
                  evidence.diagnostics,
                );
                attemptRecord.sessionId = preserveFirstSessionId(attemptRecord, evidence.sessionId);
                attemptRecord.response = evidence.rawText;
                attemptRecord.responseTruncated = evidence.responseTruncated;
                recordTranscript();
              }
              if (agent) {
                (step.failedAttempts ??= []).push({
                  attempt: step.attempts,
                  sessionId: attemptRecord.sessionId ?? null,
                  usage: attemptRecord.usage ?? null,
                });
                emit('agent.finished', id, step, {
                  harness: step.harness ?? kind,
                  outcome: classification.status,
                  sessionId: attemptRecord.sessionId ?? attemptRecord.requestedSessionId ?? null,
                  ...(attemptRecord.usage ? { usage: attemptRecord.usage } : {}),
                  diagnostics: attemptRecord.diagnostics ?? {},
                });
              }
              if (classification.markFatal) origins.markFatal(error);
              if (classification.settle) {
                step.status = 'settled-failed';
                // A settled command also keeps its exit code, signal, output tails and parsed JSON.
                step.settledError =
                  kind === 'exec' && error instanceof ExecError
                    ? { ...outcome, ...execFailureFields(error) }
                    : outcome;
                settle(step);
                if (!(await trySave())) throw error;
                emit('step.settled', id, step);
                return replay(step);
              }
              if (!classification.retry) {
                // Terminal: stamped before the save that persists the status. A failure saved
                // between retries carries no new stamp, so a crash in backoff stays conservative.
                const stamp = settle(step);
                if (step.status === 'failed') step.failureStamp ??= stamp;
              }
              if (await trySave())
                emit(classification.scoped ? 'step.cancelled' : 'step.failed', id, step);
              if (!classification.retry || signal.reason instanceof CheckpointError) throw error;
              try {
                await waitUntil(
                  clockNow(clock) + Math.min(30_000, delayMs * 2 ** (attempt - 1)),
                  signal,
                  clock,
                );
              } catch (cause) {
                if (signal.reason instanceof CheckpointError) throw error;
                if (errorKind(cause) !== 'cancelled') throw cause;
                const cancelled = cancellationError(signal, cause);
                origins.remember(cancelled, id, effectLabel);
                step.status = 'cancelled';
                step.cancelledBy = cancelled.cancelledBy;
                step.error = cancelled.message;
                step.errorStack = errorStack(cancelled);
                step.finishedAt = new Date().toISOString();
                step.durationMs = Math.max(0, Math.round(performance.now() - attemptStarted));
                settle(step);
                // The completed failed attempt remains history; cancellation interrupted its backoff.
                if (await trySave()) emit('step.cancelled', id, step);
                throw cancelled;
              }
              continue;
            }
            step.status = 'completed';
            attemptRecord.status = 'completed';
            settle(step);
            delete step.failureStamp;
            if (agent) {
              delete attemptRecord.response;
              delete attemptRecord.responseTruncated;
            }
            lease?.completed();
            step.finishedAt = attemptRecord.finishedAt = new Date().toISOString();
            step.durationMs = attemptRecord.durationMs = Math.max(
              0,
              Math.round(performance.now() - attemptStarted),
            );
            await save(
              `Step ${id} completed but its checkpoint write failed; resume may repeat it unless a later save recovers the result`,
            );
            if (transcript && execution.policy.transcripts === 'on-failure') {
              try {
                await boundedTranscript(transcript, 'discard');
                recordTranscript();
                if (
                  step.output !== null &&
                  typeof step.output === 'object' &&
                  !Array.isArray(step.output)
                )
                  step.output['diagnostics'] = jsonValue(attemptRecord.diagnostics);
              } catch (error) {
                // The attempt's action may have set warnings since the reset above; TS cannot see it.
                const warnings = step.warnings as readonly string[] | undefined;
                step.warnings = [
                  ...(warnings ?? []),
                  `Could not remove successful transcript: ${message(error)}`,
                ];
              }
              await save();
            }
            const metadata =
              kind === 'agent' || kind === 'claude' || kind === 'codex'
                ? (step.output as unknown as AgentResult<unknown>)
                : undefined;
            if (metadata)
              emit('agent.finished', id, step, {
                harness: step.harness ?? kind,
                outcome: 'completed',
                sessionId: metadata.sessionId,
                usage: metadata.usage,
                diagnostics: metadata.diagnostics ?? {},
                ...(step.warnings?.length ? { warnings: [...step.warnings] } : {}),
              });
            emit(
              'step.completed',
              id,
              step,
              metadata === undefined
                ? {}
                : {
                    usage: metadata.usage,
                    sessionId: metadata.sessionId,
                  },
            );
            if (wasFailed && !healed.has(id)) {
              const later = healedDependents(
                { id, seq: step.seq ?? 0, failureStamp: priorFailureStamp },
                priorSequence,
              );
              if (later.length) {
                healed.add(id);
                const warning = `Healed step ${id} now succeeded; later recorded steps (${later.join(', ')}) may depend on its earlier failure. Use onError: return for durable fallback decisions.`;
                replayWarnings.push(warning);
                if (options.strictReplay)
                  strictHealedDivergence = new ReplayDivergenceError('healed', warning);
                await save();
                emit('replay.divergence', id, step, {
                  message: warning,
                  healedStepId: id,
                  skippedStepIds: later,
                });
              }
            }
            return value(
              jsonValue(schema.parse(structuredClone(step.output)), `Step "${id}" output`, {
                canonical: false,
              }) as T,
            );
          } finally {
            lease?.release();
            for (const release of releases.reverse()) release();
          }
        } finally {
          admitted?.permit.release();
          admitted?.finish();
        }
      }
    }

    /**
     * Bind a callback's or observer's non-durable `context.exec` to this run's runners. A live
     * observer call goes to processRunner only under a rehearsal, where the CLI supplies the real
     * runner; otherwise it uses execRunner like every other command, so fixture rules still apply.
     */
    function stepExec(
      binding: Omit<StepExecDependencies, 'invocation' | 'runner' | 'onSchema'>,
    ): StepExecHandle {
      return createStepExec({
        ...binding,
        invocation: (signal) =>
          processInvocation(binding.owner.id, { signal, attempt: binding.attempt }),
        runner: (live) =>
          live && options.rehearsal !== undefined
            ? options.processRunner
            : (options.execRunner ?? options.processRunner),
        onSchema: (schema) => options.rehearsal?.onSchema?.(binding.owner.id, schema),
      });
    }

    function processInvocation(
      id: string,
      context: Pick<StepContext, 'signal' | 'attempt'>,
    ): HarnessInvocation {
      return {
        signal: context.signal,
        runId: options.runId,
        stepId: id,
        attempt: context.attempt,
        trackProcess: async (child) => {
          try {
            return await storage.trackProcess(
              { runId: options.runId, stepId: id, attempt: context.attempt },
              child,
            );
          } catch (cause) {
            const error = await checkpointError(
              'process',
              stateDir,
              options.runId,
              cause,
              `Could not record process for ${id}`,
            );
            checkpointProblems.push(error);
            controller.abort(error);
            throw error;
          }
        },
      };
    }

    function exec<T, TMode extends ErrorMode>(
      leaf: string,
      command: Command,
      settings: ExecOptions,
      schema: z.ZodType<T> | null,
    ): Promise<EffectResult<T, TMode, ExecStepError>> {
      const id = names.qualify(leaf);
      const phase = observations.phase;
      return launch(id, 'exec', async () => {
        if (schema !== null && !(schema instanceof z.ZodType))
          throw new Error('exec.json requires a Zod schema.');
        // Strip the built-in helper's identity before the strict option schema sees the settings.
        const { [execIdentityKey]: helperIdentity, ...publicSettings } = settings as ExecOptions &
          InternalExecIdentity;
        const helper =
          helperIdentity === undefined
            ? undefined
            : jsonValue(helperIdentity, `Step "${id}" exec identity`);
        const prepared = await prepareExec(command, publicSettings, cwd, schema !== null);
        // The error mode is neither policy nor part of the summary; it enters identity only as 'return'.
        // Labels are neither: they are recorded on the step for inspection only.
        const { onError: checkedOnError, meta, ...policySettings } = prepared.settings;
        const onError = checkedOnError as TMode | undefined;
        const execution = resolvePolicy(
          id,
          'exec',
          policySettings,
          { timeoutMs: 300_000, maxOutputBytes: 1_048_576 },
          policy,
          matchedPolicy,
        );
        // Plain exec is called with T = ExecResult and no schema.
        const outputSchema = (schema ?? execResultSchema) as z.ZodType<T>;
        const jsonSchema = schemaJson(outputSchema);
        options.rehearsal?.onSchema?.(id, outputSchema);
        const summary = jsonValue(prepared.summary) as Record<string, JsonValue>;
        const identity = stepIdentity({
          kind: 'exec',
          ...(prepared.settings.worktree === undefined
            ? {}
            : { worktree: isolationIdentity(prepared.settings.worktree) }),
          // A helper's stable value stands in for the argv, which can embed paths and program text.
          ...(helper === undefined
            ? summary
            : {
                ...Object.fromEntries(Object.entries(summary).filter(([key]) => key !== 'command')),
                helper,
              }),
          schema: jsonSchema,
          ...(onError === 'return' ? { onError } : {}),
        });
        // The settled error of a command carries ExecStepError's process fields.
        return effect<T, TMode>({
          id,
          kind: 'exec',
          schema: outputSchema,
          execution,
          action: (context) =>
            executeCommand<T>(
              options.execRunner ?? options.processRunner,
              processRequest(
                prepared,
                {
                  cwd:
                    prepared.settings.worktree === undefined ? prepared.summary.cwd : context.cwd,
                  timeoutMs: execution.policy.timeoutMs ?? 300_000,
                  maxOutputBytes: execution.policy.maxOutputBytes ?? 1_048_576,
                },
                schema ? jsonSchema : null,
              ),
              processInvocation(id, context),
              prepared.summary.okExitCodes,
              schema,
            ) as Promise<T>,
          identity,
          phase,
          ...(onError === undefined ? {} : { onError }),
          exec: prepared.summary,
          ...(meta === undefined ? {} : { meta }),
          ...(prepared.settings.worktree === undefined
            ? {}
            : {
                isolation: { value: prepared.settings.worktree, cwd: prepared.summary.cwd },
                // Only the accepted-replay probe synthesizes an isolated command.
                rehearsalSynthesized: probe,
              }),
        });
      });
    }

    // Keyed by registration; a Map (not WeakMap) so draining can release abandoned discovery.
    const metadataRequests = new Map<object, Promise<HarnessMetadata | undefined>>();
    // Project instruction detection, keyed by registration and then by isolation mode, env edits
    // and cwd.
    const projectRequests = new Map<object, Map<string, Promise<void>>>();
    // Harness and cwd pairs this invocation already recorded: the first detection replaces a
    // (possibly stale, resumed) entry, and later ones merge into it.
    const projectRecorded = new Set<string>();
    // Discovery is run-owned; an aborted scope may abandon its wait, so draining releases the rest.
    const discoveryController = new AbortController();
    const discoverySignal = AbortSignal.any([signal, discoveryController.signal]);
    async function drainDiscovery(): Promise<void> {
      // Every effect that awaited discovery has settled, so any unsettled request is abandoned.
      discoveryController.abort(new CancelledError(null, undefined));
      await Promise.allSettled([
        ...metadataRequests.values(),
        ...[...projectRequests.values()].flatMap((byCwd) => [...byCwd.values()]),
      ]);
    }
    function client<TOptions extends AgentOptions>(harness: string): AgentClient<TOptions> {
      function invoke<T, TMode extends ErrorMode, TResult>(
        leaf: string,
        agentOptions: TOptions & { readonly onError?: TMode | undefined },
        outputSchema: () => z.ZodType<T>,
        structured: boolean,
        select: (result: EffectResult<AgentResult<T>, TMode>) => TResult,
      ): Promise<TResult> {
        const id = names.qualify(leaf);
        const phase = observations.phase;
        return launch(id, harness, async () => {
          let request: HarnessRequestInput<ClaudeOptions & CodexOptions>;
          let schema: z.ZodType<T>;
          let execution: AttemptPolicy;
          let profile: ResolvedProfile;
          let legacyRequest: JsonValue;
          const registration = registry.definitions(children.definition).get(harness);
          if (!registration)
            throw new Error(
              `Workflow ${children.definition.name} has no declared harness ${harness}.`,
            );
          if (structured && registration.capabilities.structuredOutput === 'none')
            throw new Error(`Harness ${harness} does not support structured output.`);
          const native = harness === 'claude' || harness === 'codex';
          // Top-level option keys of a registered harness; request options are filtered to them.
          const shape =
            registration.options instanceof z.ZodObject
              ? (registration.options.shape as Record<string, unknown>)
              : {};
          const saved = record.steps[id];
          const replayOnly = saved !== undefined && isTerminalStep(saved);
          let adapter: Harness | undefined;
          try {
            const data = jsonValue(
              { options: optionData(agentOptions, structured) },
              `Step "${id}" agent request`,
            ) as {
              options: TOptions & JsonValue;
            };
            if (native) validateAgentOptions(harness, data.options, false);
            harnessOptions(registration, data.options);
            const resolvedProfile = resolveProfileCall(
              children.authority?.manifest ?? capabilities,
              harness,
              data.options,
              children.authority?.grants ?? grants,
              children.authority?.pins ?? grantedProfiles,
              registration,
              { callCwd: resolve(cwd, data.options.cwd ?? '.'), rootCwd: cwd },
            );
            profile = resolvedProfile.profile;
            children.authority?.check(profile.name, harness, resolvedProfile.options, registration);
            schema = outputSchema();
            legacyRequest = jsonValue({
              provider: harness,
              options: data.options,
              cwd: resolve(cwd, data.options.cwd ?? '.'),
              outputSchema: structured ? schemaJson(schema) : null,
            });
            options.rehearsal?.onSchema?.(id, schema);
            // A missing adapter or failed factory is reported by the live attempt as a
            // ConfigurationError, so the step records the failure and it is never settled,
            // retried, or journaled as map data.
            try {
              adapter =
                replayOnly || !registry.available(registration)
                  ? undefined
                  : registry.adapter(registration);
            } catch (cause) {
              if (!(cause instanceof ConfigurationError)) throw cause;
              adapter = undefined;
            }
            // Record and pass on only the limits the harness declares, keyed on its registration
            // so records do not depend on adapter availability (replay, rehearsal).
            const limitKeys = agentLimitKeys(harness, Object.keys(shape));
            execution = resolvePolicy(
              id,
              harness,
              data.options,
              adapter?.policyDefaults?.(harness) ?? {},
              policy,
              matchedPolicy,
              profile,
              children.authority?.overrides ?? profileOverrides,
              limitKeys,
            );
            if (children.authority) {
              const bounded = { ...children.authority.limits(profile.name, execution.policy) };
              // A delegated ceiling fills absent limits; drop the ones this harness never declares.
              for (const field of ['maxTurns', 'maxBudgetUsd'] as const)
                if (!limitKeys.includes(field)) Reflect.deleteProperty(bounded, field);
              const sources = { ...execution.sources };
              for (const field of [
                'timeoutMs',
                'idleTimeoutMs',
                'maxTurns',
                'maxBudgetUsd',
              ] as const)
                if (bounded[field] !== execution.policy[field])
                  sources[field] = `child-delegation:${profile.name}`;
              execution = {
                ...execution,
                policy: bounded,
                sources,
              };
            }
            // Provider semantics supply model/effort defaults, while per-call and launch policy win.
            if (execution.requestedModel === null && resolvedProfile.options.model !== undefined)
              execution = {
                ...execution,
                requestedModel: resolvedProfile.options.model,
                sources: { ...execution.sources, model: `profile:${profile.name}` },
              };
            // Codex effort is a policy control (call site, then override); the profile fills a gap.
            const profileEffort = (resolvedProfile.options as CodexOptions).effort;
            if (harness === 'codex' && execution.effort === null && profileEffort !== undefined)
              execution = {
                ...execution,
                effort: profileEffort,
                sources: { ...execution.sources, effort: `profile:${profile.name}` },
              };
            // Claude effort is semantic only; record where it came from.
            if (harness === 'claude' && resolvedProfile.options.effort !== undefined)
              execution = {
                ...execution,
                sources: {
                  ...execution.sources,
                  effort:
                    (data.options as { readonly effort?: unknown }).effort === undefined
                      ? `profile:${profile.name}`
                      : 'call-site',
                },
              };
            request = jsonValue(
              {
                harness,
                revision: registration.revision,
                options: resolvedProfile.options,
                cwd: resolve(cwd, data.options.cwd ?? '.'),
                outputSchema: structured ? schemaJson(schema) : null,
              },
              `Step "${id}" agent request`,
            ) as unknown as HarnessRequestInput<ClaudeOptions & CodexOptions>;
          } catch (cause) {
            throw new Error(`Step ${id}: ${message(cause)}`, { cause });
          }
          if (request.harness === 'codex' && request.options.images !== undefined) {
            // The same scope signal the effect captures below; interruption must release a stalled read.
            const signal = scopes.signal;
            try {
              request = {
                ...request,
                imageAttachments: await snapshotImages(request.options.images, request.cwd, signal),
              };
            } catch (cause) {
              // Surface cancellation exactly as the effect's own launch check would.
              signal.throwIfAborted();
              throw new Error(`Step ${id}: image snapshot failed: ${message(cause)}`, { cause });
            }
          }
          execution = {
            ...execution,
            requested: {
              model: execution.requestedModel ?? 'inherited',
              effort: execution.effort ?? request.options.effort ?? 'inherited',
            },
          };
          // Registered harness options skip isolationParts, so normalize legacy spellings here too.
          const isolation =
            request.options.worktree === undefined
              ? undefined
              : resolveWorktree(request.options.worktree);
          const identitySchema = agentResultIdentitySchema(schema, isolation !== undefined);
          const identity = agentIdentity(request, schemaJson(identitySchema), registration);
          const resultSchema = identitySchema.extend({ usage: agentUsageSchema });
          const onPermissionDenied =
            harness === 'claude'
              ? ((request.options as ClaudeOptions).onPermissionDenied ??
                profile.onPermissionDenied)
              : profile.onPermissionDenied;
          if (onPermissionDenied === 'fail')
            Object.assign(identity, { onPermissionDenied: digest('fail') });
          const applied = { ...request.options };
          delete applied.retry;
          delete applied.onError;
          delete applied.worktree;
          const { timeoutMs, idleTimeoutMs, maxTurns, maxBudgetUsd } = execution.policy;
          const policyOptions = {
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
            ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
            ...(maxTurns === undefined ? {} : { maxTurns }),
            ...(maxBudgetUsd === undefined ? {} : { maxBudgetUsd }),
            ...(execution.requestedModel === null ? {} : { model: execution.requestedModel }),
            ...(execution.effort === null ? {} : { effort: execution.effort }),
          };
          Object.assign(
            applied,
            Object.fromEntries(
              Object.entries(policyOptions).filter(([key]) => native || Object.hasOwn(shape, key)),
            ),
          );
          request = { ...request, options: applied };
          if (native) validateAgentOptions(harness, request.options);
          else harnessOptions(registration, request.options);
          const result = await effect({
            id,
            kind: 'agent',
            dependencies: jsonValue(request, `Step "${id}" agent request`),
            schema: resultSchema,
            execution,
            action: async (context, step, attempt, _release, transcript, reservedPermit) => {
              // A missing adapter rejects as ConfigurationError: never settled or retried.
              const liveAdapter = adapter ?? registry.adapter(registration);
              const liveRequest: HarnessRequest = {
                ...request,
                ...(isolation === undefined ? {} : { cwd: context.cwd }),
                revision: request.revision ?? 1,
                runId: options.runId,
                stepId: id,
                attempt: context.attempt,
                idempotencyKey: context.idempotencyKey,
                call: {
                  runId: options.runId,
                  stepId: id,
                  attempt: context.attempt,
                  idempotencyKey: context.idempotencyKey,
                },
              };
              const processContext = processInvocation(id, context);
              let cliVersion: string | null = null;
              // Project files follow the cwd, some files load only in one isolation mode (Claude's
              // user CLAUDE.md in inherit), and env edits can move them (CLAUDE_CONFIG_DIR, HOME,
              // CODEX_HOME), so detection runs once per distinct cwd, mode and env edits. It starts
              // before metadata is awaited, so a first call waits for the slower of the two.
              let projectDetection: Promise<void> | undefined;
              if (liveAdapter.projectInstructions) {
                const cwd = resolve(liveRequest.cwd);
                const env = digest(environmentEdits(liveRequest.options.env));
                const key = `${resolveIsolation(liveRequest.options).isolation}\0${env}\0${cwd}`;
                let byCwd = projectRequests.get(registration);
                if (!byCwd)
                  projectRequests.set(registration, (byCwd = new Map<string, Promise<void>>()));
                projectDetection = byCwd.get(key);
                if (!projectDetection) {
                  projectDetection = (async () => {
                    const warnings: string[] = [];
                    let sources: InstructionSource[] | undefined;
                    try {
                      // Shared by the run like installation discovery, and diagnostic only.
                      const detected = await liveAdapter.projectInstructions?.(liveRequest, {
                        ...processContext,
                        signal: discoverySignal,
                      });
                      if (detected) {
                        sources = z.array(instructionSourceSchema).parse(detected.sources);
                        warnings.push(...z.array(z.string()).parse(detected.warnings ?? []));
                      }
                    } catch (error) {
                      if (discoverySignal.aborted) throw error;
                      warnings.push(
                        `${harness} project instruction detection failed for ${cwd}: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`,
                      );
                    }
                    if (sources === undefined && !warnings.length) return;
                    // A re-detection (on resume) replaces its entry and moves it to the end; another
                    // mode or env at the same cwd in this invocation adds its files to that entry.
                    if (sources !== undefined) {
                      const recorded = `${harness}\0${cwd}`;
                      record.projectInstructions = withProjectInstructions(
                        record.projectInstructions,
                        { harness, cwd, sources },
                        projectRecorded.has(recorded),
                      );
                      projectRecorded.add(recorded);
                    }
                    record.harnessWarnings = [
                      ...new Set([...(record.harnessWarnings ?? []), ...warnings]),
                    ];
                    await save();
                  })();
                  // Abandoned waits must not leave an unobserved rejection behind.
                  projectDetection.catch(() => undefined);
                  byCwd.set(key, projectDetection);
                }
              }
              if (liveAdapter.metadata) {
                let discovery = metadataRequests.get(registration);
                if (!discovery) {
                  discovery = (async () => {
                    // Installation discovery is shared by the run, not owned by the first map subtree.
                    const metadata = await liveAdapter.metadata?.(liveRequest, {
                      ...processContext,
                      signal: discoverySignal,
                    });
                    if (!metadata) return;
                    const old = record.harnesses?.[harness];
                    const warnings = [...(metadata.warnings ?? [])];
                    if (old && (old.version !== metadata.version || old.binary !== metadata.binary))
                      warnings.push(
                        `${harness} harness changed from ${old.binary}@${old.version ?? 'unknown'} to ${metadata.binary}@${metadata.version ?? 'unknown'}; completed effects remain reusable.`,
                      );
                    if (
                      old?.environment &&
                      metadata.environment &&
                      digest(old.environment) !== digest(metadata.environment)
                    )
                      warnings.push(
                        `${harness} inherited environment or scrubbed variable names changed; values are not recorded or fingerprinted.`,
                      );
                    // Project files follow the call's cwd, so only user-level edits are a change.
                    const userSources = (sources: typeof metadata.instructionSources) =>
                      sources?.filter((source) => source.scope === 'user');
                    if (
                      old?.instructionSources &&
                      metadata.instructionSources &&
                      digest(userSources(old.instructionSources)) !==
                        digest(userSources(metadata.instructionSources))
                    )
                      warnings.push(
                        `${harness} instruction sources changed since this run last used it; completed effects remain reusable.`,
                      );
                    (record.harnesses ??= {})[harness] = metadata;
                    record.harnessWarnings = [
                      ...new Set([...(record.harnessWarnings ?? []), ...warnings]),
                    ];
                    await save();
                    return metadata;
                  })();
                  // Abandoned waits must not leave an unobserved rejection behind.
                  discovery.catch(() => undefined);
                  metadataRequests.set(registration, discovery);
                }
                const metadata = await untilAborted(discovery, context.signal);
                if (metadata) {
                  cliVersion = metadata.version;
                  attempt.diagnostics = {
                    ...attempt.diagnostics,
                    binary: metadata.binary,
                    cliVersion: metadata.version,
                  };
                }
                context.signal.throwIfAborted();
              }
              if (projectDetection) {
                await untilAborted(projectDetection, context.signal);
                context.signal.throwIfAborted();
              }
              const invocation: HarnessInvocation = {
                ...processContext,
                policy: execution.policy,
                sessionId: attempt.requestedSessionId ?? null,
                transcriptPath: attempt.transcript?.path ?? null,
                onSession: async (sessionId) => {
                  if (attempt.sessionId != null) return;
                  attempt.sessionId = sessionId;
                  await save();
                },
                onProgress: (progress) => {
                  if (progress.model || progress.cliVersion)
                    attempt.diagnostics = {
                      ...attempt.diagnostics,
                      ...(progress.model ? { model: progress.model } : {}),
                      ...(progress.cliVersion ? { cliVersion: progress.cliVersion } : {}),
                    };
                  emit('agent.progress', id, step, {
                    harness,
                    progress,
                    sessionId: attempt.sessionId ?? attempt.requestedSessionId ?? null,
                  });
                },
                onOutput: async (stream, chunk) => {
                  if (!transcript) return;
                  try {
                    await transcript.write(stream, chunk);
                    attempt.transcript = transcript.snapshot();
                  } catch (cause) {
                    const failure = await checkpointError(
                      'save',
                      stateDir,
                      record.id,
                      cause,
                      `Could not write transcript for step ${id}`,
                    );
                    if (!checkpointProblems.includes(failure)) checkpointProblems.push(failure);
                    controller.abort(failure);
                    throw failure;
                  }
                },
              };
              let response;
              try {
                let permit = reservedPermit;
                if (!permit) {
                  const admission = limiter.acquire(harness, context.signal);
                  emitAdmission('agent.queued', id, step, harness, 0);
                  permit = await admission;
                }
                try {
                  context.signal.throwIfAborted();
                  emitAdmission('agent.admitted', id, step, harness, permit.waitedMs);
                  context.signal.throwIfAborted();
                  emit('agent.started', id, step, {
                    harness,
                    sessionId: attempt.requestedSessionId ?? null,
                    model: request.options.model ?? null,
                    cliVersion,
                  });
                  response = await liveAdapter.invoke(liveRequest, invocation);
                } finally {
                  permit.release();
                }
              } catch (error) {
                const evidence = harnessEvidence(error);
                if (evidence) {
                  attempt.usage =
                    evidence.usage === null
                      ? null
                      : normalizeUsage(evidence.usage, request.options.model ?? null);
                  attempt.diagnostics = mergeDiagnostics(attempt.diagnostics, evidence.diagnostics);
                  attempt.sessionId = preserveFirstSessionId(attempt, evidence.sessionId);
                  attempt.response = evidence.rawText;
                  attempt.responseTruncated = evidence.responseTruncated;
                }
                if (error instanceof HarnessError) {
                  const denials = error.permissionDenials ?? 0;
                  if (denials > 0)
                    step.warnings = [
                      `Profile ${profile.name}: ${String(denials)} permission denials reported.`,
                    ];
                  throw idleTimeoutError(
                    profileLimitError(error, id, profile.name, execution),
                    id,
                    profile.name,
                    execution,
                  );
                }
                throw idleTimeoutError(error, id, profile.name, execution);
              }
              attempt.usage = normalizeUsage(response.usage, request.options.model ?? null);
              attempt.sessionId = preserveFirstSessionId(attempt, response.sessionId);
              const evidence = boundedResponse(response.text);
              attempt.response = evidence.rawText;
              attempt.responseTruncated = evidence.responseTruncated;
              attempt.diagnostics = agentDiagnosticsSchema.parse({
                ...mergeDiagnostics(attempt.diagnostics, {
                  ...(response.turns === undefined ? {} : { turns: response.turns }),
                  ...(response.permissionDenials === undefined
                    ? {}
                    : { permissionDenials: response.permissionDenials }),
                  ...(response.warnings === undefined ? {} : { warnings: [...response.warnings] }),
                  ...response.diagnostics,
                }),
                ...(transcript ? { transcript: transcript.snapshot() } : {}),
              });
              if (response.warnings !== undefined) step.warnings = [...response.warnings];
              if ((response.permissionDenials ?? 0) > 0) {
                const tools = response.diagnostics?.['deniedTools'];
                const deniedNames = Array.isArray(tools)
                  ? tools.filter((tool) => typeof tool === 'string').join(', ')
                  : '';
                const warning = `Profile ${profile.name}: ${String(response.permissionDenials)} permission denials reported${deniedNames ? ` (${deniedNames})` : ''}.`;
                step.warnings = [...(step.warnings ?? []), warning];
                if (onPermissionDenied === 'fail')
                  throw new HarnessError({
                    harness,
                    kind: 'permission',
                    exit: { code: 0, signal: null },
                    failure: null,
                    reason: warning,
                    stderr: '',
                    stdout: '',
                    usage: attempt.usage,
                    sessionId: response.sessionId,
                    diagnostics: attempt.diagnostics,
                    rawText: response.text,
                  });
              }
              let output: T;
              try {
                const raw: unknown = structured ? JSON.parse(response.text) : response.text;
                output = schema.parse(raw);
              } catch (error) {
                if (error instanceof z.ZodError)
                  attempt.validationIssues = jsonValue(error.issues) as JsonValue[];
                throw error;
              }
              // Only a completed attempt with a known count warns; adapters that report no
              // count (registered, rehearsal, fixture) never do.
              if (
                profile.expectsToolUse === true &&
                attempt.diagnostics['toolUses'] === 0 &&
                exposesTools(harness, request.options)
              )
                step.warnings = [
                  ...(step.warnings ?? []),
                  `no-tool-use: Profile ${profile.name} expects tool use, but the ${harness} attempt completed without a tool call.`,
                ];
              return {
                output,
                diagnostics: attempt.diagnostics,
                sessionId: attempt.sessionId,
                usage: attempt.usage,
                ...(step.worktree
                  ? { worktree: { base: step.worktree.base, commit: null, ref: null, files: [] } }
                  : {}),
              };
            },
            identity,
            ...(agentOptions.onError === undefined ? {} : { onError: agentOptions.onError }),
            request: requestSummary(request, execution),
            phase,
            legacyDependencies: legacyRequest,
            legacySchema: legacyAgentResultSchema(schema),
            ...(isolation === undefined
              ? {}
              : {
                  isolation: { value: isolation, cwd: request.cwd, agent: true },
                  rehearsalSynthesized:
                    probe ||
                    (rehearsalWorktrees !== undefined && canSynthesizeIsolation(isolation)),
                }),
          });
          return select(result);
        });
      }
      function object<T>(
        id: string,
        agentOptions: TOptions & { readonly schema: z.ZodType<T>; readonly onError: 'return' },
      ): Promise<Settled<AgentResult<T>>>;
      function object<T, TMode extends ErrorMode = 'throw'>(
        id: string,
        agentOptions: TOptions & {
          readonly schema: z.ZodType<T>;
          readonly onError?: TMode | undefined;
        },
      ): Promise<EffectResult<AgentResult<T>, TMode>>;
      function object<T>(
        id: string,
        agentOptions: TOptions & { readonly schema: z.ZodType<T> },
      ): Promise<AgentResult<T> | Settled<AgentResult<T>>> {
        return invoke(
          id,
          agentOptions,
          () => agentOptions.schema,
          true,
          (result) => result,
        );
      }
      function value<T>(
        id: string,
        agentOptions: TOptions & { readonly schema: z.ZodType<T>; readonly onError: 'return' },
      ): Promise<Settled<T>>;
      function value<T, TMode extends ErrorMode = 'throw'>(
        id: string,
        agentOptions: TOptions & {
          readonly schema: z.ZodType<T>;
          readonly onError?: TMode | undefined;
        },
      ): Promise<EffectResult<T, TMode>>;
      function value<TMode extends ErrorMode = 'throw'>(
        id: string,
        agentOptions: TOptions & { readonly schema?: never; readonly onError?: TMode | undefined },
      ): Promise<EffectResult<string, TMode>>;
      function value<T>(
        id: string,
        agentOptions: TOptions & { readonly schema?: z.ZodType<T> },
      ): Promise<T | string | Settled<T | string>> {
        const onError = agentOptions.onError;
        return invoke<T | string, ErrorMode, T | string | Settled<T | string>>(
          id,
          agentOptions,
          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- Explicit null is an invalid schema, not text mode.
          () => (agentOptions.schema === undefined ? z.string() : agentOptions.schema),
          agentOptions.schema !== undefined,
          (result) => {
            if (onError === 'return') {
              const settled = result as Settled<AgentResult<T | string>>;
              return settled.ok ? { ok: true, value: settled.value.output } : settled;
            }
            return (result as AgentResult<T | string>).output;
          },
        );
      }
      return {
        text: (id, agentOptions) =>
          invoke(
            id,
            agentOptions,
            () => z.string(),
            false,
            (result) => result,
          ),
        object,
        value,
      };
    }

    /**
     * Claim a step owned by a committed settled map item or settled child frame without visiting
     * its call site: mark matching policy rules and emit step.replayed.
     */
    function replayedStep(id: string, step: StepRecord): void {
      if (step.kind !== 'sleep')
        policy.forEach((rule, index) => {
          if (
            (rule.kind === undefined || rule.kind === step.kind) &&
            matchesStepGlob(rule.match ?? '**', id)
          )
            matchedPolicy.add(index);
        });
      emit('step.replayed', id, step);
    }

    const map = createMap({
      isClosed: () => closed,
      isInEffect: () => inEffect.getStore() !== undefined,
      launch: (id, work, effect) => launch(id, effect, work),
      scopes,
      names,
      operations,
      origins,
      cwd,
      record,
      maps,
      used,
      visitedMaps,
      save,
      acceptCodeChange: Boolean(options.acceptCodeChange),
      nextSeq: () => nextSeq++,
      frame: () => children.frame,
      isCheckpointFailure: (error) => checkpointProblems.includes(error as CheckpointError),
      replayChild: (id) => {
        children.replay(id);
      },
      replayed: replayedStep,
    });

    function scopeEntry<T>(action: () => T): T {
      try {
        if (closed) throw new Error('Workflow is closed; await all workflow operations.');
        if (inEffect.getStore())
          throw new Error('Do not nest workflow operations inside a local effect callback.');
        return action();
      } catch (error) {
        origins.markFatal(error);
        throw error;
      }
    }
    // Observation guards are authoring errors: settled maps must never journal them as item data.
    function observe<T>(action: () => T): T {
      try {
        if (inEffect.getStore() === 'poll')
          throw new Error('Poll observers cannot call context operations.');
        if (observationsClosed)
          throw new Error('Workflow is closed; await all workflow operations.');
        return action();
      } catch (error) {
        origins.markFatal(error);
        throw error;
      }
    }
    function phase(title: string, options?: PhaseOptions): void;
    function phase<T>(title: string, body: () => Promise<T>, options?: PhaseOptions): Promise<T>;
    function phase<T>(
      title: string,
      bodyOrOptions?: PhaseOptions | (() => Promise<T>),
      options?: PhaseOptions,
    ): void | Promise<T> {
      if (typeof bodyOrOptions === 'function') {
        // Validate before launch; errors from the body itself stay ordinary item failures.
        const info = observe(() => {
          if (closed) throw new Error('Workflow is closed; await all workflow operations.');
          return observations.checkPhase(title, options);
        });
        return launch(`phase: ${title}`, null, () => observations.scoped(info, bodyOrOptions));
      }
      observe(() => {
        observations.setPhase(title, bodyOrOptions);
      });
    }
    const questions = new RunQuestions({
      record,
      stateDir,
      activity,
      clock,
      waitMode: options.waitMode ?? 'suspend',
      skipTimers: options.rehearsal !== undefined,
      observe: (id, source, context) => {
        // Rehearsal stubs cover poll observers too: a matched wait completes with a synthesized
        // terminal value, still parsed by the poll schema, and its observer never runs.
        options.rehearsal?.onSchema?.(id, source.schema);
        const stub = options.rehearsal?.localStep?.(id, schemaJson(source.schema));
        if (stub !== undefined) return Promise.resolve({ done: true, value: stub.output });
        // Inner commands stop with the observation's own signal (deadline, observeTimeoutMs,
        // cancellation) and when the observation settles.
        const innerExec = stepExec({
          owner: { kind: 'wait', id },
          cwd: context.cwd,
          attempt: context.attempt,
          signal: context.signal,
          options: pollExecOptionsSchema,
          active: () => !closed,
        });
        return inEffect.run('poll', async () => {
          try {
            // A command poll runs its command through this same exec, then calls done.
            return await observePoll(source, { ...context, exec: innerExec.exec });
          } finally {
            await innerExec.close(
              new Error(`Wait ${id}: its observation settled; inner command terminated.`),
            );
          }
        });
      },
      isFatal: (error) => origins.isFatal(error),
      guard: (action) => inEffect.run('poll', action),
      save,
      emit: (type, id, step) => {
        emit(
          type,
          id,
          step,
          type === 'wait.opened'
            ? {
                data: jsonValue({ question: step.question?.request ?? null }),
                at: new Date(clockNow(clock)).toISOString(),
              }
            : {},
        );
      },
      tolerated: (id, step, { consecutive, tolerate, message, at, code }) => {
        // Committed by the caller's save with lastError; outside eventCounts, so it never replays.
        const event = observations.appendRuntime({
          at: new Date(at).toISOString(),
          type: 'wait.tolerated',
          phase: step.phase ?? null,
          total: null,
          message: message.slice(0, 1024),
          data: jsonValue({
            consecutive,
            tolerate,
            ...(code === undefined ? {} : { code: code.slice(0, 128) }),
          }),
          stepId: id,
          ...(step.frame == null ? {} : { frame: step.frame }),
        });
        return () => {
          notify({
            ...event,
            message: event.message ?? '',
            attempt: step.attempts,
            runId: record.id,
            replayed: false,
          });
        };
      },
      beforeLive,
      nextSeq: () => nextSeq++,
      launchStamp: takeLaunchStamp,
      warn: (message) => {
        // Persisted by the next completion, failure or suspension save; bounded like worktrees.
        record.waitWarnings = [...new Set([...(record.waitWarnings ?? []), message])].slice(-20);
      },
      fail: (error) => {
        origins.markFatal(error);
        controller.abort(error);
      },
    });
    const supportsInbox = options.store === undefined || options.store.stateDir !== undefined;
    const ask = <T>(leaf: string, options: AskOptions<T>): Promise<T> => {
      const id = names.qualify(leaf);
      return launch(
        id,
        'ask',
        async () => {
          if (inEffect.getStore())
            throw new Error(
              'Nested durable steps are unsupported; compose questions in the workflow body.',
            );
          if (!supportsInbox)
            throw new Error(
              'This RunStore has no filesystem inbox. Durable questions require FileRunStore or a store implementing the same stateDir protocol.',
            );
          if (used.has(id)) throw duplicateStepId(id, names.describe(id));
          if (record.children?.[id])
            throw new Error(`Question ${id} collides with a recorded child frame.`);
          used.add(id);
          scopes.step(id);
          const registered = await questions.register(
            id,
            options,
            observations.phase?.title ?? null,
            scopes.signal,
          );
          operations.changed();
          return registered.answer;
        },
        true,
      );
    };
    function waitOperation<T>(
      leaf: string,
      sources: WaitSources,
      project: (outcome: SignalOutcome<JsonValue> | PollOutcome<JsonValue> | DeadlineOutcome) => T,
      validate?: () => void,
    ): Promise<T> {
      const id = names.qualify(leaf);
      return launch(
        id,
        'wait',
        async () => {
          if (inEffect.getStore())
            throw new Error(
              'Nested durable operations are unsupported inside a local effect or poll observer.',
            );
          validate?.();
          if (sources.signal && !supportsInbox)
            throw new Error('Signal waits require a RunStore with the filesystem inbox protocol.');
          if (used.has(id)) throw duplicateStepId(id, names.describe(id));
          if (record.children?.[id])
            throw new Error(`Wait ${id} collides with a recorded child frame.`);
          used.add(id);
          scopes.step(id);
          const registered = await questions.wait(
            id,
            sources,
            observations.phase?.title ?? null,
            scopes.signal,
          );
          operations.changed();
          return project(await registered.answer);
        },
        true,
      );
    }
    const context: WorkflowContext = {
      agent: (name: string) => client(name),
      workflow: children.invoke,
      cwd,
      // Cast: TypeScript cannot match one generic implementation against the overload pair.
      readFile: (<TMode extends ErrorMode = 'throw'>(
        leaf: string,
        path: string,
        settings?: ReadFileOptions & { readonly onError?: TMode | undefined },
      ): Promise<EffectResult<ReadFileResult, TMode>> => {
        const id = names.qualify(leaf);
        const phase = observations.phase;
        return launch(id, 'read-file', async () => {
          const checked = readFileOptionsSchema.parse(settings ?? {});
          const target = await filePath(cwd, path, checked.allowOutsideCwd);
          const onError = checked.onError as TMode | undefined;
          return effect<ReadFileResult, TMode>({
            id,
            kind: 'read-file',
            schema: readFileResultSchema,
            execution: resolvePolicy(id, 'step', {}, {}, policy, matchedPolicy),
            action: async (context) => {
              const stub = options.rehearsal?.localStep?.(id, schemaJson(readFileResultSchema));
              return stub
                ? readFileResultSchema.parse(stub.output)
                : snapshotFile(target, checked.maxBytes ?? 1_048_576, context.signal);
            },
            identity: stepIdentity({
              kind: 'read-file',
              path: target,
              schema: schemaJson(readFileResultSchema),
              // Only 'return' enters identity, so existing reads keep their fingerprints.
              ...(onError === 'return' ? { onError } : {}),
            }),
            phase,
            ...(onError === undefined ? {} : { onError }),
          });
        });
      }) as WorkflowContext['readFile'],
      writeFile: (<TMode extends ErrorMode = 'throw'>(
        leaf: string,
        path: string,
        content: string,
        settings?: WriteFileOptions & { readonly onError?: TMode | undefined },
      ): Promise<EffectResult<WriteFileResult, TMode>> => {
        const id = names.qualify(leaf);
        const phase = observations.phase;
        return launch(id, 'write-file', async () => {
          const { onError: checkedOnError, ...checked } = writeFileOptionsSchema.parse(
            settings ?? {},
          );
          if (typeof content !== 'string') throw new Error('File content must be a string.');
          const target = await filePath(cwd, path, checked.allowOutsideCwd);
          const onError = checkedOnError as TMode | undefined;
          return effect<WriteFileResult, TMode>({
            id,
            kind: 'write-file',
            schema: writeFileResultSchema,
            execution: resolvePolicy(id, 'step', {}, {}, policy, matchedPolicy),
            action: async (context) => {
              const stub = options.rehearsal?.localStep?.(id, schemaJson(writeFileResultSchema));
              return stub
                ? writeFileResultSchema.parse(stub.output)
                : replaceFile(target, content, checked as WriteFileOptions, context.signal);
            },
            identity: stepIdentity({
              kind: 'write-file',
              path: target,
              sha256: fileDigest(content),
              ifMatch: checked.ifMatch ?? null,
              createOnly: checked.ifMatch === null,
              schema: schemaJson(writeFileResultSchema),
              // Only 'return' enters identity, so existing writes keep their fingerprints.
              ...(onError === 'return' ? { onError } : {}),
            }),
            phase,
            ...(onError === undefined ? {} : { onError }),
          });
        });
      }) as WorkflowContext['writeFile'],
      // Cast: TypeScript cannot match one generic implementation against the overload pair.
      merge: (<TMode extends ErrorMode = 'throw'>(
        leaf: string,
        changes: readonly (WorktreeChange | WorktreeHandle)[],
        settings: MergeOptions & { readonly onError?: TMode | undefined } = {},
      ): Promise<EffectResult<MergeResult, TMode>> => {
        const id = names.qualify(leaf);
        return launch(id, 'merge', () => {
          // onError is the effect's failure mode: it enters identity through effect(), never the
          // dependencies, and Git never sees it.
          const { onError: checkedOnError, ...checked } = mergeOptionsSchema.parse(
            settings,
          ) as MergeOptions;
          const onError = checkedOnError as TMode | undefined;
          const inputs = z
            .array(z.union([worktreeChangeSchema, worktreeHandleSchema]))
            .parse(changes);
          const dependencies = jsonValue({
            changes: inputs.map((change) =>
              'id' in change
                ? isolationIdentity(change)
                : { base: change.base, commit: change.commit },
            ),
            strategy: checked.strategy ?? 'rebase',
            onConflict: checked.onConflict ?? 'report',
            target: checked.target ?? 'ref',
            // Present only when requested, so merges without it keep their identity. The author
            // stays as requested ('git-config' is resolved when the merge is prepared).
            ...(checked.commit
              ? {
                  commit: {
                    message: checked.commit.message,
                    author: checked.commit.author ?? 'quiet-choir',
                  },
                }
              : {}),
          });
          return effect<MergeResult, TMode>({
            id,
            kind: 'merge',
            dependencies,
            schema: mergeResultSchema,
            ...(onError === undefined ? {} : { onError }),
            execution: resolvePolicy(id, 'step', {}, {}, [], matchedPolicy),
            ...(rehearsalWorktrees && (probe || canSynthesizeMerge(inputs))
              ? {
                  rehearsalSynthesized: true,
                  action: async (context: StepContext) => {
                    const synthesized = await rehearsalWorktrees.merge(
                      id,
                      inputs,
                      checked,
                      context,
                    );
                    notifyWorktree(synthesized.event);
                    return synthesized.result;
                  },
                }
              : {
                  action: (
                    context: StepContext,
                    step: StepRecord,
                    attempt: AttemptRecord,
                    releaseAfterSave: (release: () => void) => void,
                  ) =>
                    worktrees.merge(id, inputs, checked, context, step, attempt, releaseAfterSave),
                }),
          });
        });
      }) as WorkflowContext['merge'],
      worktree: (leaf, settings = {}) => {
        const id = names.qualify(leaf);
        return launch(id, 'worktree', () => {
          const parsed = worktreeCreateSchema.parse(settings);
          return effect({
            id,
            kind: 'worktree',
            dependencies: parsed,
            schema: worktreeHandleSchema,
            execution: resolvePolicy(id, 'step', {}, {}, [], matchedPolicy),
            // Only the accepted-replay probe synthesizes a handle; it reports no worktree event.
            ...(rehearsalWorktrees && probe
              ? {
                  rehearsalSynthesized: true,
                  action: (_context: StepContext, step: StepRecord, attempt: AttemptRecord) =>
                    rehearsalWorktrees.handle(id, parsed.base, step, attempt),
                }
              : {
                  action: (context: StepContext, step: StepRecord, attempt: AttemptRecord) =>
                    worktrees.create(id, parsed.base, context, step, attempt),
                }),
          });
        });
      },
      exec: Object.assign(
        <TMode extends ErrorMode = 'throw'>(
          id: string,
          command: Command,
          settings: ExecOptions & { readonly onError?: TMode | undefined } = {},
        ) => exec<ExecResult, TMode>(id, command, settings, null),
        {
          json: <T, TMode extends ErrorMode = 'throw'>(
            id: string,
            command: Command,
            settings: ExecOptions & {
              readonly schema: z.ZodType<T>;
              readonly onError?: TMode | undefined;
            },
          ): Promise<EffectResult<T, TMode, ExecStepError>> => {
            const { schema, ...rest } = settings;
            return exec<T, TMode>(id, command, rest, schema);
          },
        },
      ) as ExecFunction,
      now: (id) =>
        context.step(id, {
          // Identified by NOW_STEP_VERSION, not callback text. Bump it only if ctx.now's recorded
          // behavior or result contract changes, never for refactors: a bump strands completed
          // now steps. test/builtin-identity.test.ts pins it.
          version: NOW_STEP_VERSION,
          identity: 'version',
          input: null,
          schema: z.number().int().nonnegative(),
          run: () => clockNow(clock),
        }),
      // Cast: WaitSources<N> types previous.note for the author from noteSchema; the runtime passes
      // stored JSON, validated with noteSchema when the poll has one.
      wait: <const S extends WaitSources<N>, N extends JsonInput = JsonValue>(
        id: string,
        sources: S & WaitSources<N>,
      ) =>
        waitOperation(
          id,
          sources as unknown as WaitSources,
          (outcome) => outcome as WaitOutcome<S>,
        ),
      sleepUntil: (id, deadline) => waitOperation(id, { deadline }, () => null),
      // Cast: one implementation serves the observer and command overloads.
      poll: <T, N extends JsonInput = JsonValue>(
        id: string,
        settings: PollOptions<T, N> | CommandPollOptions<T, unknown, N>,
      ) =>
        waitOperation(
          id,
          {
            // PollContext<N> types previous.note for the author from noteSchema; the runtime passes stored
            // JSON, validated with noteSchema when the poll has one.
            poll: settings as AnyPollSource,
            ...(settings.timeoutMs === undefined ? {} : { timeoutMs: settings.timeoutMs }),
            ...(settings.deadline === undefined ? {} : { deadline: settings.deadline }),
          },
          (outcome) => outcome as PollOutcome<T> | DeadlineOutcome,
          () => {
            if (
              settings.timeoutMs === undefined &&
              (settings as { deadline?: number }).deadline === undefined
            )
              throw new Error('Poll requires timeoutMs or deadline.');
          },
        ),
      ask,
      approve: (id, options) => ask(id, { ...options, schema: approvalSchema }),
      phase,
      log(message, data) {
        observe(() => {
          observations.log(message, data);
        });
      },
      runId: record.id,
      get signal() {
        return scopes.signal;
      },
      id: stepId,
      scope: (prefix, action) =>
        launch('scope', null, () => {
          const path = scopeEntry(() => {
            if (typeof action !== 'function') throw new Error('Scope requires a callback.');
            return names.prefix(prefix);
          });
          return names.run(path, action);
        }),
      within: (prefix) =>
        bindContext(
          context,
          names,
          scopeEntry(() => names.bind(prefix)),
        ),
      claude: client<ClaudeOptions>('claude'),
      codex: client<CodexOptions>('codex'),
      step: <T, TMode extends ErrorMode = 'throw'>(
        leaf: string,
        step: StepDefinition<T> & { readonly onError?: TMode | undefined },
      ): Promise<EffectResult<T, TMode>> => {
        const id = names.qualify(leaf);
        return launch(id, 'step', () =>
          effect<T, TMode>({
            id,
            kind: 'step',
            dependencies: step.input,
            schema: step.schema,
            execution: resolvePolicy(
              id,
              'step',
              step.retry === undefined ? {} : { retry: step.retry },
              {},
              policy,
              matchedPolicy,
            ),
            action:
              options.rehearsal === undefined
                ? step.run
                : (context) => {
                    options.rehearsal?.onSchema?.(id, step.schema);
                    const stub = options.rehearsal?.localStep?.(id, schemaJson(step.schema));
                    return stub === undefined ? step.run(context) : step.schema.parse(stub.output);
                  },
            local: step,
            ...(step.onError === undefined ? {} : { onError: step.onError }),
            ...(step.worktree === undefined
              ? {}
              : {
                  isolation: { value: worktreeHandleSchema.parse(step.worktree), cwd },
                  // Only the accepted-replay probe synthesizes an isolated local step.
                  rehearsalSynthesized: probe,
                }),
          }),
        );
      },
      sleep: (leaf, milliseconds) => {
        const id = names.qualify(leaf);
        if (record.steps[id]?.kind !== 'sleep')
          return waitOperation(
            leaf,
            { timeoutMs: milliseconds },
            () => null,
            () => {
              if (!Number.isFinite(milliseconds) || milliseconds < 0)
                throw new Error(`Step ${id}: Sleep duration must be finite and nonnegative.`);
            },
          );
        return launch(id, 'sleep', () => {
          if (
            !Number.isFinite(milliseconds) ||
            milliseconds < 0 ||
            milliseconds > Number.MAX_SAFE_INTEGER - clockNow(clock)
          )
            throw new Error(
              `Step ${id}: Sleep duration must be a finite nonnegative safe duration (got ${String(milliseconds)}).`,
            );
          return effect({
            id,
            kind: 'sleep',
            dependencies: milliseconds,
            schema: z.null(),
            execution: resolvePolicy(id, 'sleep', {}, {}, [], matchedPolicy),
            action: async (context, step) => {
              context.signal.throwIfAborted();
              if (options.rehearsal === undefined)
                await waitUntil(step.wakeAt ?? clockNow(clock), context.signal, clock);
              return null;
            },
            wakeAt: clockNow(clock) + milliseconds,
          });
        });
      },
      map,
    };
    record.status = 'running';
    record.error = null;
    record.output = null;
    record.rootCause = null;
    delete record.interruptedBy;
    const started = observations.lifecycle('run.started');
    await save();
    notify({ ...started, message: 'Run started.', attempt: 0, runId: record.id });
    const quiet = activity.quiet(
      () => questions.shouldSuspend,
      () => questions.scan(),
    );
    /** The result of a saved suspension, for the quiescent path and the window gate alike. */
    const suspendedResult = async (): Promise<WorkflowResult<TOutput>> => ({
      ...structuredClone(record),
      status: 'suspended',
      output: null,
      pending: await pendingOperations(record, stateDir, options.commandLauncher),
      resumeCommand: record.launch
        ? workflowArgv(
            options.commandLauncher,
            'resume',
            record.id,
            '--state-dir',
            stateDir,
            ...launchPolicyFlags(record.launch),
          )
        : null,
    });
    try {
      signal.throwIfAborted();
      let bodyOutput: { value: TOutput } | undefined;
      // This promise always has a rejection handler, even when suspension abandons the body.
      const body = Promise.resolve().then(() =>
        observations.run(() =>
          definition.run(
            context as unknown as WorkflowContext<
              TProfile,
              WorkflowHarnesses<H>,
              TStrict,
              TChildren
            >,
            bodyInput,
          ),
        ),
      );
      const completedBody = body.then(async (value) => {
        bodyOutput = { value };
        await operations.drain();
        return { kind: 'completed' as const, value };
      });
      const result = await Promise.race([
        completedBody,
        quiet.then(() => ({ kind: 'quiet' as const })),
      ]);
      if (budget.error) throw budget.error;
      if (result.kind === 'quiet') {
        closed = true;
        operations.assertObserved();
        if (bodyOutput === undefined) {
          observationsClosed = true;
          await questions.close();
          await observations.flush();
          // No effect remains to await discovery, so any unsettled request is abandoned.
          await drainDiscovery();
          signal.throwIfAborted();
          if (!options.rehearsal) await worktrees.cleanup(false);
          record.status = 'suspended';
          children.finish('suspended');
          record.output = null;
          warnUnmatched();
          const priorEvents = [...(record.events ?? [])];
          // A clean suspension ends a crash loop; tick's counter restarts on the next stale recovery.
          const priorStaleRecovery = record.staleRecovery;
          delete record.staleRecovery;
          const suspended = observations.lifecycle('run.suspended');
          try {
            await save();
          } catch (error) {
            record.events = priorEvents;
            if (priorStaleRecovery) record.staleRecovery = priorStaleRecovery;
            throw error;
          }
          notify({
            ...suspended,
            message: 'Run suspended for external conditions.',
            attempt: 0,
            runId: record.id,
          });
          return await suspendedResult();
        }
      }
      const output = result.kind === 'completed' ? result.value : bodyOutput?.value;
      closed = true;
      observationsClosed = true;
      questions.withdraw();
      await questions.close();
      await activity.quiet(
        () => true,
        () => Promise.resolve(),
      );
      await observations.flush();
      operations.assertObserved();
      closed = true;
      await drainDiscovery();
      signal.throwIfAborted();
      children.assertVisited();
      children.cancelUnawaited('Root workflow completed without awaiting this child frame.');
      const missingMaps = Object.keys(maps).filter(
        (id) =>
          !visitedMaps.has(id) &&
          (maps[id]?.status === 'completed' ||
            maps[id]?.items.some((item) => item.status === 'completed')),
      );
      if (missingMaps.length)
        throw new ReplaySkippedError(
          `Replay skipped settled maps (${missingMaps.join(', ')}); workflow control flow changed.`,
          { kind: 'maps', skipped: missingMaps },
        );
      const missing = Object.entries(record.steps)
        .filter(([id, step]) => !used.has(id) && isTerminalStep(step))
        .map(([id]) => id);
      if (missing.length)
        throw new ReplaySkippedError(
          `Replay skipped recorded steps (${missing.join(', ')}); workflow control flow changed.${healed.size ? ` Healed steps: ${[...healed].join(', ')}.` : ''}`,
          { kind: 'steps', skipped: missing, healed: [...healed] },
        );
      warnUnmatched();
      record.output = jsonValue(definition.output.parse(output), 'Workflow output');
      if (!options.rehearsal) await worktrees.cleanup(true);
      // Last, after every check that can still fail the run: a failure must not claim retirements.
      // Unvisited steps are retired here too, and a failed completion save puts them back.
      const supersededSteps = Object.entries(record.steps)
        .filter(
          ([id, step]) =>
            !used.has(id) && step.status !== 'superseded' && step.status !== 'withdrawn',
        )
        .map(([id, step]) => ({ id, step, status: step.status }));
      for (const { step } of supersededSteps) step.status = 'superseded';
      const retired = children.supersede();
      record.status = 'completed';
      const priorEvents = [...(record.events ?? [])];
      const priorStaleRecovery = record.staleRecovery;
      delete record.staleRecovery;
      const completed = observations.lifecycle('run.completed');
      try {
        await save();
      } catch (error) {
        // A later failure snapshot must not claim that an uncommitted completion happened.
        record.events = priorEvents;
        if (priorStaleRecovery) record.staleRecovery = priorStaleRecovery;
        for (const { step, status } of supersededSteps) step.status = status;
        retired.restore();
        throw error;
      }
      notify({ ...completed, message: 'Run completed.', attempt: 0, runId: record.id });
      for (const { id, step } of supersededSteps) emit('step.superseded', id, step);
      retired.announce();
      const warnings = recordWarnings(record);
      return {
        ...structuredClone(record),
        status: 'completed',
        ...(warnings.length ? { warnings } : {}),
        output: jsonValue(
          definition.output.parse(structuredClone(record.output)),
          'Workflow output',
          { canonical: false },
        ) as TOutput & JsonValue,
      };
    } catch (caught) {
      closed = true;
      const interrupted =
        options.signal?.aborted === true &&
        (errorKind(caught) === 'cancelled' ||
          errorKind(origins.find(caught).error) === 'cancelled');
      const error: unknown = interrupted ? options.signal.reason : caught;
      record.rootCause = interrupted
        ? { stepId: null, error: message(error), errorKind: null, effect: null }
        : origins.root(error, errorKind);
      // Body failures stop new launches but preserve in-flight work. Only explicit cancellation
      // or checkpoint failure aborts a scope; draining here sends operations no signal. The one
      // exception is a read-only poll observation: questions.drain() aborts it, and it reruns on
      // resume.
      questions.drain();
      await Promise.race([operations.drain(), quiet.catch(() => operations.drain())]);
      await drainDiscovery();
      await questions.close();
      observationsClosed = true;
      await observations.flush().catch(() => undefined);
      if (!options.rehearsal) await worktrees.cleanup(false).catch(() => undefined);
      // A marked external interruption (a CLI signal or tick's deadline) is not a failure: save a
      // resumable suspension that is due now. It keeps staleRecovery, since it shows no progress.
      if (interrupted && options.signal.reason instanceof RunInterruptedError) {
        // After questions.close(): the question pump would otherwise rewrite the wake time.
        recordHonoredAbort(record, error, clockNow(clock));
        children.finish('suspended');
        record.output = null;
        warnUnmatched();
        const suspended = observations.lifecycle('run.suspended');
        if (await trySave()) {
          savedFailure = structuredClone(record);
          notify({
            ...suspended,
            message: `Run interrupted; resumable: ${message(error)}`,
            attempt: 0,
            runId: record.id,
          });
        }
        throw error;
      }
      // ADR 0053: the window gate latched with a known reset, and that stop is the only thing that
      // ended the run: every non-cancellation failure derives from it, with no concurrent failure,
      // interruption or checkpoint error. Save a clean suspension that tick resumes at the reset.
      const budgetError = budget.error;
      const wakeAt = budget.wakeAt;
      if (
        budgetError &&
        wakeAt !== null &&
        !interrupted &&
        !signal.aborted &&
        checkpointProblems.length === 0 &&
        origins.onlyFrom(caught, budgetError)
      ) {
        record.status = 'suspended';
        children.finish('suspended');
        record.error = null;
        record.rootCause = null;
        delete record.recoveryHint;
        record.output = null;
        // After questions.close(), whose last wake update covers only the waits: a wait still
        // parked keeps its own earlier deadline or check, so its timeout is not delayed.
        record.nextWakeAt = Math.min(wakeAt, record.nextWakeAt ?? wakeAt);
        warnUnmatched();
        const priorEvents = [...(record.events ?? [])];
        // A clean suspension ends a crash loop, as on the quiescent path.
        const priorStaleRecovery = record.staleRecovery;
        delete record.staleRecovery;
        const suspended = observations.lifecycle('run.suspended');
        try {
          await save();
        } catch (failure) {
          record.events = priorEvents;
          if (priorStaleRecovery) record.staleRecovery = priorStaleRecovery;
          throw failure;
        }
        notify({
          ...suspended,
          message: windowSuspensionMessage(budgetError.stop, record.nextWakeAt),
          attempt: 0,
          runId: record.id,
        });
        return await suspendedResult();
      }
      // A callback's own AbortError is a failure; only scope cancellation cancels the run.
      record.status = interrupted || error instanceof CancelledError ? 'cancelled' : 'failed';
      children.finish(record.status, message(error));
      record.error = message(error);
      // ADR 0006: the hint follows the typed cause, never the message text.
      const recoveryHint = chooseRecoveryHint({
        cause: recoveryCause([origins.find(error).error, error], record),
        rehearsal: options.rehearsal !== undefined,
        recordedWork:
          Object.keys(record.steps).length > 0 || Object.keys(record.maps ?? {}).length > 0,
        allTerminal: hasTerminalOutcomes(record),
        sourceChanged: (compatibility?.changed.length ?? 0) > 0,
        runId: record.id,
      });
      if (recoveryHint === undefined) delete record.recoveryHint;
      else record.recoveryHint = recoveryHint;
      warnUnmatched();
      const failed = observations.lifecycle(
        record.status === 'cancelled' ? 'run.cancelled' : 'run.failed',
        error,
      );
      if (await trySave()) {
        savedFailure = structuredClone(record);
        notify({ ...failed, message: record.error, attempt: 0, runId: record.id });
      }
      throw error;
    } finally {
      activity.close();
      await questions.close();
    }
  }
  let outcome: { ok: true; run: WorkflowResult<TOutput> } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, run: await executeOwned() };
  } catch (error) {
    outcome = { ok: false, error };
  }
  options.signal?.removeEventListener('abort', abort);
  try {
    await storage.release();
  } catch (cause) {
    const error = await checkpointError(
      'release',
      stateDir,
      options.runId,
      cause,
      `Could not release run ${options.runId} lock`,
    );
    // lockRun keeps an errno only for a vanished lock or removal after ownership was verified.
    if (
      outcome.ok &&
      (cause instanceof OrphanProcessesError ||
        errorCode(cause) === 'EACCES' ||
        errorCode(cause) === 'ENOENT')
    ) {
      return { ...outcome.run, warnings: [...(outcome.run.warnings ?? []), error.message] };
    }
    // Unknown ownership and ownership changes remain fatal even after a successful save.
    checkpointProblems.push(error);
    if (outcome.ok) outcome = { ok: false, error };
  }
  if (!outcome.ok) {
    const cause = withCheckpointErrors(outcome.error, checkpointProblems);
    if (savedFailure) throw new WorkflowRunError(savedFailure, cause);
    throw cause;
  }
  return outcome.run;
}

/**
 * Classify a failure for recovery advice from error classes and the saved record, never from
 * message text. It searches the given errors' cause chains and aggregate members, and the first
 * matching rule wins: grant, divergence, settled map change, other configuration, cancelled run,
 * recorded effect failure, then authoring.
 */
function recoveryCause(errors: readonly unknown[], record: RunRecord): RecoveryCause {
  const seen = new Set<unknown>();
  const found: Error[] = [];
  const visit = (error: unknown): void => {
    if (!(error instanceof Error) || seen.has(error)) return;
    seen.add(error);
    found.push(error);
    visit(error.cause);
    if (error instanceof AggregateError && Array.isArray(error.errors))
      for (const member of error.errors as unknown[]) visit(member);
  };
  for (const error of errors) visit(error);
  const grant = found.find((error) => error instanceof GrantRequiredError);
  if (grant) return { kind: 'grant', profile: grant.profile, access: grant.access };
  if (
    found.some(
      (error) =>
        error instanceof ReplayDivergenceError ||
        error instanceof StepIdentityChangedError ||
        error instanceof ReplaySkippedError,
    )
  )
    return { kind: 'divergence' };
  const mapChange = found.map(settledMapChange).find((change) => change !== undefined);
  if (mapChange) return { kind: 'map-changed', mapperOnly: mapChange.mapperOnly };
  if (found.some((error) => error instanceof ConfigurationError)) return { kind: 'configuration' };
  if (record.status === 'cancelled') return { kind: 'cancelled' };
  const stepId = record.rootCause?.stepId;
  if (stepId != null && record.steps[stepId]?.status === 'failed') return { kind: 'effect' };
  return { kind: 'authoring' };
}
