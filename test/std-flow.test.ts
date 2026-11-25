// quiet-choir/std flow helpers end to end: untilDry, waves and each run real workflows against a
// scripted harness, checking the exact step IDs, the loop and wave decisions, failure tolerance,
// replay after a tail failure without new calls, and that waves/each fingerprint the caller's own
// mapper source.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defineWorkflow,
  runWorkflow,
  stepId,
  z,
  type HarnessRequest,
  type WorkflowContext,
  type WorkflowDefinition,
} from '../src/index.js';
import { findingKey } from '../src/std/data.js';
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

/** Answer each call from `replies` by step ID; an Error value is thrown. */
function scripted(replies: Readonly<Record<string, string | Error>>): ScriptedHarness {
  return new ScriptedHarness((request: HarnessRequest) => {
    const reply = replies[request.stepId];
    if (reply === undefined) throw new Error(`Unexpected call ${request.stepId}`);
    if (reply instanceof Error) throw reply;
    return reply;
  });
}

/** The comma-separated items of a finder reply. */
function items(reply: string): string[] {
  return reply === '' ? [] : reply.split(',');
}

describe('untilDry', () => {
  /** A hunt whose round `n` asks the finder at `hunt/round/<n>/find`, keyed case-insensitively. */
  const hunt = (options: { rounds?: number; patience?: number; settled?: boolean } = {}) =>
    workflow('until-dry', async (ctx) => {
      const finder = ctx.claude.bind({});
      return flow.untilDry(ctx, {
        id: 'hunt',
        rounds: options.rounds ?? 6,
        patience: options.patience,
        key: (item: string) => item.toLowerCase(),
        round: async (n, known) => {
          const prompt = `round ${String(n)}; known: ${known.join(',')}`;
          if (options.settled !== true)
            return { found: items(await finder.value('find', { prompt })) };
          const answer = await finder.value('find', { prompt, onError: 'return' });
          return answer.ok ? { found: items(answer.value) } : { found: [], failed: 1 };
        },
      });
    });

  it('dedupes across rounds, counts dry rounds and stops after two in a row', async () => {
    const harness = scripted({
      'hunt/round/0/find': 'a,b,A',
      'hunt/round/1/find': 'B,c',
      'hunt/round/2/find': 'a',
      'hunt/round/3/find': '',
    });
    const result = await replayAfterTail(hunt(), null, harness, root);
    expect(result.output).toEqual({
      found: ['a', 'b', 'c'],
      rounds: 4,
      dryRounds: 2,
      failedRounds: 0,
      ended: 'dry',
    });
    expect(harness.ids()).toEqual([
      'hunt/round/0/find',
      'hunt/round/1/find',
      'hunt/round/2/find',
      'hunt/round/3/find',
    ]);
    expect(harness.prompt('hunt/round/1/find')).toBe('round 1; known: a,b');
    expect(harness.prompt('hunt/round/3/find')).toBe('round 3; known: a,b,c');
  });

  it('resets the dry streak when a round finds something new', async () => {
    const harness = scripted({
      'hunt/round/0/find': 'a',
      'hunt/round/1/find': 'a',
      'hunt/round/2/find': 'b',
      'hunt/round/3/find': '',
      'hunt/round/4/find': 'b,a',
    });
    const result = await run(hunt(), harness);
    expect(result.output).toMatchObject({
      rounds: 5,
      dryRounds: 3,
      ended: 'dry',
      found: ['a', 'b'],
    });
  });

  it('honors patience and reports the round limit', async () => {
    const patient = scripted({ 'hunt/round/0/find': 'a', 'hunt/round/1/find': '' });
    const once = await run(hunt({ patience: 1 }), patient, 'patience');
    expect(once.output).toMatchObject({ rounds: 2, dryRounds: 1, ended: 'dry' });

    const busy = scripted({
      'hunt/round/0/find': 'a',
      'hunt/round/1/find': 'b',
      'hunt/round/2/find': 'c',
    });
    const limited = await run(hunt({ rounds: 3 }), busy, 'limit');
    expect(limited.output).toEqual({
      found: ['a', 'b', 'c'],
      rounds: 3,
      dryRounds: 0,
      failedRounds: 0,
      ended: 'round-limit',
    });

    // A dry streak completed on the last allowed round still reports dry.
    const last = scripted({ 'hunt/round/0/find': 'a', 'hunt/round/1/find': '' });
    const edge = await run(hunt({ rounds: 2, patience: 1 }), last, 'edge');
    expect(edge.output).toMatchObject({ rounds: 2, ended: 'dry' });
  });

  it('never counts a failed round as dry and does not retry it on resume', async () => {
    const harness = scripted({
      'hunt/round/0/find': 'a',
      'hunt/round/1/find': new Error('finder crashed'),
      'hunt/round/2/find': '',
      'hunt/round/3/find': '',
    });
    const result = await replayAfterTail(hunt({ settled: true }), null, harness, root);
    // Without the failure rule, rounds 1 and 2 would have ended the loop after three rounds.
    expect(result.output).toEqual({
      found: ['a'],
      rounds: 4,
      dryRounds: 2,
      failedRounds: 1,
      ended: 'dry',
    });
    expect(harness.count('hunt/round/1/find')).toBe(1);
  });

  it('keeps items from a failed round and reaches the round limit while failures persist', async () => {
    const reports: flow.UntilDryRound<string>[] = [
      { found: ['a', 'b'], failed: 1 },
      { found: ['a'], failed: 2 },
      { found: [], failed: 0 },
    ];
    const definition = workflow('until-dry-mixed', (ctx) =>
      flow.untilDry(ctx, {
        id: 'mixed',
        rounds: 3,
        key: String,
        round: (n) => Promise.resolve(reports[n] ?? { found: [] }),
      }),
    );
    const result = await run(definition, scripted({}));
    expect(result.output).toEqual({
      found: ['a', 'b'],
      rounds: 3,
      dryRounds: 1,
      failedRounds: 2,
      ended: 'round-limit',
    });
  });

  it('infers the item type from the rounds, not from the key', async () => {
    // As in the module example: `key` takes any value with a file and a title, and it must not
    // narrow the item type, or `found[0].severity` would not compile.
    const finding: types.Finding = {
      title: 'Null dereference',
      file: 'src/a.ts',
      line: 3,
      severity: 'high',
      evidence: 'src/a.ts:3',
      failureScenario: 'it breaks',
    };
    const definition = workflow('until-dry-infer', async (ctx) => {
      const finder = ctx.claude.bind({});
      const hunt = await flow.untilDry(ctx, {
        id: 'hunt',
        rounds: 2,
        patience: 1,
        key: findingKey,
        round: async (_n, known) => {
          const report = await finder.value('find', {
            prompt: `Find bugs not in this list:\n${JSON.stringify(known)}`,
            schema: types.Findings,
          });
          return { found: report.findings };
        },
      });
      const severity: types.Severity | undefined = hunt.found[0]?.severity;
      return severity;
    });
    const harness = new ScriptedHarness((request) =>
      request.stepId === 'hunt/round/0/find' ? { findings: [finding] } : { findings: [] },
    );
    expect((await run(definition, harness)).output).toBe('high');
  });

  it('rejects invalid options and round results before or without new effects', async () => {
    const harness = scripted({ 'hunt/round/0/find': 'a' });
    await expect(run(hunt({ rounds: 0 }), harness, 'r0')).rejects.toThrow(
      'rounds must be a positive integer; got 0.',
    );
    await expect(run(hunt({ rounds: 1.5 }), harness, 'r1')).rejects.toThrow(
      'rounds must be a positive integer; got 1.5.',
    );
    await expect(run(hunt({ patience: 0 }), harness, 'p0')).rejects.toThrow(
      'patience must be a positive integer; got 0.',
    );
    expect(harness.calls).toHaveLength(0);

    const bad = (result: unknown) =>
      workflow('until-dry-bad', (ctx) =>
        flow.untilDry(ctx, {
          id: 'bad',
          rounds: 2,
          key: String,
          round: () => Promise.resolve(result as flow.UntilDryRound<string>),
        }),
      );
    await expect(run(bad({ found: [], failed: -1 }), harness, 'f1')).rejects.toThrow(
      'untilDry round 0 returned failed: -1; expected a nonnegative integer.',
    );
    await expect(run(bad({ items: [] }), harness, 'f2')).rejects.toThrow(
      'untilDry round 0 must return { found: [...] }.',
    );
  });
});

