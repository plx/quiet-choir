/**
 * Patterns that change files under explicit control, re-exported from `std.patterns`:
 *
 * - {@link isolatedEdits}: an editor makes each item's change in a fresh checkout of its own, in a
 *   settled map; changes outside the paths an item owns are rejected, and the rest are merged in
 *   one `ctx.merge`, with conflicts reported as data.
 * - {@link approvedPlan}: a planner writes a `std.types.Plan`, a reviewer approves it through
 *   `ctx.approve` with the plan's digest as the subject, and a rejection with a comment is revised
 *   in the next round. {@link planCall} gives the call options for implementing the approved plan.
 *
 * Each pattern takes a required `id` and records every step under it; the TSDoc of each lists the
 * exact step IDs. A failed edit is journaled by the settled map and counted in the result, so a
 * resume makes the same decision instead of retrying it. The default prompts are built with
 * `std.text.brief`.
 *
 * ```ts
 * import * as std from 'quiet-choir/std';
 *
 * const edits = await std.patterns.isolatedEdits(ctx, {
 *   id: 'edits',
 *   team: { editor: ctx.roster.Mechanic },
 *   items: input.tasks,
 *   key: (task) => task.id,
 *   task: (task) => task.change,
 *   owns: (task) => task.paths,
 * });
 * const review = await std.patterns.approvedPlan(ctx, {
 *   id: 'plan',
 *   team: { planner: ctx.roster.Planner },
 *   task: input.task,
 * });
 * if (review.approved)
 *   await ctx.roster.Mechanic.value('implement', std.patterns.planCall(review, input.task));
 * ```
 *
 * @module
 */
import {
  defineTeam,
  type Approval,
  type JsonValue,
  type MapStepError,
  type MergeOptions,
  type MergeResult,
  type Prompt,
  type Settled,
  type TeamOf,
  type WorkflowContext,
  type WorktreeBase,
  type WorktreeChange,
} from '../index.js';
import { assertDisjoint, digest as digestOf } from './data.js';
import { changedFiles, json } from './exec.js';
import { keyed, nonNegativeInt, settledMap, statusOf, type CallDefaults } from './pattern-kit.js';
import { brief, bullets, clip, fence, numbered, promptText } from './text.js';
import { Plan, WorkReport, isRepoPath } from './types.js';

/** `### <title>` followed by `body`, a subsection inside a `std.text.brief` section. */
function subsection(title: string, body: string): string {
  return `### ${title}\n\n${body}`;
}

/** Context material as prompt text: a string as written, other JSON as a fenced `json` block. */
function material(value: JsonValue | string): string {
  return typeof value === 'string' ? value : fence(json(value), 'json');
}

// ---------------------------------------------------------------------------------------------
// isolatedEdits
// ---------------------------------------------------------------------------------------------

/** The slot {@link isolatedEdits} needs: an `editor` that makes one item's change. */
export const EditTeam: ReturnType<typeof defineTeam<'editor'>> = defineTeam({
  editor:
    "Makes one item's change in a fresh checkout of its own, editing only the paths the item owns, and summarizes it; the workflow captures and merges the checkout. Fill with an editing entry such as std.roles.Mechanic, std.roles.Editor or std.roles.CodexEditor.",
});
/** The team record {@link isolatedEdits} takes: `{ readonly editor: Agent }`. */
export type EditTeam = TeamOf<typeof EditTeam>;

/** What the edit prompt of {@link isolatedEdits} is built from. */
export interface EditPromptInput<T> {
  /** The item. */
  readonly item: T;
  /** The item's unique, ID-safe key. */
  readonly key: string;
  /** The change to make, from the caller's `task`. */
  readonly task: string;
  /** The repository paths the item owns, or null when the caller gave no `owns`. */
  readonly owns: readonly string[] | null;
}

/** The merge options {@link isolatedEdits} accepts: `ctx.merge` options without `onError`. */
export type EditMergeOptions = Omit<MergeOptions, 'onError'>;

