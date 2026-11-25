/**
 * Patterns that improve work until it passes a bar, re-exported from `std.patterns`:
 *
 * - {@link critiqueRevise}: critics (optionally one per {@link Lens}) critique a draft against its
 *   brief, and an author revises it until no issue remains or the rounds run out.
 * - {@link fixUntilGreen}: run a check command, and while it fails let a mechanic, then a surgeon,
 *   fix the code; only the command decides success.
 * - {@link escalate}: give a task to a mechanic, check the result with the caller's `accept`, and
 *   hand rejected or failed work to a surgeon.
 *
 * Each pattern takes a required `id` and records every step under it, with deterministic round and
 * attempt scopes, so a resume replays completed calls and commands. Tolerated failures (a critic, a
 * fixer or an attempt whose call failed) are journaled as settled outcomes and counted in the
 * result, so a resume makes the same decision instead of retrying them. Every result counts them in
 * `failures` and reports its health as `status` (`'degraded'` exactly when one occurred); what the
 * pattern decided is in a named field (`approved`, `outcome`). Every result interface has a schema
 * of the same name, for a workflow `output` or a saved result: {@link CritiqueReviseResult} and
 * {@link FixUntilGreenResult} are schemas, and {@link EscalateResult} is a factory that takes the
 * value schema.
 *
 * ```ts
 * import * as std from 'quiet-choir/std';
 *
 * const polished = await std.patterns.critiqueRevise(ctx, {
 *   id: 'notes',
 *   team: { critic: ctx.roster.Critic, author: ctx.roster.Writer },
 *   brief: 'Release notes for 2.0 that a user can act on.',
 *   lenses: std.lenses.writing,
 * });
 * const repaired = await std.patterns.fixUntilGreen(ctx, {
 *   id: 'tests',
 *   team: { mechanic: ctx.roster.Mechanic, surgeon: ctx.roster.Surgeon },
 *   check: ['npm', 'test'],
 * });
 * ```
 *
 * @module
 */
import {
  defineTeam,
  type Command,
  type ExecOptions,
  type JsonValue,
  type Prompt,
  type TeamOf,
  type WorkflowContext,
  type WorktreeHandle,
  z,
} from '../index.js';
import { Health } from './data.js';
import { check, json } from './exec.js';
import type { Lens } from './lenses.js';
import {
  Count,
  keyed,
  nonEmpty,
  nonNegativeInt,
  placement,
  positiveInt,
  settledMap,
  statusOf,
  type CallDefaults,
} from './pattern-kit.js';
import { brief as briefText, bullets, fence, promptText } from './text.js';
import { CheckOutcome, Critique, Issue, WorkReport } from './types.js';

// ---------------------------------------------------------------------------------------------
// critiqueRevise
// ---------------------------------------------------------------------------------------------

/** The slots {@link critiqueRevise} needs: a `critic` that critiques and an `author` that writes. */
export const CritiqueTeam: ReturnType<typeof defineTeam<'critic' | 'author'>> = defineTeam({
  critic:
    'Critiques a draft against its brief and returns issues with concrete fixes (an empty list approves); does not edit. Fill with a read-only entry such as std.roles.Critic.',
  author:
    'Writes the first draft from the brief and revises it to resolve the issues raised, returning the complete text. Fill with a writing entry such as std.roles.Writer, or std.roles.Scribe when it should check sources.',
});
/** The team record {@link critiqueRevise} takes: `{ readonly critic: Agent; readonly author: Agent }`. */
export type CritiqueTeam = TeamOf<typeof CritiqueTeam>;

/** Replacement prompts for {@link critiqueRevise}; each may return text or a rendered {@link Prompt}. */
export interface CritiqueRevisePrompts {
  /** The author's prompt for the first draft, used only when `draft` is omitted. */
  readonly draft?: ((brief: string) => string | Prompt) | undefined;
  /** A critic's prompt for `draft`: through `lens`, or a general critique when `lens` is null. */
  readonly critique?:
    ((draft: string, brief: string, lens: Lens | null) => string | Prompt) | undefined;
  /** The author's prompt to revise `draft` so that it resolves `issues`. */
  readonly revise?:
    ((draft: string, issues: readonly Issue[], brief: string) => string | Prompt) | undefined;
}

/** Options of {@link critiqueRevise}. */
export interface CritiqueReviseOptions {
  /** The scope for every step this pattern records. */
  readonly id: string;
  /** The agents filling the critic and author slots. */
  readonly team: CritiqueTeam;
  /** What the draft must achieve: its purpose, audience and requirements. Critics judge against it. */
  readonly brief: string;
  /** The draft to critique first; omitted, the author writes one from the brief as `<id>/draft`. */
  readonly draft?: string | undefined;
  /**
   * The most critique rounds, a positive integer; defaults to 2. A revision follows every round
   * with issues except the last, so the returned draft has always been critiqued.
   */
  readonly rounds?: number | undefined;
  /**
   * One critic call per lens per round, such as `std.lenses.writing`; omitted, one general critic
   * call per round.
   */
  readonly lenses?: readonly Lens[] | undefined;
  /** Replacement prompts. */
  readonly prompts?: CritiqueRevisePrompts | undefined;
  /** The bound on concurrent lens critics; defaults to 4. */
  readonly concurrency?: number | undefined;
  /**
   * A revision for what the lens maps' fingerprints do not show, such as the schema. The team's
   * agent configuration is not part of a map item either, so a completed item is reused after a
   * role changes: change `version` when you change the agent that fills a slot.
   */
  readonly version?: string | undefined;
  /** Options applied to every agent call (placement, retry, deadlines). */
  readonly calls?: CallDefaults | undefined;
}

