/**
 * Pure replay decision for one effect invocation, following
 * [ADR 0005](../../../docs/decisions/0005-step-identity-and-policy.md),
 * [ADR 0006](../../../docs/decisions/0006-code-change-recovery.md) and
 * [ADR 0009](../../../docs/decisions/0009-scoped-step-ids.md).
 *
 * The functions are pure: no I/O, no clock, no store, and `decideReplay` never mutates the prior
 * step. The runner gathers the facts, calls `decideReplay`, and performs every side effect from
 * the result: legacy migration writes, sequence allocation, saves, events, frame attribution and
 * cancellation. The only stateful call is the `forkCandidate` thunk, which looks up a reusable fork
 * source step (and counts a prefix reuse); it is called at most once, and only when the decision
 * reaches it.
 *
 * Invariants:
 * - Terminal identities are immutable: a completed or settled-failed step is replayed only under
 *   the same kind and fingerprint.
 * - Questions and waits are never redefined, even while unfinished.
 * - Original format-one steps migrate only on an exact old-fingerprint match, never for a terminal
 *   agent step (its isolation mode was never pinned).
 * - Dry-run refuses Git effects after terminal replay but before fork reuse, unless the runner
 *   synthesizes the effect (a fresh isolated agent call, or a merge of unchanged changes; the
 *   accepted-replay probe synthesizes every Git effect, `ctx.worktree` included).
 * - Fork reuse is considered only for an absent step in a forked run.
 * - Strict healed divergence permits terminal replay and fork reuse but stops before the next live
 *   effect.
 * - A healed step (failed before, completes now) flags a recorded step as a possible dependent
 *   only when that step was launched at or after the healed step's first failure settled
 *   (`launchStamp >= failureStamp`, see `healedDependents`). A sibling launched in the same tick,
 *   before the failure existed, is not flagged. The rule is a watermark, not proof of dependence:
 *   a step launched later by unrelated control flow is still flagged. When either stamp is missing
 *   (checkpoints saved before stamps, or a failure saved between retries) the pair falls back to
 *   launch order: the step is flagged when its `seq` is higher.
 * - Default (prefix) fork reuse is causal (`forkPrefixBlockers`): a requested step is reused only
 *   when every source step that had settled before its source launch is already reused into the
 *   target, and no live target step settled before its target launch. Steps in sibling items of a
 *   named map are independent by declaration and never block each other. The same per-pair
 *   stamp-or-`seq` fallback applies to source steps saved without stamps.
 * - A settled map journal with a different fingerprint is reset only while nothing in it is
 *   committed. A committed map accepts only a mapper-only change, only under an explicit
 *   `acceptCodeChange`, and only when the journal saved per-component digests; items, keys,
 *   version and cwd stay strict, and a journal without components cannot name what changed. The
 *   aggregate fingerprint decides sameness, so its digest must never change shape.
 *
 * ESLint keeps this module free of runtime imports.
 */
import type { ErrorMode } from './model.js';
import type { MapComponents, StepRecord } from './record.js';

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
   * passes the agent check, and never otherwise; it may throw (a user schema without a JSON Schema
   * form).
   */
  readonly legacyFingerprint: () => string;
  /** Whether the run is a fork. */
  readonly forkedFrom: boolean;
  /** Looks up a reusable fork source step; counts a prefix reuse in the provenance when it finds one. */
  readonly forkCandidate: () => StepRecord | undefined;
  /** Whether the run is a dry-run rehearsal. */
  readonly rehearsal: boolean;
  /** Whether the effect runs inside worktree isolation. */
  readonly isolated: boolean;
  /**
   * Whether a dry-run synthesizes this Git effect instead of running it: a fresh isolated agent
   * call, or a merge whose inputs are all unchanged changes. The accepted-replay probe (#217)
   * synthesizes every Git effect, and only it synthesizes a `worktree` effect. Meaningful only
   * under `rehearsal`.
   */
  readonly rehearsalSynthesized: boolean;
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
 * replay, the dry-run Git refusal (for an unsynthesized Git effect), fork reuse, the strict healed-divergence refusal, and finally a
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
  // ctx.worktree creates a real handle, so only the accepted-replay probe synthesizes it.
  if (
    input.rehearsal &&
    (kind === 'worktree' || input.isolated || kind === 'merge') &&
    !input.rehearsalSynthesized
  )
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

/** The healed step's facts for `healedDependents`. @internal */
export interface HealedStep {
  /** The healed step's ID; never reported as its own dependent. */
  readonly id: string;
  /** Its first-use order. */
  readonly seq: number;
  /** The settlement stamp of its first terminal failure, when the failure recorded one. */
  readonly failureStamp?: number | undefined;
}

