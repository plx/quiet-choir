/**
 * Higher-order patterns typed against teams (ADR 0067 section 3): each takes the workflow context
 * and an options object whose `team` fills the slots its {@link defineTeam} declares. A team is
 * plain data of bound agents, so calls through a slot keep the step IDs, fingerprints and records
 * of the agent that fills it. Fill a team explicitly at the call site, or with
 * `ReviewTeam.from(ctx.roster)` where roster names equal slot names.
 *
 * @module
 */
import {
  defineTeam,
  z,
  type MapStepError,
  type Prompt,
  type RetryPolicy,
  type Settled,
  type TeamOf,
  type WorkflowContext,
} from '../index.js';

/** The slots {@link reviewRevise} needs: an `actor` that drafts and a `critic` that judges. */
export const ReviewTeam: ReturnType<typeof defineTeam<'actor' | 'critic'>> = defineTeam({
  actor: 'Produces and revises the draft.',
  critic: 'Judges the draft and returns feedback.',
});
/** The team record {@link reviewRevise} takes: `{ readonly actor: Agent; readonly critic: Agent }`. */
export type ReviewTeam = TeamOf<typeof ReviewTeam>;

const Review = z.object({ approved: z.boolean(), feedback: z.string() });

/** Options of {@link reviewRevise}. */
export interface ReviewReviseOptions {
  /** The agents filling the review slots. */
  readonly team: ReviewTeam;
  /** The draft to review first. */
  readonly draft: string;
  /** The most reviews to run; zero or fewer runs none and returns the draft unapproved. */
  readonly rounds: number;
  /**
   * A scope prefix for the loop's step IDs, so two loops in one workflow do not collide. Omitted,
   * the IDs are `review/<n>` and `revise/<n>` in the caller's scope.
   */
  readonly id?: string;
  /** Replacement prompts; each may return text or a rendered {@link Prompt}. */
  readonly prompts?: {
    /** The critic's prompt for `draft`. Default: `Review this draft: <draft>`. */
    readonly review?: (draft: string) => string | Prompt;
    /** The actor's prompt to revise `draft` with `feedback`. Default: `Revise <draft> using this feedback: <feedback>`. */
    readonly revise?: (draft: string, feedback: string) => string | Prompt;
  };
  /**
   * The retry policy of the critic's `review/<n>` and the actor's `revise/<n>` calls, as an agent
   * call's `retry`: policy outside step identity. Omitted, each call makes one attempt.
   */
  readonly retry?: RetryPolicy | undefined;
}

/** Result of {@link reviewRevise}. */
export interface ReviewReviseResult {
  /** Whether the critic approved a draft within the rounds. */
  readonly approved: boolean;
  /** The approved draft, or the last reviewed one when no round approved. */
  readonly draft: string;
}

/**
 * Review up to `rounds` times and revise after each rejection. Round `n` asks `team.critic` for
 * `{ approved, feedback }` as step `review/<n>` and, when rejected, asks `team.actor` for a new
 * draft as `revise/<n>`. Approval returns early, and the last round is not followed by an
 * unreviewed revision, so exhaustion returns `approved: false` with the last reviewed draft as data
 * rather than throwing.
 *
 * @param ctx - The workflow context; with `id`, the loop runs under `ctx.scope(id, ...)`.
 * @param options - The team, the first draft, the round limit, an optional scope, prompts and retry
 * policy.
 * @returns Whether a draft was approved, and that draft or the last reviewed one.
 */
export async function reviewRevise(
  ctx: WorkflowContext,
  options: ReviewReviseOptions,
): Promise<ReviewReviseResult> {
  const { team, rounds, id, retry } = options;
  const review = options.prompts?.review ?? ((draft) => `Review this draft: ${draft}`);
  const revise =
    options.prompts?.revise ??
    ((draft, feedback) => `Revise ${draft} using this feedback: ${feedback}`);
  const loop = async (): Promise<ReviewReviseResult> => {
    let draft = options.draft;
    for (let round = 0; round < rounds; round++) {
      const verdict = await team.critic.value(`review/${String(round)}`, {
        prompt: review(draft),
        schema: Review,
        retry,
      });
      if (verdict.approved) return { approved: true, draft };
      if (round + 1 < rounds) {
        draft = await team.actor.value(`revise/${String(round)}`, {
          prompt: revise(draft, verdict.feedback),
          retry,
        });
      }
    }
    return { approved: false, draft };
  };
  return id === undefined ? loop() : ctx.scope(id, loop);
}

/** The slot {@link tolerantPanel} needs: one `panelist` that answers every item. */
export const PanelTeam: ReturnType<typeof defineTeam<'panelist'>> = defineTeam({
  panelist: 'Answers one panel item.',
});
/** The team record {@link tolerantPanel} takes: `{ readonly panelist: Agent }`. */
export type PanelTeam = TeamOf<typeof PanelTeam>;

