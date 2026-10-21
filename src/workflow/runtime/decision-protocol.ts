/**
 * The shared decision protocol (ADR 0066 sections 1, 2 and 4): question constructors, provider
 * declarations, structural and capability checks, the wire request, and response validation.
 *
 * Pure: zod and pure runtime helpers only, no I/O, clock, process or runner state, so the core
 * (`ctx.decide`) and the `quiet-choir/decision` subpath share it. Questions and declarations are
 * plain frozen data checked structurally, never by `instanceof` or a registry, because a CLI
 * workflow may build them with another quiet-choir module instance.
 */
import { z } from 'zod';

import { ConfigurationError } from './configuration-error.js';
import { DecisionError } from './decision-error.js';
import { helperRefinements } from './helper-refinements.js';
import type {
  ChoiceQuestion,
  DecisionCapabilities,
  DecisionKind,
  DecisionProviderConfiguration,
  DecisionProviderDeclaration,
  ProtocolQuestion,
  DecisionQuestions,
  ProviderTransportFactory,
  ProviderTransportResponse,
  NoulCriteria,
  NoulQuestion,
  ScoreQuestion,
} from './decision-model.js';
import type { AgentUsage, JsonValue } from './model.js';

/**
 * Every wire name of the protocol, in one place. Verified against TypeSafe's published
 * `POST /v1/systemone` reference: choice options and score levels travel as `criteria`, answers
 * carry a `type`, and score `legend`/`probabilities` are keyed by level index. Correcting a name
 * here changes no step identity, which hashes the question objects, not this encoding.
 * @internal
 */
export const decisionWire = Object.freeze({
  /** Default request path of a protocol host. */
  path: '/v1/systemone',
  request: Object.freeze({ model: 'model', state: 'state', questions: 'questions' }),
  question: Object.freeze({
    type: 'type',
    instructions: 'instructions',
    /** Noul answer descriptions, choice options and score levels all travel under this name. */
    criteria: 'criteria',
  }),
  response: Object.freeze({ model: 'model', answers: 'answers', usage: 'usage' }),
  answer: Object.freeze({
    type: 'type',
    noul: 'noul',
    choice: 'choice',
    score: 'score',
    probabilities: 'probabilities',
    confidence: 'confidence',
    legend: 'legend',
  }),
  /** Usage token keys, read leniently in this order. */
  usage: Object.freeze({
    input: Object.freeze(['input_tokens', 'inputTokens']),
    output: Object.freeze(['output_tokens', 'outputTokens']),
  }),
});

/** Provider and configuration names: lowercase letters, digits and dashes, like harness names. */
const decisionProviderNamePattern = /^[a-z][a-z0-9-]{0,31}$/u;
const kinds: readonly DecisionKind[] = ['noul', 'choice', 'score'];
const maxOptions = 255;
const levelRange = [2, 10] as const;
/** Probability maps must sum to one within this tolerance. */
const sumTolerance = 1e-6;

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

/** The problem with a question's shape, or null when it is a valid protocol question. */
function questionProblem(value: unknown): string | null {
  if (!plainObject(value)) return 'must be a noul(), choice() or score() question';
  const type = value['type'];
  if (type !== 'noul' && type !== 'choice' && type !== 'score')
    return 'must be a noul(), choice() or score() question';
  if (!nonempty(value['instructions'])) return 'needs nonempty instructions';
  if (type === 'noul') {
    const extra = unknownKeys(value, ['type', 'instructions', 'criteria']);
    if (extra.length) return `has unknown fields ${extra.join(', ')}`;
    const criteria = value['criteria'];
    if (criteria === undefined) return null;
    if (
      !plainObject(criteria) ||
      unknownKeys(criteria, ['true', 'false']).length > 0 ||
      !nonempty(criteria['true']) ||
      !nonempty(criteria['false'])
    )
      return 'criteria must describe both answers: { true: string, false: string }';
    return null;
  }
  if (type === 'choice') {
    const extra = unknownKeys(value, ['type', 'instructions', 'options']);
    if (extra.length) return `has unknown fields ${extra.join(', ')}`;
    const options = value['options'];
    if (!plainObject(options)) return 'options must be a record of option name to description';
    const names = Object.keys(options);
    if (names.length < 1 || names.length > maxOptions)
      return `needs 1 to ${String(maxOptions)} options (got ${String(names.length)})`;
    for (const name of names) {
      if (!nonempty(name) || name === '__proto__') return `has an invalid option name "${name}"`;
      const description = options[name];
      if (description !== null && typeof description !== 'string')
        return `option ${name} needs a string description or null`;
    }
    return null;
  }
  const extra = unknownKeys(value, ['type', 'instructions', 'levels']);
  if (extra.length) return `has unknown fields ${extra.join(', ')}`;
  const levels = value['levels'];
  if (!Array.isArray(levels)) return 'levels must be an array of level names';
  if (levels.length < levelRange[0] || levels.length > levelRange[1])
    return `needs ${String(levelRange[0])} to ${String(levelRange[1])} levels (got ${String(levels.length)})`;
  if (!levels.every(nonempty)) return 'levels must be nonempty strings';
  if (new Set(levels).size !== levels.length) return 'levels must be unique';
  return null;
}

