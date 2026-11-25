/**
 * Aggregation patterns, re-exported from `std.patterns`:
 *
 * - {@link mapReduce} splits many items into chunks, has a mapper answer the task for each chunk
 *   in a settled map, and has a reducer combine the answers into one text. Which items the answers
 *   cover is computed in code from the chunks that succeeded, never reported by a model.
 * - {@link decompose} has a planner break a goal into a backlog of tasks, checks the IDs and
 *   dependencies in code, asks for one repair when they are invalid, and returns the tasks with
 *   their dependency waves. {@link taskCall} gives the call options for doing one of those tasks,
 *   for example as the `run` of `std.flow.waves`.
 *
 * Every pattern takes a required `id` and records all of its steps under it; each pattern's TSDoc
 * lists the exact step IDs. A failed mapper call is journaled and counted, so a resume replays the
 * same coverage instead of retrying it. Every result counts the failed calls it tolerated in
 * `failures` and reports its health as `status` (`'degraded'` exactly when one occurred). The
 * default prompts are built with `std.text.brief`. Every result interface has a schema of the same
 * name, for a workflow `output` or a saved result: {@link DecomposeResult} is a schema, and
 * {@link MapReduceResult} is a factory that takes the part schema.
 *
 * ```ts
 * import * as std from 'quiet-choir/std';
 *
 * const plan = await std.patterns.decompose(ctx, {
 *   id: 'plan',
 *   team: { planner: ctx.roster.Planner },
 *   goal: 'Add a --json flag to the export command.',
 * });
 * const build = await std.flow.waves(ctx, {
 *   id: 'build',
 *   items: plan.tasks,
 *   key: (task) => task.id,
 *   dependsOn: (task) => task.dependsOn,
 *   concurrency: 1,
 *   run: async (task) => {
 *     const report = await ctx.roster.Mechanic.value('work', std.patterns.taskCall(task));
 *     // Fail a task that is not done, so std.flow.waves skips the tasks that depend on it.
 *     if (report.status !== 'done') throw new Error(`${task.id} is ${report.status}`);
 *     return report;
 *   },
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
import { Coverage, Health, assertUnique, chunk, coverage, topoWaves, uniqueKeys } from './data.js';
import { json } from './exec.js';
import {
  Count,
  checkContext,
  placement,
  positiveInt,
  settledMap,
  statusOf,
  type CallDefaults,
} from './pattern-kit.js';
import { brief, bullets, fence, promptText } from './text.js';
import { Task, WorkReport, type TaskList } from './types.js';

/**
 * A settled-map item that carries its key, the rendered prompt the mapper sends, and where the call
 * runs (see `placement`).
 */
interface PromptRecord {
  readonly key: string;
  readonly prompt: string;
  readonly placement?: JsonValue;
}

/** `### <title>` followed by `body`, a subsection inside a `std.text.brief` section. */
function subsection(title: string, body: string): string {
  return `### ${title}\n\n${body}`;
}

/** Context material as prompt text: a string as written, other JSON as a fenced `json` block. */
function material(value: unknown): string {
  return typeof value === 'string' ? value : fence(json(value), 'json');
}

// ---------------------------------------------------------------------------------------------
// mapReduce
// ---------------------------------------------------------------------------------------------

/** The slots {@link mapReduce} needs: a `mapper` for each chunk and a `reducer` that combines. */
export const MapReduceTeam: ReturnType<typeof defineTeam<'mapper' | 'reducer'>> = defineTeam({
  mapper:
    'Answers the task for one chunk of the items, from that chunk only. Fill with a fast, inexpensive entry such as std.roles.Scribe, std.roles.Writer or std.roles.Clerk.',
  reducer:
    'Combines the chunk answers into one text without adding facts of its own. Fill with a prose entry such as std.roles.Writer or std.roles.Scribe.',
});
/** The team record {@link mapReduce} takes: `{ readonly mapper: Agent; readonly reducer: Agent }`. */
export type MapReduceTeam = TeamOf<typeof MapReduceTeam>;

