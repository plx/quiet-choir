/**
 * Runner glue for `ctx.decide` (ADR 0066 sections 2 and 3): provider resolution for the running
 * workflow, operator configuration, lazy transports, and the one version-identified step a call
 * makes. The protocol itself lives in the pure `decision-protocol.ts`.
 */
import { z } from 'zod';

import { ConfigurationError } from './configuration-error.js';
import { DecisionError } from './decision-error.js';
import type {
  DecisionProviderConfiguration,
  DecisionProviderDeclaration,
  DecisionQuestions,
  ProviderTransport,
} from './decision-model.js';
import {
  checkDecisionCapabilities,
  checkDecisionProviders,
  checkDecisionQuestions,
  decisionRequestBody,
  decisionConfigurationsSchema,
  decisionResultSchema,
  decisionUsage,
  fixtureDecisionBody,
  parseDecisionResponse,
  type DecisionConfigurations,
  type DecisionResult,
  type FixtureDecisionAnswers,
} from './decision-protocol.js';
import type { WorkflowDeclaration } from './child-model.js';
import { jsonValue } from './json.js';
import type {
  ErrorKind,
  ErrorMode,
  JsonValue,
  RetryPolicy,
  StepContext,
  StepDefinition,
} from './model.js';
import { retryPolicySchema } from './policy.js';
import { schemaJson } from './schema.js';

/**
 * Version that identifies a `ctx.decide` step. Bump it only if the recorded behavior or result
 * contract changes, never for refactors: a bump strands completed decisions.
 * test/builtin-identity.test.ts pins it. @internal
 */
export const DECIDE_STEP_VERSION = 'decision/2';

const optionKeys = [
  'provider',
  'model',
  'state',
  'questions',
  'onError',
  'retry',
  'timeoutMs',
] as const;

/** One decision attempt a fixture answerer is asked to answer. @internal */
export interface DecisionFixtureRequest {
  /** Fully qualified step ID. */
  readonly stepId: string;
  /** Cumulative one-based attempt number, as `StepContext.attempt`. */
  readonly attempt: number;
  /** Provider name. */
  readonly provider: string;
  /** The requested model, or null. */
  readonly model: string | null;
  /** JSON Schema of the step's result, with one-hot defaults for synthesis. */
  readonly schema: JsonValue;
}

/**
 * A fixture answerer's reply: canned answers in the recorded shape, validated like a live response,
 * or a simulated provider failure of `kind` (default `unknown`). @internal
 */
export type DecisionFixtureResponse =
  FixtureDecisionAnswers | { readonly error: string; readonly kind?: ErrorKind | undefined };

/**
 * Answers decision attempts in place of the provider transport, as fixture and dry-run harnesses
 * do. It throws a {@link ConfigurationError} for a decision it cannot answer, which is fatal: never
 * settled or retried. @internal
 */
export type DecisionFixture = (request: DecisionFixtureRequest) => DecisionFixtureResponse;

/** Resolve providers and build their transports lazily for one run. @internal */
export class DecisionProviders {
  readonly #configurations: DecisionConfigurations;
  readonly #transports = new WeakMap<DecisionProviderDeclaration, ProviderTransport>();
  readonly #failures = new WeakMap<DecisionProviderDeclaration, ConfigurationError>();
  /** The fixture answerer; when set, no transport is ever built. */
  public readonly fixture: DecisionFixture | undefined;

  public constructor(
    configurations: DecisionConfigurations | undefined,
    fixture?: DecisionFixture,
  ) {
    this.#configurations = configurations ?? {};
    this.fixture = fixture;
  }

