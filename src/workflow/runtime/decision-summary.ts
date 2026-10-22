/**
 * The compact summary of a completed decision step, derived from its record alone (ADR 0066
 * section 5). `workflow inspect`, the live `--events` sink and the record follower all call
 * {@link summarizeDecisionStep}, so the three can never disagree. It reads no question
 * definitions, because the record keeps only their identity hashes: each question's kind is
 * recovered from the shape of its recorded answer.
 */
import type { StepRecord } from './record.js';

/** One question of a decision step, as its recorded answer shows it. */
export interface DecisionQuestionSummary {
  /** The question's name, the key of its answer. */
  readonly name: string;
  /**
   * The question kind, recovered from the shape of the recorded answer. `unknown` marks an answer
   * of no recognized shape, such as a hand-edited record.
   */
  readonly kind: 'noul' | 'choice' | 'score' | 'unknown';
  /**
   * The headline answer: the probability of yes for `noul`, the chosen option for `choice`, the
   * probability-weighted level index for `score`, and null for `unknown`.
   */
  readonly answer: number | string | null;
  /**
   * The nearest level name of a `score` answer: the recorded legend entry at the rounded score,
   * clamped to the legend. Absent for other kinds and when the legend is unusable.
   */
  readonly level?: string;
  /** The provider's confidence in `[0, 1]` for `choice` and `score`; absent for `noul`. */
  readonly confidence?: number;
}

/**
 * What `workflow inspect` and the `step.completed` event line show for a completed decision step:
 * a `ctx.decide` call, or a legacy `decision(ctx, transport).choose` call. Plain JSON, derived
 * from the step record by a pure function that never throws.
 */
export interface DecisionStepSummary {
  /** `decide` for a `ctx.decide` step, `choose` for a legacy `decision/1` step. */
  readonly op: 'decide' | 'choose';
  /**
   * The provider's declared name, from the latest attempt's usage and else the step's `meta`; null
   * when the record names none.
   */
  readonly provider: string | null;
  /**
   * The model the call requested after defaults, from the latest attempt's usage and else the
   * step's `meta`; null when the host chose its own.
   */
  readonly requestedModel: string | null;
  /** The model the provider reported answering, or null when it reported none. */
  readonly servedModel: string | null;
  /** One entry per answered question, in the key order of the recorded answers (sorted by name). */
  readonly questions: readonly DecisionQuestionSummary[];
  /**
   * The source run of a step a fork reused from it; absent for a step that ran here. Its provider,
   * models and answers still show, but `usage` is zero because this run made no attempts.
   */
  readonly reusedFrom?: string;
  /**
   * Attempts and the tokens their reports add up to; zero for a fork-reused step. It spans every
   * attempt of the step, including any made before a redefinition, like the step's `attempts`.
   */
  readonly usage: {
    /** Attempts the step made, failed ones included. */
    readonly attempts: number;
    /** Sum of the attempts' input tokens; null when any attempt reported none. */
    readonly inputTokens: number | null;
    /** Sum of the attempts' output tokens; null when any attempt reported none. */
    readonly outputTokens: number | null;
  };
}

type PlainObject = Record<string, unknown>;

function plain(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(source: PlainObject, key: string): unknown {
  return Object.hasOwn(source, key) ? source[key] : undefined;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A token count: a finite, nonnegative number, else null. */
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** The sum of the counts, or null when there are none or any is unknown. */
function total(values: readonly (number | null)[]): number | null {
  return values.length && values.every((value) => value !== null)
    ? values.reduce<number>((sum, value) => sum + value, 0)
    : null;
}

function probability(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function question(name: string, raw: unknown): DecisionQuestionSummary {
  if (!plain(raw)) return { name, kind: 'unknown', answer: null };
  const confidence = probability(own(raw, 'confidence'));
  const noul = probability(own(raw, 'noul'));
  if (noul !== undefined) return { name, kind: 'noul', answer: noul };
  const choice = own(raw, 'choice');
  if (typeof choice === 'string')
    return {
      name,
      kind: 'choice',
      answer: choice,
      ...(confidence === undefined ? {} : { confidence }),
    };
  const score = probability(own(raw, 'score'));
  if (score !== undefined) {
    const legend = own(raw, 'legend');
    const levels = Array.isArray(legend) ? (legend as unknown[]) : [];
    const index = Math.min(Math.max(Math.round(score), 0), levels.length - 1);
    const level = levels.length ? levels[index] : undefined;
    return {
      name,
      kind: 'score',
      answer: score,
      ...(typeof level === 'string' ? { level } : {}),
      ...(confidence === undefined ? {} : { confidence }),
    };
  }
  return { name, kind: 'unknown', answer: null };
}

/**
 * The summary of a completed decision step, or null for every other step: one whose kind is not
 * `step`, that has not completed, or whose `meta` does not label it `decision` with the op
 * `decide` or `choose`. Failed and settled decision steps stay on the generic step line. Reads the
 * record only and never throws: malformed fields become null, `unknown` questions or an empty list.
 */
export function summarizeDecisionStep(step: StepRecord): DecisionStepSummary | null {
  if (step.kind !== 'step' || step.status !== 'completed') return null;
  const meta: unknown = step.meta;
  if (!plain(meta) || own(meta, 'integration') !== 'decision') return null;
  const op = own(meta, 'op');
  if (op !== 'decide' && op !== 'choose') return null;
  const output: unknown = step.output;
  const history = Array.isArray(step.attemptHistory) ? step.attemptHistory : [];
  const usages = history.map((attempt) => (plain(attempt) ? attempt.usage : undefined));
  const tokens = (field: 'inputTokens' | 'outputTokens'): number | null =>
    total(usages.map((usage) => (plain(usage) ? count(own(usage, field)) : null)));
  const reused = step.reusedFrom;
  // A fork-reused step made no attempts in this run, so the source run's tokens are not its usage.
  const usage = reused
    ? { attempts: 0, inputTokens: 0, outputTokens: 0 }
    : {
        attempts: typeof step.attempts === 'number' ? step.attempts : history.length,
        inputTokens: tokens('inputTokens'),
        outputTokens: tokens('outputTokens'),
      };
  const reuse = reused ? { reusedFrom: reused.runId } : {};
  const last = usages.at(-1);
  const lastUsage = plain(last) ? last : undefined;
  const lastModel = lastUsage ? own(lastUsage, 'model') : undefined;
  if (op === 'decide') {
    const answers = plain(output) ? own(output, 'answers') : undefined;
    return {
      op,
      // The latest attempt's usage is authoritative; `meta` is the fallback. A recorded `requested`
      // of null means the provider default, so only a missing model object falls back.
      provider:
        (lastUsage ? text(own(lastUsage, 'provider')) : null) ?? text(own(meta, 'provider')),
      requestedModel: plain(lastModel)
        ? text(own(lastModel, 'requested'))
        : text(own(meta, 'model')),
      servedModel: plain(output) ? text(own(output, 'model')) : null,
      questions: plain(answers)
        ? Object.keys(answers).map((name) => question(name, own(answers, name)))
        : [],
      ...reuse,
      usage,
    };
  }
  const chosen = plain(output) ? own(output, 'answer') : undefined;
  return {
    op,
    provider: lastUsage ? text(own(lastUsage, 'provider')) : null,
    requestedModel: plain(lastModel) ? text(own(lastModel, 'requested')) : null,
    servedModel: null,
    questions:
      typeof chosen === 'string' ? [{ name: 'answer', kind: 'choice', answer: chosen }] : [],
    ...reuse,
    usage,
  };
}