/** One successful chunk's answer in a {@link MapReduceResult}. */
export interface MapReducePart<P> {
  /** The keys of the chunk's items, in item order. */
  readonly keys: string[];
  /** The mapper's answer for the chunk. */
  readonly value: P;
}

/**
 * The schema of a {@link MapReducePart}.
 *
 * @typeParam P - The answer type.
 * @param part - The schema of the answer: the `schema` the mappers ran with. Omitted, text, as
 * {@link mapReduce} defaults to.
 * @returns A strict object schema of `{ keys, value }`.
 */
export function MapReducePart<P = string>(part?: z.ZodType<P>): z.ZodType<MapReducePart<P>> {
  return z.strictObject({
    keys: z.array(z.string()),
    value: (part ?? z.string()) as z.ZodType<P>,
  });
}

/** Replacement prompts of {@link mapReduce}. */
export interface MapReducePrompts<T, P> {
  /**
   * The mapper's prompt for one chunk: its items and their keys, index-aligned. The default
   * states `task`, lists each item as `<key>: <description>` and asks for an answer from these
   * items only.
   */
  readonly map?: ((items: readonly T[], keys: readonly string[]) => string | Prompt) | undefined;
  /**
   * The reducer's prompt for the successful parts and the coverage. The default states `reduce`
   * (or asks to combine the parts into one answer to `task`), gives the parts, lists the items no
   * part covers, and asks for a combination that adds nothing the parts do not say.
   */
  readonly reduce?:
    ((parts: readonly MapReducePart<P>[], coverage: Coverage) => string | Prompt) | undefined;
}

