/**
 * Gates that decide in code from per-item agent evidence, re-exported from `std.patterns`:
 *
 * - {@link checklist} checks each acceptance criterion against a subject, one `checker` call per
 *   criterion, and decides `done`, `not-done` or `unverified`.
 * - {@link gate} assesses a subject on several dimensions (by default `std.lenses.release`), has a
 *   panel of skeptics challenge every reported blocker, and decides `go`, `conditional-go` or
 *   `no-go`.
 *
 * Both take a required `id` and record every step under it; each pattern's TSDoc lists the exact
 * step IDs. No model makes the final decision: agents report a status with evidence for one
 * criterion or dimension, and the pattern combines them by fixed rules. A failed agent call is
 * journaled and becomes data (an errored criterion, a failed dimension, a missing seat), so a
 * resume decides the same way; every result counts those failures in `failures` and reports its
 * health as `status` (`'degraded'` exactly when one occurred), apart from the decision. Each result
 * interface has a schema of the same name, {@link ChecklistResult} and {@link GateResult}, for a
 * workflow `output` or a saved result. The default prompts are `std.text.brief`s that name the safe
 * default for an unsure agent: `unverifiable` for a checker, `concern` or `cannot-check` (never
 * `pass`) for an assessor, and `refuted: true` for a skeptic.
 *
 * ```ts
 * import * as std from 'quiet-choir/std';
 *
 * const diff = await std.exec.diff(ctx, 'diff', 'main...HEAD');
 * const change = `The change in main...HEAD:\n\n${std.text.fence(diff, 'diff')}`;
 * const acceptance = await std.patterns.checklist(ctx, {
 *   id: 'acceptance',
 *   team: { checker: ctx.roster.Reviewer },
 *   subject: change,
 *   criteria: ['Invalid input is rejected with a message.', 'The new flag is documented.'],
 * });
 * const merge = await std.patterns.gate(ctx, {
 *   id: 'gate',
 *   team: { assessor: ctx.roster.Reviewer, skeptic: ctx.roster.Skeptic },
 *   subject: change,
 *   task: 'Assess whether this change is ready to merge.',
 * });
 * if (acceptance.verdict !== 'done' || merge.decision !== 'go') ctx.log('Held', merge.reasons);
 * ```
 *
 * @module
 */
import {
  defineTeam,
  z,
  type JsonValue,
  type Prompt,
  type TeamOf,
  type WorkflowContext,
} from '../index.js';
import { Health, assertUnique, tally, threshold, type Outcome, type Rule } from './data.js';
import { LensSchema, release, type Lens } from './lenses.js';
import {
  Count,
  keyed,
  nonEmpty,
  placement,
  positiveInt,
  settledMap,
  statusOf,
  type CallDefaults,
} from './pattern-kit.js';
import { brief, bullets, promptText, section } from './text.js';
import {
  Assessment,
  Criterion,
  CriterionResult,
  GateDecision,
  Outcome as OutcomeSchema,
  Refutation,
  type CheckStatus,
} from './types.js';

/**
 * A settled-map item that carries its key, the rendered prompt the mapper sends, and where the call
 * runs (see `placement`).
 */
interface PromptRecord {
  readonly key: string;
  readonly prompt: string;
  readonly placement?: JsonValue;
}

/**
 * The settled-map item of one blocker's skeptic panel: its key, one prompt per seat, and where the
 * calls run (see `placement`).
 */
interface PanelRecord {
  readonly key: string;
  readonly prompts: readonly string[];
  readonly placement?: JsonValue;
}

// ---------------------------------------------------------------------------------------------
// checklist
// ---------------------------------------------------------------------------------------------

/** The slot {@link checklist} needs: one `checker` that checks each criterion. */
export const ChecklistTeam: ReturnType<typeof defineTeam<'checker'>> = defineTeam({
  checker:
    'Checks one acceptance criterion against the subject from evidence it verifies itself and answers unverifiable when unsure. Fill with a read-only entry such as std.roles.Reviewer, or a shell entry built with std.claude.shell when criteria name commands to run.',
});
/** The team record {@link checklist} takes: `{ readonly checker: Agent }`. */
export type ChecklistTeam = TeamOf<typeof ChecklistTeam>;