function checkedQuestion<Q extends ProtocolQuestion>(question: Q, label: string): Q {
  const problem = questionProblem(question);
  if (problem !== null) throw new Error(`${label} ${problem}.`);
  return question;
}

/**
 * A yes/no question; its answer is `{ noul }`, the probability of yes, with no confidence.
 * Throws on an empty instruction or malformed criteria.
 */
export function noul(question: {
  /** What to decide about the state. */
  readonly instructions: string;
  /** Optional descriptions of what yes (`true`) and no (`false`) mean. */
  readonly criteria?: NoulCriteria;
}): NoulQuestion {
  const value: NoulQuestion = {
    type: 'noul',
    instructions: question.instructions,
    ...(question.criteria === undefined
      ? {}
      : {
          criteria: Object.freeze({ true: question.criteria.true, false: question.criteria.false }),
        }),
  };
  return Object.freeze(checkedQuestion(value, 'A noul question'));
}

/**
 * Pick one of up to 255 options, given as a record of option name to description (or null). The
 * option names type the answer: `choice` is their union and `probabilities` is keyed by them.
 */
export function choice<const O extends string>(question: {
  /** What to decide about the state. */
  readonly instructions: string;
  /** Option name to a description, or null when the name alone describes it. */
  readonly options: Readonly<Record<O, string | null>>;
}): ChoiceQuestion<O> {
  const options: Record<string, string | null> = {};
  if (plainObject(question.options))
    for (const [name, description] of Object.entries(question.options))
      Object.defineProperty(options, name, { value: description, enumerable: true });
  const value = {
    type: 'choice',
    instructions: question.instructions,
    options: plainObject(question.options) ? Object.freeze(options) : question.options,
  } as ChoiceQuestion<O>;
  return Object.freeze(checkedQuestion(value, 'A choice question'));
}

/**
 * Place the state on an ordered scale of 2 to 10 unique levels, lowest first. The answer's `score`
 * is a level index that may fall between levels, and its `legend` is typed by the level names.
 */
export function score<const L extends string>(question: {
  /** What to decide about the state. */
  readonly instructions: string;
  /** Ordered level names, lowest first. */
  readonly levels: readonly L[];
}): ScoreQuestion<L> {
  const value: ScoreQuestion<L> = {
    type: 'score',
    instructions: question.instructions,
    levels: Array.isArray(question.levels)
      ? Object.freeze([...(question.levels as readonly L[])])
      : question.levels,
  };
  return Object.freeze(checkedQuestion(value, 'A score question'));
}

/**
 * Check a call's questions structurally: a nonempty record of protocol questions. Throws a plain
 * Error naming the first malformed question. @internal
 */
export function checkDecisionQuestions(value: unknown): DecisionQuestions {
  if (!plainObject(value))
    throw new Error('Decision questions must be a record of named questions.');
  const names = Object.keys(value);
  if (names.length === 0) throw new Error('A decision needs at least one question.');
  for (const name of names) {
    if (!nonempty(name)) throw new Error('Decision question names must be nonempty.');
    const problem = questionProblem(value[name]);
    if (problem !== null) throw new Error(`Decision question ${name} ${problem}.`);
  }
  return value as DecisionQuestions;
}

