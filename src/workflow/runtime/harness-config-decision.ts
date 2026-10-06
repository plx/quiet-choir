/**
 * Pure rule for refusing a resume under a different CLI harness configuration, following
 * [ADR 0035](../../../docs/decisions/0035-harness-configuration-persistence.md).
 *
 * The function is pure: no I/O, no clock, no store. `runWorkflow` applies it to every resume that
 * supplies a configuration digest and throws `run.incompatible` from the result. `workflow tick`
 * applies the same rule before it counts a stale recovery or imports the workflow, for the
 * selections whose outcome it can predict, and skips the run as `incompatible` with the same
 * message. Sharing one rule keeps the two from drifting.
 *
 * Invariants:
 * - A kind change is not this rule's concern: `allowHarnessChange` governs it, so different kinds
 *   never refuse here.
 * - Records without a digest (older ones, or an execution with an unknown configuration) and
 *   invocations without one stay resumable; the run adopts the supplied digest.
 * - The reserved kind `none` (a run with no agent outputs) never refuses.
 * - `allowHarnessConfigChange` accepts any change.
 *
 * ESLint keeps this module free of runtime imports.
 */
import type { RunRecord } from './record.js';

/** Facts about one resume, gathered by the runner or by tick. @internal */
export interface HarnessConfigCheck {
  /** The run being resumed. */
  readonly runId: string;
  /** The run's recorded harness, if any. */
  readonly previous: RunRecord['harness'] | undefined;
  /** The harness kind this invocation executes with. */
  readonly requestedKind: string;
  /** SHA-256 of the configuration this invocation supplies; undefined when it is unknown. */
  readonly requestedConfigDigest: string | undefined;
  /** Whether the operator accepted a changed configuration. */
  readonly allowHarnessConfigChange: boolean;
}

/** A configuration refusal: the `run.incompatible` message and its details. @internal */
export interface HarnessConfigRefusal {
  readonly message: string;
  readonly details: {
    readonly previousConfigDigest: string;
    readonly requestedConfigDigest: string;
  };
}

/**
 * Decide whether a resume must be refused because the run last executed under a different CLI
 * harness configuration. Shared by `runWorkflow` and `workflow tick`. Returns undefined when the
 * resume may proceed. @internal
 */
export function harnessConfigRefusal(check: HarnessConfigCheck): HarnessConfigRefusal | undefined {
  const { previous, requestedKind, requestedConfigDigest } = check;
  const previousConfigDigest = previous?.configDigest;
  if (
    previous === undefined ||
    previousConfigDigest === undefined ||
    requestedConfigDigest === undefined ||
    previous.kind !== requestedKind ||
    requestedKind === 'none' ||
    previousConfigDigest === requestedConfigDigest ||
    check.allowHarnessConfigChange
  )
    return undefined;
  return {
    message: `Run ${check.runId} last executed with a different harness configuration (sha256 ${previousConfigDigest.slice(0, 12)}); this invocation supplies ${requestedConfigDigest.slice(0, 12)}. Repeat the original --harness-config, or pass --allow-harness-config-change to accept the change.`,
    details: { previousConfigDigest, requestedConfigDigest },
  };
}