  /** The operator configuration for a provider name, or an empty one. */
  public configuration(name: string): DecisionProviderConfiguration {
    return Object.hasOwn(this.#configurations, name) ? (this.#configurations[name] ?? {}) : {};
  }

  /**
   * The running workflow's provider: the named one, or the only declared one when the call names
   * none. A missing or unknown provider is a {@link ConfigurationError}.
   */
  public resolve(
    owner: WorkflowDeclaration,
    provider: string | undefined,
  ): DecisionProviderDeclaration {
    const declared = checkDecisionProviders(owner.decisions, owner.name);
    if (provider === undefined) {
      const [only, ...rest] = declared;
      if (only !== undefined && rest.length === 0) return only;
      throw new ConfigurationError(
        only === undefined
          ? `Workflow ${owner.name} declares no decision providers; add decisions: [...] to its definition.`
          : `Workflow ${owner.name} declares several decision providers (${declared.map(({ name }) => name).join(', ')}); pass provider to ctx.decide.`,
      );
    }
    const found = declared.find(({ name }) => name === provider);
    if (found === undefined)
      throw new ConfigurationError(
        `Workflow ${owner.name} declares no decision provider ${provider}${declared.length ? `; it declares ${declared.map(({ name }) => name).join(', ')}` : ''}.`,
      );
    return found;
  }

  /** The requested model: the call's, then the operator configuration's, then the declaration's. */
  public model(
    declaration: DecisionProviderDeclaration,
    requested: string | undefined,
  ): string | null {
    return (
      requested ??
      this.configuration(declaration.name).defaultModel ??
      declaration.defaultModel ??
      null
    );
  }

  /**
   * The provider's transport, created on first use; a factory failure is cached and rethrown as a
   * {@link ConfigurationError}, so it is never settled or retried.
   */
  public transport(declaration: DecisionProviderDeclaration): ProviderTransport {
    const cached = this.#transports.get(declaration);
    if (cached) return cached;
    const failed = this.#failures.get(declaration);
    if (failed) throw failed;
    let transport: unknown;
    try {
      transport = declaration.transport(this.configuration(declaration.name));
      if (typeof transport !== 'function')
        throw new Error('the factory did not return a transport function');
    } catch (cause) {
      const error =
        cause instanceof ConfigurationError
          ? cause
          : new ConfigurationError(
              `Decision provider ${declaration.name} transport factory failed: ${cause instanceof Error ? cause.message : String(cause)}`,
              { cause },
            );
      this.#failures.set(declaration, error);
      throw error;
    }
    this.#transports.set(declaration, transport as ProviderTransport);
    return transport as ProviderTransport;
  }
}

/** A prepared `ctx.decide` call: its step definition and error mode. @internal */
export interface PreparedDecision {
  /** The step `ctx.decide` launches. */
  readonly step: StepDefinition<DecisionResult> & { readonly onError?: ErrorMode };
  /** Whether the call returns a `Settled` result. */
  readonly settled: boolean;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Answer one attempt from the fixture answerer instead of the transport. An error reply counts as
 * an attempt with unknown tokens, as a live failure does, and throws a {@link DecisionError} of its
 * kind; answers go through the same wire validation as a live response, so a stale fixture fails
 * with kind `schema`. A {@link ConfigurationError} from the answerer propagates unchanged.
 */
function fixtureAttempt(
  fixture: DecisionFixture,
  request: DecisionFixtureRequest,
  questions: DecisionQuestions,
  reportUsage: StepContext['reportUsage'],
): DecisionResult {
  const { provider, model } = request;
  const response = fixture(request);
  if ('error' in response) {
    reportUsage(decisionUsage(provider, model, null));
    throw new DecisionError({
      provider,
      kind: response.kind ?? 'unknown',
      message: response.error,
    });
  }
  const body = fixtureDecisionBody(response);
  reportUsage(decisionUsage(provider, model, body));
  return parseDecisionResponse(provider, questions, { body });
}

/**
 * The provider and model a decider roster entry fixes for `ctx.roster.<entry>.decide` (ADR 0066
 * section 2). @internal
 */
export interface DecisionBinding {
  /** Roster entry name, recorded as the step's `meta.roster` label. */
  readonly entry: string;
  /** Provider name. */
  readonly provider: string;
  /** Requested model; absent leaves it to the operator configuration and the declaration. */
  readonly model?: string | undefined;
}

/**
 * Validate a `ctx.decide` call synchronously, resolve its provider for the running workflow and
 * check its questions against the provider's capabilities, then build its step for `stepId`, its
 * fully qualified ID. Every failure is raised before any request or step record: an authoring
 * error, or a {@link ConfigurationError} for the provider and capability checks.
 *
 * With a `binding`, the call came through a decider roster entry: a call-site `provider` or `model`
 * is refused, the binding's are used exactly as if the call had spelled them, so the input and
 * identity are unchanged, and the entry name is added to `meta` as `roster`. @internal
 */
export function prepareDecision(
  providers: DecisionProviders,
  owner: WorkflowDeclaration,
  stepId: string,
  options: unknown,
  binding?: DecisionBinding,
): PreparedDecision {
  const call = binding === undefined ? 'ctx.decide' : `ctx.roster.${binding.entry}.decide`;
  if (!plainObject(options)) throw new Error(`${call} requires options { state, questions }.`);
  const extra = Object.keys(options).filter(
    (key) => !(optionKeys as readonly string[]).includes(key),
  );
  if (extra.length) throw new Error(`${call} has unknown options ${extra.join(', ')}.`);
  if (binding !== undefined)
    for (const key of ['provider', 'model'] as const)
      if (options[key] !== undefined)
        throw new Error(`${call} cannot set ${key}; roster entry ${binding.entry} fixes it.`);
  const { onError, timeoutMs } = options;
  const name = binding === undefined ? options['provider'] : binding.provider;
  const requestedModel = binding === undefined ? options['model'] : binding.model;
  if (name !== undefined && typeof name !== 'string')
    throw new Error(`${call} provider must be a string.`);
  if (
    requestedModel !== undefined &&
    (typeof requestedModel !== 'string' || !requestedModel.trim())
  )
    throw new Error(`${call} model must be a nonempty string.`);
  if (onError !== undefined && onError !== 'throw' && onError !== 'return')
    throw new Error('onError must be throw or return.');
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== 'number' ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 2_147_483_647)
  )
    throw new Error(`${call} timeoutMs must be a positive integer of at most 2147483647.`);
  const retry = options['retry'] as RetryPolicy | undefined;
  if (retry !== undefined) retryPolicySchema.parse(retry);
  const state = jsonValue(options['state'], 'Decision state');
  checkDecisionQuestions(options['questions']);
  // One snapshot is the identity, the request and the schema source of every attempt.
  const snapshot = jsonValue(options['questions'], 'Decision questions');
  const questions = snapshot as unknown as DecisionQuestions;
  const declaration = providers.resolve(owner, name);
  checkDecisionCapabilities(declaration, questions);
  const model = providers.model(declaration, requestedModel);
  const schema = decisionResultSchema(questions);
  const provider = declaration.name;
  const { fixture } = providers;
  // Computed once, and only for a fixture answerer, so a live call pays nothing for it.
  let schemaSource: JsonValue | undefined;
  return {
    settled: onError === 'return',
    step: {
      // Identified by DECIDE_STEP_VERSION, not callback text; `identity` is an internal, stripped
      // field of the public step definition.
      version: DECIDE_STEP_VERSION,
      identity: 'version',
      input: { provider, revision: declaration.revision, model, state, questions: snapshot },
      // Labels only, never identity: renaming a roster entry strands no completed decision.
      meta: {
        integration: 'decision',
        op: 'decide',
        provider,
        model,
        ...(binding === undefined ? {} : { roster: binding.entry }),
      },
      schema,
      ...(retry === undefined ? {} : { retry }),
      ...(onError === undefined ? {} : { onError }),
      async run({ signal, idempotencyKey, reportUsage, attempt }) {
        // A fixture answerer replaces the transport for every attempt: no factory is called, so no
        // base URL or token is needed.
        if (fixture !== undefined) {
          signal.throwIfAborted();
          schemaSource ??= schemaJson(schema);
          return fixtureAttempt(
            fixture,
            { stepId, attempt, provider, model, schema: schemaSource },
            questions,
            reportUsage,
          );
        }
        const transport = providers.transport(declaration);
        const timeout = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
        const requestSignal = timeout === undefined ? signal : AbortSignal.any([signal, timeout]);
        // A synchronous throw, such as jevCompatible's missing or invalid token, sent no request
        // and reports no usage.
        const pending = transport(
          { model, state, questions, body: decisionRequestBody(model, state, questions) },
          {
            signal: requestSignal,
            idempotencyKey: declaration.capabilities.idempotencyKey ? idempotencyKey : null,
          },
        );
        // Every attempt that may have reached the host counts, with unknown tokens until a response
        // reports them. Reported before any await, so a checkpoint saved while the request is in
        // flight keeps the provider and model if the process dies.
        reportUsage(decisionUsage(provider, model, null));
        let response: Awaited<ReturnType<ProviderTransport>>;
        try {
          response = await pending;
        } catch (cause) {
          // A configuration failure stays fatal even if it arrives after this call's timer.
          if (cause instanceof ConfigurationError) throw cause;
          // Only this call's own timer is a timeout; the step's signal stays a cancellation.
          if (timeout?.aborted === true && !signal.aborted)
            throw new DecisionError({
              provider,
              kind: 'timeout',
              message: `request timed out after ${String(timeoutMs)}ms`,
            });
          throw cause;
        }
        // Reported before the shape check, so a response without a body still counts the attempt.
        reportUsage(decisionUsage(provider, model, plainObject(response) ? response.body : null));
        if (!plainObject(response) || !('body' in response))
          throw new DecisionError({
            provider,
            kind: 'protocol',
            message: 'the transport returned no { body } response',
          });
        return parseDecisionResponse(provider, questions, {
          body: response.body,
          ...(typeof response.rawText === 'string' ? { rawText: response.rawText } : {}),
        });
      },
    },
  };
}

/** Validate `RunOptions.decisionConfigurations` strictly at run entry. @internal */
export function checkedDecisionConfigurations(value: unknown): DecisionConfigurations | undefined {
  if (value === undefined) return undefined;
  const parsed = decisionConfigurationsSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(
      `RunOptions.decisionConfigurations is invalid: ${z.prettifyError(parsed.error)}`,
      { cause: parsed.error },
    );
  return parsed.data as DecisionConfigurations;
}