/**
 * Check the questions against a provider's declared capabilities before any request: every kind
 * accepted, choice options within `maxOptions`, score levels within `levels`. A violation is a
 * {@link ConfigurationError} naming the question. @internal
 */
export function checkDecisionCapabilities(
  provider: DecisionProviderDeclaration,
  questions: DecisionQuestions,
): void {
  const { capabilities } = provider;
  for (const [name, question] of Object.entries(questions)) {
    if (!capabilities.kinds.includes(question.type))
      throw new ConfigurationError(
        `Decision provider ${provider.name} does not answer ${question.type} questions (question ${name}); it accepts ${capabilities.kinds.join(', ')}.`,
      );
    if (question.type === 'choice') {
      const count = Object.keys(question.options).length;
      if (count > capabilities.maxOptions)
        throw new ConfigurationError(
          `Decision question ${name} has ${String(count)} options; provider ${provider.name} accepts at most ${String(capabilities.maxOptions)}.`,
        );
    }
    if (question.type === 'score') {
      const [min, max] = capabilities.levels;
      const count = question.levels.length;
      if (count < min || count > max)
        throw new ConfigurationError(
          `Decision question ${name} has ${String(count)} levels; provider ${provider.name} accepts ${String(min)} to ${String(max)}.`,
        );
    }
  }
}

/** The problem with declared capabilities, or null when they are well formed. */
function capabilitiesProblem(value: unknown): string | null {
  if (!plainObject(value)) return 'capabilities must be an object';
  const extra = unknownKeys(value, ['kinds', 'maxOptions', 'levels', 'idempotencyKey']);
  if (extra.length) return `capabilities have unknown fields ${extra.join(', ')}`;
  const declared = value['kinds'];
  if (
    !Array.isArray(declared) ||
    declared.length === 0 ||
    !declared.every((kind) => kinds.includes(kind as DecisionKind)) ||
    new Set(declared).size !== declared.length
  )
    return 'capabilities.kinds must list unique kinds among noul, choice and score';
  const options = value['maxOptions'];
  if (typeof options !== 'number' || !Number.isInteger(options) || options < 1 || options > 255)
    return 'capabilities.maxOptions must be an integer from 1 to 255';
  const levels = value['levels'];
  if (
    !Array.isArray(levels) ||
    levels.length !== 2 ||
    !levels.every((level) => Number.isInteger(level)) ||
    (levels[0] as number) < levelRange[0] ||
    (levels[1] as number) > levelRange[1] ||
    (levels[0] as number) > (levels[1] as number)
  )
    return 'capabilities.levels must be [min, max] integers with 2 <= min <= max <= 10';
  if (typeof value['idempotencyKey'] !== 'boolean')
    return 'capabilities.idempotencyKey must be a boolean';
  return null;
}

/** The problem with a provider declaration, or null when it is well formed. */
function providerProblem(value: unknown): string | null {
  if (!plainObject(value)) return 'must be a defineDecisionProvider(...) declaration';
  const extra = unknownKeys(value, [
    'name',
    'revision',
    'capabilities',
    'defaultModel',
    'transport',
  ]);
  if (extra.length) return `has unknown fields ${extra.join(', ')}`;
  const name = value['name'];
  if (typeof name !== 'string' || !decisionProviderNamePattern.test(name))
    return 'name must be lowercase letters, digits and dashes, starting with a letter (at most 32)';
  const revision = value['revision'];
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1)
    return 'revision must be a positive integer';
  const capabilities = capabilitiesProblem(value['capabilities']);
  if (capabilities !== null) return capabilities;
  const model = value['defaultModel'];
  if (model !== undefined && model !== null && !nonempty(model))
    return 'defaultModel must be a nonempty string or null';
  if (typeof value['transport'] !== 'function') return 'transport must be a factory function';
  return null;
}

