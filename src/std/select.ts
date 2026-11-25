/**
 * Selection patterns, re-exported from `std.patterns`:
 *
 * - {@link tournament} has entrants propose designs from different philosophies, an anonymous
 *   judge panel score every proposal on a rubric, and a synthesizer build the final design on the
 *   winner with the best ideas of the rest.
 * - {@link rank} has one agent pick the `pick` items that rank highest on a criterion.
 * - {@link route} has one agent choose the route (a branch, a slot, a tier) that fits a subject.
 * - {@link classify} labels items from a fixed taxonomy in batches and counts the labels.
 *
 * Every pattern takes a required `id` and records all of its steps under it; each pattern's TSDoc
 * lists the exact step IDs and its team slot or slots. Answers are constrained to the keys the
 * pattern offers (`z.enum` of letters, item keys, routes or labels), and the arithmetic (means,
 * counts, ordering, caps) is done in code. A failed agent of a fan-out is journaled and becomes
 * data, so a resume replays the same decision, and results report failures and a `status`.
 * The default prompts are built with `std.text.brief` and name the safe default for an undecided
 * agent (score low what a proposal does not show; leave an item unlabeled; take the fallback).
 *
 * ```ts
 * import * as std from 'quiet-choir/std';
 *
 * const tagged = await std.patterns.classify(ctx, {
 *   id: 'triage',
 *   team: { tagger: ctx.roster.Clerk },
 *   items: issues,
 *   labels: { bug: 'Something is broken.', feature: 'A request for new behavior.' },
 * });
 * const urgent = await std.patterns.rank(ctx, {
 *   id: 'urgent',
 *   team: { ranker: ctx.roster.Judge },
 *   items: tagged.assignments,
 *   pick: 5,
 *   criterion: 'How urgently it needs attention.',
 * });
 * ```
 *
 * @module
 */
import {
  defineTeam,
  z,
  type JsonValue,
  type MapStepError,
  type Prompt,
  type Settled,
  type TeamOf,
  type WorkflowContext,
} from '../index.js';
import { assertUnique, canonicalJson } from './data.js';
import { json } from './exec.js';
import { design, designRubric, type Lens } from './lenses.js';
import {
  keyed,
  nonEmpty,
  positiveInt,
  settledMap,
  statusOf,
  type CallDefaults,
} from './pattern-kit.js';
import { brief, bullets, fence, promptText } from './text.js';
import { Proposal, Rationale, rubric } from './types.js';

/** A settled-map item that carries its key and the rendered prompt the mapper sends. */
interface PromptRecord {
  readonly key: string;
  readonly prompt: string;
}

/**
 * A judge map item: its key, its rendered prompt, and what the reply schema is built from (the
 * letters and the rubric), so the map fingerprint covers the schema even under a custom prompt.
 */
interface JudgeRecord<K extends string> extends PromptRecord {
  readonly letters: readonly [string, ...string[]];
  readonly rubric: Readonly<Record<K, string>>;
}

/** A `### title` part of a default prompt's context, below its `## Context` heading. */
function part(title: string, body: string): string {
  return `### ${title}\n\n${body}`;
}

/** Round to two decimals, for reported means. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * How an item appears in a default prompt: a string as written, plain JSON as canonical JSON (keys
 * sorted, so the prompt does not depend on the key order a journaled value comes back with), and
 * anything else as `JSON.stringify` gives it.
 */
function describeItem(item: unknown): string {
  if (typeof item === 'string') return item;
  try {
    return canonicalJson(item as JsonValue);
  } catch {
    // The standard signature says `string`, but it returns undefined for undefined and functions.
    const text = JSON.stringify(item) as string | undefined;
    return text ?? String(item);
  }
}

/** An item as a ranker or tagger sees it: the key it answers with and the item's description. */
export interface ItemText {
  /** The key the agent answers with. */
  readonly key: string;
  /** The item's description, from the pattern's `describe` option. */
  readonly text: string;
}

/** A bulleted `key: text` line per item. */
function itemLines(entries: readonly ItemText[]): string {
  return bullets(entries.map(({ key, text }) => `${key}: ${text}`));
}

/** A bulleted `key: definition` line per entry of a record such as a taxonomy or route table. */
function definitionLines(record: Readonly<Record<string, string>>): string {
  return bullets(Object.entries(record).map(([key, text]) => `${key}: ${text}`));
}

/** An item's own string `key` member, as std results such as {@link Assignment} carry, if any. */
function ownKey(item: unknown): string | undefined {
  if (typeof item !== 'object' || item === null) return undefined;
  const value: unknown = (item as { readonly key?: unknown }).key;
  return typeof value === 'string' ? value : undefined;
}

/**
 * The keys a ranker or tagger answers with: `key(item)`; without `key`, the item's own string
 * `key` member, else its 1-based position as text. They need not be step-ID segments, since they
 * only appear in prompts and enums.
 */
function itemKeys<T>(items: readonly T[], key: ((item: T) => string) | undefined): string[] {
  const keys = items.map((item, index) =>
    key === undefined ? (ownKey(item) ?? String(index + 1)) : key(item),
  );
  for (const value of keys) {
    if (typeof value !== 'string' || value.trim() === '')
      throw new TypeError(`Item keys must be nonblank strings; got ${JSON.stringify(value)}.`);
  }
  assertUnique(keys, 'item key');
  return keys;
}

/** Validate a record of definitions (labels, routes) and return its keys as a nonempty tuple. */
function definitionKeys<K extends string>(
  name: string,
  record: Readonly<Record<K, string>>,
): readonly [K, ...K[]] {
  const keys = nonEmpty(name, Object.keys(record) as K[]);
  for (const key of keys) {
    const text: unknown = record[key];
    if (key.trim() === '' || typeof text !== 'string' || text.trim() === '') {
      throw new TypeError(
        `${name} must map nonblank keys to nonblank descriptions; check ${JSON.stringify(key)}.`,
      );
    }
  }
  return keys;
}

// ---------------------------------------------------------------------------------------------
// tournament
// ---------------------------------------------------------------------------------------------

/** The slots {@link tournament} needs: a `proposer`, a `judge` and a `synthesizer`. */
export const TournamentTeam: ReturnType<typeof defineTeam<'proposer' | 'judge' | 'synthesizer'>> =
  defineTeam({
    proposer:
      'Writes one design proposal in character for one design philosophy, committing to it instead of hedging. Fill with a high-effort read-only entry such as std.roles.Planner.',
    judge:
      'Scores every anonymous proposal on the rubric, citing specifics, and scores low what a proposal does not show. Fill with std.roles.Judge.',
    synthesizer:
      'Writes the final design on the winning proposal, grafting compatible ideas from the others. Fill with a high-effort entry such as std.roles.Planner.',
  });
/**
 * The team record {@link tournament} takes:
 * `{ readonly proposer: Agent; readonly judge: Agent; readonly synthesizer: Agent }`.
 */