/** Options of {@link isolatedEdits}. */
export interface IsolatedEditsOptions<T> {
  /** The scope for every step this pattern records. */
  readonly id: string;
  /** The agent filling the editor slot. */
  readonly team: EditTeam;
  /** The items, one isolated edit each; each map item is plain JSON, so the items need not be. */
  readonly items: readonly T[];
  /**
   * A label for an item, made unique and ID-safe for the step IDs (`std.data.uniqueKeys`), such as
   * a task ID; omitted, the item's index.
   */
  readonly key?: ((item: T, index: number) => string) | undefined;
  /** The change to make for an item, in words; the default prompt adds the owned paths and rules. */
  readonly task: (item: T, index: number) => string;
  /**
   * The repository-relative paths an item owns: files, or directories that own everything under
   * them (`src/parser` owns `src/parser/lexer.ts`). A change to any other file is a violation,
   * and that item's whole change is left out of the merge. Items must own disjoint paths. Omitted,
   * every change is merged.
   */
  readonly owns?: ((item: T, index: number) => readonly string[]) | undefined;
  /**
   * The ref or commit every editor's checkout starts from; omitted, `HEAD` as resolved when each
   * edit starts. Pass a commit (`{ commit }`) to pin one base for all items across resumes.
   */
  readonly base?: WorktreeBase | undefined;
  /**
   * How to merge the changes, as for `ctx.merge`: `strategy`, `onConflict` (default `'report'`,
   * so a conflicting change is skipped and listed), `target` and `commit`. With
   * `onConflict: 'fail'` a conflict throws instead.
   */
  readonly merge?: EditMergeOptions | undefined;
  /** Replacement prompts. */
  readonly prompts?:
    | {
        /** The editor's prompt for one item. */
        readonly edit?: ((request: EditPromptInput<T>) => string | Prompt) | undefined;
      }
    | undefined;
  /** The bound on concurrent edits; defaults to 4. */
  readonly concurrency?: number | undefined;
  /** A revision for prompts the edit map's fingerprint does not show. */
  readonly version?: string | undefined;
  /**
   * Options applied to every agent call (`cwd`, `addDirs`, retry, deadlines). Not `worktree`: each
   * edit always gets a fresh checkout of its own; set `base` to choose where it starts.
   */
  readonly calls?: CallDefaults | undefined;
}

/** A captured change of {@link isolatedEdits} that stayed within its item's owned paths. */
export interface EditChange {
  /** The item's key. */
  readonly key: string;
  /** The changed repository paths, as Git lists them; a renamed file by both its old and new path. */
  readonly files: string[];
  /** The editor's final message. */
  readonly summary: string;
}

/** An item of {@link isolatedEdits} whose change touched files it does not own. */
export interface EditViolation {
  /** The item's key. */
  readonly key: string;
  /** The changed paths outside the item's owned paths (a renamed file's old path counts too). */
  readonly files: string[];
}

/** Result of {@link isolatedEdits}. */
export interface IsolatedEditsResult {
  /**
   * `'complete'` when every edit succeeded, stayed within its paths and merged cleanly (an
   * unchanged item does not count against it); else `'degraded'`.
   */
  readonly status: 'complete' | 'degraded';
  /**
   * The commit the merge published (`merge.commit`), which holds every merged change; null when
   * nothing merged (no merge ran, or every change conflicted).
   */
  readonly commit: string | null;
  /** The merge outcome, or null when no change was left to merge (no `<id>/merge` step ran). */
  readonly merge: MergeResult | null;
  /** Keys of the items whose change the merge applied, in item order. */
  readonly merged: string[];
  /** Keys of the items whose change conflicted, so the merge skipped it. */
  readonly conflicts: string[];
  /** Every captured change within its owned paths, merged or conflicted, in item order. */
  readonly changes: EditChange[];
  /** Items whose change touched files they do not own; none of their change was merged. */
  readonly violations: EditViolation[];
  /** Keys of the items whose editor left the checkout unchanged. */
  readonly unchanged: string[];
  /** Keys of the items whose edit call failed; each failure is saved, so a resume does not retry it. */
  readonly failed: string[];
}

