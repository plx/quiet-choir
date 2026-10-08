import {
  answerArgv,
  formatArgv,
  launchPolicyFlags,
  workflowArgv,
  type CommandLauncher,
  type NextCommand,
} from '../runtime/commands.js';
import type { CliErrorCode } from '../runtime/run-errors.js';
import type { JsonValue } from '../runtime/model.js';
import { hasRecordedWork, recordSchemaDrift } from '../runtime/record.js';
import type { RecoveryCause } from '../runtime/recovery-hint.js';
import type { RunRecord } from '../runtime/store.js';

// The runtime builds its own refusal commands, so these live there; they stay importable here.
export { formatArgv, type NextCommand };

/** At most this many answer entries precede a suspended run's resume entry. @internal */
export const maxAnswerEntries = 5;
/** At most this many `run.not_found` candidates become inspect entries. @internal */
export const maxCandidateEntries = 5;

/** A resume argv that repeats the run's recorded launch policy, when the record is known. */
function resume(
  launcher: CommandLauncher | undefined,
  run: RunRecord | null | undefined,
  runId: string,
  stateDir: string,
  ...flags: string[]
): string[] {
  return workflowArgv(
    launcher,
    'resume',
    runId,
    '--state-dir',
    stateDir,
    ...flags,
    ...launchPolicyFlags(run?.launch),
  );
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

/** Fork refuses legacy (format 1) checkpoints, so such a run never gets a fork entry. */
function canFork(run: RunRecord | null | undefined): boolean {
  return !run || run.formatVersion === 6 || run.formatVersion === 7;
}

/**
 * A failed run's follow-ups, chosen by its saved {@link RecoveryCause} as the recovery hint is
 * ([ADR 0006](../../../docs/decisions/0006-code-change-recovery.md)). A plain resume would repeat a
 * grant, divergence, settled-map or run-budget failure, so those causes get the grant, fork or cap
 * that the hint names instead. Every other cause, and a record saved before the cause was (schema
 * revision 10), keeps the plain resume. A legacy (format 1) run gets no fork entry.
 */
function failedNext(
  run: RunRecord,
  entrypoint: string,
  stateDir: string,
  launcher: CommandLauncher | undefined,
): NextCommand[] {
  const cause: RecoveryCause | undefined = run.recoveryCause;
  const forks = (why: string): NextCommand[] =>
    canFork(run) ? [{ why, argv: fork(launcher, entrypoint, run.id, stateDir) }] : [];
  switch (cause?.kind) {
    case 'grant':
      // `workflow resume` takes no --grant; `execute --resume` resumes the stored entrypoint too.
      return [
        {
          why: `Profile ${cause.profile} needs ${cause.access} access; grant it and resume. The grant is saved for later resumes, and completed steps are reused.`,
          argv: workflowArgv(
            launcher,
            'execute',
            '--resume',
            '--run-id',
            run.id,
            '--state-dir',
            stateDir,
            '--grant',
            cause.profile,
            ...launchPolicyFlags(run.launch),
          ),
        },
      ];
    case 'divergence':
      return forks(
        'Replay left the recorded path, so a resume repeats the divergence; fork a new run that reruns the changed steps and reuses the rest.',
      );
    case 'map-changed':
      return cause.mapperOnly
        ? [
            {
              why: "Only a settled map's mapper changed; accept the change and resume to keep its completed items.",
              argv: resume(launcher, run, run.id, stateDir, '--accept-code-change'),
            },
            ...forks('Or fork a new run under the current code, reusing matching completed steps.'),
          ]
        : forks(
            'A settled map changed after an item completed, so a resume is refused; restore the map and resume, or fork a new run under the current code.',
          );
    case 'budget':
      return [
        {
          why: `A run budget stopped the run and stays in force on resume; substitute <LIMIT> with a higher ${cause.flag} value or off. Completed steps are reused.`,
          argv: resume(launcher, run, run.id, stateDir, cause.flag, '<LIMIT>'),
        },
      ];
    default:
      return [
        {
          why: 'Resume the failed run; completed steps are reused and failed ones run again.',
          argv: resume(launcher, run, run.id, stateDir),
        },
      ];
  }
}

/**
 * Follow-ups for a saved run in a given (possibly derived) status: for a failed run, the entries
 * its saved `recoveryCause` selects (`--grant` for a grant failure, a fork after a replay
 * divergence or settled-map change, `<flag> <LIMIT>` after a run-budget stop, otherwise a plain
 * resume), and none when it recorded no step or map, matching its absent recovery hint; resume a
 * stale run; answer a suspended run's waiting questions (at most {@link maxAnswerEntries}), then
 * resume it. A run without a stored entrypoint (an embedded run) cannot be resumed by ID and gets
 * none, and neither does a run this build cannot fully read (`recordSchemaDrift`): it refuses to
 * resume it until quiet-choir is upgraded. Resume entries repeat the run's recorded launch policy
 * (fixture harness, block wait mode).
 * @internal
 */
export function runNextCommands(
  run: RunRecord,
  status: RunRecord['status'] | 'stale',
  stateDir: string,
  launcher?: CommandLauncher,
): NextCommand[] {
  if (!run.launch || recordSchemaDrift(run)) return [];
  if (status === 'failed')
    return hasRecordedWork(run) ? failedNext(run, run.launch.entrypoint, stateDir, launcher) : [];
  if (status === 'stale')
    return [
      {
        why: 'The run is marked running but its owner is gone; resume recovers it.',
        argv: resume(launcher, run, run.id, stateDir),
      },
    ];
  if (status !== 'suspended') return [];
  const answers = Object.entries(run.steps)
    .filter(([, step]) => step.status === 'waiting' && step.question)
    .slice(0, maxAnswerEntries)
    .map(([stepId, step]) => ({
      why: `Answer ${stepId}: substitute <ANSWER_JSON>${step.question?.request.audience === 'human' ? ' with a human decision and <NAME> with the name of the human who gave it' : ''}.`,
      argv: answerArgv(
        launcher,
        run.id,
        stepId,
        stateDir,
        step.question?.request.audience ?? 'any',
      ),
    }));
  return [
    ...answers,
    {
      why: run.interruptedBy
        ? 'The run was interrupted into a resumable suspension; resume it.'
        : run.budgetStop?.metric === 'maxWindowUtilization' && typeof run.nextWakeAt === 'number'
          ? `The --max-window-utilization gate suspended the run until ${new Date(run.nextWakeAt).toISOString()}; workflow tick resumes it after then, and an earlier resume suspends it again.`
          : 'Resume once its waits are answered or due; an unanswered wait suspends it again.',
      argv: resume(launcher, run, run.id, stateDir),
    },
  ];
}

/**
 * The follow-up for a pending row whose answer is already queued: resume so the run's owner
 * ingests it. A run without a stored entrypoint (an embedded run) cannot be resumed by ID and gets
 * none, and neither does a run this build cannot fully read. Callers pass only suspended or failed runs: a running owner ingests the answer itself.
 * @internal
 */
export function queuedNextCommands(
  run: RunRecord,
  stateDir: string,
  launcher?: CommandLauncher,
): NextCommand[] {
  return run.launch && !recordSchemaDrift(run)
    ? [
        {
          why: 'An answer is queued; resume the run so its owner ingests it.',
          argv: resume(launcher, run, run.id, stateDir),
        },
      ]
    : [];
}

function record(value: JsonValue): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function strings(value: JsonValue | undefined): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : undefined;
}