export type TournamentTeam = TeamOf<typeof TournamentTeam>;

/** The criteria of the default tournament rubric, `std.lenses.designRubric`. */
export type DesignCriterion = keyof typeof designRubric;

/** One successful proposal of a {@link tournament}. */
export interface TournamentEntry {
  /** The anonymous letter the judges saw: A, B, ... over the successful proposals, in entrant order. */
  readonly letter: string;
  /** The entrant's key: its lens key, with a `.2`, `.3`, ... suffix when the key repeats. */
  readonly entrant: string;
  /** The proposal. */
  readonly proposal: Proposal;
}

/** One entry's place in a {@link tournament}'s standings. */
export interface Standing<K extends string = string> {
  /** The entry's anonymous letter. */
  readonly letter: string;
  /** The entrant's key. */
  readonly entrant: string;
  /** The proposal's title. */
  readonly title: string;
  /**
   * The mean over the judges of each judge's mean criterion score, from 1 to 10, rounded to two
   * decimals; null when no judge scored the entry.
   */
  readonly score: number | null;
  /** Each criterion's mean score over the judges, rounded to two decimals; null without a score. */
  readonly criteria: Readonly<Record<K, number>> | null;
  /** How many judges scored the entry. */
  readonly votes: number;
  /** The entry's strongest ideas as the judges named them, in judge order. */
  readonly bestIdeas: string[];
}

/** Replacement prompts of a {@link tournament}; each returns text or a rendered {@link Prompt}. */
export interface TournamentPrompts<K extends string = DesignCriterion> {
  /** The proposer's prompt for one entrant. */
  readonly propose?: ((entrant: Lens, brief: string) => string | Prompt) | undefined;
  /**
   * The prompt of judge `seat` (from 0 to `seats - 1`) over the entries, in the order that judge
   * sees them. Show only the letters and proposals: the entrant keys would break anonymity.
   */
  readonly judge?:
    | ((
        brief: string,
        entries: readonly TournamentEntry[],
        rubric: Readonly<Record<K, string>>,
        seat: number,
        seats: number,
      ) => string | Prompt)
    | undefined;
  /** The synthesizer's prompt for the winner, given the standings (best first) and the dissent. */
  readonly synthesize?:
    | ((
        brief: string,
        winner: TournamentEntry,
        standings: readonly Standing<K>[],
        dissent: readonly string[],
      ) => string | Prompt)
    | undefined;
}

/** Options of {@link tournament}. */
export interface TournamentOptions<K extends string = DesignCriterion> {
  /** The scope for every step this pattern records. */
  readonly id: string;
  /** The agents filling the `proposer`, `judge` and `synthesizer` slots. */
  readonly team: TournamentTeam;
  /**
   * The design problem: what to design, its requirements and constraints, and any background the
   * entrants and judges need.
   */
  readonly brief: string;
  /**
   * The entrants' design philosophies, one proposal each, such as custom `std.lenses.lens` values;
   * defaults to `std.lenses.design`. At most 26, since the judges see each as a letter.
   */
  readonly entrants?: readonly Lens[] | undefined;
  /** How many judges score every proposal, a positive integer; defaults to 3. */
  readonly judges?: number | undefined;
  /**
   * The scoring criteria, each key mapped to what a 1 to 10 score on it measures; defaults to
   * `std.lenses.designRubric` (fitness, simplicity, evolvability, operability).
   */
  readonly rubric?: Readonly<Record<K, string>> | undefined;
  /** The fewest successful proposals the judging needs, else the tournament aborts; defaults to 2. */
  readonly minEntrants?: number | undefined;
  /**
   * Whether the synthesizer writes the final design from the winner and the others' best ideas;
   * defaults to true. When false, `design` is the winning proposal's own design.
   */
  readonly synthesize?: boolean | undefined;
  /**
   * How far below the panel's mean score for the winner (on the 1 to 10 scale) a judge's own score
   * for it must fall to be reported as dissent; defaults to 3.
   */
  readonly dissentGap?: number | undefined;
  /** Replacement prompts for the proposers, the judges and the synthesizer. */
  readonly prompts?: TournamentPrompts<K> | undefined;
  /** How many proposers or judges run at once; defaults to 4. */
  readonly concurrency?: number | undefined;
  /** A revision for prompts and schemas the settled maps' fingerprints do not show. */
  readonly version?: string | undefined;
  /** Options applied to every agent call (placement, retry, deadlines). */
  readonly calls?: CallDefaults | undefined;
}

/** Result of {@link tournament}. */
export interface TournamentResult<K extends string = DesignCriterion> {
  /** The best-scoring entry, ties going to the earlier entrant; null when the tournament aborted. */
  readonly winner: TournamentEntry | null;
  /** Every successful proposal, in entrant order. */
  readonly entries: TournamentEntry[];
  /** Every successful proposal's standing, best first; unscored entries last. */
  readonly standings: Standing<K>[];
  /**
   * The final design in Markdown: the synthesizer's, or the winner's own when `synthesize` is
   * false; null when the tournament aborted.
   */
  readonly design: string | null;
  /**
   * One line per judge whose score for the winner fell at least `dissentGap` below the panel's
   * mean, with that judge's rationale; also passed to the synthesizer.
   */
  readonly dissent: string[];
  /** The keys of the entrants whose proposal call failed. */
  readonly failedEntrants: string[];
  /** How many judge calls failed. */
  readonly failedJudges: number;
  /**
   * `'aborted'` when fewer than `minEntrants` proposals succeeded or every judge failed;
   * `'degraded'` when a proposer or judge failed; else `'complete'`.
   */
  readonly status: 'complete' | 'degraded' | 'aborted';
}

/** One judge's score sheet for one proposal, as parsed. */
interface Sheet<K extends string> {
  readonly entrant: string;
  readonly scores: Readonly<Record<K, number>>;
  readonly rationale: string;
  readonly bestIdea: string;
}

/** One judge's reply: a sheet per proposal. */
interface Sheets<K extends string> {
  readonly sheets: readonly Sheet<K>[];
}

/** The judge reply schema: one rubric score sheet per proposal, its letter constrained. */
function sheetsSchema<K extends string>(
  letters: readonly [string, ...string[]],
  criteria: Readonly<Record<K, string>>,
): z.ZodType<Sheets<K>> {
  const scored = rubric(criteria);
  const sheet = z.object({
    entrant: z.enum(letters).describe('The letter of the proposal this sheet scores.'),
    scores: scored.shape.scores,
    rationale: scored.shape.rationale,
    bestIdea: z
      .string()
      .min(1)
      .describe('The single strongest idea in this proposal, even if it scores low overall.'),
  });
  return z.object({
    sheets: z
      .array(sheet)
      .min(1)
      .describe('One score sheet per proposal, each letter exactly once.'),
  }) as unknown as z.ZodType<Sheets<K>>;
}