/** Options of {@link tolerantPanel}. */
export interface TolerantPanelOptions<T, O = string> {
  /** The map ID; each item's answer is step `<id>/<key or index>/answer`. */
  readonly id: string;
  /** The agent filling the panel slot. */
  readonly team: PanelTeam;
  /** The panel items, one call each. */
  readonly items: readonly T[];
  /**
   * The map's `key`: a stable ID for each item, valid and unique in this panel, so each answer is
   * step `<id>/<key>/answer`. Omitted, items are keyed by index as `<id>/<index>/answer`.
   */
  readonly key?: ((item: T, index: number) => string) | undefined;
  /** The panelist's prompt for one item. */
  readonly prompt: (item: T, index: number) => string | Prompt;
  /** The local mapper bound, as for `ctx.map`. */
  readonly concurrency: number;
  /** A schema for each answer; omitted, answers are text. */
  readonly schema?: z.ZodType<O>;
  /**
   * The panelist call's retry policy, as an agent call's `retry`: policy outside step identity and
   * the map's fingerprint. A vote settles failed only after its retries are spent; omitted, each
   * call makes one attempt, so one transient or schema failure is a saved failed vote.
   */
  readonly retry?: RetryPolicy | undefined;
  /**
   * A revision for dependencies the items and the mapper source do not show, such as the `prompt`
   * function or the `schema`, as `MapOptions.version` for `ctx.map`. Change it when such a
   * dependency changes in a way that should not reuse the settled votes.
   */
  readonly version?: string | undefined;
}

/**
 * One item's outcome in {@link TolerantPanelResult.outcomes}: the settled answer or saved failure,
 * with the item it belongs to. Narrow on `ok` to read `value` or `error`.
 */
export type TolerantPanelOutcome<T, O = string> = Settled<O, MapStepError> & {
  /** The panel item. */
  readonly item: T;
  /** The item's index in `items`. */
  readonly index: number;
};

/** Result of {@link tolerantPanel}. */
export interface TolerantPanelResult<O = string, T = unknown> {
  /** Whether more than half of the items were answered. */
  readonly quorum: boolean;
  /** The successful answers, in item order. */
  readonly answers: O[];
  /** How many items failed; their failures are saved, so a resume does not retry them. */
  readonly failed: number;
  /**
   * Every item's settled outcome, failures included, in item order, so each answer and failure
   * names the item it belongs to.
   */
  readonly outcomes: readonly TolerantPanelOutcome<T, O>[];
}

/**
 * Ask `team.panelist` about every item and decide a quorum over the answers that succeeded. The
 * calls run under `ctx.map(id, items, { concurrency, key, onError: 'return' })`, so each whole item
 * outcome, failure included, is journaled once the call's `retry` policy is spent: a failed vote
 * stays failed on resume instead of being retried into a different quorum. Cancellation,
 * configuration and checkpoint failures still reject rather than becoming votes. The settled map
 * fingerprints the items, keys and mapper source but not the `prompt` function or the `schema`; set
 * `version` to refuse replay after changing them.
 *
 * @param ctx - The workflow context.
 * @param options - The map ID, the team, the items, the prompt, the map's concurrency and an
 * optional `key`, `retry` and `version`.
 * @returns The quorum, the text answers in item order, the failed count and every item's outcome.
 */
export function tolerantPanel<T>(
  ctx: WorkflowContext,
  options: TolerantPanelOptions<T> & { readonly schema?: undefined },
): Promise<TolerantPanelResult<string, T>>;
/**
 * Ask `team.panelist` about every item with a schema for each answer, and decide a quorum over the
 * answers that succeeded; see the text overload for the journaling.
 *
 * @param ctx - The workflow context.
 * @param options - The map ID, the team, the items, the prompt, the concurrency and the schema.
 * @returns The quorum, the parsed answers in item order, the failed count and every item's outcome.
 */
export function tolerantPanel<T, O>(
  ctx: WorkflowContext,
  options: TolerantPanelOptions<T, O> & { readonly schema: z.ZodType<O> },
): Promise<TolerantPanelResult<O, T>>;
/**
 * Ask `team.panelist` about every item with options whose `schema` may or may not be set, such as a
 * value typed as {@link TolerantPanelOptions}; see the text overload for the journaling. The two
 * narrower overloads give a precise answer type when the schema is known at the call.
 *
 * @param ctx - The workflow context.
 * @param options - The map ID, the team, the items, the prompt, the concurrency and an optional schema.
 * @returns The quorum, the answers in item order (parsed when `schema` is set, else text), the
 * failed count and every item's outcome.
 */
export function tolerantPanel<T, O>(
  ctx: WorkflowContext,
  options: TolerantPanelOptions<T, O>,
): Promise<TolerantPanelResult<O | string, T>>;
export async function tolerantPanel<T, O>(
  ctx: WorkflowContext,
  options: TolerantPanelOptions<T, O>,
): Promise<TolerantPanelResult<O | string, T>> {
  const { id, team, prompt, concurrency, key, schema, retry, version } = options;
  // Map and pair outcomes over a copy, not `items`, which the caller may mutate while the map runs.
  const list = [...options.items];
  const answer = (item: T, index: number): Promise<O | string> =>
    schema === undefined
      ? team.panelist.value('answer', { prompt: prompt(item, index), retry })
      : team.panelist.value('answer', { prompt: prompt(item, index), schema, retry });
  const results: Settled<O | string, MapStepError>[] = await ctx.map(
    id,
    list,
    { concurrency, key, onError: 'return', version },
    answer,
  );
  const outcomes = results.map((result, index) => ({ ...result, item: list[index] as T, index }));
  const answers = results.flatMap((result) => (result.ok ? [result.value] : []));
  return {
    quorum: answers.length > results.length / 2,
    answers,
    failed: results.length - answers.length,
    outcomes,
  };
}