/** Result of {@link critiqueRevise}. */
export interface CritiqueReviseResult {
  /** The approved draft, or the last critiqued draft when none was approved. */
  readonly draft: string;
  /** Whether every critic of the last round answered and none raised an issue. */
  readonly approved: boolean;
  /** How many critique rounds ran. */
  readonly rounds: number;
  /** How many revisions the author made. */
  readonly revisions: number;
  /** The issues the last round raised, open in `draft`; empty when approved. */
  readonly issues: Issue[];
  /** Critic calls that failed, over all rounds; each is saved, so a resume does not retry it. */
  readonly failedCritics: number;
  /** How many critic calls failed: the same as `failedCritics`. */
  readonly failures: number;
  /**
   * `'complete'` when every critic call answered, else `'degraded'`. Whether the draft was approved
   * is `approved`; open issues are in `issues`.
   */
  readonly status: 'complete' | 'degraded';
}

/** The schema of a {@link CritiqueReviseResult}, for a workflow `output` or a saved result. */
export const CritiqueReviseResult: z.ZodType<CritiqueReviseResult> = z.strictObject({
  draft: z.string(),
  approved: z.boolean(),
  rounds: Count,
  revisions: Count,
  issues: z.array(Issue),
  failedCritics: Count,
  failures: Count,
  status: Health,
});

/** The author's default first-draft prompt. */
function draftPrompt(brief: string): string {
  return briefText({
    task: 'Write a draft that meets the brief below.',
    context: `### Brief\n\n${brief}`,
    guidance: [
      'Cover everything the brief asks for, and nothing it does not.',
      'Do not invent facts the brief does not give; leave a clearly marked gap instead.',
    ],
    output:
      'Only the draft itself as plain text, not wrapped in a code fence, with no preamble, notes or closing remarks.',
  });
}

/** A critic's default prompt, through `lens` or general when it is null. */
function critiquePrompt(draft: string, brief: string, lens: Lens | null): string {
  const focus =
    lens === null
      ? []
      : [
          `Focus only on ${lens.key}: ${lens.charter}`,
          'Other critics cover the other aspects; do not report issues outside this focus.',
        ];
  return briefText({
    task:
      lens === null
        ? 'Critique the draft below against its brief.'
        : `Critique the draft below against its brief, through one lens: ${lens.key}.`,
    context: `### Brief\n\n${brief}\n\n### Draft\n\n${fence(draft)}`,
    guidance: [
      ...focus,
      'Raise only issues that keep the draft from meeting its brief: errors, gaps, and unclear or unsupported passages, not matters of taste.',
      'For each issue, say where it is, what is wrong and the concrete fix.',
      'When you are unsure whether the draft meets a requirement of the brief, raise it as an issue: the safe default is not to approve.',
    ],
    output: 'The issues, most important first. An empty list approves the draft.',
  });
}

/** The author's default revision prompt. */
function revisePrompt(draft: string, issues: readonly Issue[], brief: string): string {
  const listed = issues.map((issue) => `${issue.where}: ${issue.problem}\nFix: ${issue.fix}`);
  return briefText({
    task: 'Revise the draft below so that it resolves every listed issue.',
    context: `### Brief\n\n${brief}\n\n### Draft\n\n${fence(draft)}\n\n### Issues\n\n${bullets(listed)}`,
    guidance: [
      'Resolve each issue with its fix, or with another change that resolves it as well.',
      'Keep what no issue mentions unchanged, and stay within the brief.',
    ],
    output:
      'Only the complete revised draft as plain text, not wrapped in a code fence, with no preamble, notes or closing remarks.',
  });
}

/** One lens critic's settled-map item: its key, the rendered prompt and the call placement. */
interface CriticRecord {
  /** The lens's unique map key. */
  readonly key: string;
  /** The critic's rendered prompt. */
  readonly prompt: string;
  /** Where the call runs (see `placement`), so a change is seen by the map fingerprint. */
  readonly placement?: JsonValue;
}

/** What one critique round produced. */
interface RoundCritique {
  /** Every issue the critics that answered raised, in lens order. */
  readonly issues: Issue[];
  /** How many critic calls failed. */
  readonly failed: number;
}