interface Task {
  readonly id: string;
  readonly deps: readonly string[];
}

const plan: readonly Task[] = [
  { id: 'd', deps: ['b', 'c'] },
  { id: 'a', deps: [] },
  { id: 'b', deps: ['a'] },
  { id: 'c', deps: ['a'] },
  { id: 'e', deps: [] },
  { id: 'f', deps: ['d'] },
];

describe('waves', () => {
  /** Run `tasks` in waves under `build`, each item asking the worker at `<key>/do`. */
  const build = (tasks: readonly Task[], concurrency?: number) =>
    workflow('waves', async (ctx) => {
      const worker = ctx.claude.bind({});
      return flow.waves(ctx, {
        id: 'build',
        items: tasks,
        key: (task) => task.id,
        dependsOn: (task) => task.deps,
        concurrency,
        run: (task, index) => worker.value('do', { prompt: `do ${task.id} at ${String(index)}` }),
      });
    });
  /** Echo `done <id>` for every call, failing the ones whose task ID is in `failing`. */
  const worker = (...failing: string[]) =>
    new ScriptedHarness((request) => {
      const id = /^do (\S+)/u.exec(promptOf(request))?.[1] ?? '?';
      if (failing.includes(id)) throw new Error(`${id} broke`);
      return `done ${id}`;
    });
  /** The wave number in a `build/wave/<n>/...` step ID. */
  const waveOf = (id: string): number => Number(id.split('/')[2]);

  it('runs dependency waves in order with exact step IDs', async () => {
    const harness = worker();
    const result = await replayAfterTail(build(plan), null, harness, root);
    expect(result.output).toEqual({
      results: plan.map((task) => ({
        key: task.id,
        item: task,
        status: 'done',
        value: `done ${task.id}`,
        error: null,
      })),
      waves: [['a', 'e'], ['b', 'c'], ['d'], ['f']],
      status: 'complete',
    });
    expect([...harness.ids()].sort()).toEqual([
      'build/wave/0/a/do',
      'build/wave/0/e/do',
      'build/wave/1/b/do',
      'build/wave/1/c/do',
      'build/wave/2/d/do',
      'build/wave/3/f/do',
    ]);
    const order = harness.ids().map(waveOf);
    expect(order).toEqual([...order].sort());
    expect(Object.keys(result.maps ?? {}).sort()).toEqual([
      'build/wave/0',
      'build/wave/1',
      'build/wave/2',
      'build/wave/3',
    ]);
    // `index` is the position among the items its wave runs.
    expect(harness.prompt('build/wave/0/e/do')).toBe('do e at 1');
    expect(harness.prompt('build/wave/1/c/do')).toBe('do c at 1');
  });

  it('skips dependents of a failed item and replays the failure without retrying it', async () => {
    const harness = worker('b');
    const result = await replayAfterTail(build(plan), null, harness, root);
    const output = result.output as unknown as flow.WavesResult<Task, string>;
    expect(output.status).toBe('degraded');
    expect(output.waves).toEqual([['a', 'e'], ['b', 'c'], ['d'], ['f']]);
    expect(output.results.map((entry) => [entry.key, entry.status])).toEqual([
      ['d', 'skipped'],
      ['a', 'done'],
      ['b', 'failed'],
      ['c', 'done'],
      ['e', 'done'],
      ['f', 'skipped'],
    ]);
    const failed = output.results[2];
    expect(failed?.value).toBeNull();
    expect(failed?.error).toMatchObject({ stepId: 'build/wave/1/b/do' });
    expect(failed?.error?.message).toContain('b broke');
    expect(output.results[0]).toMatchObject({ value: null, error: null });
    expect([...harness.ids()].sort()).toEqual([
      'build/wave/0/a/do',
      'build/wave/0/e/do',
      'build/wave/1/b/do',
      'build/wave/1/c/do',
    ]);
    expect(harness.count('build/wave/1/b/do')).toBe(1);
    // Waves 2 and 3 have nothing left to run, so they record no map.
    expect(Object.keys(result.maps ?? {}).sort()).toEqual(['build/wave/0', 'build/wave/1']);
  });

  it('keys items by an ID-safe form of their key', async () => {
    const tasks: Task[] = [
      { id: 'src/a.ts', deps: [] },
      { id: 'fix it', deps: ['src/a.ts'] },
    ];
    const harness = new ScriptedHarness(() => 'ok');
    const result = await run(build(tasks), harness);
    expect(harness.ids()).toEqual([
      `build/wave/0/${stepId('src/a.ts')}/do`,
      `build/wave/1/${stepId('fix it')}/do`,
    ]);
    expect(result.output).toMatchObject({ waves: [['src/a.ts'], ['fix it']], status: 'complete' });
  });

  it('rejects duplicate keys, unknown dependencies, cycles and bad concurrency before running', async () => {
    const harness = worker();
    const cases: [readonly Task[], string, number?][] = [
      [
        [
          { id: 'a', deps: [] },
          { id: 'a', deps: [] },
        ],
        'Invalid dependencies: duplicate key "a".',
      ],
      [[{ id: 'a', deps: ['zz'] }], 'Invalid dependencies: "a" depends on unknown "zz".'],
      [
        [
          { id: 'a', deps: ['b'] },
          { id: 'b', deps: ['a'] },
        ],
        'Invalid dependencies: cycle "a" -> "b" -> "a".',
      ],
      [plan, 'concurrency must be a positive integer; got 0.', 0],
    ];
    for (const [index, [tasks, message, concurrency]] of cases.entries()) {
      await expect(run(build(tasks, concurrency), harness, `bad-${String(index)}`)).rejects.toThrow(
        message,
      );
    }
    expect(harness.calls).toHaveLength(0);
  });

  it('fingerprints the caller run function itself and the version', async () => {
    let variant = 1;
    let version = 'v1';
    const definition = tailFailure(
      workflow('waves-mapper', async (ctx) => {
        const agent = ctx.claude.bind({});
        const runOne =
          variant === 1
            ? (task: Task) => agent.value('do', { prompt: task.id })
            : (task: Task) => agent.value('do', { prompt: task.id.toUpperCase() });
        return flow.waves(ctx, {
          id: 'build',
          items: plan.slice(1, 3),
          key: (task) => task.id,
          dependsOn: (task) => task.deps,
          version,
          run: runOne,
        });
      }),
    );
    const harness = new ScriptedHarness(() => 'ok');
    const options = { ...runOptions(root), harness };
    await expect(runWorkflow(definition, { ...options, input: null })).rejects.toThrow(
      'Injected tail failure',
    );
    variant = 2;
    await expect(runWorkflow(definition, { ...options, resume: true })).rejects.toThrow(
      /changed.*mapper/su,
    );
    variant = 1;
    version = 'v2';
    await expect(runWorkflow(definition, { ...options, resume: true })).rejects.toThrow(
      /changed.*version/su,
    );
    version = 'v1';
    const resumed = await runWorkflow(definition, { ...options, resume: true });
    expect(resumed.output).toMatchObject({ status: 'complete' });
    expect(harness.calls).toHaveLength(2);
  });
});

