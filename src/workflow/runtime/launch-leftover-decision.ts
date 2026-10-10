/**
 * Pure rules for leftover launch directories: the `<runId>/launch/` that `workflow start` leaves
 * when its runner fails before the run record exists, following
 * [ADR 0055](../../../docs/decisions/0055-remove-leftover-launch-directories.md).
 *
 * A run directory is a leftover only when it holds exactly one entry, the directory `launch/`, and
 * every entry of `launch/` is a regular file named `<n>.log`, `<n>.result.json`, `<n>.input.json`
 * or `<n>.runner.json` for a launch number `n` of 1 or more. The caller also checks that no record
 * and no legacy sibling exists. A launch number is settled when its `<n>.runner.json` parses and the
 * recorded runner is dead, or, without a runner record, when its newest file is older than the
 * floor. A leftover is removable only when every launch is settled; an unparsable runner record,
 * or a runner that is alive, unverifiable or on another host, keeps it in flight.
 *
 * ESLint keeps this module free of I/O; the liveness of a recorded runner is passed in.
 */
import { z } from 'zod';

/**
 * How old the newest file of a launch without a runner record must be before it counts as
 * settled: one hour. It covers launches from builds that wrote no runner record, a start that
 * stopped between spawning its runner and recording it, and the short window between start's
 * allocation and that record. @internal
 */
export const launchSettleFloorMs = 3_600_000;

/** A launch evidence file: `<n>.log`, `<n>.result.json`, `<n>.input.json` or `<n>.runner.json`. */
const launchFile = /^([1-9][0-9]*)\.(log|result\.json|input\.json|runner\.json)$/u;

/** The identity `workflow start` records in `launch/<n>.runner.json` after spawning its runner. @internal */
export const runnerIdentitySchema = z.object({
  pid: z.number().int().positive(),
  host: z.string(),
  osStartTime: z.string().nullable(),
});

/** A parsed `launch/<n>.runner.json`. @internal */
export type RunnerIdentity = z.infer<typeof runnerIdentitySchema>;

/** The liveness of a recorded process, as `liveness()` in `lock.ts` reports it. @internal */
export type RunnerLiveness = 'alive' | 'dead' | 'unknown' | 'remote';

/** One entry of a directory listing, reduced to what the shape check needs. @internal */
export interface LaunchEntry {
  readonly name: string;
  readonly kind: 'file' | 'directory' | 'other';
}

/**
 * Whether a run directory's listing is a lone `launch/` directory: exactly one entry, named
 * `launch`, that is a directory. @internal
 */
export function isLoneLaunchDirectory(entries: readonly LaunchEntry[]): boolean {
  return entries.length === 1 && entries[0]?.name === 'launch' && entries[0].kind === 'directory';
}

