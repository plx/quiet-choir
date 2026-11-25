// quiet-choir/std aggregation patterns (std.patterns.mapReduce, decompose and taskCall) end to end
// against a scripted harness: exact step IDs, default prompts, coverage computed in code, failure
// tolerance (a failed chunk becomes data, is counted, logged and not retried on resume), the
// decompose check-and-repair loop, replay after a tail failure without new calls, option
// validation before any effect, and the Codex schema check of every schema the patterns send.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkCodexSchema,
  definePrompts,
  defineWorkflow,
  runWorkflow,
  stepId,
  z,
  type HarnessRequest,
  type WorkflowContext,
  type WorkflowDefinition,
  type WorkflowResult,
} from '../src/index.js';
import * as aggregate from '../src/std/aggregate.js';
import * as flow from '../src/std/flow.js';
import * as types from '../src/std/types.js';
import {
  ScriptedHarness,
  makeRoot,
  promptOf,
  removeRoot,
  replayAfterTail,
  runOptions,
  tailFailure,
} from './std-harness.js';

let root: string;
beforeEach(async () => {
  root = await makeRoot();
});
afterEach(async () => {
  await removeRoot(root);
});

/** A workflow named `name` whose body is `body`, with an unchecked JSON output. */
function workflow(
  name: string,
  body: (ctx: WorkflowContext) => Promise<unknown>,
): WorkflowDefinition<null, unknown> {
  return defineWorkflow({
    name,
    version: '1',
    input: z.null(),
    output: z.unknown(),
    run: (ctx) => body(ctx),
  });
}

/** Run `definition` once to completion (or rejection) as run `runId`. */
function run(
  definition: WorkflowDefinition<null, unknown>,
  harness: ScriptedHarness,
  runId = 'std',
) {
  return runWorkflow(definition, { ...runOptions(root, runId), harness, input: null });
}

/** A harness answering each call through `answer`; a returned Error is thrown. */
function scripted(answer: (request: HarnessRequest) => unknown): ScriptedHarness {
  return new ScriptedHarness((request) => {
    const reply = answer(request);
    if (reply instanceof Error) throw reply;
    if (reply === undefined) throw new Error(`Unexpected call ${request.stepId}`);
    return reply;
  });
}

/** The log events a run recorded, as `[message, data]` pairs. */
function logs(result: WorkflowResult<unknown>): [string, unknown][] {
  return (result.events ?? []).flatMap((event) =>
    event.type === 'log' ? [[event.message, event.data] as [string, unknown]] : [],
  );
}

/** The first line of each item a default mapper prompt lists (its `## Context` bullets). */
function listed(prompt: string): string[] {
  const context = /## Context\n\n([\s\S]*?)\n\n## Guidance/u.exec(prompt)?.[1] ?? '';
  return context
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2));
}