/**
 * A settled-map item of {@link isolatedEdits}: the key, the rendered prompt, the owned paths and
 * the checkout base, so the map fingerprint shows a change to any of them.
 */
interface EditRecord {
  readonly key: string;
  readonly prompt: string;
  readonly owns: string[] | null;
  readonly base: WorktreeBase | null;
}

/**
 * What one isolated edit returns: the captured change, every path it touches (a rename by both
 * paths) and the editor's final message.
 */
interface EditValue {
  readonly change: WorktreeChange;
  readonly files: string[];
  readonly summary: string;
}

/** The editor's default prompt. */
function editPrompt(request: EditPromptInput<unknown>): string {
  const { task, owns } = request;
  return brief({
    task: 'Make the change described below in your checkout.',
    context: [
      subsection('Change', task),
      ...(owns === null ? [] : [subsection('Paths you own', bullets(owns))]),
    ].join('\n\n'),
    guidance: [
      'This checkout is yours alone: other changes are being made in parallel in checkouts of their own, and the workflow merges them all afterwards.',
      owns === null
        ? 'Keep the change to what the description asks for, so it merges cleanly with the others.'
        : 'Change only files under the paths you own (moving or deleting a file changes it): a change to any other file is rejected, and then none of your change is merged.',
      "Match the surrounding code's conventions, and run the checks you are allowed to run before you finish.",
      'Do not commit, push or switch branches, and leave no scratch files behind: the workflow captures every file in your checkout as you leave it.',
    ],
    output: 'A short summary of what you changed and why, and anything you could not do.',
  });
}

/** An owned path without trailing slashes, validated as a repository-relative path. */
function ownedPath(id: string, key: string, path: string): string {
  const trimmed = path.replace(/\/+$/u, '');
  if (!isRepoPath(trimmed)) {
    throw new TypeError(
      `isolatedEdits ${id}: item ${key} owns ${JSON.stringify(path)}, which is not a repository-relative path.`,
    );
  }
  return trimmed;
}

/** Whether `file` is one of `owns` or inside one of them. */
function isOwned(file: string, owns: readonly string[]): boolean {
  return owns.some((path) => file === path || file.startsWith(`${path}/`));
}

/** The merge options: the caller's, with `onConflict` defaulting to `'report'` and no `onError`. */
function mergeOptions(merge: EditMergeOptions | undefined): EditMergeOptions {
  return {
    onConflict: merge?.onConflict ?? 'report',
    ...(merge?.strategy === undefined ? {} : { strategy: merge.strategy }),
    ...(merge?.target === undefined ? {} : { target: merge.target }),
    ...(merge?.commit === undefined ? {} : { commit: merge.commit }),
  };
}