/** Replacement prompts of {@link checklist}. */
export interface ChecklistPrompts {
  /**
   * The checker's prompt for one criterion against `subject`. The default asks for a status
   * decided from evidence the checker verified itself, follows the criterion's `how` when it has
   * one, and names `unverifiable` as the safe default.
   */
  readonly check?: ((criterion: Criterion, subject: string) => string | Prompt) | undefined;
}

/** Options of {@link checklist}. */
export interface ChecklistOptions {
  /** The scope for every step this pattern records. */
  readonly id: string;
  /** The agent filling the `checker` slot. */
  readonly team: ChecklistTeam;
  /**
   * What the criteria are checked against, such as a line naming a Git range followed by its
   * fenced diff, or where a deliverable lives.
   */
  readonly subject: string;
  /**
   * The criteria, one checker call each: a string, whose ID is `C<n>` from its 1-based position
   * in this list, or a `std.types.Criterion` with its own ID and `how`. IDs must be unique.
   */
  readonly criteria: readonly (string | Criterion)[];
  /** Replacement prompts. */
  readonly prompts?: ChecklistPrompts | undefined;
  /** How many criteria are checked at once; defaults to 4. */
  readonly concurrency?: number | undefined;
  /**
   * A revision for what the settled map's fingerprint does not show, such as the schema. The
   * team's agent configuration is not part of a map item either, so a completed item is reused
   * after a role changes: change `version` when you change the agent that fills a slot.
   */
  readonly version?: string | undefined;
  /** Options applied to every agent call (placement, retry, deadlines). */
  readonly calls?: CallDefaults | undefined;
}

/** One criterion's outcome in a {@link ChecklistResult}. */
export interface ChecklistEntry {
  /** The criterion, with its ID (`C<n>` for a string criterion) and `how` (empty when none). */
  readonly criterion: Criterion;
  /** The checker's status and evidence, or null when its call failed. */
  readonly result: CriterionResult | null;
}

/** The schema of a {@link ChecklistEntry}. */
export const ChecklistEntry: z.ZodType<ChecklistEntry> = z.strictObject({
  criterion: Criterion,
  result: CriterionResult.nullable(),
});

/** How many criteria of a {@link ChecklistResult} have each `std.types.CheckStatus`. */
export interface ChecklistCounts {
  /** Criteria that passed. */
  readonly pass: number;
  /** Criteria that failed. */
  readonly fail: number;
  /** Criteria that hold only in part. */
  readonly partial: number;
  /** Criteria the checker could not verify. */
  readonly unverifiable: number;
}

/** The schema of a {@link ChecklistCounts}. */
export const ChecklistCounts: z.ZodType<ChecklistCounts> = z.strictObject({
  pass: Count,
  fail: Count,
  partial: Count,
  unverifiable: Count,
});

/** Result of {@link checklist}. */
export interface ChecklistResult {
  /**
   * `'not-done'` when any criterion failed or only partly holds; otherwise `'done'` when every
   * criterion passed, else `'unverified'` (a criterion was unverifiable or its call failed).
   */
  readonly verdict: 'done' | 'not-done' | 'unverified';
  /** Every criterion with its result, in input order. */
  readonly results: ChecklistEntry[];
  /**
   * How many criteria the checker answered with each status; a criterion whose call failed is in
   * none of them.
   */
  readonly counts: ChecklistCounts;
  /** How many checker calls failed; the failures are saved, so a resume does not retry them. */
  readonly failures: number;
  /** `'complete'` when every checker call succeeded, else `'degraded'`. */
  readonly status: 'complete' | 'degraded';
}