describe('mapReduce', () => {
  const letters = ['a', 'b', 'c', 'd', 'e'];
  const summarize = (options: Partial<aggregate.MapReduceOptions<string>> = {}) =>
    workflow('map-reduce', (ctx) =>
      aggregate.mapReduce(ctx, {
        id: 'mr',
        team: { mapper: ctx.claude.bind({}), reducer: ctx.claude.bind({ model: 'opus' }) },
        items: letters,
        task: 'Summarize these letters.',
        chunk: 2,
        ...options,
      }),
    );
  /** Mapper chunks answer `summary of <items>`; the reducer answers `combined`; `failing` chunks throw. */
  const mappers = (...failing: string[]) =>
    scripted((request) => {
      if (request.stepId === 'mr/reduce') return 'combined';
      const chunkKey = request.stepId.split('/')[2] ?? '?';
      if (failing.includes(chunkKey)) return new Error(`chunk ${chunkKey} crashed`);
      return `summary of ${listed(promptOf(request)).join('')}`;
    });

  it('maps chunks keyed by their first item, reduces once and covers every item', async () => {
    const harness = mappers();
    const result = await replayAfterTail(summarize(), null, harness, root);
    expect(result.output).toEqual({
      result: 'combined',
      parts: [
        { keys: ['a', 'b'], value: 'summary of ab' },
        { keys: ['c', 'd'], value: 'summary of cd' },
        { keys: ['e'], value: 'summary of e' },
      ],
      coverage: { covered: letters, missing: [] },
      chunks: 3,
      failedChunks: 0,
      status: 'complete',
    });
    expect([...harness.ids()].sort()).toEqual([
      'mr/map/a/part',
      'mr/map/c/part',
      'mr/map/e/part',
      'mr/reduce',
    ]);
    expect(harness.ids().at(-1)).toBe('mr/reduce');
    const map = harness.prompt('mr/map/c/part');
    expect(
      map.startsWith('Summarize these letters.\n\n## Context\n\n- c\n- d\n\n## Guidance'),
    ).toBe(true);
    expect(map).toContain('Each item starts with its key');
    expect(map).toContain('## Output\n\nYour answer for these items as concise text');
    const reduce = harness.prompt('mr/reduce');
    expect(reduce).toContain(
      'Combine the partial answers below into one complete answer to this task: Summarize these letters.',
    );
    expect(reduce).toContain('### Part 1\n\nsummary of ab\n\n### Part 2\n\nsummary of cd');
    expect(reduce).not.toContain('Not covered');
    expect(harness.calls.find((call) => call.stepId === 'mr/reduce')?.options).toMatchObject({
      model: 'opus',
    });
  });

  it('turns a failed chunk into missing coverage, tells the reducer and never retries it', async () => {
    const harness = mappers('c');
    const result = await replayAfterTail(
      summarize({ reduce: 'Write one line.' }),
      null,
      harness,
      root,
    );
    expect(result.output).toMatchObject({
      result: 'combined',
      parts: [
        { keys: ['a', 'b'], value: 'summary of ab' },
        { keys: ['e'], value: 'summary of e' },
      ],
      coverage: { covered: ['a', 'b', 'e'], missing: ['c', 'd'] },
      chunks: 3,
      failedChunks: 1,
      status: 'degraded',
    });
    expect(harness.count('mr/map/c/part')).toBe(1);
    const reduce = harness.prompt('mr/reduce');
    expect(reduce.startsWith('Write one line.\n\n')).toBe(true);
    expect(reduce).toContain('Each part answers this task for a share of the items: Summarize');
    expect(reduce).toContain('### Not covered\n\n- c\n- d');
    expect(reduce).toContain('do not guess what they contain');
    expect(logs(result)).toEqual([
      ['mr: 1 of 3 chunk(s) failed; 2 item(s) are not covered.', { missing: ['c', 'd'] }],
    ]);
  });

  it('skips the reducer when every chunk fails, and records nothing without items', async () => {
    const harness = mappers('a', 'c', 'e');
    const result = await run(summarize(), harness, 'all-fail');
    expect(result.output).toEqual({
      result: '',
      parts: [],
      coverage: { covered: [], missing: letters },
      chunks: 3,
      failedChunks: 3,
      status: 'failed',
    });
    expect(harness.ids()).not.toContain('mr/reduce');

    const idle = mappers();
    const empty = await run(summarize({ items: [] }), idle, 'empty');
    expect(empty.output).toEqual({
      result: '',
      parts: [],
      coverage: { covered: [], missing: [] },
      chunks: 0,
      failedChunks: 0,
      status: 'complete',
    });
    expect(idle.calls).toHaveLength(0);
    expect(Object.keys(empty.steps)).toEqual([]);
  });

  it('sends a structured schema, describes records and keys them by index by default', async () => {
    interface Commit {
      readonly sha: string;
      readonly subject: string;
    }
    const commits: Commit[] = [
      { sha: 'a1', subject: 'Add the export flag' },
      { sha: 'b2', subject: 'Fix the parser' },
      { sha: 'c3', subject: 'Refactor tests' },
    ];
    const change = (sha: string): types.Change => ({
      kind: 'fix',
      summary: `Change ${sha}`,
      shas: [sha],
      userVisible: true,
      migration: null,
    });
    const harness = scripted((request) => {
      if (request.stepId === 'notes/reduce') return 'Release notes';
      return {
        changes: listed(promptOf(request)).map((line) => change(line.split(': ')[0] ?? '?')),
      };
    });
    const definition = workflow('map-reduce-structured', (ctx) =>
      aggregate.mapReduce(ctx, {
        id: 'notes',
        team: { mapper: ctx.claude.bind({}), reducer: ctx.claude.bind({}) },
        items: commits,
        task: 'Turn these commits into change-log entries.',
        chunk: 2,
        schema: types.Changes,
        reduce: 'Write release notes.',
      }),
    );
    const result = await replayAfterTail(definition, null, harness, root);
    expect(result.output).toEqual({
      result: 'Release notes',
      parts: [
        { keys: ['0', '1'], value: { changes: [change('0'), change('1')] } },
        { keys: ['2'], value: { changes: [change('2')] } },
      ],
      coverage: { covered: ['0', '1', '2'], missing: [] },
      chunks: 2,
      failedChunks: 0,
      status: 'complete',
    });
    expect(harness.ids().sort()).toEqual(['notes/map/0/part', 'notes/map/2/part', 'notes/reduce']);
    // Records default to their two-space JSON after the index key.
    expect(harness.prompt('notes/map/2/part')).toContain(
      '- 2: {\n    "sha": "c3",\n    "subject": "Refactor tests"\n  }',
    );
    expect(harness.prompt('notes/map/0/part')).toContain(
      '## Output\n\nYour answer for these items, in the requested structure.',
    );
    expect(harness.prompt('notes/reduce')).toContain('### Part 1\n\n```json\n{\n  "changes": [');
    for (const call of harness.calls.filter((entry) => entry.stepId.endsWith('/part'))) {
      expect(call.outputSchema).not.toBeNull();
      expect(checkCodexSchema(call.outputSchema ?? {})).toEqual([]);
    }
    expect(harness.calls.find((call) => call.stepId === 'notes/reduce')?.outputSchema).toBeNull();
  });

  it('uses caller keys and descriptions, made ID-safe, without repeating a leading key', async () => {
    const files = ['src/a.ts', 'src/b.ts', 'docs/c.md'];
    const harness = scripted((request) =>
      request.stepId.endsWith('/reduce')
        ? 'done'
        : `read ${String(listed(promptOf(request)).length)}`,
    );
    const definition = workflow('map-reduce-keys', (ctx) =>
      aggregate.mapReduce(ctx, {
        id: 'files',
        team: { mapper: ctx.claude.bind({}), reducer: ctx.claude.bind({}) },
        items: files,
        key: (file) => file.toUpperCase(),
        describe: (file, index) =>
          [`${file.toUpperCase()} (first)`, `${file.toUpperCase()}X is longer`][index] ??
          `the file ${file}`,
        task: 'Describe these files.',
      }),
    );
    const result = await run(definition, harness);
    const first = stepId('SRC/A.TS');
    expect(harness.ids()).toEqual([`files/map/${first}/part`, 'files/reduce']);
    expect(listed(harness.prompt(`files/map/${first}/part`))).toEqual([
      'SRC/A.TS (first)',
      // Only a whole-word key prefix stands in for the key.
      'SRC/B.TS: SRC/B.TSX is longer',
      'DOCS/C.MD: the file docs/c.md',
    ]);
    expect(result.output).toMatchObject({
      parts: [{ keys: ['SRC/A.TS', 'SRC/B.TS', 'DOCS/C.MD'], value: 'read 3' }],
      coverage: { covered: ['SRC/A.TS', 'SRC/B.TS', 'DOCS/C.MD'], missing: [] },
    });
  });

  it('replaces both default prompts', async () => {
    const harness = scripted((request) => (request.stepId === 'mr/reduce' ? 'joined' : 'part'));
    const definition = summarize({
      chunk: 3,
      prompts: {
        map: (items, keys) => `map ${items.join('+')} as ${keys.join(',')}`,
        reduce: (parts, coverage) =>
          `reduce ${String(parts.length)} parts covering ${coverage.covered.join('')}`,
      },
    });
    const result = await run(definition, harness);
    expect(harness.prompt('mr/map/a/part')).toBe('map a+b+c as a,b,c');
    expect(harness.prompt('mr/map/d/part')).toBe('map d+e as d,e');
    expect(harness.prompt('mr/reduce')).toBe('reduce 2 parts covering abcde');
    expect(result.output).toMatchObject({ result: 'joined', status: 'complete' });
  });

  it('refuses to replay chunk answers after a prompt or version change', async () => {
    let task = 'Summarize these letters.';
    let version = 'v1';
    const definition = tailFailure(
      workflow('map-reduce-pinned', (ctx) =>
        aggregate.mapReduce(ctx, {
          id: 'mr',
          team: { mapper: ctx.claude.bind({}), reducer: ctx.claude.bind({}) },
          items: letters,
          task,
          chunk: 2,
          version,
        }),
      ),
    );
    const harness = mappers();
    const options = { ...runOptions(root, 'pinned'), harness };
    await expect(runWorkflow(definition, { ...options, input: null })).rejects.toThrow(
      'Injected tail failure',
    );
    const calls = harness.calls.length;
    // The rendered prompts are the map items, so a new task text is a changed map.
    task = 'Summarize these letters in one word.';
    await expect(runWorkflow(definition, { ...options, resume: true })).rejects.toThrow(
      'Settled map mr/map changed after an item completed (changed: items)',
    );
    task = 'Summarize these letters.';
    version = 'v2';
    await expect(runWorkflow(definition, { ...options, resume: true })).rejects.toThrow(
      'Settled map mr/map changed after an item completed (changed: version)',
    );
    version = 'v1';
    const resumed = await runWorkflow(definition, { ...options, resume: true });
    expect(resumed.output).toMatchObject({ result: 'combined', status: 'complete' });
    expect(harness.calls).toHaveLength(calls);
  });

  it('refuses to replay chunk answers after a call placement change, not a deadline change', async () => {
    let calls: aggregate.MapReduceOptions<string>['calls'];
    const definition = tailFailure(
      workflow('map-reduce-placed', (ctx) =>
        aggregate.mapReduce(ctx, {
          id: 'mr',
          team: { mapper: ctx.claude.bind({}), reducer: ctx.claude.bind({}) },
          items: letters,
          task: 'Summarize these letters.',
          chunk: 2,
          calls,
        }),
      ),
    );
    const harness = mappers();
    const options = { ...runOptions(root, 'placed'), harness };
    await expect(runWorkflow(definition, { ...options, input: null })).rejects.toThrow(
      'Injected tail failure',
    );
    calls = { cwd: 'pkg' };
    await expect(runWorkflow(definition, { ...options, resume: true })).rejects.toThrow(
      'Settled map mr/map changed after an item completed (changed: items)',
    );
    calls = { timeoutMs: 5_000 };
    const resumed = await runWorkflow(definition, { ...options, resume: true });
    expect(resumed.output).toMatchObject({ result: 'combined', status: 'complete' });
    expect(harness.calls).toHaveLength(4);
  });

  it('keeps Prompt objects out of the map items, as their rendered text', async () => {
    await writeFile(join(root, 'Map.md'), 'map {{ keys }}');
    await writeFile(join(root, 'Reduce.md'), 'reduce {{ count }}');
    const set = definePrompts(root, {
      Map: { file: 'Map.md', params: z.object({ keys: z.string() }) },
      Reduce: { file: 'Reduce.md', params: z.object({ count: z.string() }) },
    });
    const harness = scripted((request) => (request.stepId === 'mr/reduce' ? 'joined' : 'part'));
    const definition = summarize({
      prompts: {
        map: (_items, keys) => set.Map({ keys: keys.join(',') }),
        reduce: (parts) => set.Reduce({ count: String(parts.length) }),
      },
    });
    const result = await replayAfterTail(definition, null, harness, root);
    expect(harness.prompt('mr/map/c/part')).toBe('map c,d');
    expect(harness.prompt('mr/reduce')).toBe('reduce 3');
    expect(result.output).toMatchObject({ result: 'joined', status: 'complete' });
  });

  it('lets a failed reducer reject, then retries only the reducer on resume', async () => {
    let reducer: string | Error = new Error('reducer crashed');
    const harness = scripted((request) =>
      request.stepId === 'mr/reduce' ? reducer : `summary of ${listed(promptOf(request)).join('')}`,
    );
    await expect(run(summarize(), harness, 'reducer')).rejects.toThrow('reducer crashed');
    expect(harness.ids().filter((id) => id.endsWith('/part'))).toHaveLength(3);
    reducer = 'combined';
    const resumed = await runWorkflow(summarize(), {
      ...runOptions(root, 'reducer'),
      harness,
      resume: true,
    });
    expect(resumed.output).toMatchObject({ result: 'combined', failedChunks: 0 });
    expect(harness.ids().filter((id) => id.endsWith('/part'))).toHaveLength(3);
    expect(harness.count('mr/reduce')).toBe(2);
  });

  it('validates options before any effect', async () => {
    const harness = mappers();
    await expect(run(summarize({ chunk: 0 }), harness, 'chunk')).rejects.toThrow(
      'chunk must be a positive integer; got 0.',
    );
    await expect(run(summarize({ concurrency: 1.5 }), harness, 'conc')).rejects.toThrow(
      'concurrency must be a positive integer; got 1.5.',
    );
    await expect(run(summarize({ items: ['a', 'b', 'a', 'b'] }), harness, 'dupes')).rejects.toThrow(
      'Duplicate mapReduce item key: "a", "b".',
    );
    // Blank texts are refused up front, not after the map has spent every mapper call.
    await expect(run(summarize({ reduce: '  ' }), harness, 'reduce')).rejects.toThrow(
      'mapReduce reduce must be nonblank when given.',
    );
    await expect(
      run(summarize({ task: ' ', prompts: { map: (items) => items.join(',') } }), harness, 'task'),
    ).rejects.toThrow('mapReduce task must be nonblank.');
    expect(harness.calls).toHaveLength(0);
  });

  it('refuses an unfilled slot before any effect, instead of journaling failed chunks', async () => {
    const harness = mappers();
    const unfilled = (team: (ctx: WorkflowContext) => object) =>
      workflow('map-reduce', (ctx) =>
        aggregate.mapReduce(ctx, {
          id: 'mr',
          team: team(ctx) as aggregate.MapReduceTeam,
          items: letters,
          task: 'Summarize these letters.',
        }),
      );
    await expect(
      run(
        unfilled(() => ({})),
        harness,
        'none',
      ),
    ).rejects.toThrow('Team slot mapper is not filled.');
    await expect(
      run(
        unfilled((ctx) => ({ mapper: ctx.claude.bind({}) })),
        harness,
        'mapper',
      ),
    ).rejects.toThrow('Team slot reducer is not filled.');
    expect(harness.calls).toHaveLength(0);
  });
});

