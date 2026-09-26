import { snapshotImages } from './images.js';
import { profileLimitError } from './profile-diagnostics.js';
import {
  capabilityManifest,
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
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod';

import {
  CheckpointError,
  checkpointError,
  errorCode,
  withCheckpointErrors,
  writeCheckpoint,
} from './checkpoint.js';
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
import { HarnessError } from './harness-error.js';
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
  ClaudeOptions,
  CodexOptions,
  Harness,
  HarnessRequest,
  JsonValue,
  StepContext,
  StepDefinition,
  WorkflowContext,
  WorkflowDefinition,
} from './model.js';
import {
  hasTerminalOutcomes,
  isTerminalStep,
  lockRun,
  readRun,
  type RunRecord,
  type StepRecord,
  type AttemptRecord,
} from './store.js';

export { ConfigurationError } from './configuration-error.js';

/** A lightweight notification emitted after the associated checkpoint is persisted. */
export interface WorkflowEvent {
  /** Event lifecycle transition. */
  readonly type:
    | 'step.started'
    | 'step.completed'
    | 'step.replayed'
    | 'step.failed'
    | 'step.cancelled'
    | 'step.settled'
    | 'step.redefined'
    | 'step.superseded'
    | 'step.reused'
    | 'replay.divergence';
  /** Replay divergence diagnosis, when relevant. */
  readonly message?: string;
  /** Terminal or later recorded steps not yet visited before a live effect. */
  readonly skippedStepIds?: readonly string[];
  /** Failed step whose recovery could change a previously observed branch. */
  readonly healedStepId?: string;
  /** Owning execution. */
  readonly runId: string;
  /** Named effect. */
  readonly stepId: string;
  /** Total persisted attempts for this effect. */
  readonly attempt: number;
}

/** A completed run with its output type inferred from the workflow definition. */
export type WorkflowRun<TOutput> = RunRecord & {
  /** Final validated output, inferred from the workflow schema. */
  readonly output: TOutput;
  /** Policy warnings plus invocation-only cleanup warnings, returned after a persisted completion. */
  readonly warnings?: readonly string[];
};

