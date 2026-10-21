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

it('refuses per-call-only keys at bind and unbound keys before a bound call launches', async ({
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