describe('decompose', () => {
  const task = (id: string, dependsOn: string[] = [], title = `Do ${id}`): types.Task => ({
    id,
    title,
    description: `Work for ${id}.`,
    acceptance: [`${id} is done`],
    dependsOn,
    size: 'S',
  });
  const plan = (options: Partial<aggregate.DecomposeOptions> = {}) =>
    workflow('decompose', (ctx) =>
      aggregate.decompose(ctx, {
        id: 'plan',
        team: { planner: ctx.claude.bind({}) },
        goal: 'Add a --json flag to the export command.',
        ...options,
      }),
    );
  /** The planner answers `plan/plan` and `plan/repair` from `lists`. */
  const planner = (lists: Readonly<Record<string, readonly types.Task[]>>) =>
    scripted((request) => {
      const leaf = request.stepId.split('/').at(-1) ?? '?';
      const tasks = lists[leaf];
      return tasks === undefined ? undefined : { tasks };
    });

  it('plans once, checks the list and returns its dependency waves', async () => {
    const tasks = [task('T1'), task('T2', ['T1']), task('T3'), task('T4', ['T2', 'T3'])];
    const harness = planner({ plan: tasks });
    const result = await replayAfterTail(plan(), null, harness, root);
    expect(result.output).toEqual({
      tasks,
      waves: [[tasks[0], tasks[2]], [tasks[1]], [tasks[3]]],
      status: 'planned',
      problems: [],
    });
    expect(harness.ids()).toEqual(['plan/plan']);
    const prompt = harness.prompt('plan/plan');
    expect(
      prompt.startsWith(
        'Break the goal below into a backlog of at most 12 tasks that together achieve it.\n\n## Context\n\nAdd a --json flag to the export command.\n\n## Guidance',
      ),
    ).toBe(true);
    expect(prompt).toContain('with no cycles');
    const schema = harness.calls[0]?.outputSchema ?? {};
    expect(checkCodexSchema(schema)).toEqual([]);
    expect(schema).toMatchObject({ properties: { tasks: { minItems: 1, maxItems: 12 } } });
  });

  it('shows background, honors maxTasks and refuses an over-long list', async () => {
    const harness = planner({ plan: [task('T1'), task('T2'), task('T3')] });
    const definition = plan({ maxTasks: 2, context: { files: ['src/export.ts'] } });
    await expect(run(definition, harness)).rejects.toThrow();
    const prompt = harness.prompt('plan/plan');
    expect(prompt).toContain('at most 2 tasks');
    expect(prompt).toContain(
      '## Context\n\n### Goal\n\nAdd a --json flag to the export command.\n\n### Background\n\n```json\n{\n  "files": [\n    "src/export.ts"\n  ]\n}\n```',
    );
    expect(harness.calls[0]?.outputSchema).toMatchObject({
      properties: { tasks: { maxItems: 2 } },
    });
  });

  it('asks for one repair with every problem and reports what it fixed', async () => {
    const broken = [task('T1'), task('T1', ['T9', 'T9']), task('T2', ['T1'])];
    const fixed = [task('T1'), task('T3', ['T1']), task('T2', ['T1'])];
    const harness = planner({ plan: broken, repair: fixed });
    const result = await replayAfterTail(
      plan({ context: 'Keep the CLI stable.' }),
      null,
      harness,
      root,
    );
    const problems = [
      'The task ID "T1" is used by more than one task.',
      'Task "T1" depends on "T9", which is not in the list.',
    ];
    expect(result.output).toEqual({
      tasks: fixed,
      waves: [[fixed[0]], [fixed[1], fixed[2]]],
      status: 'repaired',
      problems,
    });
    expect(harness.ids()).toEqual(['plan/plan', 'plan/repair']);
    const repair = harness.prompt('plan/repair');
    expect(repair).toContain('### Background\n\nKeep the CLI stable.');
    expect(repair).toContain('### Task list\n\n```json\n{\n  "tasks": [');
    expect(repair).toContain(`### Problems\n\n- ${problems[0] ?? ''}\n- ${problems[1] ?? ''}`);
    expect(checkCodexSchema(harness.calls[1]?.outputSchema ?? {})).toEqual([]);
    expect(logs(result)).toEqual([
      ['plan: the task list has 2 problem(s); asking the planner for one repair.', { problems }],
    ]);
  });

  it('throws, listing the problems, when the repair leaves a cycle', async () => {
    const harness = planner({
      plan: [task('T1', ['T1'])],
      repair: [task('T1', ['T2']), task('T2', ['T1'])],
    });
    await expect(run(plan(), harness)).rejects.toThrow(
      'decompose plan: the repaired task list is still invalid: Invalid dependencies: cycle "T1" -> "T2" -> "T1".',
    );
    expect(harness.prompt('plan/repair')).toContain('- Invalid dependencies: cycle "T1" -> "T1".');
  });

  it('replaces both default prompts and validates maxTasks before any effect', async () => {
    const harness = planner({ plan: [task('T1', ['T5'])], repair: [task('T1')] });
    const definition = plan({
      maxTasks: 3,
      context: { cli: 'src/cli.ts' },
      prompts: {
        plan: (goal, max, context) =>
          `plan ${goal} in ${String(max)} given ${JSON.stringify(context)}`,
        repair: (tasks, problems) => `repair ${String(tasks.length)}: ${problems.join(' ')}`,
      },
    });
    const result = await run(definition, harness);
    expect(harness.prompt('plan/plan')).toBe(
      'plan Add a --json flag to the export command. in 3 given {"cli":"src/cli.ts"}',
    );
    expect(harness.prompt('plan/repair')).toBe(
      'repair 1: Task "T1" depends on "T5", which is not in the list.',
    );
    expect(result.output).toMatchObject({ status: 'repaired', tasks: [task('T1')] });

    const idle = planner({});
    await expect(run(plan({ maxTasks: 0 }), idle, 'zero')).rejects.toThrow(
      'maxTasks must be a positive integer; got 0.',
    );
    await expect(run(plan({ team: {} as aggregate.PlanTeam }), idle, 'unfilled')).rejects.toThrow(
      'Team slot planner is not filled.',
    );
    await expect(run(plan({ goal: '  ' }), idle, 'blank')).rejects.toThrow(
      'decompose needs a nonblank goal.',
    );
    expect(idle.calls).toHaveLength(0);
  });
});