describe('each', () => {
  /** Ask about every item at `fan/<key>/ask`; the harness fails items named in `failing`. */
  const fan = (key?: (item: string, index: number) => string, version?: string) =>
    workflow('each', async (ctx) => {
      const agent = ctx.claude.bind({});
      return flow.each(ctx, 'fan', ['x', 'y', 'z', 'y'], { key, version }, (item) =>
        agent.value('ask', { prompt: item }),
      );
    });
  const answer = (...failing: string[]) =>
    new ScriptedHarness((request) => {
      const prompt = promptOf(request);
      if (failing.includes(prompt)) throw new Error(`no answer for ${prompt}`);
      return `re:${prompt}`;
    });

  it('splits done and failed items, keyed by index, and replays without retrying', async () => {
    const harness = answer('y');
    const result = await replayAfterTail(fan(), null, harness, root);
    const output = result.output as unknown as flow.EachResult<string, string>;
    expect(output.status).toBe('degraded');
    expect(output.done).toEqual([
      { key: '0', item: 'x', index: 0, value: 're:x' },
      { key: '2', item: 'z', index: 2, value: 're:z' },
    ]);
    expect(output.failed.map((entry) => [entry.key, entry.item, entry.index])).toEqual([
      ['1', 'y', 1],
      ['3', 'y', 3],
    ]);
    expect(output.failed[0]?.error).toMatchObject({ stepId: 'fan/1/ask' });
    expect(output.failed[0]?.error.message).toContain('no answer for y');
    expect([...harness.ids()].sort()).toEqual(['fan/0/ask', 'fan/1/ask', 'fan/2/ask', 'fan/3/ask']);
    expect(harness.count('fan/1/ask')).toBe(1);
  });

  it('makes caller labels unique and ID-safe', async () => {
    const harness = answer();
    const result = await run(
      fan((item) => (item === 'z' ? 'z z' : item)),
      harness,
    );
    const output = result.output as unknown as flow.EachResult<string, string>;
    expect(output.status).toBe('complete');
    expect(output.done.map((entry) => entry.key)).toEqual(['x', 'y', stepId('z z'), 'y.2']);
    expect([...harness.ids()].sort()).toEqual(
      ['fan/x/ask', 'fan/y/ask', `fan/${stepId('z z')}/ask`, 'fan/y.2/ask'].sort(),
    );
  });

  it('fingerprints the caller mapper and the version', async () => {
    let variant = 1;
    let version = 'v1';
    const definition = tailFailure(
      workflow('each-mapper', async (ctx) => {
        const agent = ctx.claude.bind({});
        const mapper =
          variant === 1
            ? (item: string) => agent.value('ask', { prompt: item })
            : (item: string) => agent.value('ask', { prompt: item.toUpperCase() });
        return flow.each(ctx, 'fan', ['x', 'y'], { version }, mapper);
      }),
    );
    const harness = answer();
    const options = { ...runOptions(root), harness };
    await expect(runWorkflow(definition, { ...options, input: null })).rejects.toThrow(
      'Injected tail failure',
    );
    variant = 2;
    await expect(runWorkflow(definition, { ...options, resume: true })).rejects.toThrow(
      /changed.*mapper/su,
    );
    variant = 1;
    version = 'v2';
    await expect(runWorkflow(definition, { ...options, resume: true })).rejects.toThrow(
      /changed.*version/su,
    );
    version = 'v1';
    const resumed = await runWorkflow(definition, { ...options, resume: true });
    expect(resumed.output).toMatchObject({ status: 'complete' });
    expect(harness.calls).toHaveLength(2);
  });

  it('passes the input index to the mapper', async () => {
    const definition = workflow('each-index', (ctx) =>
      flow.each(ctx, 'fan', ['p', 'q', 'p'], { key: (item) => item }, (item, index) =>
        Promise.resolve(`${item}@${String(index)}`),
      ),
    );
    const result = await run(definition, answer());
    expect(result.output).toEqual({
      done: [
        { key: 'p', item: 'p', index: 0, value: 'p@0' },
        { key: 'q', item: 'q', index: 1, value: 'q@1' },
        { key: 'p.2', item: 'p', index: 2, value: 'p@2' },
      ],
      failed: [],
      status: 'complete',
    });
    expect(Object.keys(result.maps ?? {})).toEqual(['fan']);
  });

  it('completes over no items, as does waves', async () => {
    const definition = workflow('empty', async (ctx) => {
      const mapped = await flow.each(ctx, 'fan', [], {}, (item: string) => Promise.resolve(item));
      const waved = await flow.waves(ctx, {
        id: 'build',
        items: [] as Task[],
        key: (task) => task.id,
        dependsOn: (task) => task.deps,
        run: (task) => Promise.resolve(task.id),
      });
      return { mapped, waved };
    });
    const result = await run(definition, answer());
    expect(result.output).toEqual({
      mapped: { done: [], failed: [], status: 'complete' },
      waved: { results: [], waves: [], status: 'complete' },
    });
  });

  it('rejects a bad concurrency before mapping', async () => {
    const definition = workflow('each-bad', (ctx) =>
      flow.each(ctx, 'fan', ['x'], { concurrency: 0 }, (item) => Promise.resolve(item)),
    );
    await expect(run(definition, answer())).rejects.toThrow(
      'concurrency must be a positive integer; got 0.',
    );
  });
});
