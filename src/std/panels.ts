/**
 * Panels of agents over one subject, re-exported from `std.patterns`:
 *
 * - {@link lensPanel} asks one reader per lens (`std.lenses`) about the same subject.
 * - {@link vote} puts one yes-or-no question to several seats and decides it by a rule.
 * - {@link verify} tries to refute each item with a panel of skeptics and sorts the items into
 *   confirmed, refuted and undecided.
 * - {@link hunt} is a bug hunt: each round runs a lens panel over a rotating window of bug lenses,
 *   verifies the round's new findings, and the hunt ends when rounds stop finding anything new.
 *
 * Every pattern takes a required `id` and records all of its steps under it; each pattern's TSDoc
 * lists the exact step IDs. A failed agent call is journaled and becomes data (a failed lens, a
 * missing vote), so a resume replays the same decision instead of retrying it, and every result
 * reports its failures and a `status`. The default prompts are built with `std.text.brief`, and
 * the skeptical ones name the safe default for an undecided agent (refute; vote no).
 *
 * ```ts
 * import * as std from 'quiet-choir/std';
 *
 * const hunt = await std.patterns.hunt(ctx, {
 *   id: 'hunt',
 *   team: { finder: ctx.roster.Reviewer, skeptic: ctx.roster.Skeptic },
 *   subject: 'The parser in src/parser/.',
 * });
 * for (const { item } of hunt.confirmed) ctx.log(`${item.severity}: ${item.file}: ${item.title}`);
 * ```
 *
 * @module
 */
import {
  defineTeam,
  type Agent,
  type JsonValue,
  type MapOptions,
  type MapStepError,
  type Prompt,
  type Settled,
  type TeamOf,
  type WorkflowContext,
  type z,
} from '../index.js';
import {
  bySeverity,
  findingKey,
  fresh,
  rankBy,
  rotate,
  tally,
  threshold,
  type Outcome,
  type Rule,
} from './data.js';
import { json } from './exec.js';
import { bugs, type Lens } from './lenses.js';
import {
  keyed,
  nonEmpty,
  placement,
  positiveInt,
  settledMap,
  statusOf,
  type CallDefaults,
} from './pattern-kit.js';
import { brief, bullets, fence, promptText, section } from './text.js';
import { Ballot, Findings, Refutation, Severity, type Finding } from './types.js';

/**
 * A settled-map item that carries its key, the rendered prompt the mapper sends, and where the call
 * runs (see `placement`).
 */
interface PromptRecord {
  readonly key: string;
  readonly prompt: string;
  readonly placement?: JsonValue;
}

/** The settled-map options every panel map uses. */
type SettledOptions = MapOptions<PromptRecord> & { readonly onError: 'return' };

/** The text of each seat's reasoning, prefixed with how the seat voted. */
function reason(label: string, reasoning: string): string {
  return `${label}: ${reasoning}`;
}

// ---------------------------------------------------------------------------------------------
// lensPanel
// ---------------------------------------------------------------------------------------------

/** The slot {@link lensPanel} needs: one `reader` that examines the subject through each lens. */
export const LensTeam: ReturnType<typeof defineTeam<'reader'>> = defineTeam({
  reader:
    'Examines the subject through one lens and reports only within its charter. Fill with a read-only entry such as std.roles.Reviewer for code, or std.roles.Reader.',
});
/** The team record {@link lensPanel} takes: `{ readonly reader: Agent }`. */
export type LensTeam = TeamOf<typeof LensTeam>;

/** Replacement prompts of {@link lensPanel}; each may return text or a rendered {@link Prompt}. */
export interface LensPanelPrompts {
  /**
   * The reader's prompt for one lens over `subject`; the `task` option is then unused. The default
   * opens with `task`, names the lens and its charter, gives the subject as context, and asks for
   * evidenced points within the lens only, allowing an empty answer.
   */
  readonly read?: ((lens: Lens, subject: string) => string | Prompt) | undefined;
}

/** Options of {@link lensPanel}. */
export interface LensPanelOptions<O> {
  /** The scope for every step this pattern records. */
  readonly id: string;
  /** The agent filling the `reader` slot. */
  readonly team: LensTeam;
  /**
   * The lenses, one call each, such as `std.lenses.review`. A lens key repeated in the list gets
   * a `.2`, `.3`, ... suffix in its step ID.
   */
  readonly lenses: readonly Lens[];
  /** What to examine, such as a fenced diff, a list of files or a document. */
  readonly subject: string;
  /** The schema of each reader's answer, such as `std.types.Findings`. */
  readonly schema: z.ZodType<O>;
  /**
   * The opening sentence of the default prompt, before the lens; defaults to
   * `Examine the subject below.` (for example `Review the diff below for defects.`).
   */
  readonly task?: string | undefined;
  /** Replacement prompts. */
  readonly prompts?: LensPanelPrompts | undefined;
  /** How many lenses run at once; defaults to 4. */
  readonly concurrency?: number | undefined;
  /** A revision for prompts and schemas the settled map's fingerprint does not show. */
  readonly version?: string | undefined;
  /** Options applied to every agent call (placement, retry, deadlines). */
  readonly calls?: CallDefaults | undefined;
}