/** The launch number of a regular launch evidence file, or null for any other entry. */
function launchNumber(entry: LaunchEntry): number | null {
  const match = launchFile.exec(entry.name);
  if (entry.kind !== 'file' || match?.[1] === undefined) return null;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Group the entries of `launch/` by launch number, or null when any entry is not a regular launch
 * evidence file. With `ignoreOthers`, such entries are left out instead, as the launch judgement of
 * a run whose record is unreadable needs (ADR 0060). Each group lists its file names in sorted
 * order; the result is sorted by number. @internal
 */
export function groupLaunchFiles(
  entries: readonly LaunchEntry[],
  options: { readonly ignoreOthers?: boolean } = {},
): { readonly n: number; readonly files: readonly string[] }[] | null {
  const groups = new Map<number, string[]>();
  for (const entry of entries) {
    const n = launchNumber(entry);
    if (n === null) {
      if (options.ignoreOthers) continue;
      return null;
    }
    const files = groups.get(n) ?? [];
    files.push(entry.name);
    groups.set(n, files);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([n, files]) => ({ n, files: files.sort() }));
}

/** The runner record file name of launch `n`. @internal */
export function runnerFileName(n: number): string {
  return `${String(n)}.runner.json`;
}

/** Parse the text of a runner record; null when it is not valid JSON of the expected shape. @internal */
export function parseRunnerIdentity(text: string): RunnerIdentity | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = runnerIdentitySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** What the judgement of one launch number observed. @internal */
export type LaunchRunnerState = RunnerLiveness | 'unparsable' | 'none';

/** The judgement of one launch number. @internal */
export interface LaunchJudgement {
  readonly n: number;
  /** `settled` when this launch can no longer create the run's record. */
  readonly state: 'settled' | 'in-flight';
  /** The recorded runner's liveness, `unparsable` for a damaged record, `none` without one. */
  readonly runner: LaunchRunnerState;
  /** The recorded runner's PID and host; null without a parsable record. */
  readonly pid: number | null;
  readonly host: string | null;
}

/** What the judgement of one launch number reads. @internal */
export interface LaunchObservation {
  readonly n: number;
  /** The runner record's text; null when the launch has no `<n>.runner.json`. */
  readonly runnerText: string | null;
  /** The newest modification time among the launch's files, in epoch milliseconds. */
  readonly newestMtimeMs: number;
}

/**
 * Judge one launch number. With a runner record, only a parsable record whose runner is `dead`
 * settles it; without one, a newest file older than `floorMs` does. @internal
 */
export function judgeLaunch(
  observation: LaunchObservation,
  context: {
    readonly nowMs: number;
    readonly floorMs: number;
    readonly liveness: (identity: RunnerIdentity) => RunnerLiveness;
  },
): LaunchJudgement {
  const { n } = observation;
  if (observation.runnerText === null)
    return {
      n,
      state: context.nowMs - observation.newestMtimeMs > context.floorMs ? 'settled' : 'in-flight',
      runner: 'none',
      pid: null,
      host: null,
    };
  const identity = parseRunnerIdentity(observation.runnerText);
  if (identity === null)
    return { n, state: 'in-flight', runner: 'unparsable', pid: null, host: null };
  const runner = context.liveness(identity);
  return {
    n,
    state: runner === 'dead' ? 'settled' : 'in-flight',
    runner,
    pid: identity.pid,
    host: identity.host,
  };
}

/**
 * Whether a leftover may be removed: every launch is settled. A `launch/` with no files at all is
 * judged by its own modification time against the floor. @internal
 */
export function leftoverRemovable(
  launches: readonly LaunchJudgement[],
  empty: { readonly directoryMtimeMs: number; readonly nowMs: number; readonly floorMs: number },
): boolean {
  if (!launches.length) return empty.nowMs - empty.directoryMtimeMs > empty.floorMs;
  return launches.every((launch) => launch.state === 'settled');
}

/**
 * The message of rm's `run.active` refusal of a leftover whose launch may still be in flight.
 * `--force` never overrides it. @internal
 */
export function inFlightLeftoverMessage(
  runId: string,
  launches: readonly LaunchJudgement[],
): string {
  return `Run ${runId} has no record yet, but its start may still be in flight (${describeInFlight(launches, 'an empty launch directory younger than the settle floor')}); the start's runner may still create the record. rm refuses it even with --force; retry once the runner has exited, or after the settle floor for a launch without a runner record.`;
}

/**
 * The message of rm's `run.active` refusal of a run whose record is unreadable while a launch in
 * its `launch/` may still be in flight (ADR 0060). `--force` never overrides it. @internal
 */
export function inFlightUnreadableMessage(
  runId: string,
  launches: readonly LaunchJudgement[],
): string {
  return `Run ${runId} has an unreadable record, but a start of it may still be in flight (${describeInFlight(launches, 'its launch directory changed while rm inspected it')}); the start's runner may still take the run. rm refuses it even with --force and changed nothing; retry once the runner has exited, or after the settle floor for a launch without a runner record.`;
}

/** The in-flight launches, described for a refusal; `none` when there is no in-flight launch. */
function describeInFlight(launches: readonly LaunchJudgement[], none: string): string {
  const pending = launches.filter((launch) => launch.state === 'in-flight');
  return pending.length
    ? pending
        .map((launch) =>
          launch.runner === 'none'
            ? `launch ${String(launch.n)}: no runner record, files younger than the settle floor`
            : launch.runner === 'unparsable'
              ? `launch ${String(launch.n)}: unreadable runner record`
              : `launch ${String(launch.n)}: runner PID ${String(launch.pid)} on ${launch.host ?? 'unknown'} is ${launch.runner}`,
        )
        .join('; ')
    : none;
}