/** The default proposer prompt: the entrant's philosophy, the brief, and what a proposal holds. */
function proposePrompt(entrant: Lens, designBrief: string): string {
  return brief({
    task: `Propose a design for the brief below, as one entrant of a design tournament. ${entrant.charter}`,
    context: designBrief,
    guidance: [
      'Commit to your philosophy instead of hedging toward a balanced design; other entrants argue for the other philosophies.',
      'Be concrete: name the components, their interfaces and the data each owns, and walk one representative request through the design.',
      'State honestly what the design gives up (tradeoffs) and where it is most likely to fail (risks).',
      'Independent judges will score the proposals anonymously against the brief, so show how the design meets each of its requirements, and do not name your philosophy or refer to the other entrants.',
    ],
    output:
      'One proposal: a short title, the idea in a few sentences, the full design in Markdown, its tradeoffs and its risks.',
  });
}

/**
 * A proposal with its members in schema order, so prompt text does not depend on the key order a
 * journaled value comes back with.
 */
function ordered(proposal: Proposal): Proposal {
  const { title, summary, design: text, tradeoffs, risks } = proposal;
  return { title, summary, design: text, tradeoffs, risks };
}

/** The default judge prompt: the brief, the rubric and the anonymous proposals. */
function judgePrompt<K extends string>(
  designBrief: string,
  entries: readonly TournamentEntry[],
  criteria: Readonly<Record<K, string>>,
): string {
  const proposals = entries.map(({ letter, proposal }) => ({ letter, ...ordered(proposal) }));
  return brief({
    task: 'Score every proposal below against the design brief, as one judge of an independent panel. The proposals are anonymous and labeled by letter.',
    context: [
      part('Brief', designBrief),
      part('Rubric', definitionLines(criteria)),
      part('Proposals', fence(json(proposals), 'json')),
    ].join('\n\n'),
    guidance: [
      'Judge each proposal on its own merits against the brief and the rubric, not by your taste, its letter or its position in the list.',
      'Score every criterion from 1 (poor) to 10 (excellent), and cite the specifics of the proposal that justify the scores.',
      'When a proposal does not show how it meets a criterion, score that criterion low: giving no credit for what is not shown is the safe default.',
      "Name each proposal's single strongest idea, even when you score the proposal low overall.",
    ],
    output:
      'One score sheet per proposal, every letter exactly once: its letter, a score per criterion, a rationale citing specifics, and its best idea.',
  });
}

/** The default synthesizer prompt: the brief, the winner, the others' ideas and the dissent. */
function synthesizePrompt(
  designBrief: string,
  winner: TournamentEntry,
  standings: readonly Standing[],
  dissent: readonly string[],
): string {
  const others = standings
    .filter((standing) => standing.letter !== winner.letter && standing.bestIdeas.length > 0)
    .map(({ title, score, bestIdeas }) => ({ proposal: title, score, bestIdeas }));
  const context = [
    part('Brief', designBrief),
    part('Winning proposal', fence(json(ordered(winner.proposal)), 'json')),
    part("The other proposals' best ideas", fence(json(others), 'json')),
  ];
  if (dissent.length > 0) context.push(part('Dissent', bullets(dissent)));
  const guidance = [
    'Keep the winning design as the skeleton; do not average the proposals into a compromise.',
    'For each idea from another proposal, graft it in when it is compatible and improves the design, or reject it with one sentence on why.',
  ];
  if (dissent.length > 0)
    guidance.push(
      'Address each dissenting judgement: fix the weakness it names, or say why it does not apply.',
    );
  return brief({
    task: 'Write the final design for the brief below. Use the winning proposal of a design tournament as the skeleton and graft in the compatible ideas the judges found in the other proposals.',
    context: context.join('\n\n'),
    guidance,
    output:
      'The design document in Markdown: the decision, the components and their interfaces, the data flow, failure handling, the accepted tradeoffs, the grafted and rejected ideas, and open questions.',
  });
}