/** One lens's answer in a {@link LensPanelResult}. */
export interface LensAnswer<O> {
  /** The lens. */
  readonly lens: Lens;
  /** The reader's answer through it. */
  readonly value: O;
}

/** Result of {@link lensPanel}. */
export interface LensPanelResult<O> {
  /** The answers of the lenses whose call succeeded, in lens order. */
  readonly results: LensAnswer<O>[];
  /** The lenses whose call failed; the failures are saved, so a resume does not retry them. */
  readonly failed: Lens[];
  /** Whether more than half of the lenses answered. */
  readonly quorum: boolean;
  /** `'complete'` when every lens answered, else `'degraded'`. */
  readonly status: 'complete' | 'degraded';
}

/** The default lens prompt: the task, the lens and its charter, the subject and the rules. */
function lensPrompt(task: string, lens: Lens, subject: string): string {
  return brief({
    task: `${task} Work through one lens only, ${lens.key}: ${lens.charter}`,
    context: subject,
    guidance: [
      'Stay within this lens; other panelists cover the other lenses.',
      'Support every point with concrete evidence: file:line references, command output or quotes.',
      'Report only what you can support. When this lens finds nothing, an empty answer is valid.',
    ],
    output: 'Answer in the requested structure, covering only this lens.',
  });
}

/** What {@link runPanel} needs, already validated. */
interface PanelRun<O> {
  readonly reader: Agent;
  readonly leaf: string;
  readonly lenses: readonly Lens[];
  readonly prompt: (lens: Lens) => string | Prompt;
  readonly schema: z.ZodType<O>;
  readonly map: SettledOptions;
  readonly calls: CallDefaults | undefined;
}

/**
 * Run a lens panel as the settled map `lens` in the current scope: one call `lens/<key>/<leaf>`
 * per lens, keyed by the lens key (made unique), each item carrying its rendered prompt.
 */
async function runPanel<O>(ctx: WorkflowContext, run: PanelRun<O>): Promise<LensPanelResult<O>> {
  const { reader, leaf, schema, calls } = run;
  const entries = keyed(run.lenses, (lens) => lens.key);
  const records: PromptRecord[] = entries.map(({ key, item }) => ({
    key,
    prompt: promptText(run.prompt(item)),
    ...placement(calls),
  }));
  const settled: Settled<O, MapStepError>[] = await ctx.map('lens', records, run.map, (record) =>
    reader.value(leaf, { ...calls, prompt: record.prompt, schema }),
  );
  const results: LensAnswer<O>[] = [];
  const failed: Lens[] = [];
  for (const { item, index } of entries) {
    const outcome = settled[index];
    if (outcome === undefined) throw new Error(`Missing settled result for lens ${item.key}.`);
    if (outcome.ok) results.push({ lens: item, value: outcome.value });
    else failed.push(item);
  }
  return {
    results,
    failed,
    quorum: results.length > entries.length / 2,
    status: statusOf(failed.length),
  };
}

/**
 * Examine one subject through several lenses, one `team.reader` call per lens, and collect the
 * answers by lens. The calls form the settled map `<id>/lens`, keyed by lens key, so lens `k`
 * records `<id>/lens/<k>/read`; a failed call is journaled and reported in `failed`, and a resume
 * does not retry it.
 *
 * The default prompt (a `std.text.brief`) opens with `task`, names the lens and its charter, gives
 * the subject as context, and asks for evidenced points within the lens only, allowing an empty
 * answer. Each map item carries its rendered prompt, so a prompt change is detected on resume; set
 * `version` when a change the items do not show (such as the schema) should not reuse answers.
 *
 * Team slot: `reader`, a read-only agent such as `std.roles.Reviewer` (code) or `std.roles.Reader`.
 *
 * @typeParam O - The answer type of `schema`.
 * @param ctx - The workflow context the team was bound from.
 * @param options - The scope, the team, the lenses, the subject and the answer schema, with an
 * optional task, prompts, concurrency, version and call defaults.
 * @returns The answers in lens order, the failed lenses, whether a quorum answered, and the status.
 * @throws TypeError - Before any effect, when the `reader` slot is not filled, `lenses` is empty or
 * `concurrency` is not a positive integer.
 */
