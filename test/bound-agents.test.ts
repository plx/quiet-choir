// Bound agents (ADR 0063 sections 1-2, #578): ctx.<harness>.bind(options) is partial application
// over the durable client, so every bound call must fingerprint, resolve and record exactly as the
// raw call that spells the merged options at the call site.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect } from 'vitest';
import type { runWorkflow } from '../src/index.js';
import {
  defineHarness,
  defineWorkflow,
  readRun,
  z,
  type AgentRequest,
  type HarnessAdapter,
  type StepRecord,
  type WorkflowContext,
  type WorkflowHarnesses,
} from '../src/index.js';
import { bindAgent, bindRole, roleOf } from '../src/workflow/runtime/bound-agent.js';
import { it } from './setup/state-dir.js';

const prompt = 'review the diff';
const Review = z.object({ verdict: z.string() });
const base = { version: '1', input: z.null(), output: z.unknown() } as const;
const reply = { text: '{"verdict":"ok"}', sessionId: null };
const third = defineHarness({
  name: 'third',
  revision: 1,
  options: z.object({
    prompt: z.string(),
    thinking: z.string().optional(),
    timeoutMs: z.number().positive().optional(),
  }),
  capabilities: { structuredOutput: 'native' },
  access: () => 'none',
  policy: ['timeoutMs'],
});
const textOnly = defineHarness({
  ...third,
  name: 'plain',
  capabilities: { structuredOutput: 'none' },
});

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'choir-bound-'));
  directories.push(directory);
  return directory;
}

/** A capturing adapter shared by the built-in fallback and registered harnesses. */
function capture(text = reply.text) {
  const requests: AgentRequest[] = [];
  const adapter: HarnessAdapter = {
    // eslint-disable-next-line @typescript-eslint/require-await -- an immediate fake adapter
    invoke: async (request) => {
      requests.push(request);
      return { text, sessionId: null };
    },
  };
  return {
    requests,
    adapter,
    harness: {
      invoke: (request: AgentRequest) => adapter.invoke(request, new AbortController().signal),
    },
  };
}

/** The identity and recorded resolution of one step, without timestamps. */
function view(step: StepRecord | undefined) {
  expect(step).toBeDefined();
  return {
    fingerprint: step?.fingerprint,
    // The attempt's identity, resolved profile, options summary, policy and policy sources.
    attempts: step?.attemptHistory?.map(
      ({ fingerprint, profile, policy, request, requested, sources }) => ({
        fingerprint,
        profile,
        policy,
        request,
        requested,
        sources,
      }),
    ),
  };
}

const harnesses = [third, textOnly] as const;
const profiles = { scout: { claude: { model: 'haiku', tools: ['Read'] } } };
type Context = WorkflowContext<'scout', WorkflowHarnesses<typeof harnesses>, false>;
type Body = (ctx: Context) => Promise<unknown>;
function workflow(name: string, run: Body) {
  return defineWorkflow({ ...base, name, harnesses, profiles, run });
}

/** Run a raw and a bound body in separate state directories with one run ID; return both sides. */
async function compare(runs: { run: typeof runWorkflow }, raw: Body, bound: Body) {
  const sides = [];
  for (const run of [raw, bound]) {
    const stateDir = await tempDir();
    const fake = capture();
    const result = await runs.run(workflow('bound', run), {
      stateDir,
      runId: 'bound',
      input: null,
      harness: fake.harness,
      adapters: { third: fake.adapter, plain: fake.adapter },
    });
    sides.push({
      result,
      requests: fake.requests,
      record: await readRun({ stateDir, runId: 'bound' }),
    });
  }
  const [left, right] = sides as [(typeof sides)[0], (typeof sides)[0]];
  // Concurrent map items may launch in either order; identity, not order, is compared.
  const byStep = (requests: readonly AgentRequest[]) =>
    [...requests].sort((a, b) => a.stepId.localeCompare(b.stepId));
  expect(byStep(right.requests)).toEqual(byStep(left.requests));
  expect(Object.keys(right.record.steps).sort()).toEqual(Object.keys(left.record.steps).sort());
  for (const id of Object.keys(left.record.steps))
    expect(view(right.record.steps[id])).toEqual(view(left.record.steps[id]));
  expect(right.result.output).toEqual(left.result.output);
  return { left, right };
}