/** Fields of {@link defineDecisionProvider}. */
export interface DecisionProviderDefinition {
  /** Stable name, unique within a workflow: lowercase letters, digits and dashes (at most 32). */
  readonly name: string;
  /** Positive integer revision; part of every decision's identity, so bump it deliberately. */
  readonly revision: number;
  /** What the provider accepts; checked before every request. */
  readonly capabilities: DecisionCapabilities;
  /** Model requested when neither the call nor the operator configuration names one. */
  readonly defaultModel?: string;
  /** Lazy transport factory; it receives the operator configuration for this provider's name. */
  readonly transport: ProviderTransportFactory;
}

/**
 * Declare a decision provider the way `defineHarness` declares a harness: a name, a revision,
 * declared capabilities and a lazy transport factory. Returns plain frozen data for
 * `defineWorkflow({ decisions: [...] })`. Throws on a malformed declaration.
 */
export function defineDecisionProvider(
  definition: DecisionProviderDefinition,
): DecisionProviderDeclaration {
  const problem = providerProblem(definition);
  if (problem !== null) throw new Error(`Decision provider ${problem}.`);
  const { capabilities } = definition;
  return Object.freeze({
    name: definition.name,
    revision: definition.revision,
    capabilities: Object.freeze({
      kinds: Object.freeze([...capabilities.kinds]),
      maxOptions: capabilities.maxOptions,
      levels: Object.freeze([capabilities.levels[0], capabilities.levels[1]] as const),
      idempotencyKey: capabilities.idempotencyKey,
    }),
    defaultModel: definition.defaultModel ?? null,
    transport: definition.transport,
  });
}

/**
 * Check a workflow's `decisions` field structurally: an array of well-formed declarations with
 * unique names. @internal
 */
export function checkDecisionProviders(
  value: unknown,
  workflow: string,
): readonly DecisionProviderDeclaration[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new Error(
      `Workflow ${workflow} decisions must be an array of defineDecisionProvider(...) declarations.`,
    );
  const names = new Set<string>();
  for (const [index, item] of value.entries()) {
    const problem = providerProblem(item);
    if (problem !== null)
      throw new Error(`Workflow ${workflow} decisions[${String(index)}] ${problem}.`);
    const { name } = item as DecisionProviderDeclaration;
    if (names.has(name))
      throw new Error(`Workflow ${workflow} declares duplicate decision provider ${name}.`);
    names.add(name);
  }
  return value as readonly DecisionProviderDeclaration[];
}

function httpUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const { protocol } = new URL(value);
  return protocol === 'http:' || protocol === 'https:';
}

/** One provider's operator configuration, validated strictly. @internal */
export const decisionConfigurationSchema = z.strictObject({
  baseUrl: z.string().refine(httpUrl, 'baseUrl must be an http or https URL').optional(),
  apiKeyEnv: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u, 'apiKeyEnv must be an environment variable name')
    .optional(),
  defaultModel: z.string().min(1).optional(),
});

/** `decisions.<name>` configurations by provider name, validated strictly. @internal */
export const decisionConfigurationsSchema = z.record(
  z.string().regex(decisionProviderNamePattern),
  decisionConfigurationSchema,
);

/** Operator configurations by provider name. @internal */
export type DecisionConfigurations = Readonly<Record<string, DecisionProviderConfiguration>>;

/** The protocol request body for a call. The model is omitted when null. @internal */
export function decisionRequestBody(
  model: string | null,
  state: JsonValue,
  questions: DecisionQuestions,
): JsonValue {
  const wire = decisionWire.question;
  const encoded: Record<string, JsonValue> = {};
  for (const [name, question] of Object.entries(questions)) {
    const criteria: JsonValue | undefined =
      question.type === 'noul'
        ? question.criteria === undefined
          ? undefined
          : { true: question.criteria.true, false: question.criteria.false }
        : question.type === 'choice'
          ? { ...question.options }
          : [...question.levels];
    Object.defineProperty(encoded, name, {
      value: {
        [wire.type]: question.type,
        [wire.instructions]: question.instructions,
        ...(criteria === undefined ? {} : { [wire.criteria]: criteria }),
      },
      enumerable: true,
    });
  }
  return {
    ...(model === null ? {} : { [decisionWire.request.model]: model }),
    [decisionWire.request.state]: state,
    [decisionWire.request.questions]: encoded,
  };
}

