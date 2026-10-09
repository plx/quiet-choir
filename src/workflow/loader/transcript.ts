import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import { readAttemptTranscript, transcriptDirectoryName } from '../runtime/agent-transcript.js';
import { runDirectory } from '../runtime/paths.js';
import { RunRefusedError } from '../runtime/run-errors.js';
import type { AttemptRecord, RunRecord, StepRecord } from '../runtime/store.js';
import { workflowFailure, type WorkflowFailure } from './failure.js';
import type { TranscriptWorkflowPlan, WorkflowCommandResult } from './model.js';

/** At most this many agent steps with a transcript are listed for an unknown step. */
const maxListedSteps = 20;
/** The `<attempt>.<harness>.jsonl` name an attempt transcript is created with. */
const transcriptFileName = /^\d+\.[A-Za-z0-9_-]+\.jsonl$/u;

/** Why `workflow transcript` could not select a transcript: always `usage.flag`. @internal */
export type TranscriptSelectionReason =
  'unknown-step' | 'not-agent' | 'unknown-attempt' | 'no-transcript';

function agentStep(step: StepRecord): boolean {
  return step.kind === 'agent' || step.kind === 'claude' || step.kind === 'codex';
}

/**
 * Decode one agent attempt's transcript of a run that `readRequiredRun` already returned. A wrong
 * step, a non-agent step, an unknown attempt or an attempt without a retained transcript is a
 * `usage.flag` failure with `details.reason`. The receipt's path counts only through its
 * `<runId>/attempts/<step hash>/<attempt>.<harness>.jsonl` tail, re-rooted under `stateDir`. A
 * receipt without that tail for this run and step, or whose file is missing, resolves outside the
 * run's `attempts/` directory, is a symlink or is malformed, throws `run.unreadable`, except that a
 * running or interrupted attempt's torn final line is dropped; a running one reports `inProgress`.
 * Decoded bytes go to `onChunk` in order; an aborted `signal` stops the read before it opens the
 * file, between blocks and chunks, and before it reports success, throwing its reason. @internal
 */