const reviewer = { model: 'opus', effort: 'high', tools: ['Read', 'Grep'] } as const;

it('fingerprints and requests a bound Claude call exactly as the raw call (golden)', async ({
  runs,
}) => {
  const { left } = await compare(
    runs,
    async (ctx) => [
      await ctx.claude.value('review', { prompt, schema: Review, ...reviewer }),
      (await ctx.claude.text('notes', { prompt, ...reviewer })).output,
      (await ctx.claude.object('summary', { prompt, schema: Review, ...reviewer })).output,
    ],
    async (ctx) => {
      const agent = ctx.claude.bind(reviewer);
      return [
        await agent.value('review', { prompt, schema: Review }),
        (await agent.text('notes', { prompt })).output,
        (await agent.object('summary', { prompt, schema: Review })).output,
      ];
    },
  );
  expect(left.requests.map((request) => request.stepId)).toEqual(['review', 'notes', 'summary']);
  expect(left.requests[0]?.options).toMatchObject({ model: 'opus', tools: ['Read', 'Grep'] });
  expect(left.requests[0]?.outputSchema).not.toBeNull();
  expect(left.requests[1]?.outputSchema).toBeNull();
});

it('appends call addDirs to the bound list, as a raw call spelling both', async ({ runs }) => {
  const { left } = await compare(
    runs,
    async (ctx) => [
      await ctx.claude.value('dirs', { prompt, addDirs: ['a', 'b'] }),
      await ctx.claude.value('bound-only', { prompt, addDirs: ['a'] }),
      await ctx.claude.value('call-only', { prompt, addDirs: ['b'] }),
      await ctx.claude.value('neither', { prompt }),
    ],
    async (ctx) => {
      const withDirs = ctx.claude.bind({ addDirs: ['a'] });
      const without = ctx.claude.bind({});
      return [
        await withDirs.value('dirs', { prompt, addDirs: ['b'] }),
        await withDirs.value('bound-only', { prompt }),
        await without.value('call-only', { prompt, addDirs: ['b'] }),
        await without.value('neither', { prompt }),
      ];
    },
  );
  expect(left.requests.map((request) => request.options.addDirs)).toEqual([
    ['a', 'b'],
    ['a'],
    ['b'],
    undefined,
  ]);
});

it('lets a call deadline win and treats an undefined call value as absent', async ({ runs }) => {
  const { left } = await compare(
    runs,
    async (ctx) => [
      await ctx.claude.value('call-wins', { prompt, timeoutMs: 2000, idleTimeoutMs: 500 }),
      await ctx.claude.value('default', { prompt, timeoutMs: 1000, idleTimeoutMs: 100 }),
    ],
    async (ctx) => {
      const agent = ctx.claude.bind({ timeoutMs: 1000, idleTimeoutMs: 100 });
      return [
        await agent.value('call-wins', { prompt, timeoutMs: 2000, idleTimeoutMs: 500 }),
        await agent.value('default', { prompt, timeoutMs: undefined, idleTimeoutMs: undefined }),
      ];
    },
  );
  expect(left.requests.map(({ options }) => [options.timeoutMs, options.idleTimeoutMs])).toEqual([
    [2000, 500],
    [1000, 100],
  ]);
});

it('binds Codex, passing per-call images through', async ({ runs }) => {
  const directory = await tempDir();
  const image = join(directory, 'shot.png');
  await writeFile(image, 'not really a png');
  const coder = { model: 'gpt-5-codex', sandbox: 'read-only' } as const;
  const { left } = await compare(
    runs,
    async (ctx) => [
      await ctx.codex.value('plan', { prompt, schema: Review, ...coder }),
      await ctx.codex.value('look', { prompt, images: [image], ...coder }),
    ],
    async (ctx) => {
      const agent = ctx.codex.bind(coder);
      return [
        await agent.value('plan', { prompt, schema: Review }),
        await agent.value('look', { prompt, images: [image] }),
      ];
    },
  );
  expect(left.requests[1]?.options).toMatchObject({ images: [image], sandbox: 'read-only' });
  expect(left.requests[1]?.imageAttachments).toHaveLength(1);
});