/** The entries starting at `seat`, wrapping around, so each judge sees a different order. */
function shifted<T>(items: readonly T[], seat: number): T[] {
  const start = items.length === 0 ? 0 : seat % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

/** One judge's scoring of one entry, kept for the dissent check. */
interface SeatScore {
  readonly seat: number;
  readonly mean: number;
  readonly rationale: string;
}

/** The running tally of one entry. */
interface EntryTally<K extends string> {
  readonly entry: TournamentEntry;
  readonly sums: Record<K, number>;
  readonly seats: SeatScore[];
  readonly bestIdeas: string[];
}

/** The mean of `values`; NaN for none. */
function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** The exact (unrounded) score of a tallied entry, or null without a vote. */
function exactScore<K extends string>(tallied: EntryTally<K>): number | null {
  return tallied.seats.length === 0 ? null : mean(tallied.seats.map((seat) => seat.mean));
}

/** Order scored entries best first and unscored ones last; equal scores keep entrant order. */
function byScore(
  a: { readonly score: number | null },
  b: { readonly score: number | null },
): number {
  if (a.score === null) return b.score === null ? 0 : 1;
  if (b.score === null) return -1;
  // Equal means can differ in the last bits when summed in a different order: treat them as tied.
  return Math.abs(b.score - a.score) < 1e-9 ? 0 : b.score - a.score;
}

/** A standing for a tallied entry. */
function standingOf<K extends string>(tallied: EntryTally<K>, keys: readonly K[]): Standing<K> {
  const { entry, seats, sums, bestIdeas } = tallied;
  const score = exactScore(tallied);
  const votes = seats.length;
  const criteria =
    votes === 0
      ? null
      : (Object.fromEntries(keys.map((key) => [key, round2(sums[key] / votes)])) as Record<
          K,
          number
        >);
  return {
    letter: entry.letter,
    entrant: entry.entrant,
    title: entry.proposal.title,
    score: score === null ? null : round2(score),
    criteria,
    votes,
    bestIdeas: bestIdeas.slice(),
  };
}

/** The standings of unscored entries. */
function unscored<K extends string>(entries: readonly TournamentEntry[]): Standing<K>[] {
  return entries.map((entry) => ({
    letter: entry.letter,
    entrant: entry.entrant,
    title: entry.proposal.title,
    score: null,
    criteria: null,
    votes: 0,
    bestIdeas: [],
  }));
}

/**
 * Run a design tournament. Each entrant (a design philosophy, `std.lenses.design` by default)
 * writes a `std.types.Proposal` for the brief; the successful proposals are lettered A, B, ... in
 * entrant order; every judge scores every proposal on the rubric without seeing the entrants (each
 * judge sees the proposals in a different rotation, to offset position bias); the scores are
 * tallied in code; and the synthesizer writes the final design on the winner, grafting the best
 * ideas the judges named in the other proposals and answering the dissent.
 *
 * Step IDs:
 *
 * - `<id>/propose/<entrant>/proposal`: the settled map `<id>/propose`, keyed by entrant key.
 * - `<id>/judge/<n>/scores`: the settled map `<id>/judge`, judge `n` from 0 to `judges - 1`.
 * - `<id>/synthesize`: the synthesizer's text, unless `synthesize` is false or the tournament
 *   aborted.
 *
 * Team slots: `proposer` (a high-effort read-only entry such as `std.roles.Planner`), `judge`
 * (`std.roles.Judge`) and `synthesizer` (`std.roles.Planner`).
 *
 * The tally: a judge's score for an entry is the mean of its criterion scores; an entry's score is
 * the mean of its judges' scores; the highest score wins and ties go to the earlier entrant. A
 * judge sheet for a letter the judge already scored is ignored, and a letter a judge left out
 * counts as that judge's missing vote; both are logged. A failed proposer or judge is journaled
 * and reported, and a resume does not retry it. The tournament aborts, returning data rather than
 * throwing, when fewer than `minEntrants` proposals succeed (no judge runs) or every judge fails.
 * The synthesizer is a single required call: its failure throws, and a resume retries it.
 *
 * The default judge prompt names the safe default: no credit for what a proposal does not show.
 * Each map item carries its rendered prompt (and a judge item the letters and rubric its schema is
 * built from), so a prompt or rubric change is detected on resume; set `version` when a change the
 * items do not show should not reuse completed calls.
 *
 * @typeParam K - The rubric's criterion keys.
 * @param ctx - The workflow context the team was bound from.
 * @param options - The scope, the team, the brief, and optional entrants, judges, rubric and
 * limits.
 * @returns The winner, every entry, the standings, the final design, the dissent, the failures and
 * the status.
 * @throws TypeError - Before any effect, when a team slot is not filled, `brief` is blank,
 * `entrants` is empty or longer than 26, `judges`, `minEntrants` or `concurrency` is not a positive
 * integer, `minEntrants` exceeds the entrants, `dissentGap` is not a positive number, or the rubric
 * is empty or maps a blank key or description.
 */
export async function tournament<K extends string = DesignCriterion>(
  ctx: WorkflowContext,
  options: TournamentOptions<K>,
): Promise<TournamentResult<K>> {
  const designBrief = options.brief;
  if (typeof designBrief !== 'string' || designBrief.trim() === '')
    throw new TypeError('brief must be a nonblank string.');
  const entrants = nonEmpty('entrants', options.entrants ?? design).slice();
  if (entrants.length > 26)
    throw new TypeError(`entrants must hold at most 26 lenses; got ${String(entrants.length)}.`);
  const judges = positiveInt('judges', options.judges ?? 3);
  const minEntrants = positiveInt('minEntrants', options.minEntrants ?? 2);
  if (minEntrants > entrants.length) {
    throw new TypeError(
      `minEntrants (${String(minEntrants)}) exceeds the number of entrants (${String(entrants.length)}).`,
    );
  }
  const dissentGap = options.dissentGap ?? 3;
  if (typeof dissentGap !== 'number' || !Number.isFinite(dissentGap) || dissentGap <= 0)
    throw new TypeError(`dissentGap must be a positive number; got ${String(dissentGap)}.`);
  const criteria = (options.rubric ?? designRubric) as Readonly<Record<K, string>>;
  // Validates the rubric (nonempty, nonblank keys and descriptions) before any effect.
  rubric(criteria);
  const keys = definitionKeys('rubric', criteria);
  const map = settledMap<PromptRecord>(options);
  const judgeMap = settledMap<JudgeRecord<K>>(options);
  const team = TournamentTeam.from(options.team);
  const { calls, prompts } = options;
  const propose = prompts?.propose ?? proposePrompt;
  const judge = prompts?.judge ?? judgePrompt;
  const synthesize = prompts?.synthesize ?? synthesizePrompt;

  return ctx.scope(options.id, async (): Promise<TournamentResult<K>> => {
    const entrantKeys = keyed(entrants, (lens) => lens.key);
    const proposeRecords: PromptRecord[] = entrantKeys.map(({ key, item }) => ({
      key,
      prompt: promptText(propose(item, designBrief)),
    }));
    const proposals: Settled<Proposal, MapStepError>[] = await ctx.map(
      'propose',
      proposeRecords,
      map,
      (record) =>
        team.proposer.value('proposal', { ...calls, prompt: record.prompt, schema: Proposal }),
    );
    const entries: TournamentEntry[] = [];
    const failedEntrants: string[] = [];
    const proposalErrors: { entrant: string; error: string }[] = [];
    for (const { key, index } of entrantKeys) {
      const outcome = proposals[index];
      if (outcome === undefined) throw new Error(`Missing settled result for entrant ${key}.`);
      if (outcome.ok) {
        const letter = String.fromCharCode(65 + entries.length);
        entries.push({ letter, entrant: key, proposal: ordered(outcome.value) });
      } else {
        failedEntrants.push(key);
        proposalErrors.push({ entrant: key, error: outcome.error.message });
      }
    }
    const aborted = (failedJudges: number, standings: Standing<K>[]): TournamentResult<K> => ({
      winner: null,
      entries,
      standings,
      design: null,
      dissent: [],
      failedEntrants,
      failedJudges,
      status: 'aborted',
    });
    if (entries.length < minEntrants) {
      ctx.log(
        `Tournament aborted: ${String(entries.length)} of ${String(entrants.length)} proposals succeeded, fewer than minEntrants (${String(minEntrants)}).`,
        { failures: proposalErrors },
      );
      return aborted(0, unscored(entries));
    }
    if (proposalErrors.length > 0) {
      ctx.log(
        `${String(proposalErrors.length)} of ${String(entrants.length)} proposals failed; the tournament continues without them.`,
        { failures: proposalErrors },
      );
    }

    const letters = nonEmpty(
      'letters',
      entries.map((entry) => entry.letter),
    );
    const judgeRecords: JudgeRecord<K>[] = Array.from({ length: judges }, (_unused, seat) => ({
      key: String(seat),
      prompt: promptText(judge(designBrief, shifted(entries, seat), criteria, seat, judges)),
      letters,
      rubric: criteria,
    }));
    const verdicts: Settled<Sheets<K>, MapStepError>[] = await ctx.map(
      'judge',
      judgeRecords,
      judgeMap,
      (record) =>
        team.judge.value('scores', {
          ...calls,
          prompt: record.prompt,
          schema: sheetsSchema(record.letters, record.rubric),
        }),
    );

    const tallies = new Map<string, EntryTally<K>>(
      entries.map((entry) => [
        entry.letter,
        {
          entry,
          sums: Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>,
          seats: [],
          bestIdeas: [],
        },
      ]),
    );
    const judgeErrors: { judge: number; error: string }[] = [];
    verdicts.forEach((verdict, seat) => {
      if (!verdict.ok) {
        judgeErrors.push({ judge: seat, error: verdict.error.message });
        return;
      }
      const seen = new Set<string>();
      const repeated: string[] = [];
      for (const sheet of verdict.value.sheets) {
        const tallied = tallies.get(sheet.entrant);
        if (tallied === undefined) continue;
        if (seen.has(sheet.entrant)) {
          repeated.push(sheet.entrant);
          continue;
        }
        seen.add(sheet.entrant);
        for (const key of keys) tallied.sums[key] += sheet.scores[key];
        const scores = keys.map((key) => sheet.scores[key]);
        tallied.seats.push({ seat, mean: mean(scores), rationale: sheet.rationale });
        tallied.bestIdeas.push(sheet.bestIdea);
      }
      const omitted = letters.filter((letter) => !seen.has(letter));
      if (repeated.length > 0 || omitted.length > 0) {
        ctx.log(
          `Judge ${String(seat)} scored some proposals twice or not at all; repeats are ignored and omissions count as missing votes.`,
          { repeated, omitted },
        );
      }
    });
    const failedJudges = judgeErrors.length;
    if (failedJudges === judges) {
      ctx.log(`Tournament aborted: all ${String(judges)} judges failed.`, {
        failures: judgeErrors,
      });
      return aborted(failedJudges, unscored(entries));
    }
    if (failedJudges > 0) {
      ctx.log(
        `${String(failedJudges)} of ${String(judges)} judges failed; the tally uses the others.`,
        { failures: judgeErrors },
      );
    }

    const ranked = [...tallies.values()]
      .map((tallied) => ({ tallied, score: exactScore(tallied) }))
      .sort(byScore);
    const standings = ranked.map(({ tallied }) => standingOf(tallied, keys));
    const top = ranked[0];
    const panelMean = top === undefined ? null : top.score;
    if (top === undefined || panelMean === null)
      throw new Error('A tournament with a successful judge has a scored entry.');
    const winner = top.tallied.entry;
    const dissent = top.tallied.seats
      .filter((seat) => round2(panelMean - seat.mean) >= dissentGap)
      .map(
        (seat) =>
          `Judge ${String(seat.seat)} scored the winner ${String(round2(seat.mean))}/10 against the panel mean ${String(round2(panelMean))}: ${seat.rationale}`,
      );
    ctx.log(
      `Tournament standings: ${standings.map((standing) => `${standing.letter} (${standing.entrant}) ${standing.score === null ? 'unscored' : String(standing.score)}`).join(', ')}.`,
    );
    const finalDesign =
      options.synthesize === false
        ? winner.proposal.design
        : await team.synthesizer.value('synthesize', {
            ...calls,
            prompt: synthesize(designBrief, winner, standings, dissent),
          });
    return {
      winner,
      entries,
      standings,
      design: finalDesign,
      dissent,
      failedEntrants,
      failedJudges,
      status: statusOf(failedEntrants.length + failedJudges),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// rank
// ---------------------------------------------------------------------------------------------

/** The slot {@link rank} needs: one `ranker` that chooses the top items. */
export const RankTeam: ReturnType<typeof defineTeam<'ranker'>> = defineTeam({
  ranker:
    'Chooses the items that rank highest on one criterion, best first, citing what decided it. Fill with a judging entry such as std.roles.Judge, or std.roles.Reviewer for code.',
});
/** The team record {@link rank} takes: `{ readonly ranker: Agent }`. */
export type RankTeam = TeamOf<typeof RankTeam>;

/** Options of {@link rank}. */
export interface RankOptions<T> {
  /** The scope for every step this pattern records. */
  readonly id: string;
  /** The agent filling the `ranker` slot. */
  readonly team: RankTeam;
  /** The candidates. */
  readonly items: readonly T[];
  /**
   * The unique, nonblank key the ranker answers with for an item, such as an issue number.
   * Defaults to the item's own string `key` member, as std results such as {@link Assignment}
   * carry, else its 1-based position.
   */
  readonly key?: ((item: T) => string) | undefined;
  /** How many items to select, a positive integer. */
  readonly pick: number;
  /** What ranks an item higher, such as `How urgently it needs attention.` */
  readonly criterion: string;
  /**
   * An item's description for the ranker; defaults to a string item itself, else its JSON with
   * sorted keys.
   */
  readonly describe?: ((item: T) => string) | undefined;
  /** Replaces the default prompt; it receives every item's key and description. */
  readonly prompt?:
    | ((entries: readonly ItemText[], criterion: string, pick: number) => string | Prompt)
    | undefined;
  /** Options applied to the agent call (placement, retry, deadlines). */
  readonly calls?: CallDefaults | undefined;
}

/** Result of {@link rank}. */
export interface RankResult<T> {
  /** The selected items, best first (input order when nothing was ranked). */
  readonly selected: T[];
  /** The other items, in input order. */
  readonly deferred: T[];
  /** The ranker's rationale, or a note that nothing needed ranking. */
  readonly rationale: string;
  /**
   * `'ranked'` when the ranker chose; `'all-selected'` when there were at most `pick` items, so
   * every item was selected without a call.
   */
  readonly status: 'ranked' | 'all-selected';
}

/** The ranker's reply. */
interface Ranking {
  readonly selected: readonly string[];
  readonly rationale: string;
}

/** The default ranker prompt: the criterion, the items and the count to choose. */
function rankPrompt(entries: readonly ItemText[], criterion: string, pick: number): string {
  return brief({
    task: `Choose the ${String(pick)} items below that rank highest on this criterion: ${criterion}`,
    context: itemLines(entries),
    guidance: [
      'Judge every item by the criterion alone, from what its description shows, not by its position in the list.',
      `Choose exactly ${String(pick)} distinct items, refer to each by its key, and order them best first.`,
      'When the descriptions do not settle the choice between two items, prefer the one whose neglect would cost more: that is the safe default.',
    ],
    output:
      'The keys of the chosen items, best first, and a rationale citing what in the descriptions decided the choice.',
  });
}

/**
 * Select the `pick` items that rank highest on a criterion: one `team.ranker` call sees every
 * item's key and description and answers with the chosen keys, best first, constrained by
 * `z.enum` to the item keys (and at most `pick` of them). Repeated keys in the reply count once.
 * With at most `pick` items, no call is made and every item is selected. What the cap deferred is
 * logged, never dropped silently.
 *
 * Step IDs: `<id>/rank`, the ranker's structured call (none when every item fits).
 *
 * Team slot: `ranker`, a judging entry such as `std.roles.Judge` (or `std.roles.Reviewer` for
 * code). The ranker call is a single required step: its failure throws, and a resume retries it.
 *
 * @typeParam T - The item type.
 * @param ctx - The workflow context the team was bound from.
 * @param options - The scope, the team, the items, the count to pick and the criterion.
 * @returns The selected items best first, the deferred items, the rationale and the status.
 * @throws TypeError - Before any effect, when the `ranker` slot is not filled, `pick` is not a
 * positive integer, `criterion` is blank, or an item key is blank.
 * @throws Error - Before any effect, `Duplicate item key: ...` when two items share a key.
 */
export async function rank<T>(
  ctx: WorkflowContext,
  options: RankOptions<T>,
): Promise<RankResult<T>> {
  const pick = positiveInt('pick', options.pick);
  const { criterion, items, calls } = options;
  if (typeof criterion !== 'string' || criterion.trim() === '')
    throw new TypeError('criterion must be a nonblank string.');
  const { ranker } = RankTeam.from(options.team);
  const keys = itemKeys(items, options.key);
  const describe = options.describe ?? describeItem;
  const custom = options.prompt;
  return ctx.scope(options.id, async (): Promise<RankResult<T>> => {
    if (items.length <= pick) {
      return {
        selected: items.slice(),
        deferred: [],
        rationale: `All ${String(items.length)} items fit within pick ${String(pick)}; nothing was ranked.`,
        status: 'all-selected',
      };
    }
    const entries: ItemText[] = items.map((item, index) => ({
      key: keys[index] ?? String(index + 1),
      text: describe(item),
    }));
    const prompt =
      custom === undefined
        ? rankPrompt(entries, criterion, pick)
        : custom(entries, criterion, pick);
    const schema: z.ZodType<Ranking> = z.object({
      selected: z
        .array(z.enum(nonEmpty('items', keys)))
        .min(1)
        .max(pick)
        .describe(`The keys of the chosen items, best first: ${String(pick)} distinct keys.`),
      rationale: Rationale,
    });
    const ranking = await ranker.value('rank', { ...calls, prompt, schema });
    const chosen = [...new Set(ranking.selected)];
    const position = new Map(keys.map((key, index) => [key, index]));
    const selected = chosen.flatMap((key) => {
      const index = position.get(key);
      return index === undefined ? [] : [items[index] as T];
    });
    const picked = new Set(chosen);
    const deferredKeys = keys.filter((key) => !picked.has(key));
    const deferred = items.filter((_item, index) => !picked.has(keys[index] ?? ''));
    ctx.log(
      `Ranked ${String(items.length)} items: selected ${String(selected.length)}, deferred ${String(deferred.length)}.`,
      { selected: chosen, deferred: deferredKeys },
    );
    return { selected, deferred, rationale: ranking.rationale, status: 'ranked' };
  });
}

// ---------------------------------------------------------------------------------------------
// route
// ---------------------------------------------------------------------------------------------

/** The slot {@link route} needs: one `router` that chooses a route. */
export const RouteTeam: ReturnType<typeof defineTeam<'router'>> = defineTeam({
  router:
    'Chooses the one route that fits a subject, and the fallback when none clearly does. Fill with a quick entry such as std.roles.Clerk, or std.roles.Judge when the choice is consequential.',
});
/** The team record {@link route} takes: `{ readonly router: Agent }`. */
export type RouteTeam = TeamOf<typeof RouteTeam>;

/** Options of {@link route}. */
export interface RouteOptions<K extends string> {
  /** The scope for every step this pattern records. */
  readonly id: string;
  /** The agent filling the `router` slot. */
  readonly team: RouteTeam;
  /** What to route, such as a request, an issue or a change summary. */
  readonly subject: string;
  /** Each route's key mapped to when to take it. */
  readonly routes: Readonly<Record<K, string>>;
  /**
   * The safe route: the default prompt tells the router to take it when no route clearly fits,
   * and a failed router call takes it instead of throwing.
   */
  readonly fallback?: K | undefined;
  /** Replaces the default prompt; `fallback` is null when none is set. */
  readonly prompt?:
    | ((
        subject: string,
        routes: Readonly<Record<K, string>>,
        fallback: K | null,
      ) => string | Prompt)
    | undefined;
  /** Options applied to the agent call (placement, retry, deadlines). */
  readonly calls?: CallDefaults | undefined;
}

/** Result of {@link route}. */
export interface RouteResult<K extends string> {
  /** The chosen route. */
  readonly route: K;
  /** Why: the router's reason, or the router's failure when the fallback was taken. */
  readonly reason: string;
  /** Whether the router failed and the fallback was taken. */
  readonly fallback: boolean;
  /** `'routed'` when the router chose, `'fallback'` when its call failed. */
  readonly status: 'routed' | 'fallback';
}

/** The default router prompt: the subject, the routes and the safe default. */
function routePrompt(
  subject: string,
  routes: Readonly<Record<string, string>>,
  fallback: string | null,
): string {
  return brief({
    task: 'Choose the one route below that fits the subject best.',
    context: [part('Subject', subject), part('Routes', definitionLines(routes))].join('\n\n'),
    guidance: [
      'Choose by what the subject needs, as the route descriptions define it, not by how it is worded.',
      fallback === null
        ? 'When several routes could fit, choose the one that fits best and say why.'
        : `When no route clearly fits or the subject is ambiguous, choose ${fallback}: it is the safe default.`,
    ],
    output: 'The key of the chosen route and the reason, citing what in the subject decided it.',
  });
}

/**
 * Choose the route that fits a subject: one `team.router` call answers with a route key,
 * constrained by `z.enum` to the keys of `routes`, and a reason. The workflow then branches on
 * `result.route` in plain code.
 *
 * Step IDs: `<id>/route`, the router's structured call.
 *
 * With a `fallback`, the call runs with `onError: 'return'`: a failed call is journaled and the
 * fallback taken (`fallback: true`, logged), and a resume replays that decision. Without one, the
 * failure throws (the error names the step) and a resume retries the call, since a journaled
 * failure with nothing to fall back on would fail every resume the same way.
 *
 * Team slot: `router`, a quick entry such as `std.roles.Clerk`, or `std.roles.Judge` when the
 * choice is consequential.
 *
 * @typeParam K - The route keys.
 * @param ctx - The workflow context the team was bound from.
 * @param options - The scope, the team, the subject, the routes and an optional fallback.
 * @returns The chosen route, the reason, whether the fallback was taken, and the status.
 * @throws TypeError - Before any effect, when the `router` slot is not filled, `subject` is blank,
 * `routes` is empty or maps a blank key or description, or `fallback` is not one of the routes.
 */
export async function route<const K extends string>(
  ctx: WorkflowContext,
  options: RouteOptions<K>,
): Promise<RouteResult<K>> {
  const { subject, routes, fallback, calls } = options;
  if (typeof subject !== 'string' || subject.trim() === '')
    throw new TypeError('subject must be a nonblank string.');
  const keys = definitionKeys('routes', routes);
  if (fallback !== undefined && !keys.includes(fallback)) {
    throw new TypeError(
      `fallback ${JSON.stringify(fallback)} is not one of the routes: ${keys.map((key) => JSON.stringify(key)).join(', ')}.`,
    );
  }
  const prompt =
    options.prompt === undefined
      ? routePrompt(subject, routes, fallback ?? null)
      : options.prompt(subject, routes, fallback ?? null);
  const schema = z.object({
    route: z.enum(keys).describe('The key of the chosen route.'),
    reason: Rationale,
  });
  const { router } = RouteTeam.from(options.team);
  return ctx.scope(options.id, async (): Promise<RouteResult<K>> => {
    if (fallback === undefined) {
      const answer = await router.value('route', { ...calls, prompt, schema });
      return { route: answer.route, reason: answer.reason, fallback: false, status: 'routed' };
    }
    const answer = await router.value('route', { ...calls, prompt, schema, onError: 'return' });
    if (answer.ok)
      return {
        route: answer.value.route,
        reason: answer.value.reason,
        fallback: false,
        status: 'routed',
      };
    const reason = `The router failed (${answer.error.kind}): ${answer.error.message}`;
    ctx.log(`Router failed; taking the fallback route ${fallback}.`, { reason });
    return { route: fallback, reason, fallback: true, status: 'fallback' };
  });
}

// ---------------------------------------------------------------------------------------------
// classify
// ---------------------------------------------------------------------------------------------

/** The slot {@link classify} needs: one `tagger` that labels a batch of items. */
export const ClassifyTeam: ReturnType<typeof defineTeam<'tagger'>> = defineTeam({
  tagger:
    'Labels each item of a batch from a fixed taxonomy, leaving an item unlabeled when no label fits. Fill with a quick entry such as std.roles.Clerk, or std.roles.Reader when labeling needs the code.',
});
/** The team record {@link classify} takes: `{ readonly tagger: Agent }`. */
export type ClassifyTeam = TeamOf<typeof ClassifyTeam>;

/** Options of {@link classify}. */
export interface ClassifyOptions<T, L extends string> {
  /** The scope for every step this pattern records. */
  readonly id: string;
  /** The agent filling the `tagger` slot. */
  readonly team: ClassifyTeam;
  /** The items to label. */
  readonly items: readonly T[];
  /**
   * The unique, nonblank key the tagger answers with for an item, such as an issue number.
   * Defaults to the item's own string `key` member, as std results carry, else its 1-based
   * position.
   */
  readonly key?: ((item: T) => string) | undefined;
  /**
   * The taxonomy, in the order counts break ties: each label mapped to its definition, or a plain
   * list of label names whose meaning is plain (`['bug', 'feature', 'docs']`).
   */
  readonly labels: Readonly<Record<L, string>> | readonly L[];
  /** Whether an item may take several labels; defaults to false (at most one). */
  readonly multi?: boolean | undefined;
  /** How many items one tagger call labels, a positive integer; defaults to 10. */
  readonly chunk?: number | undefined;
  /**
   * An item's description for the tagger; defaults to a string item itself, else its JSON with
   * sorted keys.
   */
  readonly describe?: ((item: T) => string) | undefined;
  /** Replaces the default prompt for one batch of items; it receives `labels` as given. */
  readonly prompt?:
    | ((
        entries: readonly ItemText[],
        labels: Readonly<Record<L, string>> | readonly L[],
        multi: boolean,
      ) => string | Prompt)
    | undefined;
  /** How many batches run at once; defaults to 4. */
  readonly concurrency?: number | undefined;
  /** A revision for prompts and schemas the settled map's fingerprint does not show. */
  readonly version?: string | undefined;
  /** Options applied to every agent call (placement, retry, deadlines). */
  readonly calls?: CallDefaults | undefined;
}

/** One labeled item of a {@link classify} result. */
export interface Assignment<T, L extends string> {
  /** The item's key. */
  readonly key: string;
  /** The item. */
  readonly item: T;
  /** Its labels, in taxonomy order; at least one, and one unless `multi`. */
  readonly labels: L[];
  /** What in the item decided its labels, as the tagger put it. */
  readonly reason: string;
}

/** How many items carry one label. */
export interface LabelCount<L extends string> {
  /** The label. */
  readonly label: L;
  /** How many items carry it. */
  readonly count: number;
}

/** Result of {@link classify}. */
export interface ClassifyResult<T, L extends string> {
  /** The items that received a label, in input order. */
  readonly assignments: Assignment<T, L>[];
  /** Every label with its count, most used first; ties keep taxonomy order. */
  readonly counts: LabelCount<L>[];
  /** Items the tagger answered without a label, or left out of its reply (logged), in input order. */
  readonly unlabeled: T[];
  /** Items whose batch call failed, in input order; a resume does not retry them. */
  readonly failed: T[];
  /** How many batch calls failed. */
  readonly failedChunks: number;
  /** `'complete'` when every batch call succeeded, else `'degraded'`. */
  readonly status: 'complete' | 'degraded';
}

/** One tagged item of a batch reply. */
interface Tagged<L extends string> {
  readonly key: string;
  readonly labels: readonly L[];
  readonly reason: string;
}

/** A batch reply. */
interface TagReply<L extends string> {
  readonly items: readonly Tagged<L>[];
}

/**
 * A batch map item: its key, its rendered prompt, and what the reply schema is built from (the item
 * keys the reply may use, the labels and the mode), so the map fingerprint covers the schema even
 * under a custom prompt.
 */
interface BatchRecord<L extends string> extends PromptRecord {
  readonly keys: string[];
  readonly labels: readonly [L, ...L[]];
  readonly multi: boolean;
}

/** Whether a taxonomy is a plain list of label names rather than a record of definitions. */
function isLabelList<L extends string>(
  labels: Readonly<Record<L, string>> | readonly L[],
): labels is readonly L[] {
  return Array.isArray(labels);
}

/**
 * Validate a taxonomy and return its labels as a nonempty tuple: a list's names must be nonblank
 * strings without repeats, and a record's keys and definitions nonblank.
 */
function labelKeysOf<L extends string>(
  labels: Readonly<Record<L, string>> | readonly L[],
): readonly [L, ...L[]] {
  if (!isLabelList(labels)) return definitionKeys('labels', labels);
  const names = nonEmpty('labels', labels);
  for (const name of names) {
    if (typeof name !== 'string' || name.trim() === '')
      throw new TypeError(`labels must be nonblank strings; got ${JSON.stringify(name)}.`);
  }
  assertUnique(names, 'label');
  return names;
}

/** The default tagger prompt: the taxonomy, the batch of items and the safe default. */
function classifyPrompt(
  entries: readonly ItemText[],
  labels: Readonly<Record<string, string>> | readonly string[],
  multi: boolean,
): string {
  const listed = isLabelList(labels);
  return brief({
    task: multi
      ? 'Label each item below with every label from the taxonomy that applies to it.'
      : 'Label each item below with the one label from the taxonomy that fits it best.',
    context: [
      part('Taxonomy', listed ? bullets(labels) : definitionLines(labels)),
      part('Items', itemLines(entries)),
    ].join('\n\n'),
    guidance: [
      listed
        ? 'Use only the labels in the taxonomy, in their plain meaning.'
        : 'Use only the labels in the taxonomy, as their definitions describe them.',
      'Label each item on its own content, and answer for every item by its key.',
      'When no label clearly fits an item, give it no label: an empty list is the safe default, better than a wrong label.',
    ],
    output: 'One entry per item: its key, its labels, and what in the item decided them.',
  });
}

/** The batch reply schema: item keys and labels constrained to the known values. */
function tagSchema<L extends string>(
  keys: readonly string[],
  labels: readonly [L, ...L[]],
  multi: boolean,
): z.ZodType<TagReply<L>> {
  return z.object({
    items: z
      .array(
        z.object({
          key: z.enum(nonEmpty('keys', keys)).describe('The item key.'),
          labels: z
            .array(z.enum(labels))
            .max(multi ? labels.length : 1)
            .describe(
              multi
                ? 'Every label that applies, or an empty list when none does.'
                : 'The one label that fits best, or an empty list when none fits.',
            ),
          reason: z.string().min(1).describe('What in the item decided its labels.'),
        }),
      )
      .describe('One entry per item, by key.'),
  });
}

/**
 * Label items from a fixed taxonomy and count the labels. The items are split into batches of
 * `chunk`; each batch is one `team.tagger` call that sees the whole taxonomy and answers per item
 * key, with keys and labels constrained by `z.enum`. An item the reply leaves out (logged) or
 * gives no label counts as unlabeled; a reply entry repeating an item is ignored (logged); the
 * items of a failed batch are reported in `failed` (logged), and a resume does not retry the
 * batch. The counts are computed in code. The taxonomy is a record of definitions or, for labels
 * whose meaning is plain, a list of names.
 *
 * Step IDs: `<id>/chunk/<n>/tag`, the settled map `<id>/chunk` keyed by batch `n` from 0.
 *
 * Team slot: `tagger`, a quick entry such as `std.roles.Clerk`, or `std.roles.Reader` when labeling
 * needs the code. The default prompt names the safe default: no label rather than a wrong one.
 * Each map item carries its rendered prompt and what its reply schema is built from (the batch's
 * item keys, the labels and `multi`), so a prompt or taxonomy change is detected on resume; set
 * `version` when a change the items do not show should not reuse completed batches.
 *
 * @typeParam T - The item type.
 * @typeParam L - The labels.
 * @param ctx - The workflow context the team was bound from.
 * @param options - The scope, the team, the items, the taxonomy, and optional keys, batch size
 * and multi-label mode.
 * @returns The labeled items, the label counts, the unlabeled and failed items, and the status.
 * @throws TypeError - Before any effect, when the `tagger` slot is not filled, `labels` is empty,
 * maps a blank key or definition, or lists a blank name, `chunk` or `concurrency` is not a positive
 * integer, or an item key is blank.
 * @throws Error - Before any effect, `Duplicate item key: ...` when two items share a key, or
 * `Duplicate label: ...` when a label list repeats a name.
 */
export async function classify<T, const L extends string>(
  ctx: WorkflowContext,
  options: ClassifyOptions<T, L>,
): Promise<ClassifyResult<T, L>> {
  const { items, labels, calls } = options;
  const labelKeys = labelKeysOf(labels);
  const size = positiveInt('chunk', options.chunk ?? 10);
  const multi = options.multi ?? false;
  const keys = itemKeys(items, options.key);
  const map = settledMap<BatchRecord<L>>(options);
  const describe = options.describe ?? describeItem;
  const custom = options.prompt;
  const { tagger } = ClassifyTeam.from(options.team);
  const order = new Map<string, number>(labelKeys.map((label, index) => [label, index]));

  return ctx.scope(options.id, async (): Promise<ClassifyResult<T, L>> => {
    const batches: { key: string; item: T; index: number }[][] = [];
    items.forEach((item, index) => {
      const entry = { key: keys[index] ?? String(index + 1), item, index };
      const last = batches.at(-1);
      if (last === undefined || last.length >= size) batches.push([entry]);
      else last.push(entry);
    });
    const records: BatchRecord<L>[] = batches.map((batch, n) => {
      const entries = batch.map(({ key, item }) => ({ key, text: describe(item) }));
      return {
        key: String(n),
        prompt: promptText(
          custom === undefined
            ? classifyPrompt(entries, labels, multi)
            : custom(entries, labels, multi),
        ),
        keys: entries.map((entry) => entry.key),
        labels: labelKeys,
        multi,
      };
    });
    const replies: Settled<TagReply<L>, MapStepError>[] =
      records.length === 0
        ? []
        : await ctx.map('chunk', records, map, (record) =>
            tagger.value('tag', {
              ...calls,
              prompt: record.prompt,
              schema: tagSchema(record.keys, record.labels, record.multi),
            }),
          );

    const assignments: Assignment<T, L>[] = [];
    const unlabeled: T[] = [];
    const failed: T[] = [];
    const counts = new Map<L, number>(labelKeys.map((label) => [label, 0]));
    let failedChunks = 0;
    batches.forEach((batch, n) => {
      const reply = replies[n];
      if (reply === undefined) throw new Error(`Missing settled result for batch ${String(n)}.`);
      if (!reply.ok) {
        failedChunks += 1;
        for (const { item } of batch) failed.push(item);
        ctx.log(
          `Batch ${String(n)} failed (${reply.error.kind}); its ${String(batch.length)} items are reported as failed.`,
          { keys: batch.map(({ key }) => key), error: reply.error.message },
        );
        return;
      }
      const answers = new Map<string, Tagged<L>>();
      const repeated: string[] = [];
      for (const answer of reply.value.items) {
        if (answers.has(answer.key)) repeated.push(answer.key);
        else answers.set(answer.key, answer);
      }
      const omitted: string[] = [];
      for (const { key, item } of batch) {
        const answer = answers.get(key);
        if (answer === undefined) omitted.push(key);
        const chosen = [...new Set(answer?.labels ?? [])].sort(
          (a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0),
        );
        if (chosen.length === 0) {
          unlabeled.push(item);
          continue;
        }
        for (const label of chosen) counts.set(label, (counts.get(label) ?? 0) + 1);
        assignments.push({ key, item, labels: chosen, reason: answer?.reason ?? '' });
      }
      if (repeated.length > 0 || omitted.length > 0) {
        ctx.log(
          `Batch ${String(n)} answered some items twice or not at all; repeats are ignored and omitted items count as unlabeled.`,
          { repeated, omitted },
        );
      }
    });
    const tallied = labelKeys
      .map((label) => ({ label, count: counts.get(label) ?? 0 }))
      .sort((a, b) => b.count - a.count);
    return {
      assignments,
      counts: tallied,
      unlabeled,
      failed,
      failedChunks,
      status: statusOf(failedChunks),
    };
  });
}
