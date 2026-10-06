import { defineHarness } from '../../harnesses/definition.js';
import { claudeDefinition, codexDefinition } from '../../harnesses/builtins/definitions.js';
import type { AgentOptions, JsonValue, Harness, HarnessRequest } from './model.js';
import type { WorkflowDeclaration } from './child-model.js';
import type {
  HarnessAdapter,
  HarnessDeclaration,
  HarnessDefinition,
  HarnessCapabilities,
} from './harness-model.js';
import type { RunRecord, StepRecord } from './record.js';
import { isTerminalStep } from './record.js';
import { RunRefusedError } from './run-errors.js';
import { ConfigurationError } from './configuration-error.js';
import { digest, jsonValue } from './json.js';

/** Harness identity for both current and preceding built-in records. @internal */
export function stepHarness(step: StepRecord): string | null {
  return step.kind === 'agent'
    ? (step.harness ?? null)
    : step.kind === 'claude' || step.kind === 'codex'
      ? step.kind
      : null;
}

/** Explicit operator adapters, with option types erased only after registration validation. */
export type HarnessAdapters = Readonly<Record<string, HarnessAdapter<never>>>;

/** Operator-only adapter factory configuration, excluded from semantic fingerprints. */
export type HarnessConfigurations = Readonly<Record<string, JsonValue>>;

/** Build one workflow's value-level registry without constructing or invoking any adapter. @internal */
export function harnessDefinitions(
  owner: Pick<WorkflowDeclaration, 'name' | 'harnesses'>,
): ReadonlyMap<string, HarnessDeclaration> {
  const definitions = new Map<string, HarnessDeclaration>([
    ['claude', claudeDefinition],
    ['codex', codexDefinition],
  ]);
  for (const registration of owner.harnesses ?? []) {
    const checked = defineHarness(
      registration as unknown as HarnessDefinition<string, AgentOptions, HarnessCapabilities>,
    );
    if (definitions.has(checked.name))
      throw new Error(`Workflow ${owner.name} declares duplicate harness ${checked.name}.`);
    definitions.set(checked.name, checked);
  }
  return definitions;
}

/** Validate request data strictly, before policy resolution or any durable attempt. @internal */
export function harnessOptions(definition: HarnessDeclaration, value: unknown): AgentOptions {
  const parsed = definition.options.safeParse(value);
  if (!parsed.success)
    throw new Error(
      `Invalid harness ${definition.name} options: ${parsed.error.issues.map((issue) => `${issue.path.map(String).join('.') || 'options'}: ${issue.message}`).join('; ')}`,
    );
  if (typeof parsed.data.prompt !== 'string')
    throw new Error(`Harness ${definition.name} prompt must be a string.`);
  return jsonValue(parsed.data, `Harness ${definition.name} options`, {
    canonical: false,
  }) as unknown as AgentOptions;
}

/** Check recorded names/revisions and fresh adapter availability before workflow effects. @internal */
export function preflightHarnesses(
  owner: Pick<WorkflowDeclaration, 'name' | 'harnesses'>,
  record: RunRecord | undefined,
  frame: string | null,
  available: (definition: HarnessDeclaration) => boolean,
): ReadonlyMap<string, HarnessDeclaration> {
  const definitions = harnessDefinitions(owner);
  const steps = Object.values(record?.steps ?? {}).filter((step) => (step.frame ?? null) === frame);
  for (const step of steps) {
    const name = stepHarness(step);
    if (name === null) continue;
    const definition = definitions.get(name);
    if ((step.revision ?? 1) !== definition?.revision)
      throw new RunRefusedError(
        'run.incompatible',
        record?.id ?? '',
        `Recorded harness ${name}@${String(step.revision ?? 1)} in workflow ${owner.name} is ${definition ? `now revision ${String(definition.revision)}` : 'no longer declared'}. Restore its declaration or use a new run.`,
      );
  }
  // Implicit built-ins need no adapter for local-only workflows. Explicit registrations preflight;
  // replay can proceed without installations, but any new live call still requires an adapter.
  for (const declared of owner.harnesses ?? []) {
    const definition = definitions.get(declared.name);
    if (!definition || available(definition)) continue;
    const prior = steps.filter((step) => stepHarness(step) === definition.name);
    if (!record || prior.length === 0 || prior.some((step) => !isTerminalStep(step)))
      throw new ConfigurationError(
        `No harness adapter configured for ${definition.name}; supply RunOptions.adapters, RunOptions.harness, or createAdapter.`,
      );
  }
  return definitions;
}

/** Resolve one run's adapters lazily; completed replay never constructs an installation. @internal */
export class HarnessRegistry {
  readonly #adapters: HarnessAdapters;
  readonly #fallback: Harness | undefined;
  readonly #configurations: HarnessConfigurations;
  readonly #cache = new WeakMap<HarnessDeclaration, Harness>();
  readonly #failures = new WeakMap<HarnessDeclaration, ConfigurationError>();
  readonly #definitions = new WeakMap<object, ReadonlyMap<string, HarnessDeclaration>>();