it('binds a registered harness, and a text-only one to a text agent', async ({ runs }) => {
  await compare(
    runs,
    async (ctx) => [
      await ctx.agent('third').value('answer', { prompt, schema: Review, thinking: 'deep' }),
      (await ctx.agent('plain').text('plain', { prompt, thinking: 'deep', timeoutMs: 5 })).output,
    ],
    async (ctx) => [
      await ctx
        .agent('third')
        .bind({ thinking: 'deep' })
        .value('answer', { prompt, schema: Review }),
      (await ctx.agent('plain').bind({ thinking: 'deep' }).text('plain', { prompt, timeoutMs: 5 }))
        .output,
    ],
  );
});

it('lifts a profile into a bound agent with the raw call resolution', async ({ runs }) => {
  const { left } = await compare(
    runs,
    async (ctx) => ctx.claude.value('scan', { prompt, profile: 'scout' }),
    async (ctx) => ctx.claude.bind({ profile: 'scout' }).value('scan', { prompt }),
  );
  expect(view(left.record.steps['scan']).attempts?.[0]?.profile).toBe('scout');
  expect(left.requests[0]?.options).toMatchObject({ model: 'haiku', tools: ['Read'] });
});

it('layers a second bind over the first', async ({ runs }) => {
  const { left } = await compare(
    runs,
    async (ctx) =>
      ctx.claude.value('layered', {
        prompt,
        model: 'opus',
        addDirs: ['a', 'c', 'd'],
        timeoutMs: 9,
      }),
    async (ctx) =>
      ctx.claude
        .bind({ model: 'opus', addDirs: ['a'], timeoutMs: 1 })
        .bind({ addDirs: ['c'], timeoutMs: 9 })
        .value('layered', { prompt, addDirs: ['d'] }),
  );
  expect(left.requests[0]?.options.addDirs).toEqual(['a', 'c', 'd']);
});

it('names a call where it is invoked, keeping a ctx.within prefix', async ({ runs }) => {
  const { left } = await compare(
    runs,
    async (ctx) => {
      await ctx.scope('outer', () => ctx.claude.value('in-scope', { prompt, model: 'opus' }));
      await ctx.map('items', ['x', 'y'], { concurrency: 2 }, (item) =>
        ctx.claude.value(item, { prompt, model: 'opus' }),
      );
      return ctx.within('w').claude.value('within', { prompt, model: 'opus' });
    },
    async (ctx) => {
      const agent = ctx.claude.bind({ model: 'opus' });
      const prefixed = ctx.within('w').claude.bind({ model: 'opus' });
      await ctx.scope('outer', () => agent.value('in-scope', { prompt }));
      await ctx.map('items', ['x', 'y'], { concurrency: 2 }, (item) =>
        agent.value(item, { prompt }),
      );
      return prefixed.value('within', { prompt });
    },
  );
  expect(Object.keys(left.record.steps).sort()).toEqual([
    'items/0/x',
    'items/1/y',
    'outer/in-scope',
    'w/within',
  ]);
});