/** Explicit dependencies and execution policy for a workflow run. */
export interface RunOptions extends WorkflowCodeOptions {
  /** Sticky named limit rules, appended on resume; policyReset clears them as well. */
  readonly profileOverrides?: readonly ProfileOverride[];
  /** Authorize elevated profiles by name, access class (write/exec), or all; saved across resumes. */
  readonly grants?: readonly string[];
  /** Required stable identifier. Reuse it with resume to continue an execution. */
  readonly runId: string;
  /** Checkpoint directory; defaults to .quiet-choir/runs under the working directory. */
  readonly stateDir?: string;
  /** Workflow working directory; defaults to process.cwd(). */
  readonly cwd?: string;
  /** Untrusted input, validated by the workflow schema. Resume uses saved input when omitted. */
  readonly input?: unknown;
  /** Resume an existing run; new execution refuses to overwrite an existing run. */
  readonly resume?: boolean;
  /** Harness integration. Local-only workflows do not need this dependency. */
  readonly harness?: Harness;
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

async function waitUntil(timestamp: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let remaining = timestamp - Date.now();
  while (remaining > 0) {
    await delay(Math.min(remaining, 2_147_483_647), undefined, { signal });
    remaining = timestamp - Date.now();
  }
}

/** Describe the boundary that aborted `signal`; callers must only pass an aborted signal. */
function cancellationError(signal: AbortSignal, cause: unknown): CancelledError {
  if (signal.reason instanceof CancelledError)
    return new CancelledError(signal.reason.cancelledBy, cause, signal.reason.scope);
  // Only the run controller aborts with another reason: a checkpoint failure or strict replay.
  return new CancelledError(null, cause, 'run');
}

/** Run or resume a workflow with local, at-least-once durable effects. Throws after saving failures. */
export async function runWorkflow<TInput, TOutput>(
  definition: WorkflowDefinition<TInput, TOutput>,
  options: RunOptions,
): Promise<WorkflowRun<TOutput>> {
  if (!definition.name.trim() || !definition.version.trim())
    throw new Error('Workflow name and version must be nonempty.');
  const capabilities = capabilityManifest(definition);
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
  const stateDir = resolveStateDir(options);
  const snapshot = workflowSnapshot(definition, options);
  const { fingerprint } = snapshot;
  const release = await lockRun(stateDir, options.runId);
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort(new CancelledError(null, options.signal?.reason));
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const { signal } = controller;
  const checkpointProblems: CheckpointError[] = [];
  async function executeOwned(): Promise<WorkflowRun<TOutput>> {
    let existing: RunRecord | undefined;
    try {
      existing = await readRun({ stateDir, runId: options.runId });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    if (existing && !options.resume)
      throw new Error(`Run ${options.runId} already exists; use resume or choose a new run ID.`);
    if (!existing && options.resume)
      throw new Error(`Run ${options.runId} does not exist; cannot resume.`);
    if (existing && existing.formatVersion !== engineInfo.formatVersion)
      throw new Error(oldFormatMessage(existing.formatVersion));
    const forkStateDir =
      fork === undefined
        ? undefined
        : await canonicalCwd(fork.stateDir === undefined ? stateDir : resolve(cwd, fork.stateDir));
    if (fork?.runId === options.runId && forkStateDir === (await canonicalCwd(stateDir)))
      throw new Error('A fork must use a different target checkpoint.');
    let forkSource =
      fork && forkStateDir ? await loadFork(fork.runId, forkStateDir, definition.name) : undefined;
    let compatibility: ResumeCheck | undefined;
    if (existing) {
      compatibility = compareResume(definition, options, cwd, existing);
      if (!compatibility.compatible) throw new Error(compatibility.message);
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
    const input = definition.input.parse(
      options.input === undefined
        ? existing
          ? existing.input
          : forkSource
            ? forkSource.input
            : options.input
        : options.input,
    );
    const savedInput = jsonValue(input);
    if (existing?.status === 'completed' && !options.acceptCodeChange) {
      const output = definition.output.parse(existing.output);
      if (
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
        await writeCheckpoint(
          stateDir,
          existing.id,
          () => structuredClone(existing),
          'Could not save execution policy',
        );
      }
      return {
        ...existing,
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
      formatVersion: 5,
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
      .filter(([, step]) => isTerminalStep(step))
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
    record.capabilities = capabilities;
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
    let writeQueue = Promise.resolve();
    function save(context = `Could not save run ${record.id}`): Promise<void> {
      const write = writeQueue
        .catch(() => {
          /* A failed write must not poison later snapshots. */
        })
        .then(async () => {
          try {
            await writeCheckpoint(
              stateDir,
              record.id,
              () => {
                record.updatedAt = new Date().toISOString();
                return structuredClone(record);
              },
              context,
            );
          } catch (error) {
            const failure =
              error instanceof CheckpointError
                ? error
                : await checkpointError('save', stateDir, record.id, error, context);
            checkpointProblems.push(failure);
            controller.abort(failure);
            throw failure;
          }
        });
      writeQueue = write;
      return write;
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
    ): Promise<T> {
      return operations.launch(
        id,
        async () => {
          try {
            if (effectOperation) validateStepId(id, names.describe(id));
            return await work();
          } catch (error) {
            if (
              effectOperation &&
              origins.find(error).stepId === null &&
              !(error instanceof CancelledError) &&
              !(error instanceof CheckpointError)
            )
              origins.markFatal(error);
            throw error;
          }
        },
        scopes.owners,
      );
    }
    const inEffect = new AsyncLocalStorage<boolean>();
    let closed = false;
    const emit = (
      type: WorkflowEvent['type'],
      id: string,
      step: StepRecord,
      details: { message?: string; skippedStepIds?: readonly string[]; healedStepId?: string } = {},
    ): void => {
      try {
        void Promise.resolve(
          options.onEvent?.({
            type,
            runId: record.id,
            stepId: id,
            attempt: step.attempts,
            ...details,
          }),
        ).catch(() => {
          /* Observers never own the workflow outcome. */
        });
      } catch {
        /* Observers must not invalidate committed effects. */
      }
    };

    async function effect<T, TMode extends ErrorMode = 'throw'>(
      id: string,
      kind: StepRecord['kind'],
      dependencies: JsonValue,
      schema: z.ZodType<T>,
      execution: AttemptPolicy,
      action: (context: StepContext, step: StepRecord) => Promise<T> | T,
      wakeAt: number | null,
      requestedIdentity?: StepIdentity,
      local?: StepDefinition<T>,
      onError?: TMode,
    ): Promise<EffectResult<T, TMode>> {
      const signal = scopes.signal;
      const value = (output: T): EffectResult<T, TMode> =>
        (onError === 'return' ? { ok: true, value: output } : output) as EffectResult<T, TMode>;
      const replay = (step: StepRecord): EffectResult<T, TMode> =>
        step.status === 'settled-failed'
          ? ({ ok: false, error: structuredClone(step.settledError) } as EffectResult<T, TMode>)
          : value(schema.parse(structuredClone(step.output)));
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
        jsonValue({ dependencies });
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
            input: dependencies,
            schema: schemaJson(schema),
            ...(local
              ? {
                  callback: Function.prototype.toString.call(local.run),
                  version: local.version ?? null,
                  cwd,
                }
              : {}),
          });
        stepFingerprint = digest(identity);
      } catch (cause) {
        throw new Error(`Step ${id}: ${message(cause)}`, { cause });
      }
      const prior = Object.hasOwn(record.steps, id) ? record.steps[id] : undefined;
      const redefined =
        prior !== undefined && (prior.kind !== kind || prior.fingerprint !== stepFingerprint);
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
      const wasFailed = prior?.status === 'failed';
      if (!prior && record.forkedFrom) {
        const candidate = reuseCandidate(
          record.forkedFrom,
          forkSource,
          id,
          kind,
          stepFingerprint,
          (sourceStep) =>
            sourceStep.status === 'settled-failed'
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
      };
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
        delete step.cancelledBy;
        const attemptRecord: AttemptRecord = {
          ...structuredClone(execution),
          attempt: step.attempts,
          fingerprint: stepFingerprint,
          startedAt: new Date().toISOString(),
          finishedAt: null as string | null,
          status: 'running',
          error: null as string | null,
        };
        (step.attemptHistory ??= []).push(attemptRecord);
        await save();
        try {
          signal.throwIfAborted();
          emit('step.started', id, step);
          const result = await inEffect.run(true, () =>
            action(
              {
                signal,
                idempotencyKey: `${record.id}/${id}`,
                attempt: step.attempts,
              },
              step,
            ),
          );
          // A resolved, valid result is durable work even if cancellation arrived meanwhile.
          // The scope still rejects its next launch.
          const output = schema.parse(result);
          step.output = jsonValue(output);
        } catch (cause) {
          // Only an aborted scope signal is a scope cancellation. A callback's own AbortError
          // keeps its message and fails the step, but is still never retried or settled.
          const scoped = signal.aborted;
          const error = scoped ? cancellationError(signal, cause) : cause;
          origins.remember(error, id);
          const outcome = stepError(error, step.attempts);
          step.status = scoped ? 'cancelled' : 'failed';
          if (error instanceof CancelledError) step.cancelledBy = error.cancelledBy;
          step.error = outcome.message;
          attemptRecord.errorKind = outcome.kind;
          attemptRecord.status = scoped ? 'cancelled' : 'failed';
          attemptRecord.finishedAt = new Date().toISOString();
          attemptRecord.error = step.error;
          if (cause instanceof HarnessError) {
            (step.failedAttempts ??= []).push({
              attempt: step.attempts,
              sessionId: cause.sessionId,
              usage: cause.usage,
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
            await waitUntil(Date.now() + Math.min(30_000, delayMs * 2 ** (attempt - 1)), signal);
          } catch (cause) {
            if (signal.reason instanceof CheckpointError) throw error;
            if (errorKind(cause) !== 'cancelled') throw cause;
            const cancelled = cancellationError(signal, cause);
            origins.remember(cancelled, id);
            step.status = 'cancelled';
            step.cancelledBy = cancelled.cancelledBy;
            step.error = cancelled.message;
            // The completed failed attempt remains history; cancellation interrupted its backoff.
            if (await trySave()) emit('step.cancelled', id, step);
            throw cancelled;
          }
          continue;
        }
        step.status = 'completed';
        attemptRecord.status = 'completed';
        attemptRecord.finishedAt = new Date().toISOString();
        await save(
          `Step ${id} completed but its checkpoint write failed; resume may repeat it unless a later save recovers the result`,
        );
        emit('step.completed', id, step);
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
        return value(schema.parse(structuredClone(step.output)));
      }
    }

    const metadataRequests = new Map<string, Promise<void>>();
    function client<TOptions extends AgentOptions>(
      provider: 'claude' | 'codex',
    ): AgentClient<TOptions> {
      function invoke<T, TMode extends ErrorMode = 'throw'>(
        leaf: string,
        agentOptions: TOptions & { readonly onError?: TMode },
        outputSchema: () => z.ZodType<T>,
        structured: boolean,
      ): Promise<EffectResult<AgentResult<T>, TMode>> {
        const id = names.qualify(leaf);
        return launch(id, async () => {
          let request: HarnessRequest;
          let schema: z.ZodType<T>;
          let execution: AttemptPolicy;
          let profile: ResolvedProfile;
          try {
            const data = jsonValue({ options: optionData(agentOptions, structured) }) as {
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
            request = jsonValue({
              provider,
              options: resolvedProfile.options,
              cwd: resolve(cwd, data.options.cwd ?? '.'),
              outputSchema: structured ? schemaJson(schema) : null,
            }) as unknown as HarnessRequest;
          } catch (cause) {
            throw new Error(`Step ${id}: ${message(cause)}`, { cause });
          }
          if (request.provider === 'codex' && request.options.images !== undefined)
            request = {
              ...request,
              imageAttachments: await snapshotImages(request.options.images, request.cwd),
            };
          execution = {
            ...execution,
            requested: {
              model: execution.requestedModel ?? 'inherited',
              effort: execution.reasoningEffort ?? request.options.effort ?? 'inherited',
            },
          };
          const resultSchema = z.object({
            output: schema,
            sessionId: z.string().nullable(),
            usage: z.object({
              inputTokens: z.number().nullable(),
              outputTokens: z.number().nullable(),
              costUsd: z.number().nullable(),
            }),
          });
          const identity = agentIdentity(request, schemaJson(resultSchema));
          if (profile.onPermissionDenied === 'fail')
            Object.assign(identity, { onPermissionDenied: digest('fail') });
          const applied = { ...request.options };
          delete applied.retry;
          delete applied.onError;
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
          return effect(
            id,
            provider,
            jsonValue(request),
            resultSchema,
            execution,
            async (context, step) => {
              if (!options.harness)
                throw new ConfigurationError(
                  `No harness adapter configured for ${provider}. Supply RunOptions.harness.`,
                );
              if (options.harness.metadata) {
                let discovery = metadataRequests.get(provider);
                if (!discovery) {
                  discovery = (async () => {
                    // Installation discovery is shared by the run, not owned by the first map subtree.
                    const metadata = await options.harness?.metadata?.(request, signal);
                    if (!metadata) return;
                    const old = record.harnesses?.[provider];
                    const warnings = [...(metadata.warnings ?? [])];
                    if (old && (old.version !== metadata.version || old.binary !== metadata.binary))
                      warnings.push(
                        `${provider} harness changed from ${old.binary}@${old.version ?? 'unknown'} to ${metadata.binary}@${metadata.version ?? 'unknown'}; completed effects remain reusable.`,
                      );
                    (record.harnesses ??= {})[provider] = metadata;
                    record.harnessWarnings = [
                      ...new Set([...(record.harnessWarnings ?? []), ...warnings]),
                    ];
                    await save();
                  })();
                  metadataRequests.set(provider, discovery);
                }
                await discovery;
                context.signal.throwIfAborted();
              }
              let response;
              try {
                response = await options.harness.invoke(request, context.signal);
              } catch (error) {
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
              if (response.warnings !== undefined) step.warnings = [...response.warnings];
              if ((response.permissionDenials ?? 0) > 0) {
                const warning = `Profile ${profile.name}: ${String(response.permissionDenials)} permission denials reported.`;
                step.warnings = [...(step.warnings ?? []), warning];
                if (profile.onPermissionDenied === 'fail')
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
                  });
              }
              const raw: unknown = structured ? JSON.parse(response.text) : response.text;
              return {
                output: schema.parse(raw),
                sessionId: response.sessionId,
                usage: response.usage,
              };
            },
            null,
            identity,
            undefined,
            agentOptions.onError,
          );
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
        return invoke<T, ErrorMode>(id, agentOptions, () => agentOptions.schema, true);
      }
      return {
        text: (id, agentOptions) => invoke(id, agentOptions, () => z.string(), false),
        object,
      };
    }

    const map = createMap({
      isClosed: () => closed,
      isInEffect: () => inEffect.getStore() === true,
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
    const context: WorkflowContext = {
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
            step.run,
            null,
            undefined,
            step,
            step.onError,
          ),
        );
      },
      sleep: (leaf, milliseconds) => {
        const id = names.qualify(leaf);
        return launch(id, () => {
          if (
            !Number.isFinite(milliseconds) ||
            milliseconds < 0 ||
            milliseconds > Number.MAX_SAFE_INTEGER - Date.now()
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
              await waitUntil(step.wakeAt ?? Date.now(), context.signal);
              return null;
            },
            Date.now() + milliseconds,
          );
        });
      },
      map,
    };
    record.status = 'running';
    record.error = null;
    record.output = null;
    record.rootCause = null;
    await save();
    try {
      signal.throwIfAborted();
      const output = await definition.run(context, input);
      await operations.drain();
      operations.assertObserved();
      closed = true;
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
        ([id, step]) => !used.has(id) && step.status !== 'superseded',
      );
      for (const [, step] of superseded) step.status = 'superseded';
      warnUnmatched();
      record.output = jsonValue(definition.output.parse(output));
      record.status = 'completed';
      await save();
      for (const [id, step] of superseded) emit('step.superseded', id, step);
      return {
        ...structuredClone(record),
        ...(record.policyWarnings.length ||
        record.replayWarnings.length ||
        record.harnessWarnings?.length
          ? {
              warnings: [
                ...record.policyWarnings,
                ...record.replayWarnings,
                ...(record.harnessWarnings ?? []),
              ],
            }
          : {}),
        output: definition.output.parse(structuredClone(record.output)) as TOutput & JsonValue,
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
      await operations.drain();
      // A callback's own AbortError is a failure; only scope cancellation cancels the run.
      record.status = interrupted || error instanceof CancelledError ? 'cancelled' : 'failed';
      record.error = message(error);
      if (hasTerminalOutcomes(record))
        record.recoveryHint =
          'All recorded work has terminal outcomes, including settled map items. Fix the workflow tail/output and use --resume --accept-code-change to re-finalize; unchanged identities reuse their results.';
      warnUnmatched();
      await trySave();
      throw error;
    }
  }
  let outcome: { ok: true; run: WorkflowRun<TOutput> } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, run: await executeOwned() };
  } catch (error) {
    outcome = { ok: false, error };
  }
  options.signal?.removeEventListener('abort', abort);
  try {
    await release();
  } catch (cause) {
    const error = await checkpointError(
      'release',
      stateDir,
      options.runId,
      cause,
      `Could not release run ${options.runId} lock`,
    );
    // lockRun keeps an errno only for a vanished lock or removal after ownership was verified.
    if (outcome.ok && (errorCode(cause) === 'EACCES' || errorCode(cause) === 'ENOENT')) {
      return { ...outcome.run, warnings: [...(outcome.run.warnings ?? []), error.message] };
    }
    // Unknown ownership and ownership changes remain fatal even after a successful save.
    checkpointProblems.push(error);
    if (outcome.ok) outcome = { ok: false, error };
  }
  if (!outcome.ok) throw withCheckpointErrors(outcome.error, checkpointProblems);
  return outcome.run;
}
