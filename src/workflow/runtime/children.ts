import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import type { ChildOptions, ChildRecord, WorkflowDeclaration } from './child-model.js';
import { checkedDefinition, describeWorkflow } from './definition.js';
import { delegateCapabilities, type ChildCapabilities } from './child-profiles.js';
import { digest, jsonValue } from './json.js';
import { schemaJson } from './schema.js';
import type { JsonValue, WorkflowContext, WorkflowDefinition } from './model.js';
import type { CapabilityManifest, ProfileOverride } from './profiles-model.js';
import type { RunRecord, StepRecord } from './record.js';
import type { ExecutionScopes } from './scopes.js';
import type { NameScopes } from './names.js';
import type { OperationTracker } from './tracking.js';
import { CancelledError, type FailureOrigins, type MapStepError } from './fan-out.js';
import { RunRefusedError } from './run-errors.js';
import { duplicateStepId } from './identity.js';
import { ownedRecords, settledFailure, settlesFailure } from './settled-outcome.js';
import type { Settled } from './model.js';

interface Frame {
  readonly id: string;
  readonly definition: WorkflowDeclaration;
  readonly chain: readonly string[];
  readonly authority: ChildCapabilities;
}

interface Dependencies {
  readonly definition: WorkflowDeclaration;
  readonly capabilities: CapabilityManifest;
  readonly grants: readonly string[];
  readonly pins: Readonly<Record<string, string>>;
  readonly overrides: readonly ProfileOverride[];
  /** The run's working directory, against which declared claude.addDirRoots resolve. */
  readonly cwd: string;
  readonly maxDepth: number;
  readonly preflight: (definition: WorkflowDeclaration, frame: string | null) => void;
  readonly record: RunRecord;
  readonly names: NameScopes;
  readonly scopes: ExecutionScopes;
  readonly operations: OperationTracker;
  readonly origins: FailureOrigins;
  readonly used: Set<string>;
  /** Settled map journal IDs visited in this execution, shared with ctx.map. */
  readonly visitedMaps: Set<string>;
  /** Whether an error is this run's own checkpoint failure, not a domain error reusing the class. */
  readonly isCheckpointFailure: (error: unknown) => boolean;
  /** Claim a replayed leaf step: emits step.replayed and marks matched policy, as map replay does. */
  readonly replayed: (id: string, step: StepRecord) => void;
  readonly isInEffect: () => boolean;
  readonly context: () => WorkflowContext;
  /** Launch an operation; `effect` is the call-site effect kind, null for a child frame. */
  readonly launch: <T>(id: string, work: () => Promise<T>, effect: string | null) => Promise<T>;
  readonly save: () => Promise<void>;
  readonly isolatePhase: <T>(body: () => Promise<T>) => Promise<T>;
  readonly emit: (
    type:
      'child.started' | 'child.completed' | 'child.failed' | 'child.settled' | 'child.superseded',
    id: string,
    child: ChildRecord,
  ) => void;
}

/** Frames that a successful completion retired, with the state needed to undo an unsaved completion. */
interface Supersession {
  /** Transitioned frame IDs and records, in record order. */
  readonly frames: readonly (readonly [string, ChildRecord])[];
  /** Put every transitioned frame back as it was before supersede() ran. */
  readonly restore: () => void;
  /** Emit one child.superseded event per transitioned frame. */
  readonly announce: () => void;
}

const SUPERSEDED_REASON = 'Superseded: the completed workflow no longer invoked this child frame.';

/**
 * Resume guidance for an identity refusal on a frame that never completed. A settled frame is
 * terminal, so accepting a code change cannot retry it.
 */
function unfinishedHint(saved: ChildRecord, alternatives: boolean): string {
  return saved.status === 'completed' || saved.settled !== undefined
    ? ''
    : ` The saved frame is ${saved.status}, not completed: to retry a fixed child, keep its name, version, input and schemas and resume with --accept-code-change${alternatives ? '; otherwise use a new run or an explicit fork' : ''}.`;
}

const optionsSchema = z.strictObject({
  profiles: z.record(z.string().min(1), z.string().min(1)).optional(),
  onError: z.enum(['throw', 'return']).optional(),
});

/** Inline frame ownership shares the root run's effects, cancellation, admission and budget. @internal */
export class RunChildren {
  readonly #deps: Dependencies;
  readonly #storage = new AsyncLocalStorage<Frame>();
  readonly #visited = new Set<string>();
  readonly #described = new WeakSet<WorkflowDeclaration>();

  readonly #previous = new Map<string | null, { id: string; saved: ChildRecord }[]>();