const probability = z.number().min(0).max(1);
const sumsToOne = (values: readonly number[]): boolean =>
  Math.abs(values.reduce((total, value) => total + value, 0) - 1) <= sumTolerance;

/**
 * One answer's schema. A choice or score answer carries a one-hot JSON Schema `default`, the sample
 * rehearsal synthesizes, because a type-based sample cannot satisfy its sum-to-one refinement.
 */
function answerSchema(question: ProtocolQuestion): z.ZodType {
  if (question.type === 'noul') return z.object({ noul: probability });
  if (question.type === 'choice') {
    const names = Object.keys(question.options) as [string, ...string[]];
    return z
      .object({
        choice: z.enum(names),
        probabilities: z.strictObject(Object.fromEntries(names.map((name) => [name, probability]))),
        confidence: probability,
      })
      .refine((answer) => sumsToOne(Object.values(answer.probabilities)), {
        message: `Probabilities must sum to 1 within ${String(sumTolerance)}.`,
        path: ['probabilities'],
      })
      .meta({
        default: {
          choice: names[0],
          probabilities: Object.fromEntries(names.map((name, index) => [name, index ? 0 : 1])),
          confidence: 1,
        },
      });
  }
  const levels = question.levels;
  return z
    .object({
      score: z
        .number()
        .min(0)
        .max(levels.length - 1),
      probabilities: z.array(probability).length(levels.length),
      legend: z.tuple(levels.map((level) => z.literal(level)) as unknown as [z.ZodLiteral<string>]),
      confidence: probability,
    })
    .refine((answer) => sumsToOne(answer.probabilities), {
      message: `Probabilities must sum to 1 within ${String(sumTolerance)}.`,
      path: ['probabilities'],
    })
    .meta({
      default: {
        score: 0,
        probabilities: levels.map((_, index) => (index ? 0 : 1)),
        legend: [...levels],
        confidence: 1,
      },
    });
}

/** The recorded result of a decision step: the served model and the validated answers. @internal */
export interface DecisionResult {
  /** The model that answered, as the provider reported it, or null. */
  readonly model: string | null;
  /** Validated answers by question name. */
  readonly answers: Readonly<Record<string, JsonValue>>;
}

/**
 * The step schema of a decision over these questions: every question answered, no extra names,
 * choices among the options, probability maps complete and summing to one, score legends equal to
 * the levels. Its refinements are integrity checks, so rehearsal does not warn about them.
 * @internal
 */
export function decisionResultSchema(questions: DecisionQuestions): z.ZodType<DecisionResult> {
  return helperRefinements(
    z.object({
      model: z.string().nullable(),
      answers: z.strictObject(
        Object.fromEntries(
          Object.entries(questions).map(([name, question]) => [name, answerSchema(question)]),
        ),
      ),
    }),
  ) as unknown as z.ZodType<DecisionResult>;
}

/** An index-keyed object ("0", "1", ...) of `length` entries as an array; anything else unchanged. */
function indexed(value: unknown, length: number): unknown {
  if (Array.isArray(value) || !plainObject(value)) return value;
  const keys = Object.keys(value);
  if (keys.length !== length) return value;
  const result: unknown[] = [];
  for (let index = 0; index < length; index++) {
    if (!Object.hasOwn(value, String(index))) return value;
    result.push(value[String(index)]);
  }
  return result;
}

/** Translate one wire answer into the recorded shape, without validating it. */
function wireAnswer(question: ProtocolQuestion, raw: unknown): unknown {
  if (!plainObject(raw)) return raw;
  const wire = decisionWire.answer;
  if (question.type === 'noul') return { noul: raw[wire.noul] };
  if (question.type === 'choice')
    return {
      choice: raw[wire.choice],
      probabilities: raw[wire.probabilities],
      confidence: raw[wire.confidence],
    };
  return {
    score: raw[wire.score],
    probabilities: indexed(raw[wire.probabilities], question.levels.length),
    legend: indexed(raw[wire.legend], question.levels.length),
    confidence: raw[wire.confidence],
  };
}