/**
 * Make one change per item, each in a fresh checkout of its own, and merge the results. Every item
 * becomes an isolated `team.editor.text('edit', { worktree: true })` call (from `base` when
 * given) in a settled map, so the editors cannot see or break each other's work, and a failed call
 * is journaled as that item's outcome instead of failing the rest. The captured changes are then
 * checked in code: an item that changed nothing is `unchanged`, and with `owns`, an item that
 * changed a file outside its owned paths is a violation whose whole change is left out (a renamed
 * file is checked by both its old and new path, so moving a file in from elsewhere is a change
 * outside the owned paths). The remaining changes
 * are merged in item order with `ctx.merge`, which by default skips and reports a conflicting
 * change and publishes a run-owned ref; set `merge` for another strategy, a branch or the
 * checkout as the target, or a commit message. Failures, violations and conflicts are also
 * written to the run log.
 *
 * Steps, all under `<id>/`:
 *
 * - `item/<key>/edit`: the isolated text call to the editor for one item, in the settled map
 *   `item` keyed by the item keys.
 * - `item/<key>/paths`: only for a change that renames a file, the command
 *   `git diff --name-only --no-renames <base>..<snapshot>` (`std.exec.changedFiles`), which lists
 *   the old path of every rename as well.
 * - `merge`: the merge of the remaining changes; absent when none remain.
 *
 * Team slot: `editor`, an editing entry such as `std.roles.Mechanic` (or `std.roles.Editor`,
 * `std.roles.CodexEditor`); under `requireGrants` it needs a write grant.
 *
 * Embedded callers pass a process runner (`new NodeProcessRunner()`) to `runWorkflow`; the
 * workflow's checkout must be a Git working tree with a commit. Under a `--dry-run` rehearsal the
 * isolated calls synthesize unchanged checkouts, so every item is `unchanged` and nothing merges.
 *
 * @typeParam T - The item type.
 * @param ctx - The workflow context the team was bound from.
 * @param options - The scope, the team, the items with their tasks, and optional keys, owned
 * paths, base, merge options, prompts, concurrency, version and call defaults.
 * @returns The status, the merged commit (null when nothing merged) and merge outcome, the merged
 * and conflicting keys, the in-bounds changes, the violations, and the unchanged and failed keys.
 * @throws TypeError - Before any effect, when the `editor` slot is not filled, `concurrency` is not
 * a positive integer, `calls.worktree` is set, an item's `task` is blank, or an owned path is not a
 * repository-relative path.
 * @throws Error - Before any effect, `isolatedEdits <id>: items must own disjoint paths: ...` when
 * two items own the same path or one owns a directory containing another's path; and the merge's
 * own failures, such as a conflict under `onConflict: 'fail'`.
 */
