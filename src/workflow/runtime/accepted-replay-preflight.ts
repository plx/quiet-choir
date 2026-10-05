/**
 * The accepted-replay preflight's parts (#215). `runWorkflow({ resume: true, acceptCodeChange:
 * true })` replays the changed body against a disposable copy of the run before it touches the
 * real record, so a changed completed or settled-failed step, or a body that would skip a completed
 * step, settled map or child frame (#216), is refused without recording the acceptance, clearing
 * the saved output or failing the run. The CLI's `--accept-code-change`
 * relies on the same preflight and maps its refusal to `run.incompatible`.
 *
 * The probe needs no fixtures and no live integration: its harness, process runner and rehearsal
 * hooks synthesize every unfinished agent call, command, local step, file effect and poll observer
 * from its schema. The runtime recognizes the probe's hooks ({@link isPreflightProbe}) and
 * synthesizes every Git worktree effect with placeholders and no Git command (#217): `ctx.worktree`,
 * isolation on a fresh checkout or a handle, and any merge, which a `--dry-run` partly refuses.
 * The copy also holds the pending answer deliveries of the run's waiting questions, so it consumes
 * a delivered but unconsumed answer as the real run would. Only a completed-step identity change
 * ({@link StepIdentityChangedError}) or a skipped completed step, settled map or child frame
 * ({@link ReplaySkippedError}) counts as a finding.
 *
 * Completion, suspension, a refusal, a synthesis gap, a rehearsal limitation or any other failure
 * finds nothing, so the real run proceeds and reproduces any genuine problem itself; only an abort
 * propagates. What can still stop the probe before a changed step: a synthesized value that fails
 * validation (such as a refinement), a question with no delivery, an unresolved external wait, a
 * non-mapper settled-map refusal (#303), or a failure to copy the run. Synthesized values can also
 * steer the copy onto a different branch from a real run, so a finding is as good as the
 * rehearsal's path parity (ADR 0006). @internal
 */
import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import type { ProcessRunner } from './exec-model.js';
import { answerCandidates } from './inbox.js';
import type { Harness, HarnessResponse } from './model.js';
import { runDirectory } from './paths.js';
import type { RunRecord } from './record.js';
import { ReplaySkippedError, StepIdentityChangedError } from './run-errors.js';
import type { RunOptions } from './runner.js';
import { writeRun } from './store.js';
import { synthesizeOutput } from './synthesize.js';

/**
 * Options the real run passes on to its preflight are everything except these. Each could reach the
 * real record or a live integration (a bound store, named or declared adapters and their
 * configuration, process supervision and orphan recovery, blocking waits, event observers, a shared
 * agent limiter, launch metadata, Git checkout policy) or is replaced by the probe's own.
 */
const liveOnly = [
  'stateDir',
  'store',
  'harness',
  'adapters',
  'harnessConfigurations',
  'harnessConfigDigest',
  'allowHarnessConfigChange',
  'allowHarnessChange',
  'rehearsal',
  'processRunner',
  'execRunner',
  'processSupervisor',
  'killOrphans',
  'waitMode',
  'forkFrom',
  'onEvent',
  'commandLauncher',
  'agentLimit',
  'launch',
  'worktrees',
] as const satisfies readonly (keyof RunOptions)[];

/** The real run's options that an accepted-replay preflight shares. @internal */
export type PreflightRunOptions = Omit<RunOptions, (typeof liveOnly)[number]>;

/** Drop every live-only option, keeping identity, input, policy, budget, clock and signal. @internal */
export function preflightRunOptions(options: RunOptions): PreflightRunOptions {
  const excluded = new Set<string>(liveOnly);
  return Object.fromEntries(
    Object.entries(options).filter(([key]) => !excluded.has(key)),
  ) as PreflightRunOptions;
}

/** A synthesized response for one agent call, like the fixture harness's synthesize branch. */
function synthesizedResponse(
  harness: string,
  stepId: string,
  outputSchema: Parameters<typeof synthesizeOutput>[0] | null,
): HarnessResponse {
  return {
    text:
      outputSchema === null
        ? `[dry-run ${harness} ${stepId}]`
        : JSON.stringify(synthesizeOutput(outputSchema, stepId)),
    sessionId: null,
    usage: { inputTokens: null, outputTokens: null, costUsd: null },
  };
}

/**
 * The preflight's catch-all harness. It is a dry-run kind, so the runtime accepts the probe's
 * rehearsal hooks, and it reports no policy defaults: limits are policy, not identity.
 */
const probeHarness: Harness = {
  kind: 'dry-run',
  invoke: (request, invocation) =>
    new Promise((resolve) => {
      invocation.signal.throwIfAborted();
      resolve(synthesizedResponse(request.harness, request.call.stepId, request.outputSchema));
    }),
};

/**
 * Answers every command without spawning: exit 0 with empty plain stdout, or a synthesized value
 * for a structured command. Worktree Git gets the same answers, as the CLI's preflight did.
 */
const probeProcessRunner: ProcessRunner = {
  run: (request, invocation) =>
    new Promise((resolve) => {
      invocation.signal.throwIfAborted();
      resolve({
        code: 0,
        signal: null,
        stdout:
          request.schema === null
            ? ''
            : JSON.stringify(synthesizeOutput(request.schema, invocation.stepId)),
        stderr: '',
        truncated: false,
        durationMs: 0,
      });
    }),
};