  public constructor(options: {
    readonly adapters?: HarnessAdapters;
    readonly harness?: Harness;
    readonly harnessConfigurations?: HarnessConfigurations;
  }) {
    this.#adapters = options.adapters ?? {};
    this.#fallback = options.harness;
    this.#configurations = options.harnessConfigurations ?? {};
  }

  /** Describe explicit modes without constructing package adapters. */
  public kind(owner: WorkflowDeclaration): string {
    const named = Object.entries(this.#adapters);
    if (!named.length)
      return (
        this.#fallback?.kind ??
        (this.#fallback ? 'custom' : owner.harnesses?.length ? 'registered' : 'none')
      );
    if (
      !this.#fallback &&
      named.length === 2 &&
      named.every(([name, adapter]) => ['claude', 'codex'].includes(name) && adapter.kind === 'cli')
    )
      return 'cli';
    return `registered:${digest({ fallback: this.#fallback?.kind ?? (this.#fallback ? 'custom' : null), adapters: Object.fromEntries(named.map(([name, adapter]) => [name, adapter.kind ?? 'custom'])) }).slice(0, 32)}`;
  }

  /** Whether any currently known declaration has an execution installation. */
  public configured(owner: WorkflowDeclaration): boolean {
    if (this.#fallback || Object.keys(this.#adapters).length) return true;
    const pending = [owner];
    const visited = new Set<object>();
    while (pending.length) {
      const current = pending.pop();
      if (!current || visited.has(current)) continue;
      visited.add(current);
      if (current.harnesses?.some((item) => item.createAdapter !== undefined)) return true;
      pending.push(...(current.children ?? []));
    }
    return false;
  }

  public definitions(
    owner: Pick<WorkflowDeclaration, 'name' | 'harnesses'>,
  ): ReadonlyMap<string, HarnessDeclaration> {
    let value = this.#definitions.get(owner);
    if (!value) {
      value = harnessDefinitions(owner);
      this.#definitions.set(owner, value);
    }
    return value;
  }

  public preflight(
    owner: WorkflowDeclaration,
    record: RunRecord | undefined,
    frame: string | null,
  ): void {
    preflightHarnesses(owner, record, frame, (definition) => this.available(definition));
  }

  public available(definition: HarnessDeclaration): boolean {
    return (
      (Object.hasOwn(this.#adapters, definition.name) &&
        this.#adapters[definition.name] !== undefined) ||
      this.#fallback !== undefined ||
      definition.createAdapter !== undefined
    );
  }

  public adapter(definition: HarnessDeclaration): Harness {
    const cached = this.#cache.get(definition);
    if (cached) return cached;
    const explicit = Object.hasOwn(this.#adapters, definition.name)
      ? this.#adapters[definition.name]
      : undefined;
    if (!explicit && this.#fallback) return this.#fallback;
    const failed = this.#failures.get(definition);
    if (failed) throw failed;
    let adapter: HarnessAdapter | undefined = explicit;
    if (!adapter)
      try {
        adapter = definition.createAdapter?.(
          (Object.hasOwn(this.#configurations, definition.name)
            ? this.#configurations[definition.name]
            : undefined) ?? {},
        );
      } catch (cause) {
        // A factory failure is misconfiguration: never settled, retried or journaled as map data.
        const error = new ConfigurationError(
          `Harness ${definition.name} adapter factory failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
        this.#failures.set(definition, error);
        throw error;
      }
    if (!adapter || typeof adapter.invoke !== 'function')
      throw new ConfigurationError(
        `No harness adapter configured for ${definition.name}; supply RunOptions.adapters, RunOptions.harness, or createAdapter.`,
      );
    // The registry's strict schema is the sole type-erasure boundary before dispatch.
    const request = (value: HarnessRequest): never => value as never;
    const metadata = adapter.metadata?.bind(adapter);
    const projectInstructions = adapter.projectInstructions?.bind(adapter);
    const wrapped: Harness = {
      ...(adapter.kind === undefined ? {} : { kind: adapter.kind }),
      ...(adapter.policyDefaults === undefined
        ? {}
        : { policyDefaults: () => adapter.policyDefaults?.() ?? {} }),
      ...(metadata === undefined
        ? {}
        : {
            metadata: (value, invocation) =>
              metadata(request(value), invocation.signal, invocation),
          }),
      ...(projectInstructions === undefined
        ? {}
        : {
            projectInstructions: (value, invocation) =>
              projectInstructions(request(value), invocation.signal, invocation),
          }),
      invoke: (value, invocation) => adapter.invoke(request(value), invocation.signal, invocation),
    };
    this.#cache.set(definition, wrapped);
    return wrapped;
  }
}
