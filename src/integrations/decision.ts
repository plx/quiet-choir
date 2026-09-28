import { z, type WorkflowContext, type JsonValue, type AgentUsage } from '../index.js';

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
  /** Probability reported for every declared answer. */
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
      const schema = z.object({
        answer: z.enum(snapshot.answers),
        probabilities: z.record(z.enum(snapshot.answers), z.number().min(0).max(1)),
      });
      return ctx.step(id, {
        version: 'decision/1',
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