/** One recorded step as the run observed it at resume start. @internal */
export interface PriorLaunch {
  /** The step's ID. */
  readonly id: string;
  /** Its first-use order. */
  readonly seq: number;
  /** The settlement stamp when it was last launched, when one was recorded. */
  readonly launchStamp?: number | undefined;
}

/**
 * The recorded steps that may depend on a healed step's earlier failure, in `prior` order. With
 * both stamps, a step is flagged when it was launched at or after the failure settled
 * (`launchStamp >= failureStamp`), regardless of `seq`. When either stamp is missing, that pair
 * falls back to launch order (`seq` higher than the healed step's).
 *
 * @internal
 */
export function healedDependents(healed: HealedStep, prior: readonly PriorLaunch[]): string[] {
  return prior
    .filter((other) =>
      other.id === healed.id
        ? false
        : healed.failureStamp !== undefined && other.launchStamp !== undefined
          ? other.launchStamp >= healed.failureStamp
          : other.seq > healed.seq,
    )
    .map((other) => other.id);
}

/** One named-map item enclosing a requested effect. @internal */
export interface MapItemScope {
  /** The map's prefix, such as `review/`. */
  readonly map: string;
  /** This item's prefix, such as `review/3/`. */
  readonly item: string;
  /** Every item prefix of the same map invocation, including this one. */
  readonly items: ReadonlySet<string>;
}

/** The source step facts `forkPrefixBlockers` reads. @internal */
export type ForkSourceLaunch = Pick<StepRecord, 'seq' | 'launchStamp' | 'settleStamp'>;

/** The target step facts `forkPrefixBlockers` reads. @internal */
export type ForkTargetStep = Pick<StepRecord, 'reusedFrom' | 'settleStamp'>;

/** Facts for one default (prefix) fork reuse request. @internal */
export interface ForkPrefixFacts {
  /** The requested step ID; it must exist in `source`. */
  readonly id: string;
  /** The target run's settlement counter when the body requested this effect. */
  readonly launchStamp: number;
  /** The named-map items enclosing the request, outermost first. */
  readonly mapItems: readonly MapItemScope[];
  /** The fork source run ID that reused copies must name. */
  readonly sourceRunId: string;
  /** The pinned source run's steps. */
  readonly source: Readonly<Record<string, ForkSourceLaunch>>;
  /** The target run's steps as recorded now. */
  readonly target: Readonly<Record<string, ForkTargetStep>>;
}

/** Whether `other` belongs to a different item of a named map that encloses the request. */
function siblingItem(other: string, mapItems: readonly MapItemScope[]): boolean {
  return mapItems.some(({ map, item, items }) => {
    if (!other.startsWith(map) || other.startsWith(item)) return false;
    // Keys may contain '/', so try every candidate item prefix rather than the first segment.
    for (let end = other.indexOf('/', map.length); end !== -1; end = other.indexOf('/', end + 1))
      if (items.has(other.slice(0, end + 1))) return true;
    return false;
  });
}

/**
 * The steps that keep a default (prefix) fork from reusing `id`, source causes first and then target
 * live work, each in record order without duplicates. Reuse is allowed when the result is empty and
 * the source step also passes the identity and validity checks.
 *
 * A source step Y (other than `id`) blocks when the requested step may have depended on it in the
 * source and the target has not reused it from this source under the same ID. With both launch
 * stamps, Y is a possible cause when it had settled when the requested step was launched
 * (`Y.settleStamp <= X.launchStamp`); a source step that never settled is not a cause. When either
 * stamp is missing, the pair falls back to launch order (`Y.seq < X.seq`, and a missing `seq` counts
 * as a cause).
 *
 * A target step W blocks when it ran live in this fork (no `reusedFrom`) and settled before the
 * request (`W.settleStamp <= launchStamp`): its new outcome may feed the requested step. This also
 * covers new step IDs with no source counterpart.
 *
 * Neither rule counts a step in a sibling item of a named map that encloses the request: named-map
 * items receive only their item value (ADR 0009), so they are independent by declaration.
 *
 * @internal
 */
export function forkPrefixBlockers(facts: ForkPrefixFacts): string[] {
  const { id, launchStamp, mapItems, sourceRunId, source, target } = facts;
  const requested = source[id];
  const blockers = new Set<string>();
  for (const [other, step] of Object.entries(source)) {
    if (other === id || siblingItem(other, mapItems)) continue;
    const cause =
      requested?.launchStamp !== undefined && step.launchStamp !== undefined
        ? step.settleStamp !== undefined && step.settleStamp <= requested.launchStamp
        : step.seq === undefined || requested?.seq === undefined || step.seq < requested.seq;
    const reused = Object.hasOwn(target, other) ? target[other]?.reusedFrom : undefined;
    if (cause && (reused?.runId !== sourceRunId || reused.stepId !== other)) blockers.add(other);
  }
  for (const [other, step] of Object.entries(target))
    if (
      other !== id &&
      step.reusedFrom === undefined &&
      step.settleStamp !== undefined &&
      step.settleStamp <= launchStamp &&
      !siblingItem(other, mapItems)
    )
      blockers.add(other);
  return [...blockers];
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
      return 'Dry-run does not simulate this Git worktree effect: it synthesizes fresh isolated agent calls and merges of unchanged changes, but not ctx.worktree, effects isolated on a worktree handle, or merges of captured commits. Use a fixture harness in a temporary repository to rehearse these without paid calls.';
  }
}