/**
 * The index of the `workflow` word that ends an argv's program words, or -1: the word right after
 * the runner's own launcher words when the argv starts with exactly them, else the first exact
 * `workflow` word (which also covers the installed `quiet-choir workflow` form). A launcher word can
 * itself be `workflow` (the value of a Node option such as `--title` in development mode), which
 * only the exact match handles.
 */
function programWordsEnd(
  argv: readonly string[],
  runnerLauncher: CommandLauncher | undefined,
): number {
  if (
    runnerLauncher?.length &&
    argv.length > runnerLauncher.length &&
    runnerLauncher.every((word, index) => argv[index] === word) &&
    argv[runnerLauncher.length] === 'workflow'
  )
    return runnerLauncher.length;
  return argv.indexOf('workflow');
}

/**
 * Rebuilds the `next` entries of a runner's result document behind this invocation's launcher.
 * The runner builds its entries with its own launcher (an executable, optional Node loader flags
 * and a script path, or bare `quiet-choir`). An entry's program words end at its `workflow` word:
 * the one right after `runnerLauncher` when the entry starts with exactly those words (the words
 * start spawned the runner with), else the first exact `workflow` word. They are replaced by
 * `launcher` (the default launcher when it is absent or empty) and the words after `workflow` are
 * kept. A `why` is kept as is. Anything else is dropped: a `value` that is not a list, an element
 * that is not an object with a string `why` and an `argv` list of strings, an `argv` without
 * program words before its `workflow` word or without a subcommand after it. Only `{why, argv}` is
 * emitted. @internal
 */