export async function decodeStepTranscript(
  plan: TranscriptWorkflowPlan,
  run: RunRecord,
  stateDir: string,
  onChunk: (chunk: Uint8Array) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<WorkflowCommandResult> {
  const context = { runId: plan.runId, stateDir };
  const refuse = (
    reason: TranscriptSelectionReason,
    message: string,
    extra: Record<string, readonly string[]> = {},
  ): WorkflowFailure =>
    workflowFailure('usage.flag', message, {
      ...context,
      stepId: plan.stepId,
      details: {
        runId: plan.runId,
        stepId: plan.stepId,
        attempt: plan.attempt ?? null,
        reason,
        ...extra,
      },
    });
  const step = Object.hasOwn(run.steps, plan.stepId) ? run.steps[plan.stepId] : undefined;
  if (step === undefined) {
    const agentSteps = Object.entries(run.steps)
      .filter(
        ([, candidate]) =>
          agentStep(candidate) &&
          candidate.attemptHistory?.some((attempt) => attempt.transcript?.retained === true),
      )
      .map(([id]) => id)
      .slice(0, maxListedSteps);
    return refuse(
      'unknown-step',
      `Run ${plan.runId} has no step ${plan.stepId}. ${
        agentSteps.length
          ? `Agent steps with a transcript: ${agentSteps.join(', ')}.`
          : 'No agent step of this run has a retained transcript.'
      } Pass the full step ID, as workflow inspect shows it.`,
      { agentSteps },
    );
  }
  if (!agentStep(step))
    return refuse(
      'not-agent',
      `Step ${plan.stepId} of run ${plan.runId} is a ${step.kind} step; only agent steps have transcripts.`,
    );
  const history = step.attemptHistory ?? [];
  const attempt: AttemptRecord | undefined =
    plan.attempt === undefined
      ? history.at(-1)
      : history.find((entry) => entry.attempt === plan.attempt);
  if (attempt === undefined)
    return refuse(
      'unknown-attempt',
      plan.attempt === undefined
        ? `Step ${plan.stepId} of run ${plan.runId} has no recorded attempt.`
        : `Step ${plan.stepId} of run ${plan.runId} has no attempt ${String(plan.attempt)}; recorded attempts: ${
            history.map((entry) => String(entry.attempt)).join(', ') || 'none'
          }.`,
    );
  const receipt = attempt.transcript;
  if (receipt?.retained !== true)
    return refuse(
      'no-transcript',
      receipt === undefined
        ? `Attempt ${String(attempt.attempt)} of step ${plan.stepId} recorded no transcript; the run's policy had transcripts: off.`
        : `Attempt ${String(attempt.attempt)} of step ${plan.stepId} no longer has its transcript; transcripts: on-failure removes it after a successful attempt.`,
    );
  const unreadable = (message: string, cause?: unknown): RunRefusedError =>
    new RunRefusedError(
      'run.unreadable',
      plan.runId,
      message,
      { runId: plan.runId, stepId: plan.stepId, attempt: attempt.attempt, path: receipt.path },
      cause === undefined ? undefined : { cause },
    );
  // A record is ordinary JSON on disk; a hand-edited path must not steer the read elsewhere. Only
  // the receipt's run-relative tail counts, re-rooted under this state directory, so a state
  // directory reached through another spelling, a symlink or after a move still resolves.
  const attempts = join(runDirectory(stateDir, plan.runId), 'attempts');
  const recorded = isAbsolute(receipt.path) ? receipt.path.split(sep).slice(-4) : [];
  const [runId, attemptsName, hashDir, file] = recorded;
  if (
    runId !== plan.runId ||
    attemptsName !== 'attempts' ||
    hashDir !== transcriptDirectoryName(plan.stepId) ||
    file === undefined ||
    !transcriptFileName.test(file)
  )
    throw unreadable(
      `The transcript path recorded for attempt ${String(attempt.attempt)} of step ${plan.stepId} is not ${plan.runId}/attempts/<sha256 of the step ID>/<attempt>.<harness>.jsonl; refusing to read it.${
        step.reusedFrom === undefined
          ? ''
          : ` The step was reused from run ${step.reusedFrom.runId}; read the transcript there.`
      }`,
    );
  const inside = (root: string, path: string): boolean => {
    const rest = relative(root, path);
    return rest !== '' && rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
  };
  let path: string;
  try {
    signal?.throwIfAborted();
    const [root, parent] = await Promise.all([
      realpath(attempts),
      realpath(join(attempts, hashDir)),
    ]);
    path = join(parent, file);
    if (!inside(root, path))
      throw unreadable(
        `The transcript of attempt ${String(attempt.attempt)} of step ${plan.stepId} resolves outside ${attempts}; refusing to read it.`,
      );
  } catch (error) {
    if (error instanceof RunRefusedError || signal?.aborted) throw error;
    throw unreadable(
      `Could not read the transcript of attempt ${String(attempt.attempt)} of step ${plan.stepId}: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
  // A running attempt's writer may still be appending, or its process died mid-line; resume marks
  // such a dead attempt interrupted. Either way a torn final line is not damage.
  const inProgress = attempt.status === 'running';
  const tolerateTornTail = inProgress || attempt.status === 'interrupted';
  let decoded: Awaited<ReturnType<typeof readAttemptTranscript>>;
  // A failing writer or an abort is not a damaged transcript; only read errors are.
  const writing = { now: false };
  try {
    decoded = await readAttemptTranscript(
      path,
      plan.stream,
      async (chunk) => {
        writing.now = true;
        signal?.throwIfAborted();
        await onChunk(chunk);
        writing.now = false;
      },
      undefined,
      signal,
      { tolerateTornTail },
    );
  } catch (error) {
    if (writing.now || signal?.aborted) throw error;
    throw unreadable(
      `Could not read the transcript of attempt ${String(attempt.attempt)} of step ${plan.stepId}: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
  // An abort while no chunk of the selected stream was found must not read as a complete decode.
  signal?.throwIfAborted();
  return {
    kind: 'workflow.transcript.result',
    ok: true,
    runId: plan.runId,
    stepId: plan.stepId,
    attempt: attempt.attempt,
    harness: step.harness ?? step.kind,
    stream: plan.stream,
    path: receipt.path,
    bytes: decoded.bytes,
    truncated: decoded.truncated,
    inProgress,
  };
}
