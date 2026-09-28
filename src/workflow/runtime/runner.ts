import { mergeOptionsSchema, mergeResultSchema } from './worktree-schema.js';
import { randomUUID } from 'node:crypto';
import { deriveAgentSessionId } from './agent-session.js';
import { agentDiagnosticsSchema } from './agent-stream-schema.js';
import type {
  AgentDiagnostics,
  AgentProgress,
  AgentTranscriptWriter,
} from './agent-stream-model.js';
import { RunWorktrees, type WorktreeLease } from './worktrees.js';
import { isolationIdentity } from './worktree-identity.js';
import {
  worktreeChangeSchema,
  worktreeHandleSchema,
  worktreeCreateSchema,
} from './worktree-schema.js';
import type { WorktreeIsolation, WorktreePolicy, MergeOptions } from './worktree-model.js';
import type { ReadFileResult, WriteFileResult, WriteFileOptions } from './file-model.js';
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
import { executeCommand, prepareExec } from './exec.js';
import { execResultSchema } from './exec-schema.js';
import { ExecError } from './exec-error.js';
import type { Command, ExecOptions, ExecResult, ExecSummary, ProcessRunner } from './exec-model.js';
import { prepareLegacyReplay } from './legacy.js';
import { RunActivity } from './activity.js';
import { FileRunStore, type RunStore } from './run-store.js';
import { RunQuestions } from './questions.js';
import { clockNow, systemClock } from './clock.js';
import type {
  WorkflowClock,
  PendingOperation,
  WaitSources,
  WaitOutcome,
  PollOptions,
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
  isValidRunId,
  runIdMessage,
  RunRefusedError,
  WorkflowInputError,
  WorkflowRunError,
} from './run-errors.js';
import { missingRunError, unreadableRunError } from './read-required-run.js';
import type { ProcessSupervisor } from '../../processes/supervisor.js';
import { OrphanProcessesError } from './process-registry.js';
import type { HarnessInvocation } from './model.js';
import {
  resolveAgentLimiter,
  type AgentLimiter,
  type AgentLimits,
  type AgentLimiterSnapshot,
} from './agent-limiter.js';
import { snapshotImages } from './images.js';
import { profileLimitError } from './profile-diagnostics.js';
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
import { engineInfo, oldFormatMessage } from './engine.js';
import { loadFork, pinnedFork, reuseCandidate, validateFork } from './fork.js';
import type { ForkOptions, ResumeCheck } from './replay-model.js';
import { schemaJson } from './schema.js';

import { z } from 'zod';

import { CheckpointError, checkpointError, errorCode, withCheckpointErrors } from './checkpoint.js';
import { resolveStateDir } from './paths.js';
import {
  agentIdentity,
  stepIdentity,
  validateStepId,
  duplicateStepId,
  stepId,
  type StepIdentity,
} from './identity.js';
import {
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
import { createMap } from './map.js';
import { ExecutionScopes } from './scopes.js';
import { NameScopes } from './names.js';
import { bindContext } from './context.js';
import { stepError, errorKind } from './step-error.js';
import { ConfigurationError } from './configuration-error.js';
import { digest, jsonValue } from './json.js';
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
  isTerminalStep,
  type RunRecord,
  type StepRecord,
  type AttemptRecord,
} from './store.js';

export { ConfigurationError } from './configuration-error.js';

/** Unawaited notifications: step transitions follow persistence; admission events are live. */
export type WorkflowEvent = {
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
  readonly provider?: string;
  /** Reserved slots by provider, present on agent events. */
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
      /** Root effect for a failed run; otherwise null. */
      readonly stepId: string | null;
      /** Run lifecycle, phase, or log notification. */
      readonly type: RunEvent['type'];
    }
);