/**
 * Critique and revise a draft until the critics approve it or the rounds run out. Round `n` (from
 * 0) critiques the current draft, and when it raises issues and is not the last round the author
 * revises the draft to resolve them. A round approves when every critic answered and none raised
 * an issue; a round whose critics raised nothing but where one failed does not approve, and the
 * next round critiques the same draft again. The last round is never followed by an unreviewed
 * revision, so running out returns the last critiqued draft with its open issues as data.
 *
 * Steps, all under `<id>/`:
 *
 * - `draft`: the author's first draft (text), only when `draft` is omitted.
 * - `round/<n>/critique`: the critic, without `lenses` (settled, `std.types.Critique`).
 * - `round/<n>/lens/<key>/critique`: with `lenses`, one critic per lens in the settled map
 *   `round/<n>/lens`, keyed by the lens key (made unique with `std.data.uniqueKeys`).
 * - `round/<n>/revise`: the author's revision (text) after a round with issues, except the last.
 *
 * Team slots: `critic` (suggested `std.roles.Critic`) and `author` (`std.roles.Writer`, or
 * `std.roles.Scribe` to check sources).
 *
 * @param ctx - The workflow context the team was bound from.
 * @param options - The scope, team and brief, plus the optional first draft, rounds, lenses,
 * prompts, concurrency, version and call defaults.
 * @returns The final draft, whether it was approved, the round and revision counts, the open
 * issues, the failed critic count (also as `failures`) and the status.
 * @throws TypeError - Before any effect, when the `critic` or `author` slot is not filled, the brief
 * is blank, `rounds` or `concurrency` is not a positive integer, or `lenses` is empty.
 * @throws Error - The error of a failed author call (the first draft or a revision): only critics
 * are tolerated, so a resume retries the author's call.
 */
