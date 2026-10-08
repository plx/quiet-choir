/**
 * Pure choice of a failed run's saved `recoveryHint`, following
 * [ADR 0006](../../../docs/decisions/0006-code-change-recovery.md).
 *
 * The functions are pure: no I/O, no clock, no store, and no message parsing. The runner classifies
 * the failure into a typed {@link RecoveryCause} from error classes and the saved record, gathers
 * the other facts, and sets or deletes `recoveryHint` from the result.
 *
 * Invariants:
 * - A rehearsal (dry-run) never gets resume advice.
 * - A run with no recorded step or map gets no hint: there is nothing to reuse.
 * - Only a configuration or authoring failure, or a settled map whose only change is its mapper,
 *   suggests `--accept-code-change`. A grant failure names `--grant`, a replay divergence names
 *   `--strict-replay` and `--fork-from`, and any other settled map change names `--fork-from`.
 * - A divergence with unchanged source blames a value computed in the body outside a durable effect.
 * - A configuration or authoring failure after all recorded work is terminal keeps the re-finalize
 *   text, including "All recorded work has terminal outcomes" and "re-finalize".
 * - A run-budget stop names its cap's flag and a resume, whatever else is true of the run; it never
 *   suggests `--accept-code-change` or the re-finalize text.
 * - An effect failure or a cancellation gets a plain resume.
 *
 * ESLint keeps this module free of runtime imports.
 */

/**
 * Why a run failed, as far as recovery advice is concerned. The runner classifies each failed or
 * cancelled invocation into one cause and saves it as `RunRecord.recoveryCause`; the saved
 * `recoveryHint` and the run's `next` commands both follow it.
 *
 * - `grant`: a missing access grant; `profile` is the profile that needs it and `access` the
 *   access level it requires.
 * - `divergence`: a replay that left the recorded path.
 * - `map-changed`: a settled map that changed after an item completed; `mapperOnly` when only its
 *   mapper did, so `--accept-code-change` can keep the completed items.
 * - `configuration`: any other configuration error.
 * - `budget`: a run-budget stop; `flag` is the CLI flag of the cap that stopped the run.
 * - `authoring`: a workflow body, output or call-site failure.
 * - `effect`: a durable effect's recorded failure.
 * - `cancelled`: a cancelled run.
 *
 * A later build may add kinds, and only together with a record schema revision.
 */
export type RecoveryCause =
  | { readonly kind: 'grant'; readonly profile: string; readonly access: string }
  | { readonly kind: 'divergence' }
  | { readonly kind: 'map-changed'; readonly mapperOnly: boolean }
  | { readonly kind: 'configuration' }
  | { readonly kind: 'budget'; readonly flag: string }
  | { readonly kind: 'authoring' }
  | { readonly kind: 'effect' }
  | { readonly kind: 'cancelled' };

/** Facts about one failed invocation, all gathered by the runner. @internal */
export interface RecoveryHintInput {
  /** The typed failure cause. */
  readonly cause: RecoveryCause;
  /** Whether the run is a dry-run rehearsal. */
  readonly rehearsal: boolean;
  /** Whether the record holds at least one step or map. */
  readonly recordedWork: boolean;
  /** Whether all recorded work has terminal outcomes, so a resume repeats no effect. */
  readonly allTerminal: boolean;
  /** Whether this invocation accepted a workflow code or schema change. */
  readonly sourceChanged: boolean;
  /** The run's ID, for fork advice. */
  readonly runId: string;
}

/** The recovery hint to save on a failed run, or undefined for none. @internal */
export function chooseRecoveryHint(input: RecoveryHintInput): string | undefined {
  const { cause } = input;
  if (input.rehearsal || !input.recordedWork) return undefined;
  switch (cause.kind) {
    case 'grant':
      return `Grant the access, then resume: --resume --grant ${cause.profile} (or --grant ${cause.access}, or --grant all); completed steps are reused.`;
    case 'divergence':
      return input.sourceChanged
        ? `Replay left the recorded path after the accepted source change. Restore the replay path, or fork a new run with --fork-from ${input.runId}; --resume --strict-replay stops at the first divergence before live work.`
        : `The workflow source is unchanged, so the body likely computed a value outside a durable effect (time, randomness, environment or file contents) that changed a step identity or the replay path. Compute such values with ctx.now or inside ctx.step so replay reuses them, then fork a new run with --fork-from ${input.runId}; --resume --strict-replay stops at the first divergence before live work.`;
    case 'map-changed':
      return cause.mapperOnly
        ? `Resume with --resume --accept-code-change to keep completed map items and run unfinished ones with the edited mapper, or fork a new run with --fork-from ${input.runId}.`
        : `A settled map's items, keys, version or cwd changed after an item completed, or its journal predates per-component fingerprints; accepting code changes cannot reuse it. Restore the map and resume, or fork a new run with --fork-from ${input.runId}.`;
    case 'budget':
      return `A run budget refused a new agent attempt. Resume with --resume and a higher ${cause.flag} value, or ${cause.flag} off; completed steps are reused and replay without new spend.`;
    case 'configuration':
    case 'authoring':
      return input.allTerminal
        ? 'All recorded work has terminal outcomes, including settled map items. Fix the workflow tail, output or configuration and use --resume --accept-code-change to re-finalize; unchanged identities reuse their results.'
        : 'Fix the workflow or its configuration, then resume; add --accept-code-change if the fix edits workflow code or schemas. Completed steps are reused.';
    case 'effect':
      return 'Resume with --resume once the cause is fixed or has passed; completed steps are reused and the failed step runs again.';
    case 'cancelled':
      return 'Resume with --resume to continue; completed steps are reused.';
  }
}
