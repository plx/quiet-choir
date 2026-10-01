import type { HarnessSelection } from './harness-selection.js';
import { RehearsalHarness, rehearsalState } from './rehearsal.js';
import { runWorkflow, type RunOptions } from '../runtime/runner.js';
import {
  findStepIdentityChange,
  RunRefusedError,
  type StepIdentityChangedError,
} from '../runtime/run-errors.js';

/**
 * The real run's options that an accepted-replay preflight shares. Everything that could reach the
 * real record or a live harness (a bound store, named adapters, factory configurations, blocking
 * waits, event observers, orphan recovery) is excluded by type; the preflight supplies its own
 * state directory, harness, hooks and process runner. @internal
 */
export type PreflightRunOptions = Omit<
  RunOptions,
  | 'stateDir'
  | 'store'
  | 'harness'
  | 'adapters'
  | 'harnessConfigurations'
  | 'rehearsal'
  | 'processRunner'
  | 'processSupervisor'
  | 'killOrphans'
  | 'waitMode'
  | 'allowHarnessChange'
  | 'forkFrom'
  | 'onEvent'
>;

const divergenceRefusals = new WeakSet<Error>();

/**
 * Replay an accepted code change against a disposable copy of the run, with fixtures disabled and
 * every unfinished local step, file effect, poll observer and command stubbed, and report the first
 * completed-step identity change it meets. Any other outcome (completion, suspension, a refusal
 * before the body, a rehearsal limitation or an ordinary failure) finds nothing, so the real run
 * proceeds and reproduces any genuine problem itself. Only an abort propagates. @internal
 */
export async function preflightAcceptedReplay(
  definition: Parameters<typeof runWorkflow>[0],
  options: PreflightRunOptions,
  context: { readonly stateDir: string; readonly selection?: HarnessSelection },
): Promise<StepIdentityChangedError | undefined> {
  let copy: Awaited<ReturnType<typeof rehearsalState>> | undefined;
  try {
    copy = await rehearsalState(options.runId, context.stateDir, true);
    const rehearsal = new RehearsalHarness(
      { kind: 'cli', config: context.selection?.config ?? {} },
      ['**'],
    );
    await runWorkflow(definition, {
      ...options,
      stateDir: copy.stateDir,
      harness: rehearsal,
      rehearsal: rehearsal.hooks,
      processRunner: rehearsal.processRunner,
      allowHarnessChange: true,
      // A blocking wait would never end: rehearsal skips timers and nobody answers the copy.
      waitMode: 'suspend',
      resume: true,
      acceptCodeChange: true,
    });
    return undefined;
  } catch (error) {
    // The copy may hold an interrupted or cancelled record; report the abort, never the copy.
    options.signal?.throwIfAborted();
    return findStepIdentityChange(error);
  } finally {
    await copy?.dispose();
  }
}

/** The fork command that replaces a refused accepted resume, spelled like `resumeCommand`. @internal */
export function forkCommand(
  change: Pick<StepIdentityChangedError, 'stepId'>,
  target: { readonly runId: string; readonly stateDir: string; readonly entrypoint: string },
): string[] {
  return [
    'quiet-choir',
    'workflow',
    'execute',
    target.entrypoint,
    '--fork-from',
    target.runId,
    '--reuse',
    'matching',
    '--invalidate',
    change.stepId,
    '--run-id',
    '<NEW_RUN_ID>',
    '--state-dir',
    target.stateDir,
  ];
}

/**
 * The `run.incompatible` refusal for an accepted resume whose replay would fail on a changed
 * completed step. `details.divergent` names the step and `details.next` the fork command. @internal
 */
export function divergenceRefusal(
  change: StepIdentityChangedError,
  target: { readonly runId: string; readonly stateDir: string; readonly entrypoint: string },
): RunRefusedError {
  const next = forkCommand(change, target);
  const error = new RunRefusedError(
    'run.incompatible',
    target.runId,
    `Step ${change.stepId}: ${change.components.join(', ') || 'identity'} changed on a ${change.status} step. --accept-code-change never reuses a changed ${change.status} step, so this resume would record the change, clear the saved outcome and then fail; nothing was changed. Fork a new run instead: ${next.map(shellWord).join(' ')}`,
    {
      divergent: [{ stepId: change.stepId, components: [...change.components] }],
      next: [next],
    },
    { cause: change },
  );
  divergenceRefusals.add(error);
  return error;
}

/** Whether an error is a refusal built by {@link divergenceRefusal}. @internal */
export function isDivergenceRefusal(error: unknown): boolean {
  return error instanceof Error && divergenceRefusals.has(error);
}

function shellWord(value: string): string {
  return value === '<NEW_RUN_ID>' || /^[\w./:@%+=,-]+$/u.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
}
