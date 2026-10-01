import { workflowArgv, type CommandLauncher } from '../runtime/commands.js';
import type { CliErrorCode } from '../runtime/run-errors.js';
import type { JsonValue } from '../runtime/model.js';
import type { RunRecord } from '../runtime/store.js';

/**
 * One runnable follow-up: why it applies and the exact argument vector to run, built behind the
 * launcher of the invocation that produced it. `<ANSWER_JSON>`, `<NEW_RUN_ID>` and `<ENTRYPOINT>`
 * are placeholders to substitute first. @internal
 */
export interface NextCommand {
  readonly why: string;
  readonly argv: readonly string[];
}

/** At most this many answer entries precede a suspended run's resume entry. @internal */
export const maxAnswerEntries = 5;
/** At most this many `run.not_found` candidates become inspect entries. @internal */
export const maxCandidateEntries = 5;

const placeholder = /^<[A-Z][A-Z_]*>$/u;

/**
 * Quote an argument vector for a POSIX shell, leaving placeholders bare so they read as slots to
 * fill. Display only: run the argv itself whenever possible. @internal
 */
export function formatArgv(argv: readonly string[]): string {
  return argv
    .map((value) =>
      placeholder.test(value) || /^[\w./:@%+=,-]+$/u.test(value)
        ? value
        : `'${value.replaceAll("'", "'\\''")}'`,
    )
    .join(' ');
}

function resume(
  launcher: CommandLauncher | undefined,
  runId: string,
  stateDir: string,
  ...flags: string[]
): string[] {
  return workflowArgv(launcher, 'resume', runId, '--state-dir', stateDir, ...flags);
}

function fork(
  launcher: CommandLauncher | undefined,
  entrypoint: string,
  runId: string,
  stateDir: string,
): string[] {
  return workflowArgv(
    launcher,
    'execute',
    entrypoint,
    '--fork-from',
    runId,
    '--run-id',
    '<NEW_RUN_ID>',
    '--state-dir',
    stateDir,
  );
}

/**
 * Follow-ups for a saved run in a given (possibly derived) status: resume a failed or stale run;
 * answer a suspended run's waiting questions (at most {@link maxAnswerEntries}), then resume it.
 * A run without a stored entrypoint (an embedded run) cannot be resumed by ID and gets none.
 * @internal
 */
export function runNextCommands(
  run: RunRecord,
  status: RunRecord['status'] | 'stale',
  stateDir: string,
  launcher?: CommandLauncher,
): NextCommand[] {
  if (!run.launch) return [];
  if (status === 'failed')
    return [
      {
        why: 'Resume the failed run; completed steps are reused and failed ones run again.',
        argv: resume(launcher, run.id, stateDir),
      },
    ];
  if (status === 'stale')
    return [
      {
        why: 'The run is marked running but its owner is gone; resume recovers it.',
        argv: resume(launcher, run.id, stateDir),
      },
    ];
  if (status !== 'suspended') return [];
  const answers = Object.entries(run.steps)
    .filter(([, step]) => step.status === 'waiting' && step.question)
    .slice(0, maxAnswerEntries)
    .map(([stepId, step]) => ({
      why: `Answer ${stepId}: substitute <ANSWER_JSON>${step.question?.request.audience === 'human' ? ' with a human decision and add --by human:<name>' : ''}.`,
      argv: workflowArgv(
        launcher,
        'answer',
        run.id,
        stepId,
        '--state-dir',
        stateDir,
        '--json',
        '<ANSWER_JSON>',
      ),
    }));
  return [
    ...answers,
    {
      why: run.interruptedBy
        ? 'The run was interrupted into a resumable suspension; resume it.'
        : 'Resume once its waits are answered or due; an unanswered wait suspends it again.',
      argv: resume(launcher, run.id, stateDir),
    },
  ];
}

function record(value: JsonValue): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function strings(value: JsonValue | undefined): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : undefined;
}

/** Plain-data failure context that {@link failureNextCommands} reads. @internal */
export interface FailureNextContext {
  readonly code: CliErrorCode;
  readonly details: JsonValue;
  readonly run: RunRecord | null;
  readonly runId: string | null;
  readonly stateDir: string | null;
  readonly launcher?: CommandLauncher | undefined;
  /** A dry-run's state is temporary, so nothing it reports can be resumed. */
  readonly rehearsal: boolean;
}

