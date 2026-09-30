/**
 * Pure replay decision for one effect invocation, following
 * [ADR 0005](../../../docs/decisions/0005-step-identity-and-policy.md),
 * [ADR 0006](../../../docs/decisions/0006-code-change-recovery.md) and
 * [ADR 0009](../../../docs/decisions/0009-scoped-step-ids.md).
 *
 * The functions are pure: no I/O, no clock, no store, and `decideReplay` never mutates the prior
 * step. The runner gathers the facts, calls `decideReplay`, and performs every side effect from
 * the result: legacy migration writes, sequence allocation, saves, events, frame attribution and
 * cancellation. The only stateful call is the `forkCandidate` thunk, which advances or closes the
 * fork's prefix-reuse cursor; it is called at most once, and only when the decision reaches it.
 *
 * Invariants:
 * - Terminal identities are immutable: a completed or settled-failed step is replayed only under
 *   the same kind and fingerprint.
 * - Questions and waits are never redefined, even while unfinished.
 * - Original format-one steps migrate only on an exact old-fingerprint match, never for a terminal
 *   agent step (its isolation mode was never pinned).
 * - Dry-run refuses Git effects after terminal replay but before fork reuse.
 * - Fork reuse is considered only for an absent step in a forked run.
 * - Strict healed divergence permits terminal replay and fork reuse but stops before the next live
 *   effect.
 *
 * ESLint keeps this module free of runtime imports.
 */
import type { ErrorMode } from './model.js';
import type { StepRecord } from './record.js';

/** Facts about one effect invocation, all gathered by the runner before the decision. @internal */
export interface ReplayInput {
  /** The effect's step ID. */
  readonly id: string;
  /** The kind the workflow now requests. */
  readonly kind: StepRecord['kind'];
  /** The recorded step with this ID, if any. It is never mutated. */
  readonly prior: StepRecord | undefined;
  /** The component hashes of the requested identity. */
  readonly identity: NonNullable<StepRecord['identity']>;
  /** The digest of `identity`. */
  readonly fingerprint: string;
  /** The effect's failure mode; `undefined` behaves as `'throw'`. */
  readonly onError: ErrorMode | undefined;
  /** The agent request diagnostics, whose harness names a legacy agent step's kind. */
  readonly request: StepRecord['request'];
  /**
   * Computes the original format-one fingerprint. Called exactly once for a legacy prior that
   * passes the agent check, and never otherwise; it may throw (a schema without a JSON Schema
   * form).
   */
  readonly legacyFingerprint: () => string;
  /** Whether the run is a fork. */
  readonly forkedFrom: boolean;
  /** Looks up a reusable fork source step; advances or closes fork provenance when called. */
  readonly forkCandidate: () => StepRecord | undefined;
  /** Whether the run is a dry-run rehearsal. */
  readonly rehearsal: boolean;
  /** Whether the effect runs inside worktree isolation. */
  readonly isolated: boolean;
  /** Whether a strict replay has already recorded a healed divergence. */
  readonly strictHealedDivergence: boolean;
}

/** Why the runner must refuse an effect instead of replaying or running it. @internal */
export type ReplayRefusal =
  | { readonly reason: 'legacy-agent-unpinned' }
  | { readonly reason: 'legacy-identity-changed' }
  | { readonly reason: 'question-or-wait-redefined'; readonly priorKind: 'ask' | 'wait' }
  | {
      readonly reason: 'terminal-redefined';
      /** Identity components that differ, in first-seen order; empty when only the digest differs. */
      readonly changed: readonly string[];
      readonly status: 'completed' | 'settled-failed';
    }
  | { readonly reason: 'rehearsal-git' }
  | { readonly reason: 'strict-healed-divergence' };

/** What the runner does with the effect. @internal */
export type ReplayOutcome =
  | { readonly kind: 'refuse'; readonly refusal: ReplayRefusal }
  /** Return the terminal prior's saved outcome. */
  | { readonly kind: 'replay' }
  /** Copy a terminal fork source step. */
  | { readonly kind: 'reuse-fork'; readonly candidate: StepRecord }
  /** Record the prior's identity as a redefinition and run live. */
  | { readonly kind: 'redefine' }
  /** Run live; `resume` is true when an unfinished prior with the same identity continues. */
  | { readonly kind: 'fresh'; readonly resume: boolean };

/** A replay decision. @internal */
export interface ReplayDecision {
  /**
   * The prior is an original format-one step that must be migrated (and saved) before acting on
   * `outcome`. The outcome is evaluated as if the migration had already happened.
   */
  readonly migrateLegacy: boolean;
  /** What to do after any migration. */
  readonly outcome: ReplayOutcome;
}

const isTerminal = (step: StepRecord): boolean =>
  step.status === 'completed' || step.status === 'settled-failed';

/** The kind an original format-one step recorded: the harness name for an agent call. @internal */
export function legacyKind(kind: StepRecord['kind'], request: StepRecord['request']): string {
  return kind === 'agent' ? (request?.harness ?? kind) : kind;
}