/** A completed run with its output type inferred from the workflow definition. */
export type WorkflowRun<TOutput> = RunRecord & {
  /** Successful, durably committed completion. */
  readonly status: 'completed';
  /** Final validated output, inferred from the workflow schema. */
  readonly output: TOutput;
  /** Policy warnings plus invocation-only cleanup warnings, returned after a persisted completion. */
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
  /** Runtime-owned checkout cache and dependency provisioning policy. */
  readonly worktrees?: WorktreePolicy;
  /** Process integration for durable exec and worktree Git operations; the core never spawns. */
  readonly processRunner?: ProcessRunner;
  /** Wall clock and cancellable timer used by now, waits, and legacy sleeps. */
  readonly clock?: WorkflowClock;
  /** Suspend when quiescent by default; block keeps waits in this process. Waits due within one second stay live. */
  readonly waitMode?: 'suspend' | 'block';
  /** Optional storage implementation; defaults to private local journal files. */
  readonly store?: RunStore;
  /** Optional entrypoint metadata supplied by the CLI or embedder for resume by ID. */
  readonly launch?: WorkflowLaunch;
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
  /** Explicitly accept replaying outputs recorded under a different harness kind, including forks. */
  readonly allowHarnessChange?: boolean;
  /** Live rehearsal hooks. Requires a harness whose kind is dry-run; local callbacks otherwise run normally. */
  readonly rehearsal?: {
    /** Replace selected local callbacks; undefined means execute the original callback. */
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
  };
  /** Cancellation signal, forwarded to all active effects. */
  readonly signal?: AbortSignal;
  /** Create a new run, reusing completed effects from an immutable source snapshot. */
  readonly forkFrom?: ForkOptions;
  /** Explicitly accept only source/schema changes on resume; local callback identity still applies. */
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

/** Run or resume a workflow with local, at-least-once durable effects. Throws after saving failures. */
export async function runWorkflow<TInput, TOutput>(
  definition: WorkflowDefinition<TInput, TOutput>,
  options: RunOptions,
): Promise<WorkflowResult<TOutput>> {
  if (!isValidRunId(options.runId)) throw new Error(runIdMessage);
  if (!definition.name.trim() || !definition.version.trim())
    throw new Error('Workflow name and version must be nonempty.');
  if (options.launch) workflowLaunchSchema.parse(options.launch);
  const harnessKind = options.harness?.kind ?? (options.harness ? 'custom' : 'none');
  if (typeof harnessKind !== 'string' || !harnessKind.trim() || harnessKind.length > 100)
    throw new Error('Harness kind must be a nonempty string of at most 100 characters.');
  // 'none' marks a run with no agent outputs, which any harness may adopt without authorization.
  if (options.harness && harnessKind === 'none')
    throw new Error("Harness kind 'none' is reserved for runs without a harness adapter.");
  if (options.rehearsal !== undefined && harnessKind !== 'dry-run')
    throw new Error('Rehearsal hooks require a dry-run harness.');
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
    const engineChanged =
      existing !== undefined &&
      (existing.engine?.quietChoir !== engineInfo.version ||
        existing.engine.node !== process.version);
    if (existing && legacyReplay) prepareLegacyReplay(existing);
    if (existing) {
      existing.formatVersion = 7;
      existing.seq ??= 0;
      existing.engine = { quietChoir: engineInfo.version, node: process.version };
    }
    if (existing?.status === 'completed' && !options.acceptCodeChange && !legacyReplay) {
      const output = jsonValue(definition.output.parse(existing.output), 'Workflow output', {
        canonical: false,
      });
      if (
        migrating ||
        engineChanged ||
        incomingPolicy.length ||
        incomingProfiles.length ||
        incomingGrants.length ||
        options.policyReset ||
        options.allowModelOverride !== undefined
      ) {
        existing.profileOverrides = profileOverrides;
        existing.grants = grants;
        existing.grantedProfiles = grantedProfiles;
        existing.policy = policy;
        existing.allowModelOverride = allowModelOverride;
        existing.policyWarnings = [];
        existing.updatedAt = new Date().toISOString();
        await storage.append(existing, { context: 'Could not save completed run metadata' });
      }
      return {
        ...existing,
        status: 'completed',
        output: output as TOutput & JsonValue,
        ...(existing.policyWarnings?.length ||
        existing.replayWarnings?.length ||
        existing.harnessWarnings?.length
          ? {
              warnings: [
                ...(existing.policyWarnings ?? []),
                ...(existing.replayWarnings ?? []),
                ...(existing.harnessWarnings ?? []),
              ],
            }
          : {}),
      };
    }
    const now = new Date().toISOString();
    const record: RunRecord = existing ?? {
      formatVersion: 7,
      seq: 0,
      engine: { quietChoir: engineInfo.version, node: process.version },
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
    const priorSequence = Object.entries(record.steps).map(([id, step]) => ({
      id,
      seq: step.seq ?? 0,
    }));
    const healed = new Set<string>();
    let strictHealedDivergence: Error | undefined;
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
    function launch<T>(
      id: string,
      work: () => T | PromiseLike<T>,
      effectOperation = true,
      waiting = false,
    ): Promise<T> {
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
              if (typeof id === 'string') origins.remember(error, id);
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
    const observations = new RunObservations(record, save, (event, replayed) => {
      notify({ ...event, message: event.message ?? '', attempt: 0, runId: record.id, replayed });
    });
    const emit = (
      type: Exclude<WorkflowEvent['type'], RunEvent['type']>,
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
        ...details,
      });
    };

    const emitAdmission = (
      type: 'agent.queued' | 'agent.admitted',
      id: string,
      step: StepRecord,
      provider: string,
      waitedMs: number,
    ): void => {
      try {
        emit(type, id, step, { provider, waitedMs, ...limiter.snapshot() });
      } catch {
        /* Custom diagnostics must not leak or invalidate an invocation slot. */
      }
    };

    async function beforeLive(id: string, step: StepRecord): Promise<void> {
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
          const failure = options.strictReplay ? new Error(warning) : undefined;
          if (failure) controller.abort(failure);
          await save();
          emit('replay.divergence', id, step, { message: warning, skippedStepIds: skipped });
          if (failure) throw failure;
        }
      }
    }

    const worktrees = new RunWorktrees(
      record,
      options.processRunner,
      options.worktrees ?? {},
      save,
      processInvocation,
      signal,
    );

    async function effect<T, TMode extends ErrorMode = 'throw'>(
      id: string,
      kind: StepRecord['kind'],
      dependencies: JsonInput,
      schema: z.ZodType<T>,
      execution: AttemptPolicy,
      action: (
        context: StepContext,
        step: StepRecord,
        attempt: AttemptRecord,
        releaseAfterSave: (release: () => void) => void,
        transcript: AgentTranscriptWriter | undefined,
      ) => Promise<T> | T,
      wakeAt: number | null,
      requestedIdentity?: StepIdentity,
      local?: StepDefinition<T>,
      onError?: TMode,
      observedRequest: RequestSummary | null = null,
      observedPhase: PhaseInfo | null = observations.phase,
      legacyDependencies?: JsonValue,
      observedExec?: ExecSummary,
      isolation?: {
        readonly value: WorktreeIsolation;
        readonly cwd: string;
        readonly agent?: boolean;
      },
    ): Promise<EffectResult<T, TMode>> {
      const signal = scopes.signal;
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
          'Nested durable steps are unsupported; compose steps in the workflow body.',
        );
      signal.throwIfAborted();
      validateStepId(id, names.describe(id));
      if (used.has(id)) throw duplicateStepId(id, names.describe(id));
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
        identity =
          requestedIdentity ??
          stepIdentity({
            kind,
            onError: onError ?? 'throw',
            input: savedDependencies,
            schema: schemaJson(schema),
            ...(local
              ? {
                  callback: Function.prototype.toString.call(local.run),
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
      if (prior?.legacyIdentity === 1) {
        if ((kind === 'claude' || kind === 'codex') && isTerminalStep(prior))
          throw new Error(
            `Step ${id}: original format-one agent has no pinned isolation mode; start a new run or invalidate it in a fork.`,
          );
        const oldFingerprint = digest({
          kind,
          dependencies: legacyDependencies ?? jsonValue(dependencies),
          schema: schemaJson(schema),
          retry: {
            maxAttempts: local?.retry?.maxAttempts ?? 1,
            delayMs: local?.retry?.delayMs ?? 100,
          },
        });
        if (prior.kind !== kind || prior.fingerprint !== oldFingerprint || onError === 'return')
          throw new Error(
            `Step ${id}: original format-one identity changed; restore its inputs/options/schema/retry before migrating or start a new run.`,
          );
        prior.fingerprint = stepFingerprint;
        prior.identity = identity;
        prior.seq = nextSeq++;
        delete prior.legacyIdentity;
        await save();
      }
      const redefined =
        prior !== undefined && (prior.kind !== kind || prior.fingerprint !== stepFingerprint);
      if (redefined && (prior.kind === 'ask' || prior.kind === 'wait'))
        throw new Error(
          `Step ${id}: a ${prior.kind === 'ask' ? 'question' : 'wait'} cannot be redefined as another effect; use a new ID.`,
        );
      if (redefined && isTerminalStep(prior)) {
        const changed = [
          ...new Set([...Object.keys(prior.identity ?? {}), ...Object.keys(identity)]),
        ].filter((key) => prior.identity?.[key] !== identity[key]);
        throw new Error(
          `Step ${id}: ${changed.join(', ') || 'identity'} changed on a ${prior.status === 'completed' ? 'completed' : 'settled-failed'} step; start a new run.`,
        );
      }
      if (prior && isTerminalStep(prior)) {
        const output = replay(prior);
        emit('step.replayed', id, prior);
        return output;
      }
      if (options.rehearsal && (isolation || kind === 'worktree' || kind === 'merge'))
        throw new ConfigurationError(
          'Dry-run does not simulate Git worktree effects. Use a fixture harness in a temporary repository to rehearse isolation without paid calls.',
        );
      const wasFailed = prior?.status === 'failed';
      if (!prior && record.forkedFrom) {
        const candidate = reuseCandidate(
          record.forkedFrom,
          forkSource,
          id,
          kind,
          stepFingerprint,
          (sourceStep) =>
            kind === 'worktree'
              ? false
              : sourceStep.status === 'settled-failed'
                ? onError === 'return' && sourceStep.settledError !== undefined
                : schema.safeParse(structuredClone(sourceStep.output)).success,
        );
        if (candidate) {
          const copied: StepRecord = {
            ...structuredClone(candidate),
            seq: nextSeq++,
            reusedFrom: {
              runId: record.forkedFrom.runId,
              stateDir: record.forkedFrom.stateDir,
              stepId: id,
              fingerprint: stepFingerprint,
              at: new Date().toISOString(),
            },
          };
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
      }
      if (strictHealedDivergence) {
        controller.abort(strictHealedDivergence);
        throw strictHealedDivergence;
      }
      const step: StepRecord = prior ?? {
        kind,
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
      if (redefined) {
        (step.redefinitions ??= []).push({
          fingerprint: step.fingerprint,
          identity: step.identity ?? {},
          redefinedAt: new Date().toISOString(),
        });
        step.kind = kind;
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
      for (let attempt = 1; ; attempt++) {
        signal.throwIfAborted();
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
        step.startedAt = new Date().toISOString();
        step.finishedAt = null;
        step.durationMs = null;
        const attemptStarted = performance.now();
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
        const agent = kind === 'claude' || kind === 'codex';
        if (kind === 'claude')
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
              const context: StepContext = {
                signal,
                cwd,
                idempotencyKey: `${record.id}/${id}`,
                attempt: step.attempts,
              };
              if (isolation)
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
                    kind,
                    execution.policy.maxTranscriptBytes ?? 64 * 1024 * 1024,
                  );
                  recordTranscript();
                  await save();
                } catch (error) {
                  return transcriptFailure(error);
                }
              }
              return action(
                lease ? { ...context, cwd: lease.cwd } : context,
                step,
                attemptRecord,
                (release) => {
                  releases.push(release);
                },
                transcript,
              );
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
            // Only an aborted scope signal is a scope cancellation. A callback's own AbortError
            // keeps its message and fails the step, but is still never retried or settled. This
            // run's own storage failure (e.g. process registration) aborts the run but stays a failure.
            const scoped = signal.aborted && !checkpointProblems.includes(cause as CheckpointError);
            const error = scoped ? cancellationError(signal, cause) : cause;
            origins.remember(error, id);
            const outcome = stepError(error, step.attempts);
            step.status = scoped ? 'cancelled' : 'failed';
            if (error instanceof CancelledError) step.cancelledBy = error.cancelledBy;
            step.error = outcome.message;
            step.errorStack = errorStack(error);
            attemptRecord.errorStack = step.errorStack;
            attemptRecord.errorKind = outcome.kind;
            attemptRecord.status = scoped ? 'cancelled' : 'failed';
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
              if (evidence.usage !== null) attemptRecord.usage = structuredClone(evidence.usage);
              attemptRecord.diagnostics = { ...attemptRecord.diagnostics, ...evidence.diagnostics };
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
                provider: kind,
                outcome: scoped ? 'cancelled' : 'failed',
                sessionId: attemptRecord.sessionId ?? attemptRecord.requestedSessionId ?? null,
                ...(attemptRecord.usage ? { usage: attemptRecord.usage } : {}),
                diagnostics: attemptRecord.diagnostics ?? {},
              });
            }
            // Only this run's own storage failures are fatal; a domain error reusing the class is not.
            const infrastructure =
              checkpointProblems.includes(cause as CheckpointError) ||
              cause instanceof ConfigurationError;
            // Configuration failures must also never become settled map data.
            if (cause instanceof ConfigurationError) origins.markFatal(error);
            const fatal = scoped || errorKind(cause) === 'cancelled' || infrastructure;
            const retry =
              !fatal &&
              attempt < maxAttempts &&
              (execution.policy.retry.on === undefined ||
                execution.policy.retry.on.includes(outcome.kind));
            if (!fatal && !retry && onError === 'return') {
              step.status = 'settled-failed';
              step.settledError = outcome;
              if (!(await trySave())) throw error;
              emit('step.settled', id, step);
              return replay(step);
            }
            if (await trySave()) emit(scoped ? 'step.cancelled' : 'step.failed', id, step);
            if (!retry || signal.reason instanceof CheckpointError) throw error;
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
              origins.remember(cancelled, id);
              step.status = 'cancelled';
              step.cancelledBy = cancelled.cancelledBy;
              step.error = cancelled.message;
              step.errorStack = errorStack(cancelled);
              step.finishedAt = new Date().toISOString();
              step.durationMs = Math.max(0, Math.round(performance.now() - attemptStarted));
              // The completed failed attempt remains history; cancellation interrupted its backoff.
              if (await trySave()) emit('step.cancelled', id, step);
              throw cancelled;
            }
            continue;
          }
          step.status = 'completed';
          attemptRecord.status = 'completed';
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
            kind === 'claude' || kind === 'codex'
              ? (step.output as unknown as AgentResult<unknown>)
              : undefined;
          if (metadata)
            emit('agent.finished', id, step, {
              provider: kind,
              outcome: 'completed',
              sessionId: metadata.sessionId,
              usage: metadata.usage,
              diagnostics: metadata.diagnostics ?? {},
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
            const later = priorSequence
              .filter((other) => other.seq > (step.seq ?? 0))
              .map((other) => other.id);
            if (later.length) {
              healed.add(id);
              const warning = `Healed step ${id} now succeeded; later recorded steps (${later.join(', ')}) may depend on its earlier failure. Use onError: return for durable fallback decisions.`;
              replayWarnings.push(warning);
              if (options.strictReplay) strictHealedDivergence = new Error(warning);
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
      }
    }

    function processInvocation(id: string, context: StepContext): HarnessInvocation {
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

    function exec<T>(
      leaf: string,
      command: Command,
      settings: ExecOptions,
      schema: z.ZodType<T> | null,
    ): Promise<T | ExecResult> {
      const id = names.qualify(leaf);
      const phase = observations.phase;
      return launch(id, async () => {
        if (schema !== null && !(schema instanceof z.ZodType))
          throw new Error('exec.json requires a Zod schema.');
        const prepared = await prepareExec(command, settings, cwd, schema !== null);
        const execution = resolvePolicy(
          id,
          'exec',
          prepared.settings,
          { timeoutMs: 300_000, maxOutputBytes: 1_048_576 },
          policy,
          matchedPolicy,
        );
        const outputSchema = schema ?? execResultSchema;
        const jsonSchema = schemaJson(outputSchema);
        options.rehearsal?.onSchema?.(id, outputSchema);
        const identity = stepIdentity({
          kind: 'exec',
          ...(prepared.settings.worktree === undefined
            ? {}
            : { worktree: isolationIdentity(prepared.settings.worktree) }),
          ...(jsonValue(prepared.summary) as Record<string, JsonValue>),
          schema: jsonSchema,
        });
        return effect<T | ExecResult>(
          id,
          'exec',
          null,
          outputSchema,
          execution,
          (context) =>
            executeCommand(
              options.processRunner,
              {
                command: prepared.summary.command,
                cwd: prepared.settings.worktree === undefined ? prepared.summary.cwd : context.cwd,
                env: prepared.env,
                inheritEnv: prepared.summary.inheritEnv,
                input: prepared.input,
                timeoutMs: execution.policy.timeoutMs ?? 300_000,
                maxOutputBytes: execution.policy.maxOutputBytes ?? 1_048_576,
                capture: schema ? 'error' : 'truncate',
                schema: schema ? jsonSchema : null,
              },
              processInvocation(id, context),
              prepared.summary.okExitCodes,
              schema,
            ),
          null,
          identity,
          undefined,
          undefined,
          null,
          phase,
          undefined,
          prepared.summary,
          prepared.settings.worktree === undefined
            ? undefined
            : { value: prepared.settings.worktree, cwd: prepared.summary.cwd },
        );
      });
    }

    const metadataRequests = new Map<string, Promise<void>>();
    // Discovery is run-owned; an aborted scope may abandon its wait, so draining releases the rest.
    const discoveryController = new AbortController();
    const discoverySignal = AbortSignal.any([signal, discoveryController.signal]);
    async function drainDiscovery(): Promise<void> {
      // Every effect that awaited discovery has settled, so any unsettled request is abandoned.
      discoveryController.abort(new CancelledError(null, undefined));
      await Promise.allSettled(metadataRequests.values());
    }
    function client<TOptions extends AgentOptions>(
      provider: 'claude' | 'codex',
    ): AgentClient<TOptions> {
      function invoke<T, TMode extends ErrorMode, TResult>(
        leaf: string,
        agentOptions: TOptions & { readonly onError?: TMode },
        outputSchema: () => z.ZodType<T>,
        structured: boolean,
        select: (result: EffectResult<AgentResult<T>, TMode>) => TResult,
      ): Promise<TResult> {
        const id = names.qualify(leaf);
        const phase = observations.phase;
        return launch(id, async () => {
          let request: HarnessRequestInput;
          let schema: z.ZodType<T>;
          let execution: AttemptPolicy;
          let profile: ResolvedProfile;
          let legacyRequest: JsonValue;
          try {
            const data = jsonValue(
              { options: optionData(agentOptions, structured) },
              `Step "${id}" agent request`,
            ) as {
              options: TOptions & JsonValue;
            };
            validateAgentOptions(provider, data.options, false);
            const resolvedProfile = resolveProfileCall(
              capabilities,
              provider,
              data.options,
              grants,
              grantedProfiles,
            );
            profile = resolvedProfile.profile;
            schema = outputSchema();
            legacyRequest = jsonValue({
              provider,
              options: data.options,
              cwd: resolve(cwd, data.options.cwd ?? '.'),
              outputSchema: structured ? schemaJson(schema) : null,
            });
            options.rehearsal?.onSchema?.(id, schema);
            execution = resolvePolicy(
              id,
              provider,
              data.options,
              options.harness?.policyDefaults?.(provider) ?? {},
              policy,
              matchedPolicy,
              profile,
              profileOverrides,
            );
            // Provider semantics supply model/effort defaults, while per-call and launch policy win.
            if (execution.requestedModel === null && resolvedProfile.options.model !== undefined)
              execution = {
                ...execution,
                requestedModel: resolvedProfile.options.model,
                sources: { ...execution.sources, model: `profile:${profile.name}` },
              };
            const profileEffort = (resolvedProfile.options as CodexOptions).reasoningEffort;
            if (
              provider === 'codex' &&
              execution.reasoningEffort === null &&
              profileEffort !== undefined
            )
              execution = {
                ...execution,
                reasoningEffort: profileEffort,
                sources: { ...execution.sources, reasoningEffort: `profile:${profile.name}` },
              };
            // The shared effort is requested only when no reasoningEffort replaces it.
            if (execution.reasoningEffort === null && resolvedProfile.options.effort !== undefined)
              execution = {
                ...execution,
                sources: {
                  ...execution.sources,
                  effort:
                    data.options.effort === undefined ? `profile:${profile.name}` : 'call-site',
                },
              };
            request = jsonValue(
              {
                provider,
                options: resolvedProfile.options,
                cwd: resolve(cwd, data.options.cwd ?? '.'),
                outputSchema: structured ? schemaJson(schema) : null,
              },
              `Step "${id}" agent request`,
            ) as unknown as HarnessRequestInput;
          } catch (cause) {
            throw new Error(`Step ${id}: ${message(cause)}`, { cause });
          }
          if (request.provider === 'codex' && request.options.images !== undefined) {
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
              effort: execution.reasoningEffort ?? request.options.effort ?? 'inherited',
            },
          };
          const baseResultSchema = z.object({
            diagnostics: agentDiagnosticsSchema,
            output: schema,
            sessionId: z.string().nullable(),
            usage: z.object({
              inputTokens: z.number().nullable(),
              outputTokens: z.number().nullable(),
              costUsd: z.number().nullable(),
            }),
          });
          const isolation =
            request.options.worktree === true ? 'worktree' : request.options.worktree;
          const resultSchema =
            isolation === undefined
              ? baseResultSchema
              : baseResultSchema.extend({ worktree: worktreeChangeSchema });
          const identity = agentIdentity(request, schemaJson(resultSchema));
          const onPermissionDenied =
            provider === 'claude'
              ? ((request.options as ClaudeOptions).onPermissionDenied ??
                profile.onPermissionDenied)
              : profile.onPermissionDenied;
          if (onPermissionDenied === 'fail')
            Object.assign(identity, { onPermissionDenied: digest('fail') });
          const applied = { ...request.options };
          delete applied.retry;
          delete applied.onError;
          delete applied.worktree;
          const { timeoutMs, maxTurns, maxBudgetUsd } = execution.policy;
          Object.assign(applied, {
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
            ...(maxTurns === undefined ? {} : { maxTurns }),
            ...(maxBudgetUsd === undefined ? {} : { maxBudgetUsd }),
            ...(execution.requestedModel === null ? {} : { model: execution.requestedModel }),
            ...(execution.reasoningEffort === null
              ? {}
              : { reasoningEffort: execution.reasoningEffort }),
          });
          if (provider === 'codex' && execution.reasoningEffort !== null) delete applied.effort;
          request = { ...request, options: applied };
          validateAgentOptions(provider, request.options);
          const result = await effect(
            id,
            provider,
            jsonValue(request, `Step "${id}" agent request`),
            resultSchema,
            execution,
            async (context, step, attempt, _release, transcript) => {
              if (!options.harness)
                throw new ConfigurationError(
                  `No harness adapter configured for ${provider}. Supply RunOptions.harness.`,
                );
              const liveRequest: HarnessRequest = {
                ...request,
                ...(isolation === undefined ? {} : { cwd: context.cwd }),
                call: {
                  runId: options.runId,
                  stepId: id,
                  attempt: context.attempt,
                  idempotencyKey: context.idempotencyKey,
                },
              };
              const processContext = processInvocation(id, context);
              if (options.harness.metadata) {
                let discovery = metadataRequests.get(provider);
                if (!discovery) {
                  discovery = (async () => {
                    // Installation discovery is shared by the run, not owned by the first map subtree.
                    const metadata = await options.harness?.metadata?.(liveRequest, {
                      ...processContext,
                      signal: discoverySignal,
                    });
                    if (!metadata) return;
                    const old = record.harnesses?.[provider];
                    const warnings = [...(metadata.warnings ?? [])];
                    if (old && (old.version !== metadata.version || old.binary !== metadata.binary))
                      warnings.push(
                        `${provider} harness changed from ${old.binary}@${old.version ?? 'unknown'} to ${metadata.binary}@${metadata.version ?? 'unknown'}; completed effects remain reusable.`,
                      );
                    if (
                      old?.environment &&
                      metadata.environment &&
                      digest(old.environment) !== digest(metadata.environment)
                    )
                      warnings.push(
                        `${provider} inherited environment or scrubbed variable names changed; values are not recorded or fingerprinted.`,
                      );
                    (record.harnesses ??= {})[provider] = metadata;
                    record.harnessWarnings = [
                      ...new Set([...(record.harnessWarnings ?? []), ...warnings]),
                    ];
                    await save();
                  })();
                  // Abandoned waits must not leave an unobserved rejection behind.
                  discovery.catch(() => undefined);
                  metadataRequests.set(provider, discovery);
                }
                await untilAborted(discovery, context.signal);
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
                    provider,
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
                const admission = limiter.acquire(provider, context.signal);
                emitAdmission('agent.queued', id, step, provider, 0);
                const permit = await admission;
                try {
                  context.signal.throwIfAborted();
                  emitAdmission('agent.admitted', id, step, provider, permit.waitedMs);
                  context.signal.throwIfAborted();
                  emit('agent.started', id, step, {
                    provider,
                    sessionId: attempt.requestedSessionId ?? null,
                    model: request.options.model ?? null,
                    cliVersion: record.harnesses?.[provider]?.version ?? null,
                  });
                  response = await options.harness.invoke(liveRequest, invocation);
                } finally {
                  permit.release();
                }
              } catch (error) {
                const evidence = harnessEvidence(error);
                if (evidence) {
                  attempt.usage = evidence.usage;
                  attempt.diagnostics = { ...attempt.diagnostics, ...evidence.diagnostics };
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
                  throw profileLimitError(error, id, profile.name, execution);
                }
                throw error;
              }
              attempt.usage = structuredClone(response.usage);
              attempt.sessionId = preserveFirstSessionId(attempt, response.sessionId);
              const evidence = boundedResponse(response.text);
              attempt.response = evidence.rawText;
              attempt.responseTruncated = evidence.responseTruncated;
              attempt.diagnostics = agentDiagnosticsSchema.parse({
                ...attempt.diagnostics,
                ...(response.turns === undefined ? {} : { turns: response.turns }),
                ...(response.permissionDenials === undefined
                  ? {}
                  : { permissionDenials: response.permissionDenials }),
                ...(response.warnings === undefined ? {} : { warnings: [...response.warnings] }),
                ...response.diagnostics,
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
                    provider,
                    kind: 'permission',
                    exit: { code: 0, signal: null },
                    failure: null,
                    reason: warning,
                    stderr: '',
                    stdout: '',
                    usage: response.usage,
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
              return {
                output,
                diagnostics: attempt.diagnostics,
                sessionId: attempt.sessionId,
                usage: response.usage,
                ...(step.worktree
                  ? { worktree: { base: step.worktree.base, commit: null, ref: null, files: [] } }
                  : {}),
              };
            },
            null,
            identity,
            undefined,
            agentOptions.onError,
            requestSummary(request, execution),
            phase,
            legacyRequest,
            undefined,
            isolation === undefined
              ? undefined
              : { value: isolation, cwd: request.cwd, agent: true },
          );
          return select(result);
        });
      }
      function object<T>(
        id: string,
        agentOptions: TOptions & { readonly schema: z.ZodType<T>; readonly onError: 'return' },
      ): Promise<Settled<AgentResult<T>>>;
      function object<T, TMode extends ErrorMode = 'throw'>(
        id: string,
        agentOptions: TOptions & { readonly schema: z.ZodType<T>; readonly onError?: TMode },
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
        agentOptions: TOptions & { readonly schema: z.ZodType<T>; readonly onError?: TMode },
      ): Promise<EffectResult<T, TMode>>;
      function value<TMode extends ErrorMode = 'throw'>(
        id: string,
        agentOptions: TOptions & { readonly schema?: never; readonly onError?: TMode },
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

    const map = createMap({
      isClosed: () => closed,
      isInEffect: () => inEffect.getStore() !== undefined,
      launch,
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
      nextSeq: () => nextSeq++,
      isCheckpointFailure: (error) => checkpointProblems.includes(error as CheckpointError),
      replayed: (id, step) => {
        if (step.kind !== 'sleep')
          policy.forEach((rule, index) => {
            if (
              (rule.kind === undefined || rule.kind === step.kind) &&
              matchesStepGlob(rule.match ?? '**', id)
            )
              matchedPolicy.add(index);
          });
        emit('step.replayed', id, step);
      },
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
        return launch(`phase: ${title}`, () => observations.scoped(info, bodyOrOptions), false);
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
      observe: (source, context) => inEffect.run('poll', () => source.observe(context)),
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
      beforeLive,
      nextSeq: () => nextSeq++,
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
        async () => {
          if (inEffect.getStore())
            throw new Error(
              'Nested durable operations are unsupported inside a local effect or poll observer.',
            );
          validate?.();
          if (sources.signal && !supportsInbox)
            throw new Error('Signal waits require a RunStore with the filesystem inbox protocol.');
          if (used.has(id)) throw duplicateStepId(id, names.describe(id));
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
        true,
      );
    }
    const context: WorkflowContext = {
      cwd,
      readFile: (leaf, path, settings = {}) => {
        const id = names.qualify(leaf);
        const phase = observations.phase;
        return launch(id, async () => {
          const checked = readFileOptionsSchema.parse(settings);
          const target = await filePath(cwd, path, checked.allowOutsideCwd);
          return effect<ReadFileResult>(
            id,
            'read-file',
            null,
            readFileResultSchema,
            resolvePolicy(id, 'step', {}, {}, policy, matchedPolicy),
            async (context) => {
              const stub = options.rehearsal?.localStep?.(id, schemaJson(readFileResultSchema));
              return stub
                ? readFileResultSchema.parse(stub.output)
                : snapshotFile(target, checked.maxBytes ?? 1_048_576, context.signal);
            },
            null,
            stepIdentity({
              kind: 'read-file',
              path: target,
              schema: schemaJson(readFileResultSchema),
            }),
            undefined,
            undefined,
            null,
            phase,
          );
        });
      },
      writeFile: (leaf, path, content, settings = {}) => {
        const id = names.qualify(leaf);
        const phase = observations.phase;
        return launch(id, async () => {
          const checked = writeFileOptionsSchema.parse(settings);
          if (typeof content !== 'string') throw new Error('File content must be a string.');
          const target = await filePath(cwd, path, checked.allowOutsideCwd);
          return effect<WriteFileResult>(
            id,
            'write-file',
            null,
            writeFileResultSchema,
            resolvePolicy(id, 'step', {}, {}, policy, matchedPolicy),
            async (context) => {
              const stub = options.rehearsal?.localStep?.(id, schemaJson(writeFileResultSchema));
              return stub
                ? writeFileResultSchema.parse(stub.output)
                : replaceFile(target, content, checked as WriteFileOptions, context.signal);
            },
            null,
            stepIdentity({
              kind: 'write-file',
              path: target,
              sha256: fileDigest(content),
              ifMatch: checked.ifMatch ?? null,
              createOnly: checked.ifMatch === null,
              schema: schemaJson(writeFileResultSchema),
            }),
            undefined,
            undefined,
            null,
            phase,
          );
        });
      },
      merge: (leaf, changes, settings = {}) => {
        const id = names.qualify(leaf);
        return launch(id, () => {
          const checked = mergeOptionsSchema.parse(settings) as MergeOptions;
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
          });
          return effect(
            id,
            'merge',
            dependencies,
            mergeResultSchema,
            resolvePolicy(id, 'step', {}, {}, [], matchedPolicy),
            (context, step, attempt, releaseAfterSave) =>
              worktrees.merge(id, inputs, checked, context, step, attempt, releaseAfterSave),
            null,
          );
        });
      },
      worktree: (leaf, settings = {}) => {
        const id = names.qualify(leaf);
        return launch(id, () => {
          const parsed = worktreeCreateSchema.parse(settings);
          return effect(
            id,
            'worktree',
            parsed,
            worktreeHandleSchema,
            resolvePolicy(id, 'step', {}, {}, [], matchedPolicy),
            (context, step, attempt) => worktrees.create(id, parsed.base, context, step, attempt),
            null,
          );
        });
      },
      exec: Object.assign(
        (id: string, command: Command, settings: ExecOptions = {}) =>
          exec<never>(id, command, settings, null),
        {
          json: <T>(
            id: string,
            command: Command,
            settings: ExecOptions & { readonly schema: z.ZodType<T> },
          ): Promise<T> => {
            const { schema, ...rest } = settings;
            return exec(id, command, rest, schema) as Promise<T>;
          },
        },
      ),
      now: (id) =>
        context.step(id, {
          input: null,
          schema: z.number().int().nonnegative(),
          run: () => clockNow(clock),
        }),
      wait: <const S extends WaitSources>(id: string, sources: S) =>
        waitOperation(id, sources, (outcome) => outcome as WaitOutcome<S>),
      sleepUntil: (id, deadline) => waitOperation(id, { deadline }, () => null),
      poll: <T, N extends JsonValue = JsonValue>(id: string, settings: PollOptions<T, N>) =>
        waitOperation(
          id,
          {
            poll: settings,
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
        launch(
          'scope',
          () => {
            const path = scopeEntry(() => {
              if (typeof action !== 'function') throw new Error('Scope requires a callback.');
              return names.prefix(prefix);
            });
            return names.run(path, action);
          },
          false,
        ),
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
        step: StepDefinition<T> & { readonly onError?: TMode },
      ): Promise<EffectResult<T, TMode>> => {
        const id = names.qualify(leaf);
        return launch(id, () =>
          effect(
            id,
            'step',
            step.input,
            step.schema,
            resolvePolicy(
              id,
              'step',
              step.retry === undefined ? {} : { retry: step.retry },
              {},
              policy,
              matchedPolicy,
            ),
            options.rehearsal === undefined
              ? step.run
              : (context) => {
                  options.rehearsal?.onSchema?.(id, step.schema);
                  const stub = options.rehearsal?.localStep?.(id, schemaJson(step.schema));
                  return stub === undefined ? step.run(context) : step.schema.parse(stub.output);
                },
            null,
            undefined,
            step,
            step.onError,
            null,
            observations.phase,
            undefined,
            undefined,
            step.worktree === undefined
              ? undefined
              : { value: worktreeHandleSchema.parse(step.worktree), cwd },
          ),
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
        return launch(id, () => {
          if (
            !Number.isFinite(milliseconds) ||
            milliseconds < 0 ||
            milliseconds > Number.MAX_SAFE_INTEGER - clockNow(clock)
          )
            throw new Error(
              `Step ${id}: Sleep duration must be a finite nonnegative safe duration (got ${String(milliseconds)}).`,
            );
          return effect(
            id,
            'sleep',
            milliseconds,
            z.null(),
            resolvePolicy(id, 'sleep', {}, {}, [], matchedPolicy),
            async (context, step) => {
              context.signal.throwIfAborted();
              if (options.rehearsal === undefined)
                await waitUntil(step.wakeAt ?? clockNow(clock), context.signal, clock);
              return null;
            },
            clockNow(clock) + milliseconds,
          );
        });
      },
      map,
    };
    record.status = 'running';
    record.error = null;
    record.output = null;
    record.rootCause = null;
    const started = observations.lifecycle('run.started');
    await save();
    notify({ ...started, message: 'Run started.', attempt: 0, runId: record.id });
    const quiet = activity.quiet(
      () => questions.shouldSuspend,
      () => questions.scan(),
    );
    try {
      signal.throwIfAborted();
      let bodyOutput: { value: TOutput } | undefined;
      // This promise always has a rejection handler, even when suspension abandons the body.
      const body = Promise.resolve().then(() =>
        observations.run(() => definition.run(context, bodyInput)),
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
          record.output = null;
          warnUnmatched();
          const priorEvents = [...(record.events ?? [])];
          const suspended = observations.lifecycle('run.suspended');
          try {
            await save();
          } catch (error) {
            record.events = priorEvents;
            throw error;
          }
          notify({
            ...suspended,
            message: 'Run suspended for external conditions.',
            attempt: 0,
            runId: record.id,
          });
          return {
            ...structuredClone(record),
            status: 'suspended',
            output: null,
            pending: await pendingOperations(record, stateDir),
            resumeCommand: record.launch
              ? ['quiet-choir', 'workflow', 'resume', record.id, '--state-dir', stateDir]
              : null,
          };
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
      const missingMaps = Object.keys(maps).filter(
        (id) =>
          !visitedMaps.has(id) &&
          (maps[id]?.status === 'completed' ||
            maps[id]?.items.some((item) => item.status === 'completed')),
      );
      if (missingMaps.length)
        throw new Error(
          `Replay skipped settled maps (${missingMaps.join(', ')}); workflow control flow changed.`,
        );
      const missing = Object.entries(record.steps)
        .filter(([id, step]) => !used.has(id) && isTerminalStep(step))
        .map(([id]) => id);
      if (missing.length)
        throw new Error(
          `Replay skipped recorded steps (${missing.join(', ')}); workflow control flow changed.${healed.size ? ` Healed steps: ${[...healed].join(', ')}.` : ''}`,
        );
      const superseded = Object.entries(record.steps).filter(
        ([id, step]) =>
          !used.has(id) && step.status !== 'superseded' && step.status !== 'withdrawn',
      );
      for (const [, step] of superseded) step.status = 'superseded';
      warnUnmatched();
      record.output = jsonValue(definition.output.parse(output), 'Workflow output');
      if (!options.rehearsal) await worktrees.cleanup(true);
      record.status = 'completed';
      const priorEvents = [...(record.events ?? [])];
      const completed = observations.lifecycle('run.completed');
      try {
        await save();
      } catch (error) {
        // A later failure snapshot must not claim that an uncommitted completion happened.
        record.events = priorEvents;
        throw error;
      }
      notify({ ...completed, message: 'Run completed.', attempt: 0, runId: record.id });
      for (const [id, step] of superseded) emit('step.superseded', id, step);
      return {
        ...structuredClone(record),
        status: 'completed',
        ...(record.policyWarnings.length ||
        record.replayWarnings.length ||
        record.harnessWarnings?.length ||
        record.worktreeWarnings?.length
          ? {
              warnings: [
                ...record.policyWarnings,
                ...record.replayWarnings,
                ...(record.harnessWarnings ?? []),
                ...(record.worktreeWarnings ?? []),
              ],
            }
          : {}),
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
        ? { stepId: null, error: message(error) }
        : origins.root(error);
      // Body failures stop new launches but preserve in-flight work. Only explicit cancellation
      // or checkpoint failure aborts a scope; draining here does not send a signal.
      questions.drain();
      await Promise.race([operations.drain(), quiet.catch(() => operations.drain())]);
      await drainDiscovery();
      await questions.close();
      observationsClosed = true;
      await observations.flush().catch(() => undefined);
      if (!options.rehearsal) await worktrees.cleanup(false).catch(() => undefined);
      // A callback's own AbortError is a failure; only scope cancellation cancels the run.
      record.status = interrupted || error instanceof CancelledError ? 'cancelled' : 'failed';
      record.error = message(error);
      if (hasTerminalOutcomes(record))
        record.recoveryHint =
          'All recorded work has terminal outcomes, including settled map items. Fix the workflow tail/output and use --resume --accept-code-change to re-finalize; unchanged identities reuse their results.';
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
