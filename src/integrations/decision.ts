/**
 * Decision providers over the shared Jev-style protocol (ADR 0066): typed `noul`, `choice` and
 * `score` questions for `ctx.decide`, provider declarations, and the `jevCompatible` HTTP
 * provider. The older transport-injected `decision(ctx, transport).choose(...)` helper stays
 * available below.
 *
 * @packageDocumentation
 */
import {
  ConfigurationError,
  z,
  type WorkflowContext,
  type JsonValue,
  type AgentUsage,
} from '../index.js';
import { DecisionError } from '../workflow/runtime/decision-error.js';
import {
  decisionWire,
  defineDecisionProvider,
  type DecisionCapabilities,
  type DecisionProviderDeclaration,
  type ProviderTransport,
} from '../workflow/runtime/decision-protocol.js';

export { DecisionError } from '../workflow/runtime/decision-error.js';
export type { DecisionErrorDetails } from '../workflow/runtime/decision-error.js';
export {
  noul,
  choice,
  score,
  defineDecisionProvider,
} from '../workflow/runtime/decision-protocol.js';
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
  DecisionProviderDefinition,
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
} from '../workflow/runtime/decision-protocol.js';

/** Options of {@link jevCompatible}. */
export interface JevCompatibleOptions {
  /** Provider name, unique within a workflow: lowercase letters, digits and dashes. */
  readonly name: string;
  /** Host base URL, such as `https://api.example.com`; `decisions.<name>.baseUrl` replaces it. */
  readonly baseUrl?: string;
  /** Request path; defaults to `/v1/systemone`. */
  readonly path?: string;
  /**
   * Environment variable holding the bearer token, read at request time and never recorded;
   * `decisions.<name>.apiKeyEnv` replaces it.
   */
  readonly apiKeyEnv?: string;
  /** Model requested when a call names none; `decisions.<name>.defaultModel` replaces it. */
  readonly defaultModel: string;
  /** Provider revision, part of every decision's identity; defaults to 1. */
  readonly revision?: number;
  /**
   * Overrides of the default capabilities (all three kinds, 255 options, 2 to 10 levels, no
   * idempotency key) for hosts that lack a kind, cap options lower or accept an idempotency key.
   */
  readonly capabilities?: Partial<DecisionCapabilities>;
}

/** The `ErrorKind` of an HTTP failure status. */
function statusKind(status: number): DecisionError['kind'] {
  if (status === 429) return 'rate-limit';
  if (status >= 500) return 'overloaded';
  if (status === 401) return 'authentication';
  if (status === 403) return 'permission';
  if (status >= 400) return 'invalid-request';
  return 'protocol';
}

/** Whether a bearer token can be sent unchanged as an HTTP header value. */
function headerValue(token: string): boolean {
  // Printable ASCII and Latin-1: no C0 or C1 control characters, DEL or wider code points.
  return token === token.trim() && !/[^\x20-\x7e\xa0-\xff]/u.test(token);
}

function httpUrl(value: string, label: string): string {
  if (!URL.canParse(value) || !['http:', 'https:'].includes(new URL(value).protocol))
    throw new ConfigurationError(`${label} must be an http or https URL.`);
  return value;
}

/**
 * A decision provider for any host that speaks the shared protocol: `POST <baseUrl><path>` with a
 * JSON `{ model, state, questions }` body and an `Authorization: Bearer` token read from
 * `apiKeyEnv` at request time. The step's idempotency key is sent as an `Idempotency-Key` header
 * only when `capabilities.idempotencyKey` is true. HTTP 429 fails with kind `rate-limit`, 5xx with
 * `overloaded` (both transient), 401 with `authentication`, 403 with `permission` and other 4xx
 * with `invalid-request`. A missing base URL or token variable, or a token that is not a valid
 * header value, is a configuration failure: the step stays unfinished, and resuming after fixing it
 * runs the decision live.
 */