/** Options of {@link mapReduce}. */
export interface MapReduceOptions<T, P = string> {
  /** The scope for every step this pattern records. */
  readonly id: string;
  /** The agents filling the `mapper` and `reducer` slots. */
  readonly team: MapReduceTeam;
  /** The items, such as commit SHAs, files or feedback entries; they need not be JSON. */
  readonly items: readonly T[];
  /**
   * An item's key, unique among the items (a repeated key throws before any effect): it names the
   * item in the mapper's prompt, in {@link MapReducePart.keys} and in the coverage. Defaults to the
   * item itself for a string item, such as a commit SHA or a path, and its index otherwise.
   */
  readonly key?: ((item: T, index: number) => string) | undefined;
  /**
   * What the mapper does with each chunk of items, such as `Turn these commits into change-log
   * entries.`; the reducer's default prompt restates it.
   */
  readonly task: string;
  /** How many items each mapper call gets, a positive integer; defaults to 20. */
  readonly chunk?: number | undefined;
  /**
   * How an item appears in the mapper's prompt, after its key; defaults to the item itself for a
   * string and its two-space JSON (`std.exec.json`) otherwise. A description that already starts
   * with the item's key as a whole word (such as `<sha> <subject>`) is shown without repeating it.
   */
  readonly describe?: ((item: T, index: number) => string) | undefined;
  /** The schema of each chunk's answer, such as `std.types.Changes`; omitted, answers are text. */
  readonly schema?: z.ZodType<P> | undefined;
  /**
   * The reducer's task, such as `Write release notes from these entries.`; defaults to combining
   * the parts into one complete answer to `task`.
   */
  readonly reduce?: string | undefined;
  /** Replacement prompts; `task`, `describe` and `reduce` shape only the defaults. */
  readonly prompts?: MapReducePrompts<T, P> | undefined;
  /** How many mapper calls run at once; defaults to 4. */
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

/** Result of {@link mapReduce}. */
export interface MapReduceResult<P> {
  /** The reducer's text; empty when there were no items or no chunk succeeded. */
  readonly result: string;
  /** The answers of the chunks whose call succeeded, in item order. */
  readonly parts: MapReducePart<P>[];
  /**
   * Which item keys the successful chunks cover, computed in code: an item is covered when its
   * chunk's call succeeded, and missing when it failed.
   */
  readonly coverage: Coverage;
  /** How many chunks the items were split into, one mapper call each. */
  readonly chunks: number;
  /** How many chunk calls failed; the failures are saved, so a resume does not retry them. */
  readonly failedChunks: number;
  /** How many chunk calls failed: the same as `failedChunks`. */
  readonly failures: number;
  /**
   * `'complete'` when every chunk succeeded (or there were no items), else `'degraded'`; when every
   * chunk failed the reducer was not called and `result` is empty.
   */
  readonly status: 'complete' | 'degraded';
}

/**
 * The schema of a {@link MapReduceResult}, for a workflow `output` or a saved result.
 *
 * @typeParam P - The answer type of each part.
 * @param part - The schema of each chunk's answer: the `schema` the mappers ran with. Omitted,
 * text, as {@link mapReduce} defaults to.
 * @returns A strict object schema of the result.
 */
export function MapReduceResult<P = string>(part?: z.ZodType<P>): z.ZodType<MapReduceResult<P>> {
  return z.strictObject({
    result: z.string(),
    parts: z.array(MapReducePart(part)),
    coverage: Coverage,
    chunks: Count,
    failedChunks: Count,
    failures: Count,
    status: Health,
  });
}

/**
 * One mapper item line: `<key>: <description>`, or the description alone when it already starts
 * with the key as a whole word (followed by whitespace, a colon or nothing).
 */
function itemEntry(key: string, description: string): string {
  if (key !== '' && description.startsWith(key)) {
    const next = description.charAt(key.length);
    if (next === '' || next === ':' || /\s/u.test(next)) return description;
  }
  return `${key}: ${description}`;
}

/** The default mapper prompt for one chunk. */
function mapPrompt(task: string, entries: readonly string[], structured: boolean): string {
  return brief({
    task,
    context: bullets(entries),
    guidance: [
      'Consider every item listed, and base your answer on these items only: other agents handle the other items, and a later step combines the answers.',
      'Each item starts with its key; use that key whenever your answer refers to an item.',
    ],
    output: structured
      ? 'Your answer for these items, in the requested structure.'
      : 'Your answer for these items as concise text, with no preamble.',
  });
}

/** The default reducer prompt over the successful parts. */
function reducePrompt(
  task: string,
  reduce: string | undefined,
  parts: readonly string[],
  missing: readonly string[],
): string {
  const sections = parts.map((part, index) => subsection(`Part ${String(index + 1)}`, part));
  if (missing.length > 0) sections.push(subsection('Not covered', bullets(missing)));
  const guidance = [
    `Each part answers this task for a share of the items: ${task}`,
    'Use only what the parts say: merge duplicate and overlapping points, keep every distinct one, and add no facts of your own.',
  ];
  if (missing.length > 0) {
    guidance.push(
      'The items under "Not covered" could not be processed: say that the answer leaves them out, and do not guess what they contain.',
    );
  }
  return brief({
    task:
      reduce ?? `Combine the partial answers below into one complete answer to this task: ${task}`,
    context: sections.join('\n\n'),
    guidance,
    output: 'Only the requested text, with no preamble or closing remarks.',
  });
}

/**
 * Answer a task over many items in chunks and combine the answers. The items are split into
 * chunks of `chunk` items; each chunk is one `team.mapper` call in the settled map `<id>/map`,
 * keyed by the chunk's first item key (made ID-safe with `std.data.uniqueKeys`), so a chunk whose
 * first key is `k` records `<id>/map/<k>/part`. When at least one chunk succeeded, `team.reducer`
 * combines the answers as the text call `<id>/reduce`; with no items or no successful chunk
 * nothing more is recorded.
 *
 * A failed chunk is journaled, counted in `failedChunks` and logged with `ctx.log`, and its items
 * are reported in `coverage.missing`; the reducer is told which items no part covers. Coverage is
 * computed in code from the chunks that succeeded, never reported by a model. Each map item carries
 * its rendered prompt, so a prompt change is detected on resume; set `version` when a change the
 * prompts do not show (such as the schema) should not reuse answers.
 *
 * Team slots: `mapper`, a fast entry such as `std.roles.Scribe`, `std.roles.Writer` or
 * `std.roles.Clerk`; `reducer`, a prose entry such as `std.roles.Writer` or `std.roles.Scribe`.
 *
 * @typeParam T - The item type.
 * @param ctx - The workflow context the team was bound from.
 * @param options - The scope, the team, the items and the task, with optional key, chunk size,
 * description, reducer task and prompts.
 * @returns The reducer's text, the parts, the coverage, the chunk and failure counts and the
 * status.
 * @throws TypeError - Before any effect, when the `mapper` or `reducer` slot is not filled, `task`
 * is blank, `reduce` is given but blank, or `chunk` or `concurrency` is not a positive integer.
 * @throws Error - Before any effect, `Duplicate mapReduce item key: ...` when two items share a key.
 * @throws Error - The reducer's call failure, after the map; a resume replays the map and retries
 * only the reducer.
 */
export function mapReduce<T>(
  ctx: WorkflowContext,
  options: MapReduceOptions<T> & { readonly schema?: undefined },
): Promise<MapReduceResult<string>>;
/**
 * Answer a task over many items in chunks with a schema for each chunk's answer, and combine the
 * answers; see the text overload for the steps, the coverage and the failure handling.
 *
 * @typeParam T - The item type.
 * @typeParam P - The answer type of `schema`.
 * @param ctx - The workflow context the team was bound from.
 * @param options - The scope, the team, the items, the task and the answer schema.
 * @returns The reducer's text, the parsed parts, the coverage, the chunk and failure counts and the
 * status.
 * @throws TypeError - Before any effect, when the `mapper` or `reducer` slot is not filled, `task`
 * is blank, `reduce` is given but blank, or `chunk` or `concurrency` is not a positive integer.
 * @throws Error - Before any effect, `Duplicate mapReduce item key: ...` when two items share a key.
 * @throws Error - The reducer's call failure, after the map; a resume replays the map and retries
 * only the reducer.
 */
export function mapReduce<T, P>(
  ctx: WorkflowContext,
  options: MapReduceOptions<T, P> & { readonly schema: z.ZodType<P> },
): Promise<MapReduceResult<P>>;
/**
 * Answer a task over many items in chunks with options whose `schema` may or may not be set, such
 * as a value typed as {@link MapReduceOptions}; see the text overload for the steps, the coverage
 * and the failure handling. The two narrower overloads give a precise part type when the schema is
 * known at the call.
 *
 * @typeParam T - The item type.
 * @typeParam P - The answer type of `schema`, when it is set.
 * @param ctx - The workflow context the team was bound from.
 * @param options - The scope, the team, the items, the task and an optional answer schema.
 * @returns The reducer's text, the parts (parsed when `schema` is set, else text), the coverage,
 * the chunk and failure counts and the status.
 * @throws TypeError - Before any effect, when the `mapper` or `reducer` slot is not filled, `task`
 * is blank, `reduce` is given but blank, or `chunk` or `concurrency` is not a positive integer.
 * @throws Error - Before any effect, `Duplicate mapReduce item key: ...` when two items share a key.
 * @throws Error - The reducer's call failure, after the map; a resume replays the map and retries
 * only the reducer.
 */
export function mapReduce<T, P>(
  ctx: WorkflowContext,
  options: MapReduceOptions<T, P>,
): Promise<MapReduceResult<P | string>>;
export async function mapReduce<T, P>(
  ctx: WorkflowContext,
  options: MapReduceOptions<T, P>,
): Promise<MapReduceResult<P | string>> {
  const team = MapReduceTeam.from(options.team);
  if (options.task.trim() === '') throw new TypeError('mapReduce task must be nonblank.');
  if (options.reduce?.trim() === '')
    throw new TypeError('mapReduce reduce must be nonblank when given.');
  const size = positiveInt('chunk', options.chunk ?? 20);
  const map = settledMap<PromptRecord>(options);
  const { task, schema, calls } = options;
  const items = options.items.slice();
  const keyOf =
    options.key ?? ((item: T, index: number) => (typeof item === 'string' ? item : String(index)));
  const describe =
    options.describe ?? ((item: T) => (typeof item === 'string' ? item : json(item)));
  const keys = items.map((item, index) => keyOf(item, index));
  assertUnique(keys, 'mapReduce item key');
  const chunks = chunk(
    items.map((item, index) => ({ item, index, key: keys[index] ?? String(index) })),
    size,
  );
  const mapKeys = uniqueKeys(chunks.map((members) => members[0]?.key ?? ''));
  const records: PromptRecord[] = chunks.map((members, position) => {
    const custom = options.prompts?.map;
    const prompt =
      custom === undefined
        ? mapPrompt(
            task,
            members.map((member) => itemEntry(member.key, describe(member.item, member.index))),
            schema !== undefined,
          )
        : custom(
            members.map((member) => member.item),
            members.map((member) => member.key),
          );
    return {
      key: mapKeys[position] ?? String(position),
      prompt: promptText(prompt),
      ...placement(calls),
    };
  });
  return ctx.scope(options.id, async () => {
    const settled: Settled<P | string, MapStepError>[] =
      records.length === 0
        ? []
        : await ctx.map('map', records, map, (record): Promise<P | string> =>
            schema === undefined
              ? team.mapper.value('part', { ...calls, prompt: record.prompt })
              : team.mapper.value('part', { ...calls, prompt: record.prompt, schema }),
          );
    const parts: MapReducePart<P | string>[] = [];
    for (const [position, members] of chunks.entries()) {
      const outcome = settled[position];
      if (outcome === undefined)
        throw new Error(`Missing settled result for chunk ${String(position)}.`);
      if (outcome.ok)
        parts.push({ keys: members.map((member) => member.key), value: outcome.value });
    }
    const covered = coverage(
      keys,
      parts.flatMap((part) => part.keys),
    );
    const failedChunks = chunks.length - parts.length;
    if (failedChunks > 0) {
      ctx.log(
        `${options.id}: ${String(failedChunks)} of ${String(chunks.length)} chunk(s) failed; ${String(covered.missing.length)} item(s) are not covered.`,
        { missing: covered.missing },
      );
    }
    if (parts.length === 0) {
      return {
        result: '',
        parts,
        coverage: covered,
        chunks: chunks.length,
        failedChunks,
        failures: failedChunks,
        status: statusOf(failedChunks),
      };
    }
    const custom = options.prompts?.reduce;
    const prompt =
      custom === undefined
        ? reducePrompt(
            task,
            options.reduce,
            parts.map((part) =>
              typeof part.value === 'string' ? part.value : fence(json(part.value), 'json'),
            ),
            covered.missing,
          )
        : // Every part is a P: text exactly when there is no schema, and then P is string.
          custom(parts as MapReducePart<P>[], covered);
    const result = await team.reducer.value('reduce', { ...calls, prompt });
    return {
      result,
      parts,
      coverage: covered,
      chunks: chunks.length,
      failedChunks,
      failures: failedChunks,
      status: statusOf(failedChunks),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// decompose
// ---------------------------------------------------------------------------------------------

/** The slot {@link decompose} needs: a `planner` that writes and repairs the task list. */
export const PlanTeam: ReturnType<typeof defineTeam<'planner'>> = defineTeam({
  planner:
    'Breaks a goal into a backlog of small tasks with acceptance conditions and dependencies, and repairs the list when told what is wrong with it. Fill with a read-only planning entry such as std.roles.Planner.',
});
/** The team record {@link decompose} takes: `{ readonly planner: Agent }`. */
export type PlanTeam = TeamOf<typeof PlanTeam>;

/** Replacement prompts of {@link decompose}. */
export interface DecomposePrompts {
  /**
   * The planner's prompt for `goal`, asking for at most `maxTasks` tasks, with the `context`
   * option (undefined when it is not set) to show as background. The default asks for small,
   * grounded tasks with observable acceptance conditions, unique IDs and only the dependencies
   * that are needed, without cycles.
   */
  readonly plan?:
    ((goal: string, maxTasks: number, context: unknown) => string | Prompt) | undefined;
  /**
   * The planner's prompt to repair `tasks` given the `problems` found in them. The default gives
   * the goal, the task list and the problems, and asks for the complete list with every problem
   * fixed and as little else changed as possible.
   */
  readonly repair?:
    ((tasks: readonly Task[], problems: readonly string[]) => string | Prompt) | undefined;
}

/** Options of {@link decompose}. */
export interface DecomposeOptions {
  /** The scope for every step this pattern records. */
  readonly id: string;
  /** The agent filling the `planner` slot. */
  readonly team: PlanTeam;
  /** What the tasks must achieve together, such as a feature request or a requirements document. */
  readonly goal: string;
  /**
   * Background for the planner, such as constraints, relevant files or an earlier plan: text, or a
   * JSON value (read-only arrays and interfaces included; checked before any effect). The default
   * prompts show a string as written and other JSON as a fenced block, and a replacement `plan`
   * prompt receives it.
   */
  readonly context?: unknown;
  /** The most tasks the list may hold, a positive integer; defaults to 12. */
  readonly maxTasks?: number | undefined;
  /** Replacement prompts. */
  readonly prompts?: DecomposePrompts | undefined;
  /** Options applied to every agent call (placement, retry, deadlines). */
  readonly calls?: CallDefaults | undefined;
}

/** Result of {@link decompose}. */
export interface DecomposeResult {
  /** The tasks, in the planner's order. */
  readonly tasks: Task[];
  /**
   * The tasks in dependency waves (`std.data.topoWaves`): wave 0 has no dependencies, and each
   * later wave depends only on earlier ones.
   */
  readonly waves: Task[][];
  /** Whether the first list was invalid and the repair call fixed it. */
  readonly repaired: boolean;
  /** The problems the repair fixed; empty when the first list was valid. */
  readonly problems: string[];
  /** Always 0: the planner calls are required, so a failure throws instead of being tolerated. */
  readonly failures: number;
  /** Always `'complete'`: decompose tolerates no failed call. */
  readonly status: 'complete' | 'degraded';
}

/** The schema of a {@link DecomposeResult}, for a workflow `output` or a saved result. */
export const DecomposeResult: z.ZodType<DecomposeResult> = z.strictObject({
  tasks: z.array(Task),
  waves: z.array(z.array(Task)),
  repaired: z.boolean(),
  problems: z.array(z.string()),
  failures: Count,
  status: Health,
});

/** The planner's schema: a {@link TaskList} of 1 to `maxTasks` tasks. */
function taskListSchema(maxTasks: number): z.ZodType<TaskList> {
  return z.object({
    tasks: z
      .array(Task)
      .min(1)
      .max(maxTasks)
      .describe('The tasks, each small enough to finish and review on its own.'),
  });
}

/**
 * Every problem with a task list's IDs and dependencies: repeated IDs, dependencies on IDs outside
 * the list, and (when there are neither) a dependency cycle.
 */
function planProblems(tasks: readonly Task[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const repeated = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) repeated.add(task.id);
    ids.add(task.id);
  }
  for (const id of repeated)
    problems.push(`The task ID ${JSON.stringify(id)} is used by more than one task.`);
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) {
        problems.push(
          `Task ${JSON.stringify(task.id)} depends on ${JSON.stringify(dep)}, which is not in the list.`,
        );
      }
    }
  }
  // A dependency listed twice is one problem.
  if (problems.length > 0) return [...new Set(problems)];
  try {
    topoWaves(
      tasks,
      (task) => task.id,
      (task) => task.dependsOn,
    );
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  return problems;
}

/** The dependency waves of a valid task list. */
function wavesOf(tasks: readonly Task[]): Task[][] {
  return topoWaves(
    tasks,
    (task) => task.id,
    (task) => task.dependsOn,
  );
}

/** The goal, with any background under its own heading. */
function goalMaterial(goal: string, context: unknown): string[] {
  const parts = [subsection('Goal', goal)];
  if (context !== undefined) parts.push(subsection('Background', material(context)));
  return parts;
}

/** The default planning prompt. */
function planPrompt(goal: string, context: unknown, max: number): string {
  return brief({
    task: `Break the goal below into a backlog of at most ${String(max)} tasks that together achieve it.`,
    context: context === undefined ? goal : goalMaterial(goal, context).join('\n\n'),
    guidance: [
      'Ground the tasks in the code and documents you can read; do not invent files, interfaces or requirements.',
      'Make each task small enough to finish and review on its own, with observable acceptance conditions.',
      'Give each task a short unique ID such as T1. In dependsOn, list only IDs of tasks in this list that must be finished first, with no cycles; leave out orderings that are not needed, so that independent tasks can run in parallel.',
      'Cover the whole goal and nothing beyond it.',
    ],
    output: 'The task list, in a sensible order of work.',
  });
}

/** The default repair prompt. */
function repairPrompt(
  goal: string,
  context: unknown,
  tasks: readonly Task[],
  problems: readonly string[],
): string {
  return brief({
    task: 'Repair the task list below: fix every listed problem with its task IDs and dependencies, and change as little else as possible.',
    context: [
      ...goalMaterial(goal, context),
      subsection('Task list', fence(json({ tasks: tasks.map(orderedTask) }), 'json')),
      subsection('Problems', bullets(problems)),
    ].join('\n\n'),
    guidance: [
      'Keep every task ID unique.',
      'List in dependsOn only IDs of tasks in the list, and leave no dependency cycle.',
      'Keep the tasks that have no problem as they are.',
    ],
    output: 'The complete repaired task list, including the tasks you did not change.',
  });
}

/**
 * Break a goal into a backlog of tasks with acceptance conditions and dependencies. `team.planner`
 * writes the list as `<id>/plan` (schema `std.types.TaskList` with at most `maxTasks` tasks); the
 * IDs and dependencies are then checked in code: every ID unique, every dependency an ID in the
 * list, and no cycle. When a check fails, the problems are logged with `ctx.log` and the planner is
 * asked for one repair as `<id>/repair`, given the list and the problems. The waves are computed
 * with `std.data.topoWaves`, so `std.flow.waves` can run the tasks in dependency order (pass
 * {@link taskCall} to have an implementer do each one).
 *
 * The default prompts (`std.text.brief`) ask for small, grounded tasks with observable acceptance
 * conditions and only the dependencies that are needed, so independent tasks can run in parallel.
 * A `--dry-run` rehearsal synthesizes task lists whose dependencies name no task, so the repair is
 * invalid too and the call throws: give `<id>/plan` a fixture to rehearse past it.
 *
 * Team slot: `planner`, a read-only planning entry such as `std.roles.Planner`.
 *
 * @param ctx - The workflow context the team was bound from.
 * @param options - The scope, the team, the goal, and optional background, task limit and prompts.
 * @returns The tasks, their dependency waves, whether a repair was needed and what it fixed, and
 * the failure count and status (always 0 and `'complete'`).
 * @throws TypeError - Before any effect, when the `planner` slot is not filled, `goal` is blank,
 * `maxTasks` is not a positive integer, or `context` is neither a string nor a JSON value.
 * @throws Error - `decompose <id>: the repaired task list is still invalid: ...`, listing the
 * problems, when the repair leaves any; and the planner's own call failures.
 */
export async function decompose(
  ctx: WorkflowContext,
  options: DecomposeOptions,
): Promise<DecomposeResult> {
  const team = PlanTeam.from(options.team);
  const maxTasks = positiveInt('maxTasks', options.maxTasks ?? 12);
  const { goal, context, calls } = options;
  if (goal.trim() === '') throw new TypeError('decompose needs a nonblank goal.');
  checkContext('decompose', context);
  const schema = taskListSchema(maxTasks);
  const custom = options.prompts;
  return ctx.scope(options.id, async () => {
    const plan = await team.planner.value('plan', {
      ...calls,
      prompt:
        custom?.plan === undefined
          ? planPrompt(goal, context, maxTasks)
          : custom.plan(goal, maxTasks, context),
      schema,
    });
    const problems = planProblems(plan.tasks);
    if (problems.length === 0) {
      return {
        tasks: plan.tasks,
        waves: wavesOf(plan.tasks),
        repaired: false,
        problems,
        failures: 0,
        status: 'complete',
      };
    }
    ctx.log(
      `${options.id}: the task list has ${String(problems.length)} problem(s); asking the planner for one repair.`,
      { problems },
    );
    const repaired = await team.planner.value('repair', {
      ...calls,
      prompt:
        custom?.repair === undefined
          ? repairPrompt(goal, context, plan.tasks, problems)
          : custom.repair(plan.tasks, problems),
      schema,
    });
    const remaining = planProblems(repaired.tasks);
    if (remaining.length > 0) {
      throw new Error(
        `decompose ${options.id}: the repaired task list is still invalid: ${remaining.join(' ')}`,
      );
    }
    return {
      tasks: repaired.tasks,
      waves: wavesOf(repaired.tasks),
      repaired: true,
      problems,
      failures: 0,
      status: 'complete',
    };
  });
}

/**
 * A task with its fields in schema order and any extra fields (of an extended task schema) after
 * them in name order, so the rendered prompt does not depend on the object's key order: a task
 * read back from a settled map's items has its keys sorted.
 */
function orderedTask(task: Task): Record<string, unknown> {
  const { id, title, description, acceptance, dependsOn, size, ...rest } = task;
  const extra = Object.keys(rest)
    .sort()
    .map((name) => [name, (rest as Readonly<Record<string, unknown>>)[name]] as const);
  return { id, title, description, acceptance, dependsOn, size, ...Object.fromEntries(extra) };
}

/** The call options {@link taskCall} returns: the prompt for one task and the report schema. */
export interface TaskCall {
  /** The rendered prompt for doing the task. */
  readonly prompt: string;
  /** `std.types.WorkReport`, the implementer's report. */
  readonly schema: z.ZodType<WorkReport>;
}

/**
 * The call options for having an implementer do one task of a {@link decompose} backlog: a
 * `std.text.brief` prompt with the goal and the task (its acceptance conditions included), and
 * `std.types.WorkReport` as the schema. The task is shown as JSON with its fields in schema order
 * (any extra fields of an extended task follow in name order), whatever its key order. Spread it
 * into a call to add placement or policy, such as
 * `{ ...std.patterns.taskCall(task, goal), worktree: true }`; trust a command, not the report, for
 * whether the work succeeded.
 *
 * The prompt asks for this task only, assuming the tasks in its `dependsOn` are done, for a check of
 * every acceptance condition before reporting, and for an honest `blocked` or `partial` status when
 * a condition is not met. `std.flow.waves` runs a task only after its dependencies' `run` calls
 * returned, whatever the report says, so make that assumption true: throw from `run` when the
 * report's `status` is not `'done'`, and the dependent tasks are skipped.
 *
 * @param task - The task to do.
 * @param goal - The goal the backlog serves, shown for context; omitted, the prompt has the task
 * alone.
 * @returns `{ prompt, schema }` for `agent.value(id, ...)`.
 */
export function taskCall(task: Task, goal?: string): TaskCall {
  const shown = fence(json(orderedTask(task)), 'json');
  const prompt = brief({
    task: `Complete task ${task.id}: ${task.title}`,
    context:
      goal === undefined
        ? shown
        : [subsection('Goal', goal), subsection('Task', shown)].join('\n\n'),
    guidance: [
      'Do this task only: other tasks cover the rest of the goal, and you may assume the tasks in its dependsOn are done.',
      'Meet every acceptance condition, and check each one before you report.',
      "Keep the change within the task's scope, and match the surrounding code's conventions.",
      'Report honestly: when an acceptance condition is not met, report the work as blocked or partial and say why.',
    ],
    output:
      'A report of the work: its status, what you did, the files you changed, any blockers and notes.',
  });
  return { prompt, schema: WorkReport };
}