export function relaunchNextCommands(
  value: unknown,
  launcher: CommandLauncher | undefined,
  runnerLauncher?: CommandLauncher,
): NextCommand[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown): NextCommand[] => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const { why, argv } = entry as { why?: unknown; argv?: unknown };
    if (typeof why !== 'string' || !Array.isArray(argv)) return [];
    if (!argv.every((word): word is string => typeof word === 'string')) return [];
    const at = programWordsEnd(argv, runnerLauncher);
    return at >= 1 && at < argv.length - 1
      ? [{ why, argv: workflowArgv(launcher, ...argv.slice(at + 1)) }]
      : [];
  });
}

/** Plain-data failure context that {@link failureNextCommands} reads. @internal */
export interface FailureNextContext {
  readonly code: CliErrorCode;
  readonly details: JsonValue;
  /**
   * The saved run, re-read after the failure. A failed run's `recoveryCause` selects its entries
   * through {@link runNextCommands}.
   */
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
  const forkable = canFork(run);
  if (details['reason'] === 'entrypoint_missing')
    return forkable
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
        argv: resume(launcher, run, runId, stateDir),
      },
      ...(forkable
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
  const forks = forkable ? [forkEntry] : [];
  return details['canAcceptCodeChange'] === true && run?.status !== 'completed'
    ? [
        {
          why: 'Only code or schemas changed; accept the change and resume (refused without changes if a completed step changed).',
          argv: resume(launcher, run, runId, stateDir, '--accept-code-change'),
        },
        ...forks,
      ]
    : forks;
}

/**
 * The `{why, argv}` entries a `run.locked` or `worktree.locked` refusal carries in `details.next`,
 * built by the runtime with the invocation's launcher. A malformed entry, or a `next` that is not a
 * list, is dropped.
 */
function lockedNext(details: Record<string, JsonValue> | undefined): NextCommand[] {
  const entries = details?.['next'];
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((value) => {
    const entry = record(value);
    const argv = strings(entry?.['argv']);
    return typeof entry?.['why'] === 'string' && argv?.length ? [{ why: entry['why'], argv }] : [];
  });
}

/**
 * Follow-ups for a failure document, by error code. A failed run's entries follow its saved
 * `recoveryCause` (see {@link runNextCommands}). A rehearsal, and any code without a runnable
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
  // The worktree administration lock belongs to a repository, so its refusal names no run.
  if (code === 'worktree.locked') return lockedNext(details);
  if (runId === null || stateDir === null) return [];
  switch (code) {
    case 'workflow.failed':
    case 'workflow.interrupted':
    case 'start.timeout':
      return run && (run.status === 'failed' || run.status === 'suspended')
        ? runNextCommands(run, run.status, stateDir, launcher)
        : [];
    case 'run.orphans':
      return run?.launch
        ? [
            {
              why: 'Child processes of a dead owner survive; stop the identity-confirmed ones and resume.',
              argv: resume(launcher, run, runId, stateDir, '--kill-orphans'),
            },
          ]
        : [];
    case 'run.incompatible':
      return details ? incompatibleNext(context, details, runId, stateDir) : [];
    case 'run.locked':
      return lockedNext(details);
    default:
      return [];
  }
}