/** The served model a response reports, or null. @internal */
export function servedModel(body: unknown): string | null {
  const model = plainObject(body) ? body[decisionWire.response.model] : undefined;
  return typeof model === 'string' && model.length > 0 ? model : null;
}

/**
 * Validate a transport response against the questions and return the recorded result. A failure
 * throws a {@link DecisionError} of kind `schema` carrying the raw body and the issues.
 * @internal
 */
export function parseDecisionResponse(
  provider: string,
  questions: DecisionQuestions,
  response: ProviderTransportResponse,
): DecisionResult {
  const { body } = response;
  const rawText = response.rawText ?? safeStringify(body);
  const answers = plainObject(body) ? body[decisionWire.response.answers] : undefined;
  const translated: Record<string, unknown> = {};
  // An answer whose `type` names another kind is rejected even when its fields would parse.
  const typeIssues: JsonValue[] = [];
  if (plainObject(answers))
    for (const [name, raw] of Object.entries(answers)) {
      const question = Object.hasOwn(questions, name) ? questions[name] : undefined;
      const type = plainObject(raw) ? raw[decisionWire.answer.type] : undefined;
      if (question !== undefined && type !== undefined && type !== question.type)
        typeIssues.push({
          code: 'custom',
          path: ['answers', name, 'type'],
          message: `Answer type must be ${question.type}.`,
        });
      Object.defineProperty(translated, name, {
        value: question === undefined ? raw : wireAnswer(question, raw),
        enumerable: true,
      });
    }
  const parsed = decisionResultSchema(questions).safeParse({
    model: servedModel(body),
    answers: plainObject(answers) ? translated : answers,
  });
  if (parsed.success && typeIssues.length === 0) return parsed.data;
  const issues = [
    ...typeIssues,
    ...(parsed.success ? [] : (JSON.parse(JSON.stringify(parsed.error.issues)) as JsonValue[])),
  ];
  throw new DecisionError({
    provider,
    kind: 'schema',
    message: `response failed validation: ${issues
      .slice(0, 5)
      .map((issue) => {
        const { path, message } = issue as { path?: unknown; message?: unknown };
        return `${Array.isArray(path) && path.length ? path.join('.') : '(root)'}: ${String(message)}`;
      })
      .join('; ')}`,
    rawText,
    issues,
  });
}

function safeStringify(value: unknown): string {
  try {
    // JSON.stringify returns undefined for undefined and functions, despite its declared type.
    const text = JSON.stringify(value) as unknown;
    return typeof text === 'string' ? text : String(value);
  } catch {
    return String(value);
  }
}

function tokenCount(usage: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

/**
 * The usage a decision attempt reports: leniently read token counts, unknown cost, the requested
 * and served model, the provider, and the provider's raw usage object as `reported`. @internal
 */
export function decisionUsage(
  provider: string,
  requested: string | null,
  body: unknown,
): AgentUsage {
  const raw = plainObject(body) ? body[decisionWire.response.usage] : undefined;
  const usage = plainObject(raw) ? raw : {};
  const served = servedModel(body);
  return {
    inputTokens: tokenCount(usage, decisionWire.usage.input),
    outputTokens: tokenCount(usage, decisionWire.usage.output),
    costUsd: null,
    model: { requested, effective: served === null ? null : [served] },
    provider,
    ...(plainObject(raw) ? { reported: JSON.parse(JSON.stringify(raw)) as JsonValue } : {}),
  };
}

export type {
  ChoiceAnswer,
  ChoiceQuestion,
  DecideOptions,
  AnswerOf,
  DecisionAnswers,
  DecisionCapabilities,
  DecisionKind,
  DecisionProviderConfiguration,
  DecisionProviderDeclaration,
  ProtocolQuestion,
  DecisionQuestions,
  ProviderTransport,
  ProviderTransportContext,
  ProviderTransportFactory,
  ProviderTransportRequest,
  ProviderTransportResponse,
  NoulAnswer,
  NoulCriteria,
  NoulQuestion,
  ScoreAnswer,
  ScoreQuestion,
} from './decision-model.js';