function incompatibleNext(
  context: FailureNextContext,
  details: Record<string, JsonValue>,
  runId: string,
  stateDir: string,
): NextCommand[] {
  const { launcher, run } = context;
  // Fork refuses legacy (format 1) checkpoints, so such a run never gets a fork entry.
  const canFork = !run || run.formatVersion === 6 || run.formatVersion === 7;
  if (details['reason'] === 'entrypoint_missing')
    return canFork
      ? [
          {
            why: 'The stored entrypoint is gone (moved checkout or deleted file); fork from its new location, substituting <ENTRYPOINT>.',
            argv: fork(launcher, '<ENTRYPOINT>', runId, stateDir),
          },
        ]
      : [];
  // A divergence refusal already carries its fork command, built with the same launcher.
  const divergence = Array.isArray(details['next']) ? strings(details['next'][0]) : undefined;
  if (divergence)
    return [
      {
        why: 'A completed step changed; fork a new run that reruns it and reuses the rest.',
        argv: divergence,
      },
    ];
  const stored = details['storedEntrypoint'];
  const requested = details['requestedEntrypoint'];
  if (typeof stored === 'string' && typeof requested === 'string')
    return [
      {
        why: 'Resume with the entrypoint the run was launched from.',
        argv: resume(launcher, runId, stateDir),
      },
      ...(canFork
        ? [
            {
              why: 'Or fork a new run from the requested entrypoint.',
              argv: fork(launcher, requested, runId, stateDir),
            },
          ]
        : []),
    ];
  const changed = strings(details['changed']);
  const entrypoint = run?.launch?.entrypoint;
  if (!changed || entrypoint === undefined || changed.includes('name')) return [];
  const forkEntry = {
    why: 'Fork a new run under the current code, reusing matching completed steps.',
    argv: fork(launcher, entrypoint, runId, stateDir),
  };
  const forks = canFork ? [forkEntry] : [];
  return details['canAcceptCodeChange'] === true && run?.status !== 'completed'
    ? [
        {
          why: 'Only code or schemas changed; accept the change and resume (refused without changes if a completed step changed).',
          argv: resume(launcher, runId, stateDir, '--accept-code-change'),
        },
        ...forks,
      ]
    : forks;
}

/**
 * Follow-ups for a failure document, by error code. A rehearsal, and any code without a runnable
 * remedy, gets none. @internal
 */
export function failureNextCommands(context: FailureNextContext): NextCommand[] {
  const { code, run, runId, stateDir, launcher } = context;
  const details = record(context.details);
  if (context.rehearsal) return [];
  if (code === 'run.not_found') {
    const candidates = Array.isArray(details?.['candidates']) ? details['candidates'] : [];
    // The missing run can be a --fork-from source, not the run the command named.
    const missing = typeof details?.['runId'] === 'string' ? details['runId'] : runId;
    return candidates.slice(0, maxCandidateEntries).flatMap((candidate) => {
      const entry = record(candidate);
      const candidateDir = entry?.['stateDir'];
      return missing !== null && typeof candidateDir === 'string'
        ? [
            {
              why: `Run ${missing} exists in ${candidateDir}${typeof entry?.['cwd'] === 'string' ? ` (project ${entry['cwd']})` : ''}; inspect it there.`,
              argv: workflowArgv(launcher, 'inspect', missing, '--state-dir', candidateDir),
            },
          ]
        : [];
    });
  }
  if (runId === null || stateDir === null) return [];
  switch (code) {
    case 'workflow.failed':
    case 'workflow.interrupted':
      return run && (run.status === 'failed' || run.status === 'suspended')
        ? runNextCommands(run, run.status, stateDir, launcher)
        : [];
    case 'run.orphans':
      return run?.launch
        ? [
            {
              why: 'Child processes of a dead owner survive; stop the identity-confirmed ones and resume.',
              argv: resume(launcher, runId, stateDir, '--kill-orphans'),
            },
          ]
        : [];
    case 'run.incompatible':
      return details ? incompatibleNext(context, details, runId, stateDir) : [];
    default:
      return [];
  }
}