/**
 * Whether a terminal fork source step may be reused. Worktree steps never are; a settled failure
 * needs `onError: 'return'` and its settled error; a completed output must still parse.
 * `outputParses` is called only for a completed non-worktree step.
 *
 * @internal
 */
export function forkReuseValid(
  kind: StepRecord['kind'],
  onError: ErrorMode | undefined,
  sourceStep: StepRecord,
  outputParses: (output: StepRecord['output']) => boolean,
): boolean {
  return kind === 'worktree'
    ? false
    : sourceStep.status === 'settled-failed'
      ? onError === 'return' && sourceStep.settledError !== undefined
      : outputParses(sourceStep.output);
}

const refuse = (migrateLegacy: boolean, refusal: ReplayRefusal): ReplayDecision => ({
  migrateLegacy,
  outcome: { kind: 'refuse', refusal },
});

/**
 * Decide how an effect invocation relates to its recorded step, in this order: legacy format-one
 * checks, the question/wait redefinition refusal, the terminal redefinition refusal, terminal
 * replay, the dry-run Git refusal, fork reuse, the strict healed-divergence refusal, and finally a
 * redefinition or a fresh run.
 *
 * @internal
 */
export function decideReplay(input: ReplayInput): ReplayDecision {
  const { kind, prior, identity, fingerprint, onError } = input;
  let migrateLegacy = false;
  let priorKind = prior?.kind;
  let priorFingerprint = prior?.fingerprint;
  let priorIdentity = prior?.identity;
  if (prior?.legacyIdentity === 1) {
    if ((kind === 'agent' || kind === 'claude' || kind === 'codex') && isTerminal(prior))
      return refuse(false, { reason: 'legacy-agent-unpinned' });
    // Computed before any comparison, as it always was: its failure surfaces first.
    const legacyFingerprint = input.legacyFingerprint();
    if (
      prior.kind !== legacyKind(kind, input.request) ||
      prior.fingerprint !== legacyFingerprint ||
      onError === 'return'
    )
      return refuse(false, { reason: 'legacy-identity-changed' });
    // Evaluate the rest as if the runner had already migrated the prior.
    migrateLegacy = true;
    priorKind = kind;
    priorFingerprint = fingerprint;
    priorIdentity = identity;
  }
  const redefined = prior !== undefined && (priorKind !== kind || priorFingerprint !== fingerprint);
  if (redefined && (priorKind === 'ask' || priorKind === 'wait'))
    return refuse(migrateLegacy, { reason: 'question-or-wait-redefined', priorKind });
  if (redefined && isTerminal(prior)) {
    const changed = [
      ...new Set([...Object.keys(priorIdentity ?? {}), ...Object.keys(identity)]),
    ].filter((key) => priorIdentity?.[key] !== identity[key]);
    return refuse(migrateLegacy, {
      reason: 'terminal-redefined',
      changed,
      status: prior.status === 'completed' ? 'completed' : 'settled-failed',
    });
  }
  if (prior && isTerminal(prior)) return { migrateLegacy, outcome: { kind: 'replay' } };
  if (input.rehearsal && (input.isolated || kind === 'worktree' || kind === 'merge'))
    return refuse(migrateLegacy, { reason: 'rehearsal-git' });
  if (!prior && input.forkedFrom) {
    const candidate = input.forkCandidate();
    if (candidate) return { migrateLegacy, outcome: { kind: 'reuse-fork', candidate } };
  }
  if (input.strictHealedDivergence)
    return refuse(migrateLegacy, { reason: 'strict-healed-divergence' });
  return {
    migrateLegacy,
    outcome: redefined ? { kind: 'redefine' } : { kind: 'fresh', resume: prior !== undefined },
  };
}

/**
 * The error message for a refusal. A strict healed divergence has none: the runner rethrows the
 * divergence error it recorded.
 *
 * @internal
 */
export function replayRefusalMessage(
  id: string,
  refusal: Exclude<ReplayRefusal, { readonly reason: 'strict-healed-divergence' }>,
): string {
  switch (refusal.reason) {
    case 'legacy-agent-unpinned':
      return `Step ${id}: original format-one agent has no pinned isolation mode; start a new run or invalidate it in a fork.`;
    case 'legacy-identity-changed':
      return `Step ${id}: original format-one identity changed; restore its inputs/options/schema/retry before migrating or start a new run.`;
    case 'question-or-wait-redefined':
      return `Step ${id}: a ${refusal.priorKind === 'ask' ? 'question' : 'wait'} cannot be redefined as another effect; use a new ID.`;
    case 'terminal-redefined':
      return `Step ${id}: ${refusal.changed.join(', ') || 'identity'} changed on a ${refusal.status} step; --accept-code-change cannot reuse it. Fork a new run with --fork-from RUN --reuse matching --invalidate ${id}.`;
    case 'rehearsal-git':
      return 'Dry-run does not simulate Git worktree effects. Use a fixture harness in a temporary repository to rehearse isolation without paid calls.';
  }
}