it('refuses per-call-only keys at bind, fixed keys at a re-bind and unbound keys before a bound call launches', async ({
  runs,
  stateDir,
}) => {
  const untyped = (value: unknown) => value as never;
  const fake = capture();
  const errors: unknown[] = [];
  const definition = workflow('guards', async (ctx) => {
    for (const key of ['prompt', 'cwd', 'onError', 'schema', 'worktree', 'retry', 'images']) {
      try {
        ctx.claude.bind(untyped({ [key]: key === 'schema' ? Review : 'x' }));
      } catch (error) {
        errors.push(error);
      }
    }
    const agent = ctx.claude.bind({ model: 'opus' });
    await expect(agent.value('model', untyped({ prompt, model: 'haiku' }))).rejects.toThrow(
      new TypeError(
        'A bound agent call cannot set model; bind it instead, or call the harness client directly (ADR 0063).',
      ),
    );
    await expect(agent.text('tools', untyped({ prompt, tools: ['Bash'] }))).rejects.toThrow(
      TypeError,
    );
    // Malformed untyped options are refused the same way, before any launch.
    expect(() => ctx.claude.bind(untyped(null))).toThrow('bind options must be an object.');
    expect(() => ctx.claude.bind(untyped({ addDirs: 'a' }))).toThrow(
      'bind addDirs must be an array.',
    );
    await expect(agent.value('null', untyped(null))).rejects.toThrow(
      'Bound agent call options must be an object.',
    );
    await expect(agent.value('dirs', untyped({ prompt, addDirs: 'b' }))).rejects.toThrow(
      'A bound agent call addDirs must be an array.',
    );
    // A re-bind may set only the both-sides keys; the first bind fixed the rest.
    expect(() => (agent.bind as (options: unknown) => unknown)({ model: 'haiku' })).toThrow(
      new TypeError('A bound agent cannot bind model again; the first bind fixed it (ADR 0063).'),
    );
    expect(() => agent.bind(untyped({ tools: ['Bash'], timeoutMs: 1 }))).toThrow(
      'A bound agent cannot bind tools again',
    );
    expect(() => agent.bind(untyped({ prompt }))).toThrow(
      'bind cannot set prompt; it is a per-call option (ADR 0063).',
    );
    agent.bind({ addDirs: ['a'], timeoutMs: 1, idleTimeoutMs: 1 });
    // An undefined non-bound key is absent, as optionData treats it.
    return agent.value('fine', untyped({ prompt, model: undefined }));
  });
  await runs.run(definition, { stateDir, runId: 'guards', input: null, harness: fake.harness });
  expect(errors).toHaveLength(7);
  for (const error of errors) expect(error).toBeInstanceOf(TypeError);
  expect((errors[0] as Error).message).toBe(
    'bind cannot set prompt; it is a per-call option (ADR 0063).',
  );
  expect((errors[1] as Error).message).toContain('cwd');
  expect((errors[2] as Error).message).toContain('onError');
  expect(fake.requests.map((request) => request.stepId)).toEqual(['fine']);
  expect(Object.keys((await readRun({ stateDir, runId: 'guards' })).steps)).toEqual(['fine']);
});

it('fails the run on a bound validation error in a settled map, as on a raw one', async ({
  runs,
  stateDir,
}) => {
  const untyped = (value: unknown) => value as never;
  type Mapper = (ctx: Context) => Promise<unknown>;
  const cases: [string, Mapper, string][] = [
    ['raw', (ctx) => ctx.claude.value('call', untyped({ prompt, addDirs: 'invalid' })), 'addDirs'],
    [
      'call-dirs',
      (ctx) => ctx.claude.bind({}).value('call', untyped({ prompt, addDirs: 'invalid' })),
      'A bound agent call addDirs must be an array.',
    ],
    [
      'call-fixed',
      (ctx) =>
        ctx.claude.bind({ model: 'opus' }).value('call', untyped({ prompt, model: 'haiku' })),
      'A bound agent call cannot set model',
    ],
    [
      'bind',
      (ctx) => ctx.claude.bind(untyped({ prompt })).value('call', { prompt }),
      'bind cannot set prompt',
    ],
    [
      're-bind',
      (ctx) =>
        ctx.claude
          .bind({ model: 'opus' })
          .bind(untyped({ model: 'haiku' }))
          .value('call', { prompt }),
      'A bound agent cannot bind model again',
    ],
    [
      'within',
      (ctx) =>
        ctx
          .within('w')
          .claude.bind({ model: 'opus' })
          .value('call', untyped({ prompt, tools: ['Bash'] })),
      'A bound agent call cannot set tools',
    ],
  ];
  for (const [runId, mapper, message] of cases) {
    const fake = capture();
    const definition = workflow(runId, (ctx) =>
      ctx.map('items', ['x'], { concurrency: 1, onError: 'return' }, () => mapper(ctx)),
    );
    await expect(
      runs.run(definition, { stateDir, runId, input: null, harness: fake.harness }),
    ).rejects.toThrow(message);
    const record = await readRun({ stateDir, runId });
    // Nothing is journaled for the item, and no step is claimed or invoked.
    expect(record.maps?.['items']?.items[0]?.status).toBe('running');
    expect(record.steps).toEqual({});
    expect(fake.requests).toEqual([]);
  }
});