/** Stub every unfinished local step, file effect and poll observer, as `--stub-steps '**'` does. */
const probeHooks: NonNullable<RunOptions['rehearsal']> = {
  localStep: (stepId, schema) => ({ output: synthesizeOutput(schema, stepId) }),
  onWorktree: () => undefined,
};

/**
 * Whether `hooks` are the probe's own rehearsal hooks, so the runner may synthesize every Git
 * worktree effect (#217). Detected by identity: no public option can ask for it. @internal
 */
export function isPreflightProbe(hooks: RunOptions['rehearsal']): boolean {
  return hooks === probeHooks;
}

/**
 * The options that point a preflight's nested run at a disposable copy: the probe harness, hooks
 * and process runner, a suspending wait, and an accepted resume. @internal
 */
export function preflightProbeOptions(
  stateDir: string,
): Required<
  Pick<
    RunOptions,
    | 'stateDir'
    | 'harness'
    | 'rehearsal'
    | 'processRunner'
    | 'execRunner'
    | 'allowHarnessChange'
    | 'waitMode'
    | 'resume'
    | 'acceptCodeChange'
  >
> {
  return {
    stateDir,
    harness: probeHarness,
    rehearsal: probeHooks,
    processRunner: probeProcessRunner,
    execRunner: probeProcessRunner,
    // The copy's adapter kind is the probe's; the real run keeps its own harness checks.
    allowHarnessChange: true,
    // A blocking wait would never end: rehearsal skips timers and nobody answers the copy.
    waitMode: 'suspend',
    resume: true,
    acceptCodeChange: true,
  };
}

/**
 * Copy each waiting question's pending delivery from `sourceStateDir` to the same relative path
 * under `stateDir`: the first existing answer candidate, which is the one the real run's question
 * reads first. A copy, never a rename or link, so the copy's consumption or rejection leaves the
 * source delivery for the real run. Rejected deliveries and cancel requests are not copied.
 */
async function copyPendingDeliveries(
  record: RunRecord,
  sourceStateDir: string,
  stateDir: string,
): Promise<void> {
  const source = resolve(sourceStateDir);
  for (const [stepId, step] of Object.entries(record.steps)) {
    if (step.status !== 'waiting' || !step.question) continue;
    for (const candidate of answerCandidates(source, record.id, stepId)) {
      const target = join(stateDir, relative(source, candidate));
      try {
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await copyFile(candidate, target, constants.COPYFILE_EXCL);
        break;
      } catch (error) {
        // A missing candidate, or a delivery withdrawn or consumed mid-copy: try the next one.
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
  }
}

/**
 * Write `record` (the one the real run read under its lock, so a custom store works too) into a
 * fresh temporary state directory, with the pending answer deliveries of its waiting questions
 * from `sourceStateDir` (the real run's resolved state directory, which its questions read).
 * `dispose` removes the directory. @internal
 */
export async function disposableRunCopy(
  record: RunRecord,
  sourceStateDir: string,
): Promise<{ readonly stateDir: string; readonly dispose: () => Promise<void> }> {
  const stateDir = await mkdtemp(join(tmpdir(), 'quiet-choir-preflight-'));
  const dispose = async (): Promise<void> => {
    await rm(stateDir, { recursive: true, force: true });
  };
  try {
    await mkdir(runDirectory(stateDir, record.id), { recursive: true, mode: 0o700 });
    // A clone, so the copy's journal writer never touches the real run's in-memory record.
    await writeRun(stateDir, structuredClone(record));
    await copyPendingDeliveries(record, sourceStateDir, stateDir);
    return { stateDir, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

const refusals = new WeakSet<Error>();

/**
 * The rejection for an accepted resume whose preflight met a changed completed or settled-failed
 * step, or skipped recorded work: an error of the same class and fields, the probe's error as its
 * cause, and a message saying the run was left unchanged. A skip's message also names the fork that
 * replaces the resume, as a changed step's message already does. @internal
 */
export function acceptedReplayRefusal(
  change: StepIdentityChangedError | ReplaySkippedError,
  runId: string,
): StepIdentityChangedError | ReplaySkippedError {
  const refused = `${change.message} The accepted replay was refused before run ${runId} was changed.`;
  const error =
    change instanceof ReplaySkippedError
      ? new ReplaySkippedError(
          `${refused} Fork a new run with --fork-from RUN --reuse matching --invalidate ${change.skipped[0] ?? '<STEP_ID>'}.`,
          { kind: change.kind, skipped: change.skipped, healed: change.healed },
          { cause: change },
        )
      : new StepIdentityChangedError(
          refused,
          { stepId: change.stepId, components: change.components, status: change.status },
          { cause: change },
        );
  refusals.add(error);
  return error;
}

/**
 * Whether `error` is the runner's own preflight refusal, thrown before the run was changed. A
 * {@link StepIdentityChangedError} or {@link ReplaySkippedError} reached any other way, such as the
 * cause of a saved failure after the preflight failed open, is not. @internal
 */
export function isAcceptedReplayRefusal(
  error: unknown,
): error is StepIdentityChangedError | ReplaySkippedError {
  return error instanceof Error && refusals.has(error);
}