describe('taskCall', () => {
  const task: types.Task = {
    id: 'T2',
    title: 'Add the flag',
    description: 'Parse --json in the export command.',
    acceptance: ['export --json prints JSON'],
    dependsOn: ['T1'],
    size: 'M',
  };

  it('gives a brief with the goal and the task and the WorkReport schema', () => {
    const call = aggregate.taskCall(task, 'Ship JSON export.');
    expect(call.schema).toBe(types.WorkReport);
    expect(checkCodexSchema(call.schema)).toEqual([]);
    expect(call.prompt).toContain(
      'Complete task T2: Add the flag\n\n## Context\n\n### Goal\n\nShip JSON export.\n\n### Task\n\n```json\n{\n  "id": "T2",',
    );
    expect(call.prompt).toContain('"export --json prints JSON"');
    expect(call.prompt).toContain('you may assume the tasks in its dependsOn are done');
    expect(call.prompt).toContain('report the work as blocked or partial and say why');
    expect(aggregate.taskCall(task).prompt).toContain('## Context\n\n```json\n{\n  "id": "T2",');
  });

  it('renders the task in schema order whatever its key order, extra fields last', () => {
    const shuffled = Object.fromEntries(Object.entries(task).reverse()) as types.Task;
    expect(aggregate.taskCall(shuffled, 'Goal.').prompt).toBe(
      aggregate.taskCall(task, 'Goal.').prompt,
    );
    const extended = { ...task, zone: 'cli', owner: 'ada' };
    expect(aggregate.taskCall(extended).prompt).toContain(
      '  "size": "M",\n  "owner": "ada",\n  "zone": "cli"\n}',
    );
  });

  it('is what an implementer call takes in std.flow.waves, whose items have sorted keys', async () => {
    const report: types.WorkReport = {
      status: 'done',
      summary: 'Added the flag.',
      files: ['src/export.ts'],
      blockers: [],
      notes: [],
    };
    const harness = scripted(() => report);
    const definition = workflow('task-call', (ctx) =>
      flow.waves(ctx, {
        id: 'build',
        items: [task],
        key: (item) => item.id,
        dependsOn: () => [],
        run: (item) => ctx.claude.bind({}).value('work', aggregate.taskCall(item, 'Ship it.')),
      }),
    );
    const result = await run(definition, harness);
    expect(result.output).toMatchObject({ status: 'complete', results: [{ value: report }] });
    expect(harness.prompt('build/wave/0/T2/work')).toBe(
      aggregate.taskCall(task, 'Ship it.').prompt,
    );
  });
});