export function jevCompatible(options: JevCompatibleOptions): DecisionProviderDeclaration {
  const name = options.name;
  const path = options.path ?? decisionWire.path;
  if (!path.startsWith('/')) throw new Error(`Decision provider ${name} path must start with /.`);
  if (options.baseUrl !== undefined) httpUrl(options.baseUrl, `Decision provider ${name} baseUrl`);
  const capabilities: DecisionCapabilities = {
    kinds: options.capabilities?.kinds ?? ['noul', 'choice', 'score'],
    maxOptions: options.capabilities?.maxOptions ?? 255,
    levels: options.capabilities?.levels ?? [2, 10],
    idempotencyKey: options.capabilities?.idempotencyKey ?? false,
  };
  return defineDecisionProvider({
    name,
    revision: options.revision ?? 1,
    capabilities,
    defaultModel: options.defaultModel,
    transport: (configuration): ProviderTransport => {
      const baseUrl = configuration.baseUrl ?? options.baseUrl;
      if (baseUrl === undefined)
        throw new ConfigurationError(
          `Decision provider ${name} has no baseUrl; set it in jevCompatible or --harness-config decisions.${name}.baseUrl.`,
        );
      const url = `${httpUrl(baseUrl, `Decision provider ${name} baseUrl`).replace(/\/+$/u, '')}${path}`;
      const apiKeyEnv = configuration.apiKeyEnv ?? options.apiKeyEnv;
      if (apiKeyEnv === undefined)
        throw new ConfigurationError(
          `Decision provider ${name} has no apiKeyEnv; set it in jevCompatible or --harness-config decisions.${name}.apiKeyEnv.`,
        );
      return async (request, context) => {
        const token = process.env[apiKeyEnv];
        if (token === undefined || token === '')
          throw new ConfigurationError(
            `Decision provider ${name} reads its bearer token from ${apiKeyEnv}, which is unset.`,
          );
        // fetch would reject such a header value with a message that echoes it.
        if (!headerValue(token))
          throw new ConfigurationError(
            `Decision provider ${name} reads its bearer token from ${apiKeyEnv}, whose value is not a valid HTTP header value (it has control or non-Latin-1 characters, or leading or trailing whitespace).`,
          );
        let response: Response;
        let text: string;
        try {
          response = await fetch(url, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
              accept: 'application/json',
              ...(context.idempotencyKey === null
                ? {}
                : { 'idempotency-key': context.idempotencyKey }),
            },
            body: JSON.stringify(request.body),
            signal: context.signal,
          });
          text = await response.text();
        } catch (cause) {
          // Cancellation and the call's own timeout propagate unchanged; the runtime classifies them.
          if (context.signal.aborted) throw cause;
          throw new DecisionError({
            provider: name,
            kind: 'unknown',
            // Defense in depth: never let a client error that echoes the token reach the record.
            message: `request failed: ${(cause instanceof Error ? cause.message : String(cause)).replaceAll(token, '[redacted]')}`,
          });
        }
        if (!response.ok)
          throw new DecisionError({
            provider: name,
            kind: statusKind(response.status),
            status: response.status,
            message: `HTTP ${String(response.status)}${text ? `: ${text.slice(0, 200)}` : ''}`,
            rawText: text,
          });
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          throw new DecisionError({
            provider: name,
            kind: 'schema',
            status: response.status,
            message: 'response is not JSON',
            rawText: text,
          });
        }
        return { body, rawText: text };
      };
    },
  });
}

/** Version that identifies a decision step; see `choose` before changing it. */
const DECISION_STEP_VERSION = 'decision/1';

/** Prompt-free decision input; this reference transport does not integrate a particular service. */
export interface DecisionQuestion<A extends readonly [string, ...string[]]> {
  /** Explicit state captured as replay input. */
  readonly state: JsonValue;
  /** Decision to make. */
  readonly question: string;
  /** Finite answer space. */
  readonly answers: A;
}

/** Validated selection with the complete reported distribution. */
export interface DecisionAnswer<TAnswer extends string> {
  /** One answer from the declared finite answer space. */
  readonly answer: TAnswer;
  /** Normalized distribution: a probability for every declared answer, summing to one. */
  readonly probabilities: Record<TAnswer, number>;
}

/** Inject a service client with its own authentication, outside durable semantic inputs. */
export type DecisionTransport = (
  question: DecisionQuestion<readonly [string, ...string[]]>,
  context: {
    /** Cooperative cancellation. */
    readonly signal: AbortSignal;
    /** Stable external deduplication key, unchanged across retries/resume. */
    readonly idempotencyKey: string;
  },
) => Promise<{
  /** Unknown service payload, validated inside the one local effect. */
  readonly output: unknown;
  /** Optional cumulative usage for this attempt, retained even if output validation fails. */
  readonly usage?: AgentUsage;
}>;

/** One ordinary step per decision, with no extra context property or effect kind. */
export function decision(
  ctx: Pick<WorkflowContext, 'step'>,
  transport: DecisionTransport,
): {
  /** Choose one declared answer, preserving the complete reported probability distribution. */
  choose<const A extends readonly [string, ...string[]]>(
    id: string,
    question: DecisionQuestion<A>,
  ): Promise<DecisionAnswer<A[number]>>;
} {
  return {
    choose(id, question) {
      // One synchronous snapshot is both the fingerprinted input and every attempt's transport input.
      const snapshot = {
        state: structuredClone(question.state),
        question: question.question,
        answers: [...question.answers] as const,
      };
      const schema = z
        .object({
          answer: z.enum(snapshot.answers),
          probabilities: z.record(z.enum(snapshot.answers), z.number().min(0).max(1)),
        })
        .refine(
          ({ probabilities }) =>
            Math.abs(
              Object.values<number>(probabilities).reduce((sum, value) => sum + value, 0) - 1,
            ) <= 1e-6,
          { message: 'Probabilities must sum to 1.', path: ['probabilities'] },
        );
      return ctx.step(id, {
        // Identified by DECISION_STEP_VERSION, not callback text. Bump it only if decision.choose's
        // recorded behavior or result contract changes, never for refactors: a bump strands
        // completed decision steps. `identity` is an internal, stripped field of the public step
        // definition; test/builtin-identity.test.ts pins the result.
        version: DECISION_STEP_VERSION,
        identity: 'version',
        input: { ...snapshot, answers: [...snapshot.answers] },
        schema,
        meta: { integration: 'decision', op: 'choose' },
        async run({ signal, idempotencyKey, reportUsage }) {
          const response = await transport(structuredClone(snapshot), { signal, idempotencyKey });
          if (response.usage !== undefined) reportUsage(response.usage);
          return schema.parse(response.output);
        },
      });
    },
  };
}
