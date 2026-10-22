/**
 * The authoring model of decision providers (ADR 0066): typed questions, their inferred answers,
 * provider declarations and the transport contract. Type-only: `model.ts` imports it, so it must
 * type-check without Node types.
 */
import type { ErrorMode, JsonInput, JsonValue, RetryPolicy } from './model.js';

/** The question kinds of the shared decision protocol. */
export type DecisionKind = 'noul' | 'choice' | 'score';

/**
 * A yes/no question; its answer is the probability of yes. Build it with `noul()` from
 * `quiet-choir/decision`.
 */
export interface NoulQuestion {
  /** Discriminator. */
  readonly type: 'noul';
  /** What to decide about the state. */
  readonly instructions: string;
  /** Optional descriptions of what a yes (`true`) and a no (`false`) answer mean. */
  readonly criteria?: NoulCriteria;
}

/** Descriptions of the two answers of a {@link NoulQuestion}. */
export interface NoulCriteria {
  /** What a yes answer means. */
  readonly true: string;
  /** What a no answer means. */
  readonly false: string;
}

/**
 * Pick one of up to 255 named options. `O` is the option-name union, inferred from the `options`
 * keys by `choice()` from `quiet-choir/decision`.
 */
export interface ChoiceQuestion<O extends string = string> {
  /** Discriminator. */
  readonly type: 'choice';
  /** What to decide about the state. */
  readonly instructions: string;
  /** Option name to a description, or null when the name alone describes it. */
  readonly options: Readonly<Record<O, string | null>>;
}

/**
 * Place the state on an ordered scale of 2 to 10 levels, lowest first. `L` is the level-name union,
 * inferred by `score()` from `quiet-choir/decision`.
 */
export interface ScoreQuestion<L extends string = string> {
  /** Discriminator. */
  readonly type: 'score';
  /** What to decide about the state. */
  readonly instructions: string;
  /** Ordered level names, lowest first; each name also describes its level. */
  readonly levels: readonly L[];
}

/** Any question of the protocol. */
export type ProtocolQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

/** A call's questions by name; each name keys its answer. */
export type DecisionQuestions = Readonly<Record<string, ProtocolQuestion>>;

/** The answer to a {@link NoulQuestion}. It has no `confidence`, as in the protocol. */
export interface NoulAnswer {
  /** Probability of yes, in [0, 1]. */
  readonly noul: number;
}

/** The answer to a {@link ChoiceQuestion} over options `O`. */
export interface ChoiceAnswer<O extends string = string> {
  /** The most probable option. */
  readonly choice: O;
  /** A probability for every option, summing to one. */
  readonly probabilities: Readonly<Record<O, number>>;
  /** The provider's confidence in the choice, in [0, 1]. */
  readonly confidence: number;
}

/** The answer to a {@link ScoreQuestion} over levels `L`. */
export interface ScoreAnswer<L extends string = string> {
  /** Probability-weighted level index in [0, levels - 1]; it may fall between levels. */
  readonly score: number;
  /** One probability per level; index `i` is `legend[i]`. They sum to one. */
  readonly probabilities: readonly number[];
  /** The question's levels in order, as the provider reported them. */
  readonly legend: readonly L[];
  /** The provider's confidence in the score, in [0, 1]. */
  readonly confidence: number;
}

/** The answer type of question `Q`. */
export type AnswerOf<Q> = Q extends NoulQuestion
  ? NoulAnswer
  : Q extends ChoiceQuestion<infer O>
    ? ChoiceAnswer<O>
    : Q extends ScoreQuestion<infer L>
      ? ScoreAnswer<L>
      : never;

/** The answers of a `ctx.decide` call, keyed like its questions. */
export type DecisionAnswers<Q extends DecisionQuestions> = {
  readonly [K in keyof Q]: AnswerOf<Q[K]>;
};

/** What a provider accepts; `ctx.decide` checks every call against it before any request. */
export interface DecisionCapabilities {
  /** Question kinds the provider answers. */
  readonly kinds: readonly DecisionKind[];
  /** Most options a choice question may have, at most 255. */
  readonly maxOptions: number;
  /** Fewest and most levels a score question may have, within [2, 10]. */
  readonly levels: readonly [number, number];
  /** Whether the transport sends the step's idempotency key with the request. */
  readonly idempotencyKey: boolean;
}