/** The schema of a {@link ChecklistResult}, for a workflow `output` or a saved result. */
export const ChecklistResult: z.ZodType<ChecklistResult> = z.strictObject({
  verdict: z.enum(['done', 'not-done', 'unverified']),
  results: z.array(ChecklistEntry),
  counts: ChecklistCounts,
  failures: Count,
  status: Health,
});

/** The default checker prompt; it names `unverifiable` as the safe default. */
function checkPrompt(criterion: Criterion, subject: string): string {
  return brief({
    task: `Check whether acceptance criterion ${criterion.id} holds for the target below: ${criterion.criterion}`,
    context: subject,
    guidance: [
      criterion.how.trim() === ''
        ? 'Choose the most direct check: read the code the criterion concerns, or inspect or run what it names.'
        : `Check it this way: ${criterion.how}`,
      'Decide from evidence you check yourself, not from claims in commit messages, descriptions or comments.',
      'Answer pass only when that evidence shows the whole criterion holds, fail when it shows the criterion does not hold, and partial when only part of it holds.',
      'When the evidence does not settle it, or you cannot check it, answer unverifiable; that is the safe default, never pass.',
    ],
    output:
      'The status and the evidence that decided it: file:line references, command output or quotes.',
  });
}

/** Normalize and validate the criteria before any effect: IDs for strings, unique IDs. */
function criteriaOf(criteria: readonly (string | Criterion)[]): Criterion[] {
  const list = nonEmpty('criteria', criteria).map((entry, index): Criterion => {
    const at = `criteria[${String(index)}]`;
    if (typeof entry === 'string') {
      if (entry.trim() === '') throw new TypeError(`${at} must not be blank.`);
      return { id: `C${String(index + 1)}`, criterion: entry, how: '' };
    }
    const parsed = Criterion.safeParse(entry);
    if (!parsed.success) {
      const problems = parsed.error.issues.map(
        (issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
      );
      throw new TypeError(`${at} is not a valid criterion: ${problems.join('; ')}.`);
    }
    return parsed.data;
  });
  assertUnique(
    list.map((criterion) => criterion.id),
    'criterion ID',
  );
  return list;
}

/**
 * Check every acceptance criterion against `subject`, one `team.checker` call per criterion, and
 * decide the verdict in code. The calls form the settled map `<id>/criterion`, keyed by criterion
 * ID (made ID-safe), so criterion `C1` records `<id>/criterion/C1/check` (schema
 * `std.types.CriterionResult`). A failed call is journaled and counted in `failures`, and a resume
 * does not retry it.
 *
 * The verdict is `not-done` as soon as one criterion fails or holds only in part, `done` only
 * when every criterion passed, and `unverified` otherwise. The default prompt (a
 * `std.text.brief`) gives the criterion and the subject (calling it the target), follows the
 * criterion's `how`, and names
 * `unverifiable` as the safe default when the evidence does not settle it. Each map item carries
 * its rendered prompt, so a prompt change is detected on resume.
 *
 * Team slot: `checker`, a read-only agent such as `std.roles.Reviewer`, or a shell entry built
 * with `std.claude.shell` when criteria name commands to run.
 *
 * @param ctx - The workflow context the team was bound from.
 * @param options - The scope, the team, the subject and the criteria, with optional prompts.
 * @returns The verdict, every criterion with its result, the counts by status, the failure count
 * and the status.
 * @throws TypeError - Before any effect, when the `checker` slot is not filled, `criteria` is
 * empty, a string criterion is blank, a criterion object is not a valid `std.types.Criterion`, or
 * `concurrency` is not a positive integer.
 * @throws Error - Before any effect, when two criteria share an ID.
 */
export async function checklist(
  ctx: WorkflowContext,
  options: ChecklistOptions,
): Promise<ChecklistResult> {
  // Fill the slot before any effect: an unfilled slot would otherwise fail inside the settled
  // mapper and be journaled as a failed criterion instead of rejecting the run.
  const { checker } = ChecklistTeam.from(options.team);
  const criteria = criteriaOf(options.criteria);
  const map = settledMap<PromptRecord>(options);
  const { subject, calls } = options;
  const prompt = options.prompts?.check ?? checkPrompt;
  const records: PromptRecord[] = keyed(criteria, (criterion) => criterion.id).map(
    ({ key, item }) => ({ key, prompt: promptText(prompt(item, subject)), ...placement(calls) }),
  );
  const settled = await ctx.scope(options.id, () =>
    ctx.map('criterion', records, map, (record) =>
      checker.value('check', { ...calls, prompt: record.prompt, schema: CriterionResult }),
    ),
  );
  const results = criteria.map((criterion, index): ChecklistEntry => {
    const outcome = settled[index];
    if (outcome === undefined) throw new Error(`Missing settled result for ${criterion.id}.`);
    return { criterion, result: outcome.ok ? outcome.value : null };
  });
  const count = (status: CheckStatus): number =>
    results.filter((entry) => entry.result?.status === status).length;
  const counts: ChecklistCounts = {
    pass: count('pass'),
    fail: count('fail'),
    partial: count('partial'),
    unverifiable: count('unverifiable'),
  };
  const failures = results.filter((entry) => entry.result === null).length;
  return {
    verdict:
      counts.fail + counts.partial > 0
        ? 'not-done'
        : counts.pass === results.length
          ? 'done'
          : 'unverified',
    results,
    counts,
    failures,
    status: statusOf(failures),
  };
}

// ---------------------------------------------------------------------------------------------
// gate
// ---------------------------------------------------------------------------------------------

/** The slots {@link gate} needs: an `assessor` per dimension and a `skeptic` per blocker seat. */
export const GateTeam: ReturnType<typeof defineTeam<'assessor' | 'skeptic'>> = defineTeam({
  assessor:
    'Assesses the subject on one gate dimension from evidence it checks itself, never answering pass when unsure. Fill with a read-only reviewing entry such as std.roles.Reviewer.',
  skeptic:
    'Tries to refute one reported blocker and refutes it when unsure, which downgrades it to a concern. Fill with a high-effort read-only entry such as std.roles.Skeptic.',
});
/** The team record {@link gate} takes: `{ readonly assessor: Agent; readonly skeptic: Agent }`. */
export type GateTeam = TeamOf<typeof GateTeam>;

/** Replacement prompts of {@link gate}. */
export interface GatePrompts {
  /**
   * The assessor's prompt for one dimension of `subject`. The default opens with the `task`
   * option, names the dimension and its charter, and names `concern` or `cannot-check` (never
   * `pass`) as the safe default.
   */
  readonly assess?: ((dimension: Lens, subject: string) => string | Prompt) | undefined;
  /**
   * The prompt for seat `seat` (from 0) of the `seats` skeptics challenging a blocker the
   * assessor reported on `dimension`. The default gives the `task` option as the gate's question,
   * asks the skeptic to refute the blocker, and names `refuted: true` as the safe default when the
   * evidence does not establish that it must block.
   */
  readonly challenge?:
    | ((
        dimension: Lens,
        assessment: Assessment,
        subject: string,
        seat: number,
        seats: number,
      ) => string | Prompt)
    | undefined;
}

/** Options of {@link gate}. */
export interface GateOptions {
  /** The scope for every step this pattern records. */
  readonly id: string;
  /** The agents filling the `assessor` and `skeptic` slots. */
  readonly team: GateTeam;
  /** What is gated, such as a release's commit list and diff stat, or a fenced diff. */
  readonly subject: string;
  /**
   * What the gate decides, as one or two sentences: the opening of the default assessor prompt
   * (before the dimension) and the gate's question in the default skeptic prompt; defaults to
   * `Assess whether the subject below is ready to ship.`
   */
  readonly task?: string | undefined;
  /**
   * The dimensions, one assessor call each; defaults to `std.lenses.release`. A key repeated in
   * the list gets a `.2`, `.3`, ... suffix in its step IDs and in the result.
   */
  readonly dimensions?: readonly Lens[] | undefined;
  /** How many skeptics challenge each reported blocker, a positive integer; defaults to 1. */
  readonly seats?: number | undefined;
  /** How many upholding seats confirm a blocker; defaults to `'majority'`. */
  readonly rule?: Rule | undefined;
  /** Replacement prompts. */
  readonly prompts?: GatePrompts | undefined;
  /** How many dimensions, and separately how many blockers' panels, run at once; defaults to 4. */
  readonly concurrency?: number | undefined;
  /**
   * A revision for what the settled maps' fingerprints do not show, such as a schema. The team's
   * agent configuration is not part of a map item either, so a completed item is reused after a
   * role changes: change `version` when you change the agent that fills a slot.
   */
  readonly version?: string | undefined;
  /** Options applied to every agent call (placement, retry, deadlines). */
  readonly calls?: CallDefaults | undefined;
}

/** The schema of a {@link GateDisposition}. */
export const GateDisposition: z.ZodEnum<
  z.util.ToEnum<
    'pass' | 'concern' | 'blocker' | 'undecided' | 'downgraded' | 'cannot-check' | 'failed'
  >
> = z.enum(['pass', 'concern', 'blocker', 'undecided', 'downgraded', 'cannot-check', 'failed']);

/**
 * What a dimension contributes to a {@link gate} decision:
 *
 * - `pass`: assessed without a problem.
 * - `concern`: assessed with a problem that need not block.
 * - `blocker`: a reported blocker the skeptic panel confirmed.
 * - `undecided`: a reported blocker whose panel failed seats left open; it still blocks.
 * - `downgraded`: a reported blocker the panel refuted; it counts as a concern.
 * - `cannot-check`: the assessor could not assess the dimension.
 * - `failed`: the assessor call failed.
 */
export type GateDisposition =
  'pass' | 'concern' | 'blocker' | 'undecided' | 'downgraded' | 'cannot-check' | 'failed';

/** How the skeptic panel decided one reported blocker in a {@link gate}. */
export interface GateChallenge {
  /**
   * `'confirmed'` when the upholding seats reach the rule's threshold (the blocker stands),
   * `'refuted'` when they cannot reach it even if every missing seat had upheld (the blocker is
   * downgraded), else `'undecided'`.
   */
  readonly outcome: Outcome;
  /** Seats that upheld the blocker (`refuted: false`). */
  readonly upheld: number;
  /** Seats that refuted it. */
  readonly against: number;
  /** Seats whose call failed; a failed seat counts for neither side. */
  readonly missing: number;
  /** The panel size. */
  readonly seats: number;
  /** Each answering seat's reasoning in seat order, prefixed `upheld: ` or `refuted: `. */
  readonly reasons: string[];
}

/** The schema of a {@link GateChallenge}. */
export const GateChallenge: z.ZodType<GateChallenge> = z.strictObject({
  outcome: OutcomeSchema,
  upheld: Count,
  against: Count,
  missing: Count,
  seats: Count,
  reasons: z.array(z.string()),
});

/** One dimension's outcome in a {@link GateResult}. */
export interface GateDimension {
  /** The dimension's key in the step IDs and the result lists: its lens key, made unique. */
  readonly key: string;
  /** The dimension. */
  readonly lens: Lens;
  /** The assessor's status, summary and evidence, or null when its call failed. */
  readonly assessment: Assessment | null;
  /** The skeptic panel's verdict when the assessor reported a blocker, else null. */
  readonly challenge: GateChallenge | null;
  /** What the dimension contributes to the decision. */
  readonly disposition: GateDisposition;
}

/** The schema of a {@link GateDimension}. */
export const GateDimension: z.ZodType<GateDimension> = z.strictObject({
  key: z.string(),
  lens: LensSchema,
  assessment: Assessment.nullable(),
  challenge: GateChallenge.nullable(),
  disposition: GateDisposition,
});

/** Result of {@link gate}. */
export interface GateResult {
  /**
   * `'no-go'` when a blocker was confirmed or left undecided; otherwise `'conditional-go'` when a
   * dimension has a concern, a downgraded blocker, could not be checked or failed; else `'go'`.
   */
  readonly decision: GateDecision;
  /** Every dimension with its assessment, challenge and disposition, in dimension order. */
  readonly assessments: GateDimension[];
  /** Keys of the dimensions whose blocker the skeptic panel confirmed. */
  readonly blockers: string[];
  /** Keys of the dimensions whose blocker the panel left undecided (failed seats); they block. */
  readonly undecided: string[];
  /** Keys of the dimensions whose blocker the panel refuted; they count as concerns. */
  readonly downgraded: string[];
  /** Keys of the dimensions the assessor rated `concern`. */
  readonly concerns: string[];
  /** Keys of the dimensions the assessor rated `cannot-check`. */
  readonly cannotCheck: string[];
  /** Keys of the dimensions whose assessor call failed; the failures are saved and not retried. */
  readonly failed: string[];
  /**
   * Why the decision is not `go`: one line per dimension that is not a pass, in dimension order,
   * `<key> (<disposition>): <summary>`; empty for `go`.
   */
  readonly reasons: string[];
  /** How many skeptic seats failed across all blockers. */
  readonly failedVotes: number;
  /** How many assessor and skeptic calls failed: `failed.length + failedVotes`. */
  readonly failures: number;
  /** `'complete'` when every assessor and seat answered, else `'degraded'`. */
  readonly status: 'complete' | 'degraded';
}

/** The schema of a {@link GateResult}, for a workflow `output` or a saved result. */
export const GateResult: z.ZodType<GateResult> = z.strictObject({
  decision: GateDecision,
  assessments: z.array(GateDimension),
  blockers: z.array(z.string()),
  undecided: z.array(z.string()),
  downgraded: z.array(z.string()),
  concerns: z.array(z.string()),
  cannotCheck: z.array(z.string()),
  failed: z.array(z.string()),
  reasons: z.array(z.string()),
  failedVotes: Count,
  failures: Count,
  status: Health,
});

/** The default opening sentence of the assessor prompt. */
const GATE_TASK = 'Assess whether the subject below is ready to ship.';

/** The default assessor prompt; it names `concern` or `cannot-check` as the safe default. */
function assessPrompt(task: string, dimension: Lens, subject: string): string {
  return brief({
    task: `${task} Assess one dimension only, ${dimension.key}: ${dimension.charter}`,
    context: subject,
    guidance: [
      'Check the evidence yourself (the code, tests, documentation or command output) rather than trusting descriptions or commit messages.',
      'blocker: a problem you can demonstrate that must stop the subject from proceeding; concern: a problem to fix or watch that need not block; pass: you checked this dimension and found no problem, including when you confirmed that the subject does not touch it.',
      'When you are unsure, do not answer pass: answer concern for a possible problem you cannot confirm, or cannot-check when you could not assess the dimension; that is the safe default.',
      'Stay within this dimension; other assessors cover the others.',
    ],
    output:
      'The status, a summary in a few sentences, and the specific evidence for it: file:line references, command output or quotes.',
  });
}

/**
 * The default skeptic prompt for a reported blocker, with the gate's `task` as its question; it
 * names `refuted: true` as the safe default.
 */
function challengePrompt(
  task: string,
  dimension: Lens,
  assessment: Assessment,
  subject: string,
): string {
  const reported = `${assessment.summary}\n\nEvidence:\n\n${bullets(assessment.evidence)}`;
  return brief({
    task: 'Try to refute the blocker an assessor reported below. Check whether the problem is real, and whether it must stop the subject from proceeding rather than being minor, already handled or unrelated to the subject.',
    context: [
      section('Gate', task),
      section('Dimension', `${dimension.key}: ${dimension.charter}`),
      section('Reported blocker', reported),
      section('Subject', subject),
    ].join('\n\n'),
    guidance: [
      'Check the reported evidence against the actual code, tests or output yourself.',
      'Answer refuted: false only when you confirm, from evidence you checked, that the problem is real and must block.',
      'When the evidence does not establish that, refute the blocker (refuted: true); that is the safe default. A refuted blocker still counts as a concern, not a pass.',
    ],
    output:
      'Whether the blocker is refuted, and the reasoning that decided it, citing the evidence you checked.',
  });
}

/** The disposition of an assessed dimension, given its blocker panel's verdict when it has one. */
function dispositionOf(
  assessment: Assessment | null,
  challenge: GateChallenge | null,
): GateDisposition {
  if (assessment === null) return 'failed';
  if (assessment.status !== 'blocker') return assessment.status;
  if (challenge === null) throw new Error('A reported blocker has no challenge.');
  return challenge.outcome === 'confirmed'
    ? 'blocker'
    : challenge.outcome === 'refuted'
      ? 'downgraded'
      : 'undecided';
}

/**
 * Assess `subject` on every dimension, challenge each reported blocker with a panel of skeptics,
 * and decide in code. The assessments form the settled map `<id>/dimension`, keyed by lens key,
 * so dimension `k` records `<id>/dimension/<k>/assess` (schema `std.types.Assessment`). Each
 * reported blocker then gets its own settled panel inside the settled map `<id>/blocker`: seat `n`
 * of dimension `k` records `<id>/blocker/<k>/seat/<n>/verdict` (schema `std.types.Refutation`),
 * decided with `std.data.tally` under `rule`. No blocker, no `<id>/blocker` map.
 *
 * The decision: a confirmed blocker is `no-go`; so is a blocker whose panel failed seats left
 * undecided, because a gate fails closed. A refuted blocker is downgraded to a concern. Any
 * concern, downgraded blocker, `cannot-check` or failed assessor call makes it `conditional-go`,
 * with one line per such dimension in `reasons`; otherwise it is `go`. Failed calls are journaled,
 * so a resume decides the same way.
 *
 * The default prompts are `std.text.brief`s: the assessor's opens with `task`, names the dimension
 * and its charter, and names `concern` or `cannot-check` (never `pass`) as the safe default; the
 * skeptic's gives `task` as the gate's question, the dimension, the reported blocker and the
 * subject, and names `refuted: true` as the safe default. Each map item carries its rendered
 * prompts, so a prompt change is detected on resume.
 *
 * Team slots: `assessor`, a read-only reviewer such as `std.roles.Reviewer` (or a shell entry
 * built with `std.claude.shell` that can run the checks); `skeptic`, a high-effort read-only agent
 * such as `std.roles.Skeptic`.
 *
 * @param ctx - The workflow context the team was bound from.
 * @param options - The scope, the team and the subject, with optional task, dimensions, seats,
 * rule and prompts.
 * @returns The decision, every dimension's assessment and disposition, the dimension keys by
 * disposition, the reasons, the failed seat count, the failure count and the status.
 * @throws TypeError - Before any effect, when the `assessor` or `skeptic` slot is not filled,
 * `dimensions` is empty, `seats` or `concurrency` is not a positive integer, or the rule is invalid
 * for `seats`.
 */
export async function gate(ctx: WorkflowContext, options: GateOptions): Promise<GateResult> {
  // Fill both slots before any effect: an unfilled slot would otherwise fail inside a settled
  // mapper and be journaled as a failed dimension or an undecided blocker.
  const { assessor, skeptic } = GateTeam.from(options.team);
  const dimensions = nonEmpty('dimensions', options.dimensions ?? release).slice();
  const seats = positiveInt('seats', options.seats ?? 1);
  const rule = options.rule ?? 'majority';
  threshold(rule, seats);
  const dimensionMap = settledMap<PromptRecord>(options);
  const blockerMap = settledMap<PanelRecord>(options);
  const { subject, calls, version } = options;
  const task = options.task ?? GATE_TASK;
  const assess =
    options.prompts?.assess ??
    ((dimension: Lens, text: string) => assessPrompt(task, dimension, text));
  const challenge =
    options.prompts?.challenge ??
    ((dimension: Lens, assessment: Assessment, text: string) =>
      challengePrompt(task, dimension, assessment, text));
  const entries = keyed(dimensions, (dimension) => dimension.key);
  const where = placement(calls);
  const records: PromptRecord[] = entries.map(({ key, item }) => ({
    key,
    prompt: promptText(assess(item, subject)),
    ...where,
  }));

  return ctx.scope(options.id, async () => {
    const assessed = await ctx.map('dimension', records, dimensionMap, (record) =>
      assessor.value('assess', { ...calls, prompt: record.prompt, schema: Assessment }),
    );
    const assessments = entries.map(({ key, item, index }) => {
      const outcome = assessed[index];
      if (outcome === undefined) throw new Error(`Missing settled result for dimension ${key}.`);
      return { key, lens: item, assessment: outcome.ok ? outcome.value : null };
    });
    const panels: PanelRecord[] = [];
    for (const { key, lens, assessment } of assessments) {
      if (assessment?.status !== 'blocker') continue;
      const prompts = Array.from({ length: seats }, (_unused, seat) =>
        promptText(challenge(lens, assessment, subject, seat, seats)),
      );
      panels.push({ key, prompts, ...where });
    }
    const challenged =
      panels.length === 0
        ? []
        : await ctx.map('blocker', panels, blockerMap, (record) =>
            ctx.map(
              'seat',
              record.prompts.map((prompt, seat): PromptRecord => ({
                key: String(seat),
                prompt,
                ...where,
              })),
              {
                concurrency: record.prompts.length,
                key: (seat) => seat.key,
                onError: 'return',
                version,
              },
              (seat) =>
                skeptic.value('verdict', { ...calls, prompt: seat.prompt, schema: Refutation }),
            ),
          );
    const challenges = new Map<string, GateChallenge>();
    let failedVotes = 0;
    for (const [index, panel] of panels.entries()) {
      const outcome = challenged[index];
      if (outcome === undefined)
        throw new Error(`Missing settled result for blocker ${panel.key}.`);
      let upheld = 0;
      let against = 0;
      const reasons: string[] = [];
      for (const seat of outcome.ok ? outcome.value : []) {
        if (!seat.ok) continue;
        if (seat.value.refuted) against += 1;
        else upheld += 1;
        reasons.push(`${seat.value.refuted ? 'refuted' : 'upheld'}: ${seat.value.reasoning}`);
      }
      const decided = tally({ upheld, against, seats }, rule);
      failedVotes += decided.missing;
      challenges.set(panel.key, { ...decided, reasons });
    }

    const results = assessments.map(({ key, lens, assessment }): GateDimension => {
      const verdict = challenges.get(key) ?? null;
      return {
        key,
        lens,
        assessment,
        challenge: verdict,
        disposition: dispositionOf(assessment, verdict),
      };
    });
    const keysOf = (disposition: GateDisposition): string[] =>
      results.filter((entry) => entry.disposition === disposition).map((entry) => entry.key);
    const blockers = keysOf('blocker');
    const undecided = keysOf('undecided');
    const failed = keysOf('failed');
    const reasons = results
      .filter((entry) => entry.disposition !== 'pass')
      .map(
        (entry) =>
          `${entry.key} (${entry.disposition}): ${entry.assessment?.summary ?? 'The assessor call failed.'}`,
      );
    return {
      decision:
        blockers.length + undecided.length > 0
          ? 'no-go'
          : reasons.length > 0
            ? 'conditional-go'
            : 'go',
      assessments: results,
      blockers,
      undecided,
      downgraded: keysOf('downgraded'),
      concerns: keysOf('concern'),
      cannotCheck: keysOf('cannot-check'),
      failed,
      reasons,
      failedVotes,
      failures: failed.length + failedVotes,
      status: statusOf(failed.length + failedVotes),
    };
  });
}