/** The saved facts of one settled map journal. @internal */
export interface SavedSettledMap {
  /** The saved aggregate fingerprint. */
  readonly fingerprint: string;
  /** The saved component digests, or undefined for a journal saved before they existed. */
  readonly components: MapComponents | undefined;
  /** Whether the map completed or any item completed, so outcomes may already be observed. */
  readonly committed: boolean;
}

/** Facts for one settled map invocation, all gathered by the map before the decision. @internal */
export interface SettledMapInput {
  /** The saved journal with this ID, if any. */
  readonly saved: SavedSettledMap | undefined;
  /** The current aggregate fingerprint. */
  readonly fingerprint: string;
  /** The current component digests. */
  readonly components: MapComponents;
  /** Whether the operator explicitly accepted code changes for this resume. */
  readonly acceptCodeChange: boolean;
}

/** What the map does with its saved journal. @internal */
export type SettledMapReplay =
  /** Keep the journal; `backfill` stores the current components in a journal saved without them. */
  | { readonly kind: 'reuse'; readonly backfill: boolean }
  /** Start a fresh journal: none was saved, or nothing in the changed one is committed. */
  | { readonly kind: 'reset' }
  /** Keep the journal and its outcomes, and record the accepted mapper change. */
  | { readonly kind: 'accept' }
  /** Refuse; `changed` names the differing components in a fixed order. */
  | { readonly kind: 'refuse'; readonly changed: readonly string[] }
  /** Refuse a changed committed journal that saved no components. */
  | { readonly kind: 'refuse-legacy' };

const mapComponentNames = ['items', 'keys', 'mapper', 'version', 'cwd'] as const;

/**
 * Decide how a settled map relates to its saved journal: reuse on the same aggregate fingerprint,
 * reset when nothing is committed, accept a mapper-only change under explicit acceptance, and
 * otherwise refuse. A component counts as changed when its digest differs or it is present on one
 * side only (`keys`).
 *
 * @internal
 */
export function decideSettledMapReplay(input: SettledMapInput): SettledMapReplay {
  const { saved, components } = input;
  if (saved === undefined) return { kind: 'reset' };
  // A matching aggregate means the current components are the ones the journal would have saved.
  if (saved.fingerprint === input.fingerprint)
    return { kind: 'reuse', backfill: saved.components === undefined };
  if (!saved.committed) return { kind: 'reset' };
  if (saved.components === undefined) return { kind: 'refuse-legacy' };
  const prior = saved.components;
  const changed = mapComponentNames.filter((name) => prior[name] !== components[name]);
  return input.acceptCodeChange && changed.length === 1 && changed[0] === 'mapper'
    ? { kind: 'accept' }
    : { kind: 'refuse', changed };
}

/** Whether a settled map refusal changed only the mapper, which `acceptCodeChange` accepts. @internal */
export function mapperOnlyChange(
  refusal: Extract<SettledMapReplay, { readonly kind: 'refuse' | 'refuse-legacy' }>,
): boolean {
  return (
    refusal.kind === 'refuse' && refusal.changed.length === 1 && refusal.changed[0] === 'mapper'
  );
}

/**
 * The error message for a settled map refusal. Every message starts with
 * `Settled map <id> changed after an item completed`.
 *
 * @internal
 */
export function settledMapRefusalMessage(
  id: string,
  refusal: Extract<SettledMapReplay, { readonly kind: 'refuse' | 'refuse-legacy' }>,
): string {
  const head = `Settled map ${id} changed after an item completed`;
  if (refusal.kind === 'refuse-legacy')
    return `${head}; its journal predates per-component fingerprints, so the changed component is unknown. Fork a new run.`;
  if (mapperOnlyChange(refusal))
    return `${head} (changed: mapper). Resume with --accept-code-change to keep completed item outcomes and run unfinished items with the new mapper, or fork a new run. A thin mapper such as (item) => handle(ctx, item) keeps helper edits out of map identity.`;
  return `${head} (changed: ${refusal.changed.join(', ') || 'identity'}); --accept-code-change accepts only a mapper change. Fork a new run.`;
}