/**
 * Operator configuration of one provider: `--harness-config` `decisions.<name>` or
 * `RunOptions.decisionConfigurations`. Each field set here replaces the factory's own value.
 */
export interface DecisionProviderConfiguration {
  /** Base URL of the host, such as `https://api.example.com`. */
  readonly baseUrl?: string;
  /** Name of the environment variable holding the bearer token, read at request time. */
  readonly apiKeyEnv?: string;
  /** Model requested when a call names none. It is part of each decision's identity. */
  readonly defaultModel?: string;
}

/** One request a transport performs. */
export interface ProviderTransportRequest {
  /** The requested model, or null to let the host choose. */
  readonly model: string | null;
  /** The state the questions refer to. */
  readonly state: JsonValue;
  /** The questions, as the call passed them. */
  readonly questions: DecisionQuestions;
  /** The protocol's JSON request body for these values, ready to send. */
  readonly body: JsonValue;
}

/** Per-request context a transport receives. */
export interface ProviderTransportContext {
  /** Aborted on cancellation or when the call's `timeoutMs` elapses; pass it to the request. */
  readonly signal: AbortSignal;
  /**
   * The step's stable idempotency key when the provider declares `idempotencyKey`, otherwise
   * null. It is unchanged across retries and resume.
   */
  readonly idempotencyKey: string | null;
}

/** The raw response of one request; `ctx.decide` validates it. */
export interface ProviderTransportResponse {
  /** The parsed JSON response body, in wire shape: every answer carries its question's `type`. */
  readonly body: unknown;
  /** The response text, kept as evidence when validation fails; defaults to `body` as JSON. */
  readonly rawText?: string;
}

/**
 * Perform one request. Throw a `DecisionError` for a provider failure and a `ConfigurationError`
 * for missing configuration, such as an unset token variable. A synchronous throw sends no request
 * and reports no usage; once the transport returns its promise, the attempt counts under its
 * provider with unknown tokens until the response reports them.
 */
export type ProviderTransport = (
  request: ProviderTransportRequest,
  context: ProviderTransportContext,
) => Promise<ProviderTransportResponse>;

/**
 * Create a provider's transport from its operator configuration. The runtime calls it lazily, at
 * most once per run, before the first live request; replay never calls it. A throw is a
 * configuration failure.
 */
export type ProviderTransportFactory = (
  configuration: DecisionProviderConfiguration,
) => ProviderTransport;

/** A decision provider, as `defineDecisionProvider` returns it: plain frozen data. */
export interface DecisionProviderDeclaration {
  /** Stable name, unique within a workflow: lowercase letters, digits and dashes. */
  readonly name: string;
  /** Positive integer revision; bump it when the provider's answers change meaning. */
  readonly revision: number;
  /** What the provider accepts. */
  readonly capabilities: DecisionCapabilities;
  /** Model requested when neither the call nor the configuration names one, or null. */
  readonly defaultModel: string | null;
  /** Lazy transport factory. */
  readonly transport: ProviderTransportFactory;
}

/** Options of one `ctx.decide` call over questions `Q`. */
export interface DecideOptions<Q extends DecisionQuestions = DecisionQuestions> {
  /** Declared provider name; required when the workflow declares more than one. */
  readonly provider?: string;
  /** Requested model, which may be an alias; part of the decision's identity. */
  readonly model?: string;
  /** JSON state the questions refer to; captured as replay input. */
  readonly state: JsonInput;
  /** At least one named question. */
  readonly questions: Q;
  /** Persist and return a final failure as `Settled`; cancellation still rejects. */
  readonly onError?: ErrorMode | undefined;
  /** Retry policy, as for any step; `on: ['transient']` retries 429 and 5xx responses. */
  readonly retry?: RetryPolicy;
  /** Per-attempt request deadline in milliseconds; policy, never identity. */
  readonly timeoutMs?: number;
}
