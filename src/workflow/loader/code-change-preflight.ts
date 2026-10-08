import { formatArgv } from './next-commands.js';
import { workflowArgv, type CommandLauncher } from '../runtime/commands.js';
import {
  ReplaySkippedError,
  RunRefusedError,
  SettledMapChangedError,
  type StepIdentityChangedError,
} from '../runtime/run-errors.js';

const divergenceRefusals = new WeakSet<Error>();

/** The singular `skipped` value of a `details.divergent` entry for each kind of skipped record. */
const skippedEntry = { steps: 'step', maps: 'map', 'child-frames': 'child-frame' } as const;

/** How a refusal message names each kind of skipped record. */
const skippedNoun = {
  steps: 'recorded steps',
  maps: 'settled maps',
  'child-frames': 'completed or settled child frames',
} as const;

/** The ID a fork invalidates: the changed step or settled map, or the first skipped record. */
function invalidatedId(
  change: Pick<StepIdentityChangedError, 'stepId'> | ReplaySkippedError | SettledMapChangedError,
): string {
  if (change instanceof SettledMapChangedError) return change.mapId;
  return change instanceof ReplaySkippedError ? (change.skipped[0] ?? '<STEP_ID>') : change.stepId;
}

/** The fork command that replaces a refused accepted resume, spelled like `resumeCommand`. @internal */
export function forkCommand(
  change: Pick<StepIdentityChangedError, 'stepId'> | ReplaySkippedError | SettledMapChangedError,
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
    invalidatedId(change),
    '--run-id',
    '<NEW_RUN_ID>',
    '--state-dir',
    target.stateDir,
  );
}

/**
 * The `run.incompatible` refusal for an accepted resume whose replay would fail on a changed
 * completed step, on recorded work the changed body skips, or on a settled map changed beyond its
 * mapper. `details.divergent` names the changed step (`{stepId, components}`), the changed settled
 * map (`{stepId, components, map: true}`, plus `legacy: true` and no components for a journal that
 * predates per-component fingerprints) or each skipped ID (`{stepId, skipped}`, where `skipped` is
 * `step`, `map` or `child-frame`), and `details.next` the fork command. @internal
 */
export function divergenceRefusal(
  change: StepIdentityChangedError | ReplaySkippedError | SettledMapChangedError,
  target: { readonly runId: string; readonly stateDir: string; readonly entrypoint: string },
  launcher?: CommandLauncher,
): RunRefusedError {
  const next = forkCommand(change, target, launcher);
  const error =
    change instanceof SettledMapChangedError
      ? new RunRefusedError(
          'run.incompatible',
          target.runId,
          `${change.legacy ? `Settled map ${change.mapId} changed after an item completed; its journal predates per-component fingerprints, so the changed component is unknown.` : `Settled map ${change.mapId}: ${change.components.join(', ') || 'identity'} changed after an item completed.`} --accept-code-change accepts only a mapper change, so this resume would record the change, clear the saved outcome and then fail; nothing was changed. Fork a new run instead: ${formatArgv(next)}`,
          {
            divergent: [
              {
                stepId: change.mapId,
                components: [...change.components],
                map: true,
                ...(change.legacy ? { legacy: true } : {}),
              },
            ],
            next: [next],
          },
          { cause: change },
        )
      : change instanceof ReplaySkippedError
        ? new RunRefusedError(
            'run.incompatible',
            target.runId,
            `The changed workflow skipped ${skippedNoun[change.kind]} (${change.skipped.join(', ')})${change.healed.length ? ` after healed steps (${change.healed.join(', ')})` : ''}. --accept-code-change still requires the body to revisit every completed step, settled map and child frame, so this resume would record the change, clear the saved outcome and then fail; nothing was changed. Fork a new run instead: ${formatArgv(next)}`,
            {
              divergent: change.skipped.map((stepId) => ({
                stepId,
                skipped: skippedEntry[change.kind],
              })),
              next: [next],
            },
            { cause: change },
          )
        : new RunRefusedError(
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