export async function isolatedEdits<T>(
  ctx: WorkflowContext,
  options: IsolatedEditsOptions<T>,
): Promise<IsolatedEditsResult> {
  const team = EditTeam.from(options.team);
  const { id, calls } = options;
  if (calls?.worktree !== undefined) {
    throw new TypeError(
      `isolatedEdits ${id}: every edit gets a fresh checkout of its own; set base, not calls.worktree.`,
    );
  }
  const promptFor = options.prompts?.edit ?? editPrompt;
  const base = options.base ?? null;
  const items = keyed(options.items, options.key);
  const records: EditRecord[] = items.map(({ key, item, index }) => {
    const owned = options.owns?.(item, index);
    const owns = owned === undefined ? null : owned.map((path) => ownedPath(id, key, path));
    const task = options.task(item, index);
    if (task.trim() === '')
      throw new TypeError(`isolatedEdits ${id}: item ${key} has a blank task.`);
    return { key, prompt: promptText(promptFor({ item, key, task, owns })), owns, base };
  });
  if (options.owns !== undefined) {
    try {
      assertDisjoint(
        records,
        (record) => record.owns ?? [],
        (record) => record.key,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`isolatedEdits ${id}: items must own disjoint paths: ${reason}`, {
        cause: error,
      });
    }
  }
  const map = settledMap<EditRecord>(options);
  return ctx.scope(id, async () => {
    const results: Settled<EditValue, MapStepError>[] = await ctx.map(
      'item',
      records,
      map,
      async (record) => {
        const result = await team.editor.text('edit', {
          ...calls,
          prompt: record.prompt,
          worktree: record.base === null ? true : { base: record.base },
        });
        const change = result.worktree;
        if (change === undefined)
          throw new Error(`The edit of ${record.key} returned no captured change.`);
        // A captured rename names only its destination; list both paths, so a file moved in from
        // outside the owned paths counts as a change to its old path.
        const renamed = change.files.some((file) => file.status === 'renamed');
        const files =
          renamed && change.commit !== null
            ? await changedFiles(ctx, 'paths', `${change.base}..${change.commit}`)
            : change.files.map((file) => file.path);
        return { change, files, summary: result.output };
      },
    );
    const changes: EditChange[] = [];
    const captured: WorktreeChange[] = [];
    const keyOf = new Map<string, string>();
    const violations: EditViolation[] = [];
    const unchanged: string[] = [];
    const failed: string[] = [];
    records.forEach((record, index) => {
      const settled = results[index];
      if (!settled?.ok) {
        failed.push(record.key);
        const reason = settled === undefined ? 'no outcome' : settled.error.message;
        ctx.log(`${id}: the edit of ${record.key} failed: ${reason}`);
        return;
      }
      const { change, files, summary } = settled.value;
      if (change.commit === null || files.length === 0) {
        unchanged.push(record.key);
        return;
      }
      const owns = record.owns;
      const outside = owns === null ? [] : files.filter((file) => !isOwned(file, owns));
      if (outside.length > 0) {
        violations.push({ key: record.key, files: outside });
        ctx.log(
          `${id}: left the change of ${record.key} out of the merge; it touched files it does not own: ${outside.join(', ')}`,
        );
        return;
      }
      changes.push({ key: record.key, files, summary });
      captured.push(change);
      keyOf.set(change.commit, record.key);
    });
    if (captured.length === 0) {
      return {
        status: statusOf(failed.length + violations.length),
        commit: null,
        merge: null,
        merged: [],
        conflicts: [],
        changes,
        violations,
        unchanged,
        failed,
      };
    }
    const merge = await ctx.merge('merge', captured, mergeOptions(options.merge));
    const merged = merge.merged.map((commit) => keyOf.get(commit) ?? commit);
    const conflicts = merge.conflicts.map(
      (conflict) => keyOf.get(conflict.commit) ?? conflict.commit,
    );
    for (const conflict of merge.conflicts) {
      const key = keyOf.get(conflict.commit) ?? conflict.commit;
      ctx.log(
        `${id}: the change of ${key} conflicted and was not merged: ${conflict.files.join(', ')}`,
      );
    }
    return {
      status: statusOf(failed.length + violations.length + conflicts.length),
      commit: merged.length === 0 ? null : merge.commit,
      merge,
      merged,
      conflicts,
      changes,
      violations,
      unchanged,
      failed,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// approvedPlan
// ---------------------------------------------------------------------------------------------

/** The slot {@link approvedPlan} needs: a `planner` that writes and revises the plan. */
export const PlanApprovalTeam: ReturnType<typeof defineTeam<'planner'>> = defineTeam({
  planner:
    "Writes an implementation plan for review, and revises it to answer the reviewer's comment; never edits. Fill with a read-only planning entry such as std.roles.Planner.",
});
/** The team record {@link approvedPlan} takes: `{ readonly planner: Agent }`. */
export type PlanApprovalTeam = TeamOf<typeof PlanApprovalTeam>;

/**
 * Replacement prompts for {@link approvedPlan}; each may return text or a rendered {@link Prompt}.
 * A replacement receives only its arguments, not the `context` option: include any background
 * yourself.
 */
export interface ApprovedPlanPrompts {
  /** The planner's prompt for the first plan. */
  readonly plan?: ((task: string) => string | Prompt) | undefined;
  /** The planner's prompt to revise the rejected `plan` so that it answers `comment`. */
  readonly revise?: ((task: string, plan: Plan, comment: string) => string | Prompt) | undefined;
}

/** Options of {@link approvedPlan}. */
export interface ApprovedPlanOptions {
  /** The scope for every step this pattern records. */
  readonly id: string;
  /** The agent filling the planner slot. */
  readonly team: PlanApprovalTeam;
  /** What the plan must achieve, shown to the planner and the reviewer. */
  readonly task: string;
  /**
   * Background for the planner, under the task: a string as written, other JSON as a fenced
   * `json` block. The reviewer sees the task and the plan.
   */
  readonly context?: JsonValue | string | undefined;
  /**
   * The most revisions, a nonnegative integer; defaults to 2, so up to three plans are reviewed.
   * A rejection with a comment is revised while revisions remain.
   */
  readonly revisions?: number | undefined;
  /**
   * The one-line approval question; defaults to
   * `Approve this implementation plan? Reject with a comment to have it revised.`
   */
  readonly question?: string | undefined;
  /** The short question-tool header, at most 12 characters; defaults to `Plan review`. */
  readonly title?: string | undefined;
  /** Who should answer, a routing hint; defaults to `'human'`. */
  readonly audience?: 'human' | 'agent' | 'any' | undefined;
  /** Replacement prompts. */
  readonly prompts?: ApprovedPlanPrompts | undefined;
  /** Options applied to every agent call (placement, retry, deadlines). */
  readonly calls?: CallDefaults | undefined;
}

/** Result of {@link approvedPlan}. */
export interface ApprovedPlanResult {
  /** Whether the reviewer approved `plan`. */
  readonly approved: boolean;
  /**
   * `'approved'`; `'rejected'` when the reviewer rejected a plan without a comment, so there was
   * nothing to revise; or `'out-of-revisions'` when the last allowed plan was rejected too.
   */
  readonly status: 'approved' | 'rejected' | 'out-of-revisions';
  /** The approved plan, or the last reviewed one. */
  readonly plan: Plan;
  /** `std.data.digest(plan)`, the subject the reviewer decided on. */
  readonly digest: string;
  /** How many plans were reviewed. */
  readonly rounds: number;
  /** The reviewer's comment on `plan`, or null when there was none (an approval may carry one). */
  readonly comment: string | null;
}

/** The default approval question. */
const APPROVAL_QUESTION =
  'Approve this implementation plan? Reject with a comment to have it revised.';

/** The default question-tool header. */
const APPROVAL_TITLE = 'Plan review';

/** The most UTF-8 bytes of the approval details. */
const DETAILS_BYTES = 16_000;

/** A rejected plan with the reviewer's comment, which the next round revises. */
interface Rejection {
  readonly plan: Plan;
  readonly comment: string;
}

/** One reviewed round of {@link approvedPlan}: the plan, its digest and the reviewer's answer. */
interface PlanRound {
  readonly plan: Plan;
  readonly digest: string;
  readonly answer: Approval;
}

/** The planner's default output description. */
const PLAN_OUTPUT =
  'The plan: the approach in a few sentences, the ordered steps with the files each changes or creates, the risks, and the commands that prove the change works.';

/** A plan with its fields in schema order, so the rendered JSON does not depend on key order. */
function orderedPlan(plan: Plan): JsonValue {
  return {
    summary: plan.summary,
    steps: plan.steps.map((step) => ({
      id: step.id,
      description: step.description,
      files: step.files,
    })),
    risks: plan.risks,
    checks: plan.checks,
  };
}

/** The task with optional background, as the context of a planner prompt. */
function taskContext(task: string, context: JsonValue | string | undefined): string[] {
  return [
    subsection('Task', task),
    ...(context === undefined ? [] : [subsection('Background', material(context))]),
  ];
}

/** The planner's default first-plan prompt. */
function planPrompt(task: string, context: JsonValue | string | undefined): string {
  return brief({
    task: 'Write an implementation plan for the task below. A reviewer approves it before anyone implements it.',
    context: taskContext(task, context).join('\n\n'),
    guidance: [
      'Read enough of the code to ground every step, and name the files each step changes or creates.',
      'Keep the steps small and in order, so an implementer can follow them without rediscovering anything.',
      'List the risks that matter, and the commands that prove the change works, such as the test suite.',
      'Do not edit files: this is a plan for review.',
    ],
    output: PLAN_OUTPUT,
  });
}

/** The planner's default revision prompt. */
function revisePrompt(
  task: string,
  context: JsonValue | string | undefined,
  plan: Plan,
  comment: string,
): string {
  return brief({
    task: "Revise the implementation plan below to answer the reviewer's comment. The reviewer approves the revised plan before anyone implements it.",
    context: [
      ...taskContext(task, context),
      subsection('Rejected plan', fence(json(orderedPlan(plan)), 'json')),
      subsection("Reviewer's comment", comment),
    ].join('\n\n'),
    guidance: [
      'Answer every point of the comment; keep what it does not question.',
      'Return the complete revised plan, not only what changed.',
      'Read enough of the code to ground every step you change, and name the files each step changes or creates.',
      'Do not edit files: this is a plan for review.',
    ],
    output: PLAN_OUTPUT,
  });
}

/** The plan as Markdown for the reviewer, clipped to the details limit. */
function approvalDetails(
  task: string,
  plan: Plan,
  digest: string,
  answered: string | null,
): string {
  const steps = plan.steps.map(
    (step) =>
      `${step.id}: ${step.description}${step.files.length === 0 ? '' : `\nFiles: ${step.files.join(', ')}`}`,
  );
  const parts = [
    `Plan digest: ${digest}`,
    `## Task\n\n${task}`,
    ...(answered === null ? [] : [`## Revised to answer\n\n${answered}`]),
    `## Approach\n\n${plan.summary}`,
    `## Steps\n\n${numbered(steps)}`,
    `## Risks\n\n${bullets(plan.risks)}`,
    `## Checks\n\n${bullets(plan.checks)}`,
  ];
  return clip(parts.join('\n\n'), DETAILS_BYTES);
}

/**
 * Have a planner write an implementation plan and a reviewer approve it before anything is
 * implemented. Round `n` asks `team.planner` for a `std.types.Plan` (the first from the task, later
 * ones revising the rejected plan to answer the reviewer's comment), then asks for approval with
 * `ctx.approve`: the subject is the plan's `std.data.digest`, so an answer applies to exactly that
 * plan, and the details are the task and the plan as Markdown, clipped to 16000 bytes. An approval
 * returns at once. A rejection with a comment is revised in the next round while `revisions`
 * remain; a rejection without a comment stops, since there is nothing to revise. Running out of
 * rounds returns the last plan unapproved, as data.
 *
 * The run suspends at each approval until an answer arrives (`quiet-choir workflow answer`, or `writeAnswer`
 * when embedded); the answer is saved, so a resume replays it.
 *
 * Steps, all under `<id>/round/<n>/` for rounds `n` from 0:
 *
 * - `plan`: the planner's `std.types.Plan` call.
 * - `approve`: the approval of that plan.
 *
 * Team slot: `planner`, a read-only planning entry such as `std.roles.Planner`. Implement the
 * approved plan with {@link planCall}.
 *
 * @param ctx - The workflow context the team was bound from.
 * @param options - The scope, the team and the task, plus optional background, revision limit,
 * approval question, title and audience, prompts and call defaults.
 * @returns Whether a plan was approved, why the loop ended, that plan (or the last reviewed one),
 * its digest, the rounds and the reviewer's last comment.
 * @throws TypeError - Before any effect, when the `planner` slot is not filled, `task` is blank,
 * `revisions` is not a nonnegative integer, `question` is not one nonblank line of at most 1024
 * characters, or `title` is not 1 to 12 characters.
 * @throws Error - The planner's call failures.
 */
export async function approvedPlan(
  ctx: WorkflowContext,
  options: ApprovedPlanOptions,
): Promise<ApprovedPlanResult> {
  const team = PlanApprovalTeam.from(options.team);
  const revisions = nonNegativeInt('revisions', options.revisions ?? 2);
  const { task, context, calls } = options;
  const question = options.question ?? APPROVAL_QUESTION;
  const title = options.title ?? APPROVAL_TITLE;
  if (task.trim() === '')
    throw new TypeError(`approvedPlan ${options.id}: task must not be blank.`);
  // The rules `ctx.approve` applies, checked here so a bad option fails before the planner runs.
  if (question.trim() === '' || /[\r\n]/u.test(question) || question.length > 1024) {
    throw new TypeError(
      `approvedPlan ${options.id}: question must be one nonblank line of at most 1024 characters.`,
    );
  }
  if (title.length < 1 || title.length > 12)
    throw new TypeError(`approvedPlan ${options.id}: title must be 1 to 12 characters.`);
  const first = options.prompts?.plan ?? ((text: string) => planPrompt(text, context));
  const revise =
    options.prompts?.revise ??
    ((text: string, plan: Plan, comment: string) => revisePrompt(text, context, plan, comment));
  return ctx.scope(options.id, async (): Promise<ApprovedPlanResult> => {
    let previous: Rejection | null = null;
    for (let round = 0; ; round++) {
      const last: Rejection | null = previous;
      const reviewed = await ctx.scope(ctx.id('round', round), async (): Promise<PlanRound> => {
        const prompt = last === null ? first(task) : revise(task, last.plan, last.comment);
        const plan = await team.planner.value('plan', { ...calls, prompt, schema: Plan });
        const digest = digestOf(orderedPlan(plan));
        const answer = await ctx.approve('approve', {
          prompt: question,
          title,
          audience: options.audience ?? 'human',
          subject: digest,
          details: approvalDetails(task, plan, digest, last?.comment ?? null),
        });
        return { plan, digest, answer };
      });
      const { plan, digest, answer } = reviewed;
      const comment =
        answer.comment === undefined || answer.comment.trim() === '' ? null : answer.comment;
      const rounds = round + 1;
      if (answer.approved)
        return { approved: true, status: 'approved', plan, digest, rounds, comment };
      if (comment === null)
        return { approved: false, status: 'rejected', plan, digest, rounds, comment };
      if (round >= revisions)
        return { approved: false, status: 'out-of-revisions', plan, digest, rounds, comment };
      previous = { plan, comment };
    }
  });
}

/** Where {@link planCall} takes the plan from: an {@link approvedPlan} result, or `{ plan }`. */
export interface PlanSource {
  /** The plan to implement. */
  readonly plan: Plan;
  /** A reviewer's comment to pass on, such as an approval's caveat; null or omitted for none. */
  readonly comment?: string | null | undefined;
  /** Whether the plan was approved; `false` is refused, so an unapproved plan is not implemented. */
  readonly approved?: boolean | undefined;
}

/** The call options {@link planCall} returns: the prompt for implementing a plan and the report schema. */
export interface PlanCall {
  /** The rendered prompt for implementing the plan. */
  readonly prompt: string;
  /** `std.types.WorkReport`, the implementer's report. */
  readonly schema: typeof WorkReport;
}

/**
 * The call options for having an implementer carry out an approved plan: a `std.text.brief`
 * prompt with the task, the plan (as JSON in schema order) and the reviewer's comment, and
 * `std.types.WorkReport` as the schema. Spread it into a call to add placement or policy, such as
 * `{ ...std.patterns.planCall(review, task), worktree: true }`; trust a command, not the report,
 * for whether the work succeeded.
 *
 * The prompt asks the implementer to follow the plan as approved (honoring the reviewer's comment
 * where it refines a step), to report any step the code proves wrong as a deviation instead of
 * silently redesigning, to run the plan's checks it is allowed to run, and to report honestly.
 *
 * @param source - An {@link approvedPlan} result, or `{ plan }` for a plan from elsewhere.
 * @param task - The task the plan is for, shown for context; omitted, the prompt has the plan
 * alone.
 * @returns `{ prompt, schema }` for `agent.value(id, ...)`.
 * @throws TypeError - When `source.approved` is `false`.
 */
export function planCall(source: PlanSource, task?: string): PlanCall {
  if (source.approved === false)
    throw new TypeError('planCall: the plan was not approved; implement only an approved plan.');
  const comment = source.comment ?? null;
  const prompt = brief({
    task: 'Implement the approved plan below.',
    context: [
      ...(task === undefined ? [] : [subsection('Task', task)]),
      subsection('Approved plan', fence(json(orderedPlan(source.plan)), 'json')),
      ...(comment === null ? [] : [subsection("Reviewer's comment", comment)]),
    ].join('\n\n'),
    guidance: [
      'Follow the plan: it was reviewed and approved as written. Where the code proves a step wrong, do the least that achieves its intent, and report the deviation in your notes.',
      ...(comment === null
        ? []
        : ["Honor the reviewer's comment above where it narrows or refines a step of the plan."]),
      "Keep the change within the plan's scope, and match the surrounding code's conventions.",
      "Run the plan's checks that you are allowed to run before you report; never claim a check passed that you did not run.",
      'Report honestly: when a step is not done, report the work as partial or blocked and say why.',
    ],
    output:
      'A report of the work: its status, what you did, the files you changed, any blockers and notes.',
  });
  return { prompt, schema: WorkReport };
}
