import { formatArgv } from './next-commands.js';
import { workflowArgv, type CommandLauncher } from '../runtime/commands.js';
import { RunRefusedError, type StepIdentityChangedError } from '../runtime/run-errors.js';

const divergenceRefusals = new WeakSet<Error>();

/** The fork command that replaces a refused accepted resume, spelled like `resumeCommand`. @internal */
export function forkCommand(
  change: Pick<StepIdentityChangedError, 'stepId'>,
  target: { readonly runId: string; readonly stateDir: string; readonly entrypoint: string },
  launcher?: CommandLauncher,
): string[] {
  return workflowArgv(
    launcher,
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
  );
}

/**
 * The `run.incompatible` refusal for an accepted resume whose replay would fail on a changed
 * completed step. `details.divergent` names the step and `details.next` the fork command. @internal
 */
export function divergenceRefusal(
  change: StepIdentityChangedError,
  target: { readonly runId: string; readonly stateDir: string; readonly entrypoint: string },
  launcher?: CommandLauncher,
): RunRefusedError {
  const next = forkCommand(change, target, launcher);
  const error = new RunRefusedError(
    'run.incompatible',
    target.runId,
    `Step ${change.stepId}: ${change.components.join(', ') || 'identity'} changed on a ${change.status} step. --accept-code-change never reuses a changed ${change.status} step, so this resume would record the change, clear the saved outcome and then fail; nothing was changed. Fork a new run instead: ${formatArgv(next)}`,
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