export async function critiqueRevise(
  ctx: WorkflowContext,
  options: CritiqueReviseOptions,
): Promise<CritiqueReviseResult> {
  const team = CritiqueTeam.from(options.team);
  const { brief, calls } = options;
  if (brief.trim() === '') throw new TypeError('critiqueRevise needs a nonblank brief.');
  const rounds = positiveInt('rounds', options.rounds ?? 2);
  const fanOut = settledMap<CriticRecord>(options);
  const lenses =
    options.lenses === undefined
      ? null
      : keyed(nonEmpty('lenses', options.lenses), (lens) => lens.key);
  const draftFor = options.prompts?.draft ?? draftPrompt;
  const critiqueFor = options.prompts?.critique ?? critiquePrompt;
  const reviseFor = options.prompts?.revise ?? revisePrompt;

  const critique = async (draft: string): Promise<RoundCritique> => {
    if (lenses === null) {
      const settled = await team.critic.value('critique', {
        ...calls,
        prompt: critiqueFor(draft, brief, null),
        schema: Critique,
        onError: 'return',
      });
      return settled.ok ? { issues: settled.value.issues, failed: 0 } : { issues: [], failed: 1 };
    }
    const records: CriticRecord[] = lenses.map(({ key, item }) => ({
      key,
      prompt: promptText(critiqueFor(draft, brief, item)),
      ...placement(calls),
    }));
    const settled = await ctx.map('lens', records, fanOut, (record) =>
      team.critic.value('critique', { ...calls, prompt: record.prompt, schema: Critique }),
    );
    const issues: Issue[] = [];
    let failed = 0;
    for (const result of settled) {
      if (result.ok) issues.push(...result.value.issues);
      else failed += 1;
    }
    return { issues, failed };
  };

  return ctx.scope(options.id, async () => {
    let draft =
      options.draft ?? (await team.author.value('draft', { ...calls, prompt: draftFor(brief) }));
    let failedCritics = 0;
    let revisions = 0;
    let last: RoundCritique = { issues: [], failed: 0 };
    let ran = 0;
    while (ran < rounds) {
      const round = ran;
      const current = draft;
      last = await ctx.scope(ctx.id('round', round), async () => {
        const found = await critique(current);
        if (found.issues.length > 0 && round + 1 < rounds) {
          draft = await team.author.value('revise', {
            ...calls,
            prompt: reviseFor(current, found.issues, brief),
          });
          revisions += 1;
        }
        return found;
      });
      ran += 1;
      failedCritics += last.failed;
      if (last.failed > 0)
        ctx.log(
          `${options.id}: ${String(last.failed)} critic call(s) failed in round ${String(round)}`,
        );
      if (last.issues.length === 0 && last.failed === 0) break;
    }
    return {
      draft,
      approved: last.issues.length === 0 && last.failed === 0,
      rounds: ran,
      revisions,
      issues: last.issues,
      failedCritics,
      failures: failedCritics,
      status: statusOf(failedCritics),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Shared by fixUntilGreen and escalate
// ---------------------------------------------------------------------------------------------

/** The schema of an {@link EscalationSlot}. */
export const EscalationSlot: z.ZodEnum<z.util.ToEnum<'mechanic' | 'surgeon'>> = z.enum([
  'mechanic',
  'surgeon',
]);

/** The slots of {@link RepairTeam} and {@link EscalationTeam}: who did a piece of work. */
export type EscalationSlot = 'mechanic' | 'surgeon';

/** The guidance line every default implementer prompt ends with. */
const HONEST_REPORT =
  'Report honestly: your work is checked independently, and an honest partial or blocked report is worth more than a false claim of success.';

/**
 * A command as prompt text: the shell program, or the argv joined by spaces (JSON when an argument
 * needs quoting). The fix prompt fences a multi-line shell program.
 */
function commandText(command: Command): string {
  if ('shell' in command) return command.shell;
  return command.every((arg) => /^[\w@%+=:,./-]+$/u.test(arg))
    ? command.join(' ')
    : JSON.stringify(command);
}

// ---------------------------------------------------------------------------------------------
// fixUntilGreen
// ---------------------------------------------------------------------------------------------

/** The slots {@link fixUntilGreen} needs: a `mechanic` for the early rounds, a `surgeon` for the rest. */
export const RepairTeam: ReturnType<typeof defineTeam<EscalationSlot>> = defineTeam({
  mechanic:
    'Fixes the failing check in the early rounds by editing files. Fill with an editing entry such as std.roles.Mechanic.',
  surgeon:
    'Takes over the later rounds when the check still fails, finding the root cause first. Fill with a stronger editing entry such as std.roles.Surgeon, or with the mechanic to never escalate.',
});
/** The team record {@link fixUntilGreen} takes: `{ readonly mechanic: Agent; readonly surgeon: Agent }`. */
export type RepairTeam = TeamOf<typeof RepairTeam>;

/** One fix round of {@link fixUntilGreen}. */
export interface FixRound {
  /** The round, from 1; `checks[round]` is the check that followed it. */
  readonly round: number;
  /** The slot that made the fix. */
  readonly slot: EscalationSlot;
  /** The fixer's report, or null when its call failed. Only the check decides success. */
  readonly report: WorkReport | null;
  /** The failed call's message, or null when the call succeeded. */
  readonly error: string | null;
}

/** The schema of a {@link FixRound}. */
export const FixRound: z.ZodType<FixRound> = z.strictObject({
  round: Count,
  slot: EscalationSlot,
  report: WorkReport.nullable(),
  error: z.string().nullable(),
});

/** What the fix prompt of {@link fixUntilGreen} is built from. */
export interface FixPromptInput {
  /** The fix round, from 1. */
  readonly round: number;
  /** The slot making this fix. */
  readonly slot: EscalationSlot;
  /** The check command. */
  readonly command: Command;
  /** The failing check this round must fix. */
  readonly failure: CheckOutcome;
  /** The caller's `task`, or null. */
  readonly task: string | null;
  /** The earlier fix rounds, oldest first. */
  readonly earlier: readonly FixRound[];
}

/** Options of {@link fixUntilGreen}. */
export interface FixUntilGreenOptions {
  /** The scope for every step this pattern records. */
  readonly id: string;
  /** The agents filling the mechanic and surgeon slots. */
  readonly team: RepairTeam;
  /** The check command, such as `['npm', 'test']`; it passes when it exits 0 (see `exec`). */
  readonly check: Command;
  /** The most fix rounds, a positive integer; defaults to 3. */
  readonly rounds?: number | undefined;
  /**
   * How many of the first rounds use the mechanic, from 0 to `rounds`; later rounds use the
   * surgeon. Defaults to `rounds - 1`, so only the last round escalates.
   */
  readonly escalateAfter?: number | undefined;
  /** What the change being checked is for, given to every fixer as context. */
  readonly task?: string | undefined;
  /**
   * A shared checkout for the check and both agents. Set it here rather than in `calls`, which
   * would leave the check running outside the agents' checkout.
   */
  readonly worktree?: WorktreeHandle | undefined;
  /** Options for every check command, such as `cwd`, `env`, `timeoutMs` or `okExitCodes`. */
  readonly exec?: Omit<ExecOptions, 'onError' | 'worktree'> | undefined;
  /** Replacement prompts. */
  readonly prompts?:
    | {
        /** The fixer's prompt for one round. */
        readonly fix?: ((request: FixPromptInput) => string | Prompt) | undefined;
      }
    | undefined;
  /** Options applied to every agent call (placement, retry, deadlines). */
  readonly calls?: CallDefaults | undefined;
}

/** Result of {@link fixUntilGreen}. */
export interface FixUntilGreenResult {
  /** `'green'` when the last check passed, else `'red'`. */
  readonly outcome: 'green' | 'red';
  /** How many fix rounds ran; 0 when the first check passed. */
  readonly rounds: number;
  /**
   * The slot whose fix made the check pass; null when the check passed at first, never passed, or
   * passed after a round whose fix call failed (that round's entry in `fixes` has the error).
   */
  readonly fixedBy: EscalationSlot | null;
  /** Every check outcome: `checks[0]` before any fix, `checks[n]` after round `n`. */
  readonly checks: CheckOutcome[];
  /** Every fix round, in order. */
  readonly fixes: FixRound[];
  /** Fix calls that failed; the loop went on to the next check, and a resume does not retry them. */
  readonly failedFixes: number;
  /** How many fix calls failed: the same as `failedFixes`. */
  readonly failures: number;
  /**
   * `'complete'` when every fix call answered, else `'degraded'`. Whether the check passed is
   * `outcome`: only the command decides it.
   */
  readonly status: 'complete' | 'degraded';
}

/**
 * The schema of a {@link FixUntilGreenResult}, for a workflow `output` or a saved result:
 * `defineWorkflow({ output: std.patterns.FixUntilGreenResult, ... })`.
 */
export const FixUntilGreenResult: z.ZodType<FixUntilGreenResult> = z.strictObject({
  outcome: z.enum(['green', 'red']),
  rounds: Count,
  fixedBy: EscalationSlot.nullable(),
  checks: z.array(CheckOutcome),
  fixes: z.array(FixRound),
  failedFixes: Count,
  failures: Count,
  status: Health,
});

/** One earlier fix round as a prompt line. */
function earlierLine(fix: FixRound): string {
  const outcome =
    fix.report === null
      ? `the call failed (${fix.error ?? 'no message'})`
      : `reported ${fix.report.status}: ${fix.report.summary}`;
  return `Round ${String(fix.round)} (${fix.slot}): ${outcome}. The check still failed.`;
}

/** The fixer's default prompt. */
function fixPrompt(request: FixPromptInput): string {
  const { failure, earlier } = request;
  const exit =
    failure.code !== null
      ? `exit code ${String(failure.code)}`
      : failure.signal !== null
        ? `signal ${failure.signal}`
        : 'no exit code';
  const context = [
    ...(request.task === null ? [] : [`### Task\n\n${request.task}`]),
    `### Last run\n\nThe check failed with ${exit}${failure.truncated ? '; this is the end of its output' : ''}:\n\n${fence(failure.output)}`,
    ...(earlier.length === 0 ? [] : [`### Earlier rounds\n\n${bullets(earlier.map(earlierLine))}`]),
  ];
  const shown = commandText(request.command);
  return briefText({
    task: shown.includes('\n')
      ? `Make this check pass:\n\n${fence(shown, 'sh')}`
      : `Make this check pass: ${shown}`,
    context: context.join('\n\n'),
    guidance: [
      'Find the root cause of the failure and fix it with the smallest change that does so.',
      'Do not weaken, skip or delete tests or checks, or change the check command, to make it pass.',
      ...(earlier.length === 0
        ? []
        : [
            'Earlier rounds did not make the check pass: see what they changed before you change more.',
          ]),
      'The workflow runs the check again after you finish and trusts only its result.',
      HONEST_REPORT,
    ],
    output:
      'A work report: done only when you expect the check to pass now, else partial or blocked; the cause and the fix; the files you changed; and what stopped you, if anything.',
  });
}

/**
 * Run a check command and, while it fails, have an agent fix the code and run it again. Only the
 * command decides: an agent's report never makes the result green. The first `escalateAfter`
 * rounds go to the mechanic and the rest to the surgeon; a fix call that fails is journaled and the
 * loop goes on to the next check. Checks run through `std.exec.check`, so a failing command is
 * data and its output's end is shown to the next fixer, with the earlier rounds' reports.
 *
 * Steps, all under `<id>/`:
 *
 * - `check/<n>`: the check command after `n` fixes (`check/0` before any), a settled command.
 * - `fix/<n>`: round `n`'s fix (from 1), a settled `std.types.WorkReport` call to the mechanic or
 *   the surgeon.
 *
 * Team slots: `mechanic` (suggested `std.roles.Mechanic`) and `surgeon` (`std.roles.Surgeon`).
 * Fill both with one agent to never escalate. Under `requireGrants`, both need write grants.
 *
 * @param ctx - The workflow context the team was bound from.
 * @param options - The scope, team and check command, plus the optional rounds, escalation point,
 * task, shared worktree, command options, prompts and call defaults.
 * @returns Whether the check ended green, the rounds run, which slot fixed it, every check outcome
 * and fix round, the failed fix count (also as `failures`) and the status.
 * @throws TypeError - Before any effect, when the `mechanic` or `surgeon` slot is not filled,
 * `rounds` is not a positive integer, `escalateAfter` is not an integer from 0 to `rounds`, `task`
 * is blank, or `calls.worktree` is set without `worktree`.
 */
export async function fixUntilGreen(
  ctx: WorkflowContext,
  options: FixUntilGreenOptions,
): Promise<FixUntilGreenResult> {
  const team = RepairTeam.from(options.team);
  const rounds = positiveInt('rounds', options.rounds ?? 3);
  const escalateAfter = nonNegativeInt('escalateAfter', options.escalateAfter ?? rounds - 1);
  if (escalateAfter > rounds)
    throw new TypeError(
      `escalateAfter must be at most rounds (${String(rounds)}); got ${String(escalateAfter)}.`,
    );
  const { worktree, calls } = options;
  if (calls?.worktree !== undefined && worktree === undefined)
    throw new TypeError(
      'fixUntilGreen runs the check where the fixers work: pass a shared checkout as worktree, not calls.worktree.',
    );
  const command = options.check;
  const task = options.task ?? null;
  if (task?.trim() === '')
    throw new TypeError('fixUntilGreen needs a nonblank task when one is given.');
  const promptFor = options.prompts?.fix ?? fixPrompt;
  const execOptions: Omit<ExecOptions, 'onError'> =
    worktree === undefined ? { ...options.exec } : { ...options.exec, worktree };
  const placement = worktree === undefined ? {} : { worktree };
  return ctx.scope(options.id, async () => {
    let last = await check(ctx, ctx.id('check', 0), command, execOptions);
    const checks: CheckOutcome[] = [last];
    const fixes: FixRound[] = [];
    let fixedBy: EscalationSlot | null = null;
    let round = 0;
    while (!last.passed && round < rounds) {
      round += 1;
      const slot: EscalationSlot = round <= escalateAfter ? 'mechanic' : 'surgeon';
      const prompt = promptFor({
        round,
        slot,
        command,
        failure: last,
        task,
        earlier: fixes.slice(),
      });
      const settled = await team[slot].value(ctx.id('fix', round), {
        ...calls,
        ...placement,
        prompt,
        schema: WorkReport,
        onError: 'return',
      });
      fixes.push(
        settled.ok
          ? { round, slot, report: settled.value, error: null }
          : { round, slot, report: null, error: settled.error.message },
      );
      if (!settled.ok) ctx.log(`${options.id}: the ${slot}'s fix ${String(round)} failed`);
      last = await check(ctx, ctx.id('check', round), command, execOptions);
      checks.push(last);
      // A failed call reported no fix, so a pass after it (edits made before the failure, or a
      // flaky check) is credited to no slot; `fixes` shows the failed round.
      if (last.passed && settled.ok) fixedBy = slot;
    }
    const failedFixes = fixes.filter((fix) => fix.report === null).length;
    return {
      outcome: last.passed ? 'green' : 'red',
      rounds: round,
      fixedBy,
      checks,
      fixes,
      failedFixes,
      failures: failedFixes,
      status: statusOf(failedFixes),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// escalate
// ---------------------------------------------------------------------------------------------

/** The slots {@link escalate} needs: a `mechanic` that tries first and a `surgeon` that takes over. */
export const EscalationTeam: ReturnType<typeof defineTeam<EscalationSlot>> = defineTeam({
  mechanic:
    'Makes the first attempt at the task. Fill with an editing entry such as std.roles.Mechanic.',
  surgeon:
    'Takes over after a rejected or failed attempt, starting from what that attempt did. Fill with a stronger entry such as std.roles.Surgeon.',
});
/** The team record {@link escalate} takes: `{ readonly mechanic: Agent; readonly surgeon: Agent }`. */
export type EscalationTeam = TeamOf<typeof EscalationTeam>;

/** What an attempt's prompt in {@link escalate} is built from. */
export interface AttemptPromptInput<V> {
  /** The caller's task. */
  readonly task: string;
  /** The attempt, from 0. */
  readonly attempt: number;
  /** The slot making this attempt. */
  readonly slot: EscalationSlot;
  /** The previous attempt's value, or null on the first attempt or when its call failed. */
  readonly previous: V | null;
  /** Why the previous attempt was not accepted, or null on the first attempt. */
  readonly problems: string | null;
}

/**
 * Decide whether an attempt's value is acceptable: `true` accepts it, and a string rejects it with
 * the problems the next attempt should fix. It runs inside the attempt's scope, so its own effects
 * use fixed leaves (any but `work`), such as `std.exec.check(ctx, 'tests', argv)` recording
 * `<id>/attempt/<n>/tests`. A resume runs it again, so build its decision from the value and
 * durable effects only, never from files or state read outside an effect.
 */
export type AcceptCheck<V> = (
  value: V,
  slot: EscalationSlot,
  attempt: number,
) => Promise<true | string> | true | string;

/** Options of {@link escalate}. */
export interface EscalateOptions<V> {
  /** The scope for every step this pattern records. */
  readonly id: string;
  /** The agents filling the mechanic and surgeon slots. */
  readonly team: EscalationTeam;
  /** The work to do, as the opening of every attempt's prompt. */
  readonly task: string;
  /** The schema of an attempt's value; defaults to `std.types.WorkReport`. */
  readonly schema?: z.ZodType<V> | undefined;
  /** The caller's independent check of each attempt's value. */
  readonly accept: AcceptCheck<V>;
  /** The most attempts, a positive integer; defaults to 2. */
  readonly attempts?: number | undefined;
  /** The slot of the first attempt; defaults to `'mechanic'`. Later attempts use the surgeon. */
  readonly start?: EscalationSlot | undefined;
  /** Replacement prompts. */
  readonly prompts?:
    | {
        /** The prompt for one attempt. */
        readonly work?: ((request: AttemptPromptInput<V>) => string | Prompt) | undefined;
      }
    | undefined;
  /**
   * Options applied to every agent call (placement, retry, deadlines). Attempts hand work on through
   * the files, and an attempt returns only its value: a fresh checkout per call (`worktree: true`
   * or `{ base }`) would discard each attempt's changes, so share a `ctx.worktree` handle instead.
   */
  readonly calls?: CallDefaults | undefined;
}

/** Result of {@link escalate}. */
export interface EscalateResult<V> {
  /** `'accepted'` when `accept` returned true for an attempt, else `'rejected'`. */
  readonly outcome: 'accepted' | 'rejected';
  /** The slot of the accepted attempt, or of the last attempt when none was accepted. */
  readonly slot: EscalationSlot;
  /** How many attempts ran. */
  readonly attempts: number;
  /** The accepted value, or the last attempt's value (null when its call failed). */
  readonly value: V | null;
  /** The last attempt's problems, or null when accepted. */
  readonly problems: string | null;
  /** Attempts whose agent call failed; each is saved, so a resume does not retry it. */
  readonly failedCalls: number;
  /** How many attempt calls failed: the same as `failedCalls`. */
  readonly failures: number;
  /**
   * `'complete'` when every attempt's call answered, else `'degraded'`. Whether an attempt was
   * accepted is `outcome`.
   */
  readonly status: 'complete' | 'degraded';
}

/**
 * The schema of an {@link EscalateResult}, for a workflow `output` or a saved result.
 *
 * @typeParam V - The attempt value type.
 * @param value - The schema of an attempt's value: the `schema` the attempts ran with. Omitted,
 * `std.types.WorkReport`, as {@link escalate} defaults to.
 * @returns A strict object schema of the result.
 */
export function EscalateResult<V = WorkReport>(value?: z.ZodType<V>): z.ZodType<EscalateResult<V>> {
  const schema = (value ?? WorkReport) as z.ZodType<V>;
  return z.strictObject({
    outcome: z.enum(['accepted', 'rejected']),
    slot: EscalationSlot,
    attempts: Count,
    value: schema.nullable(),
    problems: z.string().nullable(),
    failedCalls: Count,
    failures: Count,
    status: Health,
  });
}

/** The honesty guidance of a default attempt prompt whose value is not a `std.types.WorkReport`. */
const HONEST_RESULT =
  'Answer honestly: your result is checked independently, and saying what is missing or uncertain is worth more than a false claim of success.';

/** The default attempt prompt; `report` says the value is a `std.types.WorkReport`. */
function attemptPrompt(request: AttemptPromptInput<unknown>, report: boolean): string {
  const output = report
    ? 'A work report: done only when the task is complete, else partial or blocked; what you did and what remains; the files you changed; and what stopped you, if anything.'
    : 'The result in the requested structure.';
  const honest = report ? HONEST_REPORT : HONEST_RESULT;
  if (request.attempt === 0) {
    return briefText({
      task: request.task,
      guidance: ["Keep the work within the task's scope.", honest],
      output,
    });
  }
  const previous =
    request.previous === null
      ? 'Its agent call failed before returning a result.'
      : fence(json(request.previous), 'json');
  return briefText({
    task: request.task,
    context: `### Previous attempt\n\n${previous}\n\n### Problems found\n\n${request.problems ?? '(none given)'}`,
    guidance: [
      'An earlier attempt at this task was not accepted; its result and the problems found are above.',
      report
        ? 'Start from the current state of the files: see what the earlier attempt changed before you change more, and fix the problems found.'
        : 'Fix the problems found and keep what the earlier attempt got right; if it changed files, start from their current state.',
      "Keep the work within the task's scope.",
      honest,
    ],
    output,
  });
}

/** The validated `start` option of {@link escalate}; untyped callers may pass anything. */
function startSlot(value: unknown): EscalationSlot {
  if (value === undefined) return 'mechanic';
  if (value === 'mechanic' || value === 'surgeon') return value;
  throw new TypeError(`start must be 'mechanic' or 'surgeon'; got ${JSON.stringify(value)}.`);
}

/** What one attempt of {@link escalate} decided. */
interface AttemptOutcome<V> {
  /** The attempt's value, or null when its call failed. */
  readonly value: V | null;
  /** The problems, or null when accepted. */
  readonly problems: string | null;
}

/**
 * Give a task to the mechanic, check the result with `accept`, and hand rejected or failed work
 * to the surgeon. Attempt 0 uses the `start` slot and every later attempt the surgeon, whose
 * prompt carries the previous attempt's value and problems. An attempt's agent call is settled, so
 * a failed call is journaled and escalates like a rejection instead of failing the workflow.
 *
 * Steps, all under `<id>/`:
 *
 * - `attempt/<n>/work`: attempt `n`'s agent call (from 0), settled, with `schema`.
 * - `attempt/<n>/<leaf>`: any effect `accept` records for that attempt, with a leaf other than
 *   `work`; `accept` runs again on resume, so its decision must come from durable effects.
 *
 * Team slots: `mechanic` (suggested `std.roles.Mechanic`) and `surgeon` (`std.roles.Surgeon`).
 *
 * @param ctx - The workflow context the team was bound from.
 * @param options - The scope, team, task and `accept`, plus the optional attempts, start slot,
 * prompts and call defaults; the value is a `std.types.WorkReport`.
 * @returns Whether an attempt was accepted, the deciding slot, the attempts run, the value, the
 * last problems, the failed call count (also as `failures`) and the status.
 * @throws TypeError - Before any effect, when the `mechanic` or `surgeon` slot is not filled, the
 * task is blank, `attempts` is not a positive integer or `start` is not a slot; and when `accept`
 * returns something other than `true` or a string.
 */
export function escalate(
  ctx: WorkflowContext,
  options: EscalateOptions<WorkReport> & {
    /** Omitted: attempts return a `std.types.WorkReport`. */
    readonly schema?: undefined;
  },
): Promise<EscalateResult<WorkReport>>;
/**
 * Give a task to the mechanic with a custom result `schema`, check each value with `accept`, and
 * hand rejected or failed work to the surgeon; see the default overload for the steps.
 *
 * @typeParam V - The attempt value's type.
 * @param ctx - The workflow context the team was bound from.
 * @param options - The scope, team, task, schema and `accept`, plus the optional attempts, start
 * slot, prompts and call defaults.
 * @returns Whether an attempt was accepted, the deciding slot, the attempts run, the value, the
 * last problems, the failed call count (also as `failures`) and the status.
 * @throws TypeError - As for the default overload.
 */
export function escalate<V>(
  ctx: WorkflowContext,
  options: EscalateOptions<V> & {
    /** The schema of an attempt's value. */
    readonly schema: z.ZodType<V>;
  },
): Promise<EscalateResult<V>>;
/**
 * Give a task to the mechanic with options whose `schema` may or may not be set, such as a value
 * typed as {@link EscalateOptions}; see the default overload for the steps. Without a schema the
 * value is a `std.types.WorkReport`, so the result's value type includes it; the two narrower
 * overloads give a precise value type when the schema is known at the call.
 *
 * @typeParam V - The attempt value's type when `schema` is set.
 * @param ctx - The workflow context the team was bound from.
 * @param options - The scope, team, task and `accept`, an optional schema, plus the optional
 * attempts, start slot, prompts and call defaults.
 * @returns Whether an attempt was accepted, the deciding slot, the attempts run, the value, the
 * last problems, the failed call count (also as `failures`) and the status.
 * @throws TypeError - As for the default overload.
 */
export function escalate<V>(
  ctx: WorkflowContext,
  options: EscalateOptions<V>,
): Promise<EscalateResult<V | WorkReport>>;
export async function escalate<V>(
  ctx: WorkflowContext,
  options: EscalateOptions<V>,
): Promise<EscalateResult<V>> {
  const team = EscalationTeam.from(options.team);
  const { task, accept, calls } = options;
  if (task.trim() === '') throw new TypeError('escalate needs a nonblank task.');
  const attempts = positiveInt('attempts', options.attempts ?? 2);
  const start = startSlot(options.start);
  // Without a schema the overloads make V a WorkReport.
  const schema = options.schema ?? (WorkReport as unknown as z.ZodType<V>);
  const report = options.schema === undefined;
  const promptFor =
    options.prompts?.work ?? ((request: AttemptPromptInput<V>) => attemptPrompt(request, report));
  return ctx.scope(options.id, async () => {
    let outcome: AttemptOutcome<V> = { value: null, problems: null };
    let slot: EscalationSlot = start;
    let failedCalls = 0;
    let ran = 0;
    while (ran < attempts) {
      const attempt = ran;
      slot = attempt === 0 ? start : 'surgeon';
      const current = slot;
      const previous = outcome;
      outcome = await ctx.scope(
        ctx.id('attempt', attempt),
        async (): Promise<AttemptOutcome<V>> => {
          const settled = await team[current].value('work', {
            ...calls,
            prompt: promptFor({
              task,
              attempt,
              slot: current,
              previous: previous.value,
              problems: previous.problems,
            }),
            schema,
            onError: 'return',
          });
          if (!settled.ok) {
            failedCalls += 1;
            return {
              value: null,
              problems: `The ${current}'s agent call failed: ${settled.error.message}`,
            };
          }
          const verdict: unknown = await accept(settled.value, current, attempt);
          if (verdict === true) return { value: settled.value, problems: null };
          if (typeof verdict !== 'string')
            throw new TypeError(
              `escalate accept must return true or a string of problems; got ${String(verdict)}.`,
            );
          return {
            value: settled.value,
            problems: verdict.trim() === '' ? 'Rejected without details.' : verdict,
          };
        },
      );
      ran += 1;
      if (outcome.problems === null) break;
      ctx.log(`${options.id}: attempt ${String(attempt)} by the ${current} was not accepted`);
    }
    return {
      outcome: outcome.problems === null ? 'accepted' : 'rejected',
      slot,
      attempts: ran,
      value: outcome.value,
      problems: outcome.problems,
      failedCalls,
      failures: failedCalls,
      status: statusOf(failedCalls),
    };
  });
}