  public constructor(dependencies: Dependencies) {
    this.#deps = dependencies;
    for (const [id, saved] of Object.entries(dependencies.record.children ?? {})) {
      const siblings = this.#previous.get(saved.parent) ?? [];
      siblings.push({ id, saved });
      this.#previous.set(saved.parent, siblings);
    }
    this.#validateDeclared(dependencies.definition, null);
  }

  #validateDeclared(definition: WorkflowDeclaration, parent: string | null): void {
    const pending = [{ definition, parent }];
    const visited = new Set<string>();
    while (pending.length) {
      const next = pending.pop();
      if (!next) break;
      this.#deps.preflight(next.definition, next.parent);
      for (const { id, saved } of this.#previous.get(next.parent) ?? []) {
        if (!saved.declared || visited.has(id)) continue;
        visited.add(id);
        const current = next.definition.children?.find(
          (child) => child.name === saved.workflow.name,
        );
        if (
          current?.version !== saved.workflow.version ||
          digest({ input: schemaJson(current.input), output: schemaJson(current.output) }) !==
            saved.schemaDigest
        ) {
          const error = new RunRefusedError(
            'run.incompatible',
            this.#deps.record.id,
            `Child frame ${id} changed: ${saved.workflow.name}@${saved.workflow.version} -> ${current ? `${current.name}@${current.version}` : 'no matching declared child'}; declared child identity must match on resume.${unfinishedHint(saved, true)}`,
          );
          this.#deps.origins.markFatal(error);
          throw error;
        }
        pending.push({ definition: current, parent: id });
      }
    }
  }

  public get definition(): WorkflowDeclaration {
    return this.#storage.getStore()?.definition ?? this.#deps.definition;
  }

  public get frame(): string | null {
    return this.#storage.getStore()?.id ?? null;
  }

  public get authority(): ChildCapabilities | undefined {
    return this.#storage.getStore()?.authority;
  }

  public readonly invoke = ((
    leaf: string,
    child: WorkflowDeclaration | string,
    input: unknown,
    settings: ChildOptions = {},
  ) => {
    const d = this.#deps;
    const parent = this.#storage.getStore();
    return d.launch(
      `child: ${leaf}`,
      async () => {
        if (d.isInEffect())
          throw new Error('Child workflows cannot start inside durable effects or poll observers.');
        const declaration =
          typeof child === 'string'
            ? (parent?.definition ?? d.definition).children?.find(
                (candidate) => candidate.name === child,
              )
            : child;
        if (!declaration)
          throw new Error(
            `Workflow ${(parent?.definition ?? d.definition).name} has no declared child ${typeof child === 'string' ? child : '<invalid definition>'}.`,
          );
        const definition = checkedDefinition(declaration);
        const declared =
          (parent?.definition ?? d.definition).children?.some(
            (candidate) => candidate === definition,
          ) ?? false;
        if (d.scopes.requiresDeclaredChildren && !declared) {
          const error = new Error(
            `Child ${definition.name} must appear in its parent's children declaration inside a settled map or settled child frame, so resume can validate it without rerunning a committed mapper or frame.`,
          );
          d.origins.markFatal(error);
          throw error;
        }
        // The run validated only the root's declaration tree; a dynamic child's own tree is checked
        // here so duplicate names cannot make named dispatch and resume select different children.
        if (!declared && definition.children !== undefined && !this.#described.has(definition)) {
          describeWorkflow(definition);
          this.#described.add(definition);
        }
        const chain = [...(parent?.chain ?? [d.definition.name]), definition.name];
        const depth = chain.length - 1;
        if (depth > d.maxDepth)
          throw new Error(
            `Child workflow depth ${String(depth)} exceeds maxChildDepth ${String(d.maxDepth)}: ${chain.join(' > ')}. Raise --max-child-depth deliberately to allow deeper composition.`,
          );
        const id = d.names.childId(leaf);
        const options = optionsSchema.parse(settings);
        const mode = options.onError ?? 'throw';
        let parsed: JsonValue;
        try {
          parsed = jsonValue(
            definition.input.parse(input),
            `Child ${id} (${definition.name}) input`,
            { canonical: false },
          );
        } catch (cause) {
          throw new Error(
            `Child ${id} (${definition.name}) input validation failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            { cause },
          );
        }
        const schemaDigest = digest({
          input: schemaJson(definition.input),
          output: schemaJson(definition.output),
        });
        const inputDigest = digest(parsed);
        const prior = d.record.children?.[id];
        const invalid = (message: string): never => {
          const error = new Error(message);
          d.origins.markFatal(error);
          throw error;
        };
        if (d.used.has(id) || d.record.steps[id] || d.record.maps?.[id])
          invalid(`Duplicate child frame/effect ID: ${id}.`);
        // Only a settled frame pins its mode: an unsettled frame reruns its body anyway, so it may
        // switch, for example to settle a failure on resume (ADR 0007).
        const priorMode = prior?.onError ?? 'throw';
        const modeChanged = prior?.settled !== undefined && priorMode !== mode;
        if (
          prior &&
          (prior.workflow.name !== definition.name ||
            prior.workflow.version !== definition.version ||
            prior.inputDigest !== inputDigest ||
            prior.schemaDigest !== schemaDigest ||
            prior.parent !== (parent?.id ?? null) ||
            modeChanged)
        )
          invalid(
            `Child frame ${id} changed: ${prior.workflow.name}@${prior.workflow.version} -> ${definition.name}@${definition.version}${modeChanged ? ` (onError ${priorMode} -> ${mode})` : ''}; child name, version, input and schemas, and the onError of a settled frame, must match on resume. Use a new run or an explicit fork.${unfinishedHint(prior, false)}`,
          );
        // Dynamic parents become known only at invocation. Validate their declared descendants
        // before a committed settled map can skip those descendants' bodies.
        this.#validateDeclared(definition, id);
        const authority = delegateCapabilities(
          definition,
          parent?.authority.manifest ?? d.capabilities,
          parent?.authority.grants ?? d.grants,
          parent?.authority.pins ?? d.pins,
          parent?.authority.overrides ?? d.overrides,
          options.profiles === undefined ? {} : { profiles: options.profiles },
          d.cwd,
        );
        d.used.add(id);
        this.#visited.add(id);
        d.scopes.child(id);
        if (prior?.settled !== undefined) {
          // A settled frame is terminal: claim what it owned and replay its outcome (ADR 0007).
          this.#claim(prior.settled);
          return structuredClone(prior.settled.outcome);
        }
        // Captured at invocation, like a settled map's parent signal.
        const parentSignal = d.scopes.signal;
        const frame: ChildRecord = {
          declared,
          label: leaf,
          workflow: { name: definition.name, version: definition.version },
          parent: parent?.id ?? null,
          depth,
          inputDigest,
          schemaDigest,
          ...(mode === 'return' ? { onError: 'return' as const } : {}),
          status: 'running',
          startedAt: new Date().toISOString(),
          finishedAt: null,
          error: null,
        };
        Object.defineProperty((d.record.children ??= {}), id, {
          value: frame,
          enumerable: true,
          configurable: true,
          writable: true,
        });
        await d.save();
        d.emit('child.started', id, frame);
        // A settled frame's owner requires declared descendants, as a settled map item does.
        const owner = d.scopes.create(d.scopes.signal, mode === 'return');
        try {
          const output = await this.#storage.run({ id, definition, chain, authority }, () =>
            d.names.run(`${id}/`, () =>
              d.scopes.run(owner, () =>
                d.isolatePhase(async () => {
                  let returned: unknown;
                  let failure: { cause: unknown } | undefined;
                  try {
                    returned = await (
                      definition as unknown as WorkflowDefinition<unknown, unknown>
                    ).run(d.context(), structuredClone(parsed));
                  } catch (cause) {
                    failure = { cause };
                  }
                  await d.operations.drain(owner);
                  try {
                    d.operations.assertObserved(owner);
                  } catch (cause) {
                    d.origins.markFatal(cause);
                    throw cause;
                  }
                  if (failure) throw failure.cause;
                  try {
                    return jsonValue(
                      definition.output.parse(returned),
                      `Child ${id} (${definition.name}) output`,
                      { canonical: false },
                    );
                  } catch (cause) {
                    throw new Error(
                      `Child ${id} (${definition.name}) output validation failed: ${cause instanceof Error ? cause.message : String(cause)}`,
                      { cause },
                    );
                  }
                }),
              ),
            ),
          );
          frame.status = 'completed';
          frame.finishedAt = new Date().toISOString();
          const outcome: Settled<JsonValue, MapStepError> = { ok: true, value: output };
          if (mode === 'return') frame.settled = { outcome, ...ownedRecords(owner, d.record) };
          try {
            await d.save();
          } catch (error) {
            // Never claim a settlement that did not commit; the failure path below records it.
            delete frame.settled;
            throw error;
          }
          d.emit('child.completed', id, frame);
          return mode === 'return' ? structuredClone(outcome) : output;
        } catch (cause) {
          // Match the root: a callback's own AbortError fails the frame; only scope cancellation cancels it.
          frame.status = cause instanceof CancelledError ? 'cancelled' : 'failed';
          frame.finishedAt = new Date().toISOString();
          frame.error = cause instanceof Error ? cause.message : String(cause);
          if (
            mode === 'return' &&
            settlesFailure(cause, {
              parentAborted: parentSignal.aborted,
              ownCancellation: false,
              checkpointFailure: d.isCheckpointFailure(cause),
              origins: d.origins,
            })
          ) {
            const outcome = settledFailure(d.origins.find(cause), d.record);
            // The schema requires a started attempt; a body error without an effect counts as one.
            outcome.error = { ...outcome.error, attempts: Math.max(1, outcome.error.attempts) };
            frame.settled = { outcome, ...ownedRecords(owner, d.record) };
            try {
              await d.save();
            } catch {
              /* The runner owns the checkpoint failure; preserve the original child error. */
              delete frame.settled;
              throw cause;
            }
            d.emit('child.settled', id, frame);
            return structuredClone(outcome);
          }
          try {
            await d.save();
            d.emit('child.failed', id, frame);
          } catch {
            /* The runner owns the checkpoint failure; preserve the original child error. */
          }
          throw cause;
        }
      },
      null,
    );
  }) as WorkflowContext['workflow'];

  /** Claim the effects, maps and frames a settled frame owned, as settled map replay does. */
  #claim(settled: NonNullable<ChildRecord['settled']>): void {
    const d = this.#deps;
    for (const id of settled.steps) {
      if (d.used.has(id)) {
        const error = duplicateStepId(id, d.names.describe(id));
        d.origins.markFatal(error);
        throw error;
      }
      d.used.add(id);
      d.scopes.step(id);
      const step = d.record.steps[id];
      if (step) d.replayed(id, step);
    }
    for (const id of settled.maps) {
      if (d.visitedMaps.has(id)) {
        const error = new Error(`Duplicate settled map ID: ${id}.`);
        d.origins.markFatal(error);
        throw error;
      }
      d.visitedMaps.add(id);
      d.scopes.map(id);
    }
    for (const id of settled.children) this.replay(id);
  }

  public replay(id: string): void {
    if (this.#visited.has(id)) throw new Error(`Duplicate replayed child frame ${id}.`);
    this.#visited.add(id);
    this.#deps.used.add(id);
    this.#deps.scopes.child(id);
  }

  public finish(status: 'suspended' | 'failed' | 'cancelled', reason?: string): void {
    for (const frame of Object.values(this.#deps.record.children ?? {}))
      if (frame.status === 'running' || frame.status === 'suspended')
        this.#settle(frame, status, reason);
  }

  /** On completion, cancel only frames this execution invoked but never awaited. */
  public cancelUnawaited(reason: string): void {
    for (const [id, frame] of Object.entries(this.#deps.record.children ?? {}))
      if (this.#visited.has(id) && (frame.status === 'running' || frame.status === 'suspended'))
        this.#settle(frame, 'cancelled', reason);
  }

  #settle(frame: ChildRecord, status: 'suspended' | 'failed' | 'cancelled', reason?: string): void {
    frame.status = status;
    if (status !== 'suspended') {
      frame.finishedAt = new Date().toISOString();
      frame.error ??= reason ?? 'The enclosing workflow ended before this child settled.';
    }
  }

  /**
   * Retire every unfinished frame this execution never reached. Call it only for a completion that
   * already passed the replay checks: a completed frame or a frame holding terminal effects must
   * still fail the run instead.
   */
  public supersede(): Supersession {
    const at = new Date().toISOString();
    const transitioned: (readonly [string, ChildRecord])[] = [];
    const previous: {
      frame: ChildRecord;
      status: ChildRecord['status'];
      finishedAt: string | null;
      error: string | null;
    }[] = [];
    for (const [id, frame] of Object.entries(this.#deps.record.children ?? {})) {
      if (
        this.#visited.has(id) ||
        frame.status === 'completed' ||
        frame.status === 'superseded' ||
        frame.settled !== undefined
      )
        continue;
      previous.push({
        frame,
        status: frame.status,
        finishedAt: frame.finishedAt,
        error: frame.error,
      });
      frame.status = 'superseded';
      frame.finishedAt = at;
      frame.error ??= SUPERSEDED_REASON;
      transitioned.push([id, frame]);
    }
    return {
      frames: transitioned,
      restore: () => {
        for (const { frame, status, finishedAt, error } of previous) {
          frame.status = status;
          frame.finishedAt = finishedAt;
          frame.error = error;
        }
      },
      announce: () => {
        for (const [id, frame] of transitioned) this.#deps.emit('child.superseded', id, frame);
      },
    };
  }

  public assertVisited(): void {
    const missing = Object.entries(this.#deps.record.children ?? {})
      .filter(
        ([id, frame]) =>
          (frame.status === 'completed' || frame.settled !== undefined) && !this.#visited.has(id),
      )
      .map(([id]) => id);
    if (missing.length)
      throw new Error(
        `Replay skipped completed or settled child frames (${missing.join(', ')}); workflow control flow changed.`,
      );
  }
}