it('fails the run on an unawaited invalid bound call in a settled map, as on a raw one', async ({
  runs,
  stateDir,
}) => {
  const untyped = (value: unknown) => value as never;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    type Fire = (ctx: Context) => Promise<unknown>;
    const cases: [string, Fire, string, string][] = [
      [
        'raw',
        (ctx) => ctx.claude.value('call', untyped({ prompt, addDirs: 'invalid' })),
        'items/0/call',
        'Invalid claude options: addDirs',
      ],
      [
        'bound',
        (ctx) =>
          ctx.claude.bind({ model: 'opus' }).value('call', untyped({ prompt, model: 'haiku' })),
        'items/0/call',
        'A bound agent call cannot set model',
      ],
      [
        'within',
        (ctx) => ctx.within('w').claude.bind({}).text('call', untyped(null)),
        'items/0/w/call',
        'Bound agent call options must be an object.',
      ],
    ];
    for (const [runId, fire, stepId, message] of cases) {
      const fake = capture();
      // The mapper drops the failed call and returns normally; the tracker still owns the call.
      const definition = workflow(runId, (ctx) =>
        ctx.map('items', ['x'], { concurrency: 1, onError: 'return' }, () => {
          void fire(ctx);
          return Promise.resolve('done');
        }),
      );
      const failure = runs.run(definition, { stateDir, runId, input: null, harness: fake.harness });
      await expect(failure).rejects.toThrow(
        `Step ${stepId} (claude) failed: Unawaited workflow operation "${stepId}" failed: `,
      );
      await expect(failure).rejects.toThrow(message);
      expect(fake.requests).toEqual([]);
      expect((await readRun({ stateDir, runId })).steps).toEqual({});
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

it('snapshots bound options so later mutation cannot change the agent', async ({
  runs,
  stateDir,
}) => {
  const fake = capture();
  const definition = workflow('snapshot', async (ctx) => {
    // An undefined bound value is absent too, so it never reaches the request.
    const options = {
      model: 'opus',
      addDirs: ['a'],
      tools: ['Read'],
      env: { A: '1' } as Record<string, string>,
      settings: { nested: { A: '1' } } as { nested: Record<string, string> },
      effort: undefined,
    };
    const agent = ctx.claude.bind(options);
    options.model = 'haiku';
    options.addDirs.push('b');
    // Nested values are copied too, not shared with the caller.
    options.tools.push('Bash');
    options.env['A'] = '2';
    options.settings.nested['A'] = '2';
    options.settings.nested['B'] = '3';
    return agent.value('snap', { prompt });
  });
  await runs.run(definition, { stateDir, runId: 'snapshot', input: null, harness: fake.harness });
  expect(fake.requests[0]?.options).toMatchObject({
    model: 'opus',
    addDirs: ['a'],
    tools: ['Read'],
    env: { A: '1' },
    settings: { nested: { A: '1' } },
  });
  expect(fake.requests[0]?.options.env).toEqual({ A: '1' });
  expect(fake.requests[0]?.options).toHaveProperty('settings', { nested: { A: '1' } });
  expect(fake.requests[0]?.options).not.toHaveProperty('effort');
});

it('keeps own __proto__ keys in bound options, as the raw spelling does', async ({ runs }) => {
  // Computed keys define own properties; assignment would set the prototype instead.
  const settings = () => ({
    ['__proto__']: 'x',
    nested: { ['__proto__']: { A: '1' }, B: '2' },
  });
  const { left } = await compare(
    runs,
    async (ctx) => ctx.claude.value('proto', { prompt, settings: settings() }),
    async (ctx) => ctx.claude.bind({ settings: settings() }).value('proto', { prompt }),
  );
  const sent = Reflect.get(left.requests[0]?.options ?? {}, 'settings') as Record<string, unknown>;
  expect(Object.keys(sent)).toEqual(['__proto__', 'nested']);
  expect(Object.getOwnPropertyDescriptor(sent, '__proto__')?.value).toBe('x');
  const nested = sent['nested'] as Record<string, unknown>;
  expect(Object.getOwnPropertyDescriptor(nested, '__proto__')?.value).toEqual({ A: '1' });
});

it('refuses at bind a nested value the raw call boundary would reject, never copying it away', async ({
  runs,
  stateDir,
}) => {
  const untyped = (value: unknown) => value as never;
  let reads = 0;
  const hidden = Object.defineProperty({ A: '1' }, 'B', { value: '2', enumerable: false });
  const symbolic = { A: '1', [Symbol('s')]: '2' };
  const getter = Object.defineProperty({ A: '1' }, 'B', {
    get: () => ++reads,
    enumerable: true,
  });
  // A hole: index 1 is absent while the length counts it.
  const holey = ['a'];
  holey[2] = 'c';
  const arrayGetter = Object.defineProperty(['a'], 0, { get: () => ++reads, enumerable: true });
  const arrayHidden = Object.defineProperty(['a', 'b'], 1, { value: 'b', enumerable: false });
  const augmented = Object.assign(['a'], { extra: 'x' });
  const cases = [
    [hidden, 'objects cannot contain symbols or non-enumerable properties'],
    [symbolic, 'objects cannot contain symbols or non-enumerable properties'],
    [getter, 'it cannot contain getters'],
    [{ nested: getter }, 'it cannot contain getters'],
    [holey, 'arrays cannot have holes'],
    [arrayGetter, 'it cannot contain getters'],
    [arrayHidden, 'it cannot contain non-enumerable properties'],
    [augmented, 'arrays cannot have extra keys'],
  ] as const;
  const fake = capture();
  const definition = workflow('not-json', async (ctx) => {
    for (const [settings, reason] of cases)
      expect(() => ctx.claude.bind(untyped({ settings }))).toThrow(
        new TypeError(`bind settings must be plain JSON: ${reason}.`),
      );
    // The raw spelling of the first case is refused too, at the call's JSON boundary.
    await expect(ctx.claude.value('raw', untyped({ prompt, settings: hidden }))).rejects.toThrow(
      'non-enumerable',
    );
    return null;
  });
  await runs.run(definition, { stateDir, runId: 'not-json', input: null, harness: fake.harness });
  // No getter was evaluated, and nothing reached the adapter.
  expect(reads).toBe(0);
  expect(fake.requests).toEqual([]);
});

it('reads top-level bind and call options by descriptor, never evaluating or dropping a key', async ({
  runs,
  stateDir,
}) => {
  const untyped = (value: unknown) => value as never;
  let reads = 0;
  const getter = <T extends object>(target: T, key: string) =>
    Object.defineProperty(target, key, { get: () => ++reads, enumerable: true });
  const hidden = <T extends object>(target: T, key: string, value: unknown) =>
    Object.defineProperty(target, key, { value, enumerable: false });
  const fake = capture();
  const definition = workflow('top-level', async (ctx) => {
    const hiddenOption = 'bind cannot set a symbol or non-enumerable option.';
    expect(() => ctx.claude.bind(untyped(getter({}, 'model')))).toThrow(
      new TypeError('bind model must be a data property, not a getter.'),
    );
    expect(() => ctx.claude.bind(untyped(hidden({}, 'model', 'opus')))).toThrow(
      new TypeError(hiddenOption),
    );
    expect(() => ctx.claude.bind(untyped({ model: 'opus', [Symbol('s')]: 'x' }))).toThrow(
      new TypeError(hiddenOption),
    );
    expect(() => ctx.claude.bind(untyped({ addDirs: getter(['a'], '0') }))).toThrow(
      new TypeError('bind addDirs must be plain JSON: it cannot contain getters.'),
    );
    const agent = ctx.claude.bind({ model: 'opus', addDirs: ['a'] });
    expect(() => agent.bind(untyped(getter({}, 'timeoutMs')))).toThrow(
      new TypeError('bind timeoutMs must be a data property, not a getter.'),
    );
    const call = 'A bound agent call';
    const calls = [
      [getter({ prompt }, 'timeoutMs'), `${call} timeoutMs must be a data property, not a getter.`],
      [hidden({}, 'prompt', prompt), `${call} cannot set a symbol or non-enumerable option.`],
      [{ prompt, [Symbol('s')]: 'x' }, `${call} cannot set a symbol or non-enumerable option.`],
      [
        { prompt, addDirs: Object.assign(['b'], { extra: 'x' }) },
        `${call} addDirs must be plain JSON: arrays cannot have extra keys.`,
      ],
      [
        { prompt, addDirs: getter(['b'], '0') },
        `${call} addDirs must be plain JSON: it cannot contain getters.`,
      ],
    ] as const;
    for (const [index, [options, message]] of calls.entries())
      await expect(agent.value(`call-${String(index)}`, untyped(options))).rejects.toThrow(
        new TypeError(message),
      );
    return null;
  });
  await runs.run(definition, { stateDir, runId: 'top-level', input: null, harness: fake.harness });
  // No getter was evaluated, nothing reached the adapter and no step was claimed.
  expect(reads).toBe(0);
  expect(fake.requests).toEqual([]);
  expect(Object.keys((await readRun({ stateDir, runId: 'top-level' })).steps)).toEqual([]);
});

/** A client that records each call's method, step ID and options object. */
function stubClient() {
  const calls: { method: string; id: string; options: Record<string, unknown> }[] = [];
  const record =
    (method: string) =>
    (id: string, options: Record<string, unknown>): Promise<null> => {
      calls.push({ method, id, options });
      return Promise.resolve(null);
    };
  return {
    calls,
    client: { value: record('value'), text: record('text'), object: record('object') },
  };
}

type StubAgent = Record<
  'value' | 'text' | 'object',
  (id: string, options: unknown) => Promise<unknown>
> & { readonly bind: (options: unknown) => StubAgent };

it('names a role-bound call through the role channel, never a profile key', async () => {
  const { calls, client } = stubClient();
  const agent = bindRole(client, 'Reviewer') as StubAgent;
  await agent.value('review', { prompt, schema: Review });
  await agent.text('notes', { prompt, addDirs: ['a'] });
  await agent.object('summary', { prompt });
  // A re-bind's calls still reach the stub through the role layer, marked, with addDirs appended.
  await agent.bind({ addDirs: ['b'] }).value('again', { prompt, addDirs: ['c'] });
  expect(calls.map(({ method, id }) => [method, id])).toEqual([
    ['value', 'review'],
    ['text', 'notes'],
    ['object', 'summary'],
    ['value', 'again'],
  ]);
  for (const { options } of calls) {
    expect(Object.hasOwn(options, 'profile')).toBe(false);
    expect(roleOf(options)).toBe('Reviewer');
  }
  expect(calls[3]?.options).toEqual({ addDirs: ['b', 'c'], prompt });
  // A plain bind leaves its calls unmarked; a profile key or a non-object names no role.
  const plain = stubClient();
  await (bindAgent(plain.client as never, {}) as unknown as StubAgent).value('plain', { prompt });
  expect(roleOf(plain.calls[0]?.options)).toBeUndefined();
  expect(roleOf({ profile: 'X' })).toBeUndefined();
  expect(roleOf('x')).toBeUndefined();
  expect(roleOf(null)).toBeUndefined();
  // A role-bound call still cannot set profile, and a re-bind cannot bind it.
  await expect(agent.value('profile', { prompt, profile: 'scout' })).rejects.toThrow(
    new TypeError(
      'A bound agent call cannot set profile; bind it instead, or call the harness client directly (ADR 0063).',
    ),
  );
  expect(() => agent.bind({ profile: 'scout' })).toThrow(
    new TypeError('A bound agent cannot bind profile again; the first bind fixed it (ADR 0063).'),
  );
  expect(calls).toHaveLength(4);
});

it('reuses a completed bound step on resume without invoking the adapter', async ({
  runs,
  stateDir,
}) => {
  const fake = capture();
  let fail = true;
  const definition = workflow('resume', async (ctx) => {
    const agent = ctx.claude.bind(reviewer);
    const verdict = await agent.value('review', { prompt, schema: Review });
    if (fail) throw new Error('pause');
    return verdict;
  });
  const options = { stateDir, runId: 'resume', input: null, harness: fake.harness };
  await expect(runs.run(definition, options)).rejects.toThrow('pause');
  fail = false;
  const result = await runs.run(definition, { ...options, resume: true });
  expect(result.output).toEqual({ verdict: 'ok' });
  expect(fake.requests).toHaveLength(1);
});