export async function lensPanel<O>(
  ctx: WorkflowContext,
  options: LensPanelOptions<O>,
): Promise<LensPanelResult<O>> {
  const { reader } = LensTeam.from(options.team);
  const lenses = nonEmpty('lenses', options.lenses).slice();
  const map = settledMap<PromptRecord>(options);
  const task = options.task ?? 'Examine the subject below.';
  const custom = options.prompts?.read;
  const { subject } = options;
  return ctx.scope(options.id, () =>
    runPanel(ctx, {
      reader,
      leaf: 'read',
      lenses,
      prompt: (lens) =>
        custom === undefined ? lensPrompt(task, lens, subject) : custom(lens, subject),
      schema: options.schema,
      map,
      calls: options.calls,
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// vote
// ---------------------------------------------------------------------------------------------

/** The slot {@link vote} needs: one `voter` that every seat calls. */
export const VoteTeam: ReturnType<typeof defineTeam<'voter'>> = defineTeam({
  voter:
    'Answers one yes-or-no question with its reasoning and votes no when the evidence does not decide. Fill with a read-only judging entry such as std.roles.Judge or std.roles.Skeptic.',
});
/** The team record {@link vote} takes: `{ readonly voter: Agent }`. */
export type VoteTeam = TeamOf<typeof VoteTeam>;

/** Replacement prompts of {@link vote}; each may return text or a rendered {@link Prompt}. */
export interface VotePrompts {
  /**
   * The ballot prompt for seat `seat` (from 0 to `seats - 1`) on `question`. The default asks for a
   * vote decided from checked evidence, shows the `context` option under the question, and names no
   * as the safe default; a replacement that needs the context closes over it.
   */
  readonly ballot?:
    ((question: string, seat: number, seats: number) => string | Prompt) | undefined;
}

/** Options of {@link vote}. */
export interface VoteOptions {
  /** The scope for every step this pattern records. */
  readonly id: string;
  /** The agent filling the `voter` slot; every seat calls it. */
  readonly team: VoteTeam;
  /** The question, phrased so that no is the safe answer (`Is this change safe to merge?`). */
  readonly question: string;
  /** Material the question is about, shown under the default prompt's context. */
  readonly context?: string | undefined;
  /** How many seats vote, a positive integer; defaults to 3. */
  readonly seats?: number | undefined;
  /** How many yes votes carry the question; defaults to `'majority'`. */
  readonly rule?: Rule | undefined;
  /** Replacement prompts. */
  readonly prompts?: VotePrompts | undefined;
  /** How many seats vote at once; defaults to 4. */
  readonly concurrency?: number | undefined;
  /** A revision for prompts and schemas the settled map's fingerprint does not show. */
  readonly version?: string | undefined;
  /** Options applied to every agent call (placement, retry, deadlines). */
  readonly calls?: CallDefaults | undefined;
}

/** Result of {@link vote}. */
export interface VoteResult {
  /**
   * `'yes'` when the yes votes reach the rule's threshold, `'no'` when they cannot reach it even
   * if every missing seat had voted yes, else `'undecided'` (the missing seats decide it).
   */
  readonly outcome: 'yes' | 'no' | 'undecided';
  /** Seats that voted yes. */
  readonly yes: number;
  /** Seats that voted no. */
  readonly no: number;
  /** Seats whose call failed; a failed seat counts for neither side. */
  readonly missing: number;
  /** How many seats voted. */
  readonly seats: number;
  /** Each answering seat's reasoning in seat order, prefixed `yes: ` or `no: `. */
  readonly reasons: string[];
  /** `'complete'` when every seat answered, else `'degraded'`. */
  readonly status: 'complete' | 'degraded';
}

/** The default ballot prompt; it names no as the safe default. */
function ballotPrompt(question: string, context: string | undefined): string {
  return brief({
    task: `Vote yes or no on this question: ${question}`,
    context,
    guidance: [
      'Decide from evidence you check yourself (the code, data or sources the question concerns), not from assumptions.',
      'Vote yes only when the evidence shows the answer is yes. When it does not settle the question, vote no; that is the safe default.',
    ],
    output:
      'Your vote (yes: true for yes, false for no) and the reasoning, citing the evidence that decided it.',
  });
}

/**
 * Put one yes-or-no question to `seats` independent calls of `team.voter` and decide it with
 * `std.data.tally` under `rule`. The seats form the settled map `<id>/seat`, so seat `n` records
 * `<id>/seat/<n>/ballot` (schema `std.types.Ballot`); a failed seat is journaled and counted as
 * missing, never as a vote, so a resume decides the same way.
 *
 * The default prompt (a `std.text.brief`) asks for a vote decided from checked evidence and names
 * no as the safe default when the evidence does not settle the question, so phrase the question
 * so that yes is the claim that needs support.
 *
 * Team slot: `voter`, a read-only judging agent such as `std.roles.Judge` or `std.roles.Skeptic`.
 *
 * @param ctx - The workflow context the team was bound from.
 * @param options - The scope, the team, the question, and optional context, seats, rule, prompts,
 * concurrency, version and call defaults.
 * @returns The outcome, the vote counts, each seat's reasoning and the status.
 * @throws TypeError - Before any effect, when the `voter` slot is not filled, `seats` or
 * `concurrency` is not a positive integer, or the rule is invalid for `seats`.
 */
export async function vote(ctx: WorkflowContext, options: VoteOptions): Promise<VoteResult> {
  const { voter } = VoteTeam.from(options.team);
  const seats = positiveInt('seats', options.seats ?? 3);
  const rule = options.rule ?? 'majority';
  threshold(rule, seats);
  const map = settledMap<PromptRecord>(options);
  const { question, calls } = options;
  const custom = options.prompts?.ballot;
  const records: PromptRecord[] = Array.from({ length: seats }, (_unused, seat) => ({
    key: String(seat),
    prompt: promptText(
      custom === undefined
        ? ballotPrompt(question, options.context)
        : custom(question, seat, seats),
    ),
    ...placement(calls),
  }));
  return ctx.scope(options.id, async () => {
    const settled = await ctx.map('seat', records, map, (record) =>
      voter.value('ballot', { ...calls, prompt: record.prompt, schema: Ballot }),
    );
    let yes = 0;
    let no = 0;
    const reasons: string[] = [];
    for (const outcome of settled) {
      if (!outcome.ok) continue;
      if (outcome.value.yes) yes += 1;
      else no += 1;
      reasons.push(reason(outcome.value.yes ? 'yes' : 'no', outcome.value.reasoning));
    }
    const decided = tally({ upheld: yes, against: no, seats }, rule);
    return {
      outcome:
        decided.outcome === 'confirmed'
          ? 'yes'
          : decided.outcome === 'refuted'
            ? 'no'
            : 'undecided',
      yes,
      no,
      missing: decided.missing,
      seats,
      reasons,
      status: statusOf(decided.missing),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------------------------

/** The slot {@link verify} needs: one `skeptic` that every seat of every item's panel calls. */
export const VerifyTeam: ReturnType<typeof defineTeam<'skeptic'>> = defineTeam({
  skeptic:
    'Tries to refute one claim against the evidence and refutes it when unsure. Fill with a high-effort read-only entry such as std.roles.Skeptic.',
});
/** The team record {@link verify} takes: `{ readonly skeptic: Agent }`. */
export type VerifyTeam = TeamOf<typeof VerifyTeam>;

/** Replacement prompts of {@link verify} and {@link hunt}. */
export interface VerifyPrompts {
  /**
   * The prompt for seat `seat` (from 0) of a panel of `seats` judging `claim`, the item's claim
   * text. The default asks the skeptic to refute the claim, shows the `context` under it, and asks
   * for `refuted: true` when the evidence is inconclusive; a replacement that needs the context
   * closes over it.
   */
  readonly verify?: ((claim: string, seat: number, seats: number) => string | Prompt) | undefined;
}

/** Options of {@link verify}. */
export interface VerifyOptions<T> {
  /** The scope for every step this pattern records. */
  readonly id: string;
  /** The agent filling the `skeptic` slot. */
  readonly team: VerifyTeam;
  /** The claims to verify, such as findings; each is judged by its own panel. */
  readonly items: readonly T[];
  /**
   * An item's label for its step IDs, such as `std.data.findingKey`; labels are made unique and
   * ID-safe with `std.data.uniqueKeys`. Defaults to the item's index. A content key names each
   * item's steps after the item rather than its position, so the step IDs read well and an item
   * keeps its IDs when other items are added or removed.
   */
  readonly key?: ((item: T, index: number) => string) | undefined;
  /**
   * The claim text a skeptic judges; defaults to a string item itself and to any other item as a
   * fenced JSON block.
   */
  readonly claim?: ((item: T) => string) | undefined;
  /**
   * What the claims are about, such as the reviewed diff or the hunted scope, shown under the
   * claim in the default prompt so a skeptic checks the claim against the same material.
   */
  readonly context?: string | undefined;
  /**
   * How many skeptics judge each item, or a function of the item (such as more seats for a more
   * severe finding); defaults to 3.
   */
  readonly seats?: number | ((item: T) => number) | undefined;
  /** How many upholding seats confirm an item; defaults to `'majority'`. */
  readonly rule?: Rule | undefined;
  /** Replacement prompts. */
  readonly prompts?: VerifyPrompts | undefined;
  /** How many items are verified at once (each item's seats run together); defaults to 4. */
  readonly concurrency?: number | undefined;
  /** A revision for prompts and schemas the settled maps' fingerprints do not show. */
  readonly version?: string | undefined;
  /** Options applied to every agent call (placement, retry, deadlines). */
  readonly calls?: CallDefaults | undefined;
}

/** One item's verdict from {@link verify}. */
export interface Verified<T> {
  /** The item's map key in the step IDs. */
  readonly key: string;
  /** The item. */
  readonly item: T;
  /**
   * `'confirmed'` when the upholding seats reach the rule's threshold, `'refuted'` when they
   * cannot reach it even if every missing seat had upheld, else `'undecided'`.
   */
  readonly outcome: Outcome;
  /** Seats that upheld the claim (`refuted: false`). */
  readonly upheld: number;
  /** Seats that refuted it. */
  readonly against: number;
  /** Seats whose call failed; a failed seat counts for neither side. */
  readonly missing: number;
  /** The panel size for this item. */
  readonly seats: number;
  /** Each answering seat's reasoning in seat order, prefixed `upheld: ` or `refuted: `. */
  readonly reasons: string[];
}

/** Result of {@link verify}. */
export interface VerifyResult<T> {
  /** The confirmed items, in input order. */
  readonly confirmed: Verified<T>[];
  /** The refuted items, in input order. */
  readonly refuted: Verified<T>[];
  /** The items whose missing seats left the vote open, in input order. */
  readonly undecided: Verified<T>[];
  /** How many seats failed across all items; their failures are saved and not retried. */
  readonly failedVotes: number;
  /** `'complete'` when every seat answered, else `'degraded'`. */
  readonly status: 'complete' | 'degraded';
}

/** The default skeptic prompt; it names `refuted: true` as the safe default. */
function verifyPrompt(claim: string, context: string | undefined): string {
  return brief({
    task: 'Try to refute the claim below. Check it against the actual code, data or sources, and look for the guards, callers, tests or facts that would make it false.',
    context: context === undefined ? claim : `${claim}\n\n${section('Subject', context)}`,
    guidance: [
      ...(context === undefined
        ? []
        : [
            'The claim was made about the material under Subject: check it against that material and the code it refers to.',
          ]),
      'Answer refuted: false only when your best refutation fails and you can cite the evidence that the claim holds.',
      'When the evidence is inconclusive, refute the claim (refuted: true); that is the safe default.',
    ],
    output:
      'Whether the claim is refuted, and the reasoning that decided it, citing the evidence you checked.',
  });
}

/** An item ready for verification: its key, seat count and one rendered prompt per seat. */
interface VerifyEntry<T> {
  readonly key: string;
  readonly item: T;
  readonly seats: number;
  readonly prompts: readonly string[];
}

/**
 * The settled-map item of one item's panel: its key, one rendered prompt per seat, and where the
 * calls run (see `placement`).
 */
interface PanelRecord {
  readonly key: string;
  readonly prompts: readonly string[];
  readonly placement?: JsonValue;
}

/** Validate a seat count for `rule` and return it. */
function seatCount(seats: number, rule: Rule): number {
  positiveInt('seats', seats);
  threshold(rule, seats);
  return seats;
}

/** The seat count of every item, each validated for `rule`; a function is called once per item. */
function seatCounts<T>(
  items: readonly T[],
  seats: number | ((item: T) => number) | undefined,
  rule: Rule,
): number[] {
  const option = seats ?? 3;
  return items.map((item) => seatCount(typeof option === 'number' ? option : option(item), rule));
}

/**
 * Prepare verification entries: unique keys, the given seat counts and rendered prompts, all
 * before any effect.
 */
function verifyEntries<T>(
  items: readonly T[],
  seats: readonly number[],
  options: {
    readonly key?: ((item: T, index: number) => string) | undefined;
    readonly claim?: ((item: T) => string) | undefined;
    readonly context?: string | undefined;
    readonly prompts?: VerifyPrompts | undefined;
  },
): VerifyEntry<T>[] {
  const claimOf =
    options.claim ?? ((item: T) => (typeof item === 'string' ? item : fence(json(item), 'json')));
  const { context } = options;
  const custom = options.prompts?.verify;
  return keyed(items, options.key).map(({ key, item, index }) => {
    const count = seats[index];
    if (count === undefined) throw new Error(`Missing seat count for item ${key}.`);
    const claim = claimOf(item);
    const prompts = Array.from({ length: count }, (_unused, seat) =>
      promptText(custom === undefined ? verifyPrompt(claim, context) : custom(claim, seat, count)),
    );
    return { key, item, seats: count, prompts };
  });
}

/** The verdicts of a {@link runVerify} call, without the status. */
interface VerifyTally<T> {
  readonly confirmed: Verified<T>[];
  readonly refuted: Verified<T>[];
  readonly undecided: Verified<T>[];
  readonly failedVotes: number;
}

/**
 * Verify entries as the settled map `item` in the current scope: item `k` runs its own settled map
 * `item/<k>/seat`, whose seat `n` records `item/<k>/seat/<n>/verdict`.
 */
async function runVerify<T>(
  ctx: WorkflowContext,
  skeptic: Agent,
  entries: readonly VerifyEntry<T>[],
  rule: Rule,
  map: MapOptions<PanelRecord> & { readonly onError: 'return' },
  calls: CallDefaults | undefined,
): Promise<VerifyTally<T>> {
  const result: VerifyTally<T> = { confirmed: [], refuted: [], undecided: [], failedVotes: 0 };
  if (entries.length === 0) return result;
  const where = placement(calls);
  const records: PanelRecord[] = entries.map(({ key, prompts }) => ({ key, prompts, ...where }));
  const { version } = map;
  const panels = await ctx.map('item', records, map, (record) =>
    ctx.map(
      'seat',
      record.prompts.map((prompt, seat): PromptRecord => ({ key: String(seat), prompt, ...where })),
      {
        concurrency: record.prompts.length,
        key: (seat) => seat.key,
        onError: 'return',
        version,
      },
      (seat) => skeptic.value('verdict', { ...calls, prompt: seat.prompt, schema: Refutation }),
    ),
  );
  let failedVotes = 0;
  for (const [index, entry] of entries.entries()) {
    const panel = panels[index];
    if (panel === undefined) throw new Error(`Missing settled result for item ${entry.key}.`);
    let upheld = 0;
    let against = 0;
    const reasons: string[] = [];
    for (const seat of panel.ok ? panel.value : []) {
      if (!seat.ok) continue;
      if (seat.value.refuted) against += 1;
      else upheld += 1;
      reasons.push(reason(seat.value.refuted ? 'refuted' : 'upheld', seat.value.reasoning));
    }
    const decided = tally({ upheld, against, seats: entry.seats }, rule);
    failedVotes += decided.missing;
    const verdict: Verified<T> = {
      key: entry.key,
      item: entry.item,
      outcome: decided.outcome,
      upheld,
      against,
      missing: decided.missing,
      seats: entry.seats,
      reasons,
    };
    result[decided.outcome].push(verdict);
  }
  return { ...result, failedVotes };
}

/**
 * Try to refute every item with its own panel of `team.skeptic` seats and decide each with
 * `std.data.tally` under `rule`. The panels form the settled map `<id>/item` keyed by the item
 * keys, and each panel is the settled map `<id>/item/<key>/seat`, so seat `n` of item `key`
 * records `<id>/item/<key>/seat/<n>/verdict` (schema `std.types.Refutation`). A failed seat is
 * journaled and counted as missing for that item, so a resume decides the same way.
 *
 * The default prompt (a `std.text.brief`) gives the claim (by default a string item itself, or any
 * other item as fenced JSON) and any `context` under it, asks the skeptic to refute the claim
 * against the actual code, data or sources, and names `refuted: true` as the safe default when the
 * evidence is inconclusive. Each map item carries the rendered prompts, so a prompt change is
 * detected on resume.
 *
 * Team slot: `skeptic`, a high-effort read-only agent such as `std.roles.Skeptic`.
 *
 * @typeParam T - The item type; items must be JSON-serializable for the default claim.
 * @param ctx - The workflow context the team was bound from.
 * @param options - The scope, the team, the items, and optional key, claim, context, seats, rule
 * and prompts.
 * @returns The confirmed, refuted and undecided items, the failed seat count and the status.
 * @throws TypeError - Before any effect, when the `skeptic` slot is not filled, a seat count or
 * `concurrency` is not a positive integer, or the rule is invalid for an item's seat count.
 */
export async function verify<T>(
  ctx: WorkflowContext,
  options: VerifyOptions<T>,
): Promise<VerifyResult<T>> {
  const { skeptic } = VerifyTeam.from(options.team);
  const rule = options.rule ?? 'majority';
  const items = options.items.slice();
  const entries = verifyEntries(items, seatCounts(items, options.seats, rule), options);
  const map = settledMap<PanelRecord>(options);
  const verdicts = await ctx.scope(options.id, () =>
    runVerify(ctx, skeptic, entries, rule, map, options.calls),
  );
  return { ...verdicts, status: statusOf(verdicts.failedVotes) };
}

// ---------------------------------------------------------------------------------------------
// hunt
// ---------------------------------------------------------------------------------------------

/** The slots {@link hunt} needs: a `finder` per lens and a `skeptic` per verification seat. */
export const HuntTeam: ReturnType<typeof defineTeam<'finder' | 'skeptic'>> = defineTeam({
  finder:
    'Hunts the subject for defects through one bug lens and reports evidenced findings. Fill with a read-only reviewing entry such as std.roles.Reviewer.',
  skeptic:
    'Tries to refute one finding against the code and refutes it when unsure. Fill with a high-effort read-only entry such as std.roles.Skeptic.',
});
/** The team record {@link hunt} takes: `{ readonly finder: Agent; readonly skeptic: Agent }`. */
export type HuntTeam = TeamOf<typeof HuntTeam>;

/** Replacement prompts of {@link hunt}. */
export interface HuntPrompts extends VerifyPrompts {
  /**
   * The finder's prompt for one lens, given the subject and every finding reported in earlier
   * rounds. The default asks for evidenced findings within the lens that are not already known,
   * and allows an empty list.
   */
  readonly find?:
    ((lens: Lens, subject: string, known: readonly Finding[]) => string | Prompt) | undefined;
}

/** Options of {@link hunt}. */
export interface HuntOptions {
  /** The scope for every step this pattern records. */
  readonly id: string;
  /** The agents filling the `finder` and `skeptic` slots. */
  readonly team: HuntTeam;
  /**
   * Where to hunt, such as a directory, a list of files or a fenced diff; finders get it as their
   * context, and skeptics see it under each finding.
   */
  readonly subject: string;
  /** The lens pool to rotate through; defaults to `std.lenses.bugs`. */
  readonly lenses?: readonly Lens[] | undefined;
  /** How many lenses each round runs (a window that walks the pool); defaults to 3. */
  readonly perRound?: number | undefined;
  /** The most rounds to run; defaults to 4. */
  readonly rounds?: number | undefined;
  /**
   * How many consecutive dry rounds end the hunt once every lens of the pool has run; defaults
   * to 2.
   */
  readonly patience?: number | undefined;
  /** Skeptics per finding, or a function of the finding (called once per finding); defaults to 3. */
  readonly seats?: number | ((finding: Finding) => number) | undefined;
  /** How many upholding seats confirm a finding; defaults to `'majority'`. */
  readonly rule?: Rule | undefined;
  /**
   * The most agent calls to admit, finders and skeptic seats together; unlimited when omitted.
   * Lenses and findings the cap leaves out are logged with `ctx.log`, the skipped findings are
   * returned in `unverified`, and the hunt ends with status `'call-limit'`.
   */
  readonly maxCalls?: number | undefined;
  /** Replacement prompts. */
  readonly prompts?: HuntPrompts | undefined;
  /** How many finders, and separately how many findings' panels, run at once; defaults to 4. */
  readonly concurrency?: number | undefined;
  /** A revision for prompts and schemas the settled maps' fingerprints do not show. */
  readonly version?: string | undefined;
  /** Options applied to every agent call (placement, retry, deadlines). */
  readonly calls?: CallDefaults | undefined;
}

/** Result of {@link hunt}. */
export interface HuntResult {
  /** The confirmed findings, most severe first (discovery order within a severity). */
  readonly confirmed: Verified<Finding>[];
  /** The refuted findings, most severe first. */
  readonly refuted: Verified<Finding>[];
  /** The findings whose missing seats left the vote open, most severe first. */
  readonly undecided: Verified<Finding>[];
  /** New findings the call cap left unverified, most severe first; empty without `maxCalls`. */
  readonly unverified: Finding[];
  /** How many rounds ran. */
  readonly rounds: number;
  /** How many rounds found nothing new without a failed finder. */
  readonly dryRounds: number;
  /** How many finder calls failed; a round with a failed finder is never dry. */
  readonly failedFinders: number;
  /** How many skeptic seats failed across all findings. */
  readonly failedVotes: number;
  /** How many agent calls the hunt admitted (finders plus skeptic seats). */
  readonly callsAdmitted: number;
  /**
   * Why the hunt stopped: `'dry'` after `patience` consecutive dry rounds with every lens run,
   * `'round-limit'` after `rounds` rounds, or `'call-limit'` when `maxCalls` left work out.
   */
  readonly ended: 'dry' | 'round-limit' | 'call-limit';
  /**
   * `'call-limit'` when `maxCalls` left lenses or findings out, else `'degraded'` when a finder or
   * a seat failed, else `'complete'`.
   */
  readonly status: 'complete' | 'degraded' | 'call-limit';
}

/** A finding as one line: `file[:line]: title`. */
function findingLine(finding: Finding): string {
  const line = finding.line === null ? '' : `:${String(finding.line)}`;
  return `${finding.file}${line}: ${finding.title}`;
}

/** The default finder prompt for one lens, listing what earlier rounds already reported. */
function findPrompt(lens: Lens, subject: string, known: readonly Finding[]): string {
  const repeat =
    known.length === 0
      ? []
      : ['Do not report anything listed under Already reported, even in other words.'];
  return brief({
    task: `Hunt for defects in the subject below through one lens, ${lens.key}: ${lens.charter}`,
    context:
      known.length === 0
        ? subject
        : `${subject}\n\n${section('Already reported', bullets(known.map(findingLine)))}`,
    guidance: [
      'Read the code itself and report only defects you can demonstrate, each with file:line evidence and the concrete inputs or state that make it fail.',
      'Stay within this lens; other finders cover the other lenses.',
      ...repeat,
      'An empty list is a valid answer: do not invent findings to seem thorough.',
    ],
    output: 'The findings, most severe first.',
  });
}

/** Sort verdicts on findings most severe first, keeping discovery order within a severity. */
function severest(verdicts: readonly Verified<Finding>[]): Verified<Finding>[] {
  return rankBy(verdicts, (verdict) => verdict.item.severity, Severity.options);
}

/**
 * Hunt for defects round by round until the hunt runs dry. Round `n` runs under
 * `<id>/round/<n>`: a lens panel over `std.data.rotate(lenses, n, perRound)` asks `team.finder`
 * for `std.types.Findings` as `<id>/round/<n>/lens/<lens>/find`; the round's new findings
 * (deduplicated by `std.data.findingKey` against every earlier finding) are then verified most
 * severe first, as in {@link verify} with the subject as its `context`, at
 * `<id>/round/<n>/item/<key>/seat/<s>/verdict`. Later finders see the earlier findings in their
 * prompt, so they look for something new.
 *
 * A round is dry when it adds no new finding and no finder failed. The hunt stops after `patience`
 * consecutive dry rounds, but never before every lens of the pool has run once (a dry window says
 * nothing about the lenses it did not run); after `rounds` rounds; or when `maxCalls` cannot admit
 * the next round's lenses or a new finding's seats. The loop follows `std.flow.untilDry` but runs
 * its own rounds, so the call cap can end it early. Failed finders and seats are journaled, so a
 * resume replays the same rounds without new calls.
 *
 * Team slots: `finder`, a read-only reviewer such as `std.roles.Reviewer`; `skeptic`, a
 * high-effort read-only agent such as `std.roles.Skeptic`. The default prompts are
 * `std.text.brief`s; the skeptic's names `refuted: true` as the safe default.
 *
 * @param ctx - The workflow context the team was bound from.
 * @param options - The scope, the team and the subject, with optional lenses, round, seat and call
 * limits and prompts.
 * @returns The verified findings by outcome, the unverified ones, round and failure counts, why the
 * hunt ended and the status.
 * @throws TypeError - Before any effect, when a team slot is not filled, `lenses` is empty, a count
 * option is not a positive integer, or the rule is invalid for `seats`; during the hunt, when a
 * `seats` function returns an invalid count.
 */
export async function hunt(ctx: WorkflowContext, options: HuntOptions): Promise<HuntResult> {
  const { finder, skeptic } = HuntTeam.from(options.team);
  const { subject, calls } = options;
  const pool = nonEmpty('lenses', options.lenses ?? bugs).map((lens, index) => ({ lens, index }));
  const perRound = positiveInt('perRound', options.perRound ?? 3);
  const rounds = positiveInt('rounds', options.rounds ?? 4);
  const patience = positiveInt('patience', options.patience ?? 2);
  const maxCalls =
    options.maxCalls === undefined ? Infinity : positiveInt('maxCalls', options.maxCalls);
  const rule = options.rule ?? 'majority';
  const { seats } = options;
  if (typeof seats === 'number') seatCount(seats, rule);
  const lensMap = settledMap<PromptRecord>(options);
  const itemMap = settledMap<PanelRecord>(options);
  const find = options.prompts?.find ?? findPrompt;
  const verifyOptions = { key: findingKey, context: subject, prompts: options.prompts };

  return ctx.scope(options.id, async () => {
    const seen = new Set<string>();
    const known: Finding[] = [];
    const ranLenses = new Set<number>();
    const verdicts: VerifyTally<Finding>[] = [];
    const unverified: Finding[] = [];
    let ran = 0;
    let dryRounds = 0;
    let streak = 0;
    let failedFinders = 0;
    let callsAdmitted = 0;
    let limited = false;
    const dry = (): boolean => streak >= patience && ranLenses.size === pool.length;
    while (ran < rounds && !dry()) {
      const n = ran;
      const window = rotate(pool, n, perRound);
      const room = maxCalls - callsAdmitted;
      if (room < 1) {
        limited = true;
        ctx.log(`Call limit reached before round ${String(n)}; the hunt ends.`, {
          round: n,
          maxCalls,
        });
        break;
      }
      const picked = window.slice(0, room);
      if (picked.length < window.length) {
        limited = true;
        ctx.log(
          `Call limit: round ${String(n)} skips ${String(window.length - picked.length)} lens(es).`,
          {
            round: n,
            skipped: window.slice(picked.length).map((entry) => entry.lens.key),
          },
        );
      }
      for (const entry of picked) ranLenses.add(entry.index);
      callsAdmitted += picked.length;
      const snapshot = known.slice();
      const round = await ctx.scope(ctx.id('round', n), async () => {
        const panel = await runPanel(ctx, {
          reader: finder,
          leaf: 'find',
          lenses: picked.map((entry) => entry.lens),
          prompt: (lens) => find(lens, subject, snapshot),
          schema: Findings,
          map: lensMap,
          calls,
        });
        const reported = panel.results.flatMap((answer) => answer.value.findings);
        const added = bySeverity(fresh(reported, seen, findingKey));
        const costs = seatCounts(added, seats, rule);
        let budget = maxCalls - callsAdmitted;
        let fits = 0;
        for (const cost of costs) {
          if (cost > budget) break;
          budget -= cost;
          fits += 1;
        }
        const admitted = added.slice(0, fits);
        const entries = verifyEntries(admitted, costs.slice(0, fits), verifyOptions);
        callsAdmitted += entries.reduce((sum, entry) => sum + entry.seats, 0);
        const tallied = await runVerify(ctx, skeptic, entries, rule, itemMap, calls);
        return { failed: panel.failed.length, added, skipped: added.slice(fits), tallied };
      });
      ran += 1;
      for (const finding of round.added) known.push(finding);
      verdicts.push(round.tallied);
      if (round.skipped.length > 0) {
        limited = true;
        unverified.push(...round.skipped);
        ctx.log(
          `Call limit: round ${String(n)} leaves ${String(round.skipped.length)} finding(s) unverified.`,
          { round: n, unverified: round.skipped.map(findingLine) },
        );
      }
      if (round.failed > 0) {
        failedFinders += round.failed;
        streak = 0;
      } else if (round.added.length === 0) {
        dryRounds += 1;
        streak += 1;
      } else {
        streak = 0;
      }
      if (limited) break;
    }
    const failedVotes = verdicts.reduce((sum, tallied) => sum + tallied.failedVotes, 0);
    return {
      confirmed: severest(verdicts.flatMap((tallied) => tallied.confirmed)),
      refuted: severest(verdicts.flatMap((tallied) => tallied.refuted)),
      undecided: severest(verdicts.flatMap((tallied) => tallied.undecided)),
      unverified: bySeverity(unverified),
      rounds: ran,
      dryRounds,
      failedFinders,
      failedVotes,
      callsAdmitted,
      ended: limited ? 'call-limit' : dry() ? 'dry' : 'round-limit',
      status: limited ? 'call-limit' : statusOf(failedFinders + failedVotes),
    };
  });
}
