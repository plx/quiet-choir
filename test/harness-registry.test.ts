/* eslint-disable @typescript-eslint/require-await -- Deliberately immediate asynchronous fake adapters. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  defineHarness,
  defineWorkflow,
  runWorkflow,
  readRun,
  z,
  type AgentRequest,
  type HarnessDeclaration,
  type HarnessAdapter,
} from '../src/index.js';

const directories: string[] = [];
async function setup() {
  const stateDir = await mkdtemp(join(tmpdir(), 'choir-registry-'));
  directories.push(stateDir);
  return { stateDir, runId: 'registered', input: null };
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const response = (text: string) => ({ text, sessionId: null });
const base = { name: 'registry', version: '1', input: z.null(), output: z.string() };
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
function workflow(registration: HarnessDeclaration = third) {
  return defineWorkflow({
    ...base,
    harnesses: [registration],
    async run(ctx) {
      return ctx.agent('third').value('answer', { prompt: 'hello' });
    },
  });
}

it('dispatches explicit adapters before catch-all before factories and supplies durable identity', async () => {
  const requests: AgentRequest[] = [];
  let factories = 0;
  const registration = defineHarness({
    ...third,
    createAdapter: () => {
      factories++;
      return {
        invoke: async (request) => {
          requests.push(request);
          return response('factory');
        },
      };
    },
  });
  const adapter: HarnessAdapter = {
    invoke: async (request) => {
      requests.push(request);
      return response('explicit');
    },
  };
  const definition = workflow(registration);
  const fallback = { invoke: async () => response('fallback') };
  const first = await runWorkflow(definition, {
    ...(await setup()),
    adapters: { third: adapter },
    harness: fallback,
  });
  expect(first.output).toBe('explicit');
  expect(requests[0]).toMatchObject({
    harness: 'third',
    revision: 1,
    runId: 'registered',
    stepId: 'answer',
    attempt: 1,
    idempotencyKey: 'registered/answer',
  });
  expect(first.steps['answer']).toMatchObject({ kind: 'agent', harness: 'third', revision: 1 });
  expect((await runWorkflow(definition, { ...(await setup()), harness: fallback })).output).toBe(
    'fallback',
  );
  expect(factories).toBe(0);
  expect((await runWorkflow(definition, await setup())).output).toBe('factory');
  expect(factories).toBe(1);
});

it('preflights duplicate and missing declarations before local effects', async () => {
  let local = 0;
  const definition = defineWorkflow({
    ...base,
    harnesses: [third],
    async run(ctx) {
      return ctx.step('local', {
        input: null,
        schema: z.string(),
        run: () => {
          local++;
          return 'local';
        },
      });
    },
  });
  await expect(runWorkflow(definition, await setup())).rejects.toThrow(
    'No harness adapter configured for third',
  );
  await expect(
    runWorkflow({ ...definition, harnesses: [third, third] }, await setup()),
  ).rejects.toThrow('duplicate harness third');
  expect(local).toBe(0);
});

it('replays completed registered calls without constructing an adapter and refuses missing names or revisions', async () => {
  const options = await setup();
  let factories = 0;
  const registered = defineHarness({
    ...third,
    createAdapter: () => {
      factories++;
      return { invoke: async () => response('saved') };
    },
  });
  await runWorkflow(workflow(registered), options);
  await runWorkflow(workflow(registered), { ...options, resume: true, acceptCodeChange: true });
  expect(factories).toBe(1);
  expect(
    (await runWorkflow(workflow(), { ...options, resume: true, acceptCodeChange: true })).output,
  ).toBe('saved');
  await expect(
    runWorkflow(
      { ...workflow(), harnesses: [] },
      { ...options, resume: true, acceptCodeChange: true, allowHarnessChange: true },
    ),
  ).rejects.toThrow('no longer declared');
  await expect(
    runWorkflow(workflow({ ...third, revision: 2 }), {
      ...options,
      resume: true,
      acceptCodeChange: true,
    }),
  ).rejects.toThrow('now revision 2');
});

it('validates unknown options and text-only structured calls before an attempt', async () => {
  const options = await setup();
  const definition = defineWorkflow({
    ...base,
    harnesses: [third],
    async run(ctx) {
      return ctx.agent('third').value('bad', { prompt: 'x', ...{ unknown: 'no' } });
    },
  });
  let calls = 0;
  await expect(
    runWorkflow(definition, {
      ...options,
      adapters: {
        third: {
          invoke: async () => {
            calls++;
            return response('bad');
          },
        },
      },
    }),
  ).rejects.toThrow('unknown');
  expect(calls).toBe(0);
  expect((await readRun(options)).steps).toEqual({});
  const textOnly = { ...third, capabilities: { structuredOutput: 'none' as const } };
  await expect(
    runWorkflow(
      defineWorkflow({
        ...base,
        harnesses: [textOnly],
        async run(ctx) {
          // @ts-expect-error Runtime also rejects structured calls made by untyped code.
          return ctx.agent('third').value('structured', { prompt: 'x', schema: z.string() });
        },
      }),
      { ...(await setup()), adapters: { third: { invoke: async () => response('"bad"') } } },
    ),
  ).rejects.toThrow('does not support structured output');
});

it('keeps declared policy changes out of replay identity while semantic options invalidate reuse', async () => {
  const options = await setup();
  const adapter = { invoke: async () => response('saved') };
  const make = (thinking: string, timeoutMs: number) =>
    defineWorkflow({
      ...base,
      harnesses: [third],
      async run(ctx) {
        return ctx
          .within('scope')
          .agent('third')
          .value('answer', { prompt: 'x', thinking, timeoutMs });
      },
    });
  await runWorkflow(make('first', 100), { ...options, adapters: { third: adapter } });
  expect(
    (
      await runWorkflow(make('first', 200), {
        ...options,
        resume: true,
        acceptCodeChange: true,
        adapters: { third: adapter },
      })
    ).output,
  ).toBe('saved');
  await expect(
    runWorkflow(make('changed', 200), {
      ...options,
      resume: true,
      acceptCodeChange: true,
      adapters: { third: adapter },
    }),
  ).rejects.toThrow(/changed/u);
});

it('uses package capabilities for grants, strict profiles and bounded child delegation', async () => {
  const tool = defineHarness({
    ...third,
    name: 'tool',
    options: z.object({ prompt: z.string(), tools: z.array(z.string()).optional() }),
    policy: [],
    capabilityKeys: ['tools'],
    access: (options) => (options.tools?.length ? 'exec' : 'none'),
  });
  const adapter = { invoke: async () => response('done') };
  const child = defineWorkflow({
    ...base,
    name: 'child',
    harnesses: [tool],
    profiles: { worker: { harnesses: { tool: { tools: ['shell'] } } } },
    defaults: { profile: 'worker' },
    async run(ctx) {
      return ctx.agent('tool').value('work', { prompt: 'x' });
    },
  });
  await expect(
    runWorkflow(child, { ...(await setup()), adapters: { tool: adapter } }),
  ).rejects.toThrow('requires exec access');
  expect(
    (
      await runWorkflow(child, {
        ...(await setup()),
        adapters: { tool: adapter },
        grants: ['worker'],
      })
    ).output,
  ).toBe('done');
  const parent = defineWorkflow({
    ...base,
    harnesses: [tool],
    children: [child],
    async run(ctx) {
      return ctx.workflow('child', child, null);
    },
  });
  await expect(
    runWorkflow(parent, { ...(await setup()), adapters: { tool: adapter }, grants: ['exec'] }),
  ).rejects.toThrow('no parent grant worker');
  const grantedParent = {
    ...parent,
    profiles: { worker: { harnesses: { tool: { tools: ['shell'], model: 'parent-model' } } } },
  };
  const delegated = await runWorkflow(grantedParent, {
    ...(await setup()),
    adapters: { tool: adapter },
    grants: ['worker'],
  });
  expect(delegated.output).toBe('done');
  expect(delegated.steps['child/work']?.request?.model).toBe('parent-model');
  const raw = defineWorkflow({
    ...base,
    harnesses: [tool],
    // The failed overload's result type would otherwise surface as a second error on run.
    async run(ctx): Promise<string> {
      // @ts-expect-error -- strictProfiles omits the declared capability key tools at type level too.
      return ctx.agent('tool').value('raw', { prompt: 'x', tools: ['shell'] });
    },
  });
  await expect(
    runWorkflow(raw, { ...(await setup()), adapters: { tool: adapter }, grants: ['exec'] }),
  ).rejects.toThrow('strictProfiles');
});

it('permits adapter-free replay of catch-all outputs and checks fresh child registrations before root effects', async () => {
  const options = await setup();
  await runWorkflow(workflow(), {
    ...options,
    harness: { kind: 'fixture', invoke: async () => response('saved') },
  });
  expect(
    (await runWorkflow(workflow(), { ...options, resume: true, acceptCodeChange: true })).output,
  ).toBe('saved');
  let effects = 0;
  const child = workflow();
  const parent = defineWorkflow({
    ...base,
    name: 'parent',
    children: [child],
    async run(ctx) {
      await ctx.step('before-child', {
        input: null,
        schema: z.null(),
        run: () => {
          effects++;
          return null;
        },
      });
      return ctx.workflow('child', child, null);
    },
  });
  await expect(runWorkflow(parent, await setup())).rejects.toThrow(
    'No harness adapter configured for third',
  );
  expect(effects).toBe(0);
});

it('discovers each frame registration even when a child uses another revision of the same harness', async () => {
  const discovered: number[] = [];
  const registration = (revision: number) =>
    defineHarness({
      ...third,
      revision,
      createAdapter: () => ({
        metadata: async () => {
          discovered.push(revision);
          return { binary: 'third', version: String(revision) };
        },
        invoke: async () => response(String(revision)),
      }),
    });
  const child = workflow(registration(2));
  const parent = defineWorkflow({
    ...base,
    name: 'parent',
    harnesses: [registration(1)],
    children: [child],
    async run(ctx) {
      await ctx.agent('third').value('first', { prompt: 'parent' });
      await ctx.agent('third').value('second', { prompt: 'parent' });
      return ctx.workflow('child', child, null);
    },
  });
  const record = await runWorkflow(parent, await setup());
  expect(record.output).toBe('2');
  expect(discovered).toEqual([1, 2]);
  expect(record.harnesses?.['third']?.version).toBe('2');
  expect(record.steps['first']?.attemptHistory?.[0]?.diagnostics).toMatchObject({
    binary: 'third',
    cliVersion: '1',
  });
  expect(record.steps['child/answer']?.attemptHistory?.[0]?.diagnostics).toMatchObject({
    binary: 'third',
    cliVersion: '2',
  });
  expect(record.harnessWarnings?.join(' ')).toContain('third@1 to third@2');
});

it('keeps object-level option refinements when adding runtime fields', async () => {
  const ranged = defineHarness({
    ...third,
    name: 'ranged',
    options: z
      .object({ prompt: z.string(), min: z.number(), max: z.number().optional() })
      .refine((value) => value.max === undefined || value.min <= value.max, {
        message: 'min must not exceed max',
      }),
    policy: [],
  });
  expect(ranged.options.safeParse({ prompt: 'x', min: 2, max: 1 }).success).toBe(false);
  expect(ranged.options.safeParse({ prompt: 'x', min: 1, max: 2, cwd: '.' }).success).toBe(true);
  let calls = 0;
  const adapter = {
    invoke: async () => {
      calls++;
      return response('ranged');
    },
  };
  const call = (options: { min: number; max?: number; profile?: 'bounded' }) =>
    defineWorkflow({
      ...base,
      harnesses: [ranged],
      profiles: { bounded: { harnesses: { ranged: { max: 2 } } } },
      async run(ctx) {
        return ctx.agent('ranged').value('answer', { prompt: 'x', ...options });
      },
    });
  // Directly supplied options, then a profile default that only conflicts once merged.
  for (const options of [
    { min: 3, max: 2 },
    { min: 3, profile: 'bounded' as const },
  ]) {
    const rejected = await setup();
    await expect(
      runWorkflow(call(options), { ...rejected, adapters: { ranged: adapter } }),
    ).rejects.toThrow('min must not exceed max');
    expect((await readRun(rejected)).steps).toEqual({});
  }
  expect(calls).toBe(0);
  expect(
    (
      await runWorkflow(call({ min: 1, profile: 'bounded' }), {
        ...(await setup()),
        adapters: { ranged: adapter },
      })
    ).output,
  ).toBe('ranged');
  expect(calls).toBe(1);
});

it('rejects a failing adapter factory as configuration instead of settling it', async () => {
  let factories = 0;
  const broken = defineHarness({
    ...third,
    createAdapter: () => {
      factories++;
      throw new Error('missing credentials');
    },
  });
  const definition = defineWorkflow({
    ...base,
    harnesses: [broken],
    async run(ctx) {
      const direct = await ctx.agent('third').value('direct', { prompt: 'x', onError: 'return' });
      return direct.ok ? direct.value : 'settled';
    },
  });
  const options = await setup();
  await expect(runWorkflow(definition, options)).rejects.toThrow(
    'Harness third adapter factory failed: missing credentials',
  );
  expect(factories).toBe(1);
  const failed = await readRun(options);
  expect(failed.steps['direct']).toMatchObject({ status: 'failed' });
  expect(failed.steps['direct']?.settledError).toBeUndefined();

  const mapped = defineWorkflow({
    ...base,
    harnesses: [broken],
    async run(ctx) {
      const items = await ctx.map('items', [0], { concurrency: 1, onError: 'settle' }, () =>
        ctx.agent('third').value('ask', { prompt: 'x' }),
      );
      return JSON.stringify(items.map((item) => item.ok));
    },
  });
  const mapOptions = await setup();
  await expect(runWorkflow(mapped, mapOptions)).rejects.toThrow('adapter factory failed');
  expect((await readRun(mapOptions)).maps?.['items']?.items[0]?.status).toBe('running');

  // Correcting the configuration on resume runs the unfinished step live.
  const resumed = await runWorkflow(definition, {
    ...options,
    resume: true,
    allowHarnessChange: true,
    adapters: { third: { invoke: async () => response('fixed') } },
  });
  expect(resumed.output).toBe('fixed');
});

it('preflights unreached declared children on resume and fork before new root effects', async () => {
  let gates = 0;
  let fail = true;
  const child = workflow();
  const parent = defineWorkflow({
    ...base,
    name: 'parent',
    children: [child],
    async run(ctx) {
      await ctx.step('gate', {
        input: null,
        schema: z.null(),
        run: () => {
          gates++;
          if (fail) throw new Error('not yet');
          return null;
        },
      });
      return ctx.workflow('child', child, null);
    },
  });
  const options = await setup();
  const adapters = { third: { invoke: async () => response('child') } };
  await expect(runWorkflow(parent, { ...options, adapters })).rejects.toThrow('not yet');
  expect(gates).toBe(1);
  fail = false;
  await expect(
    runWorkflow(parent, { ...options, resume: true, allowHarnessChange: true }),
  ).rejects.toThrow('No harness adapter configured for third');
  await expect(
    runWorkflow(parent, {
      ...options,
      runId: 'forked',
      forkFrom: { runId: options.runId },
      allowHarnessChange: true,
    }),
  ).rejects.toThrow('No harness adapter configured for third');
  expect(gates).toBe(1);
  expect((await readRun(options)).children ?? {}).toEqual({});
});

it('replays a recorded declared child without an adapter on resume and fork', async () => {
  let fail = true;
  const child = workflow();
  const parent = defineWorkflow({
    ...base,
    name: 'parent',
    children: [child],
    async run(ctx) {
      const answer = await ctx.workflow('child', child, null);
      await ctx.step('gate', {
        input: null,
        schema: z.null(),
        run: () => {
          if (fail) throw new Error('not yet');
          return null;
        },
      });
      return answer;
    },
  });
  const options = await setup();
  let calls = 0;
  const adapters = {
    third: {
      invoke: async () => {
        calls++;
        return response('child');
      },
    },
  };
  await expect(runWorkflow(parent, { ...options, adapters })).rejects.toThrow('not yet');
  expect(calls).toBe(1);
  fail = false;
  const forked = await runWorkflow(parent, {
    ...options,
    runId: 'forked',
    forkFrom: { runId: options.runId },
    allowHarnessChange: true,
  });
  expect(forked.output).toBe('child');
  const resumed = await runWorkflow(parent, { ...options, resume: true, allowHarnessChange: true });
  expect(resumed.output).toBe('child');
  expect(calls).toBe(1);
});

it('preflights a declared child recorded only under another parent before new root effects', async () => {
  let gates = 0;
  let fail = true;
  const child = workflow();
  const via = (name: string) =>
    defineWorkflow({
      ...base,
      name,
      children: [child],
      async run(ctx) {
        return ctx.workflow('child', child, null);
      },
    });
  const first = via('first');
  const second = via('second');
  const parent = defineWorkflow({
    ...base,
    name: 'parent',
    children: [first, second],
    async run(ctx) {
      const answer = await ctx.workflow('first', first, null);
      await ctx.step('gate', {
        input: null,
        schema: z.null(),
        run: () => {
          gates++;
          if (fail) throw new Error('not yet');
          return null;
        },
      });
      return answer + (await ctx.workflow('second', second, null));
    },
  });
  const options = await setup();
  const adapters = { third: { invoke: async () => response('child') } };
  await expect(runWorkflow(parent, { ...options, adapters })).rejects.toThrow('not yet');
  expect(gates).toBe(1);
  expect(Object.values((await readRun(options)).children ?? {})).toHaveLength(2);
  fail = false;
  await expect(
    runWorkflow(parent, { ...options, resume: true, allowHarnessChange: true }),
  ).rejects.toThrow('No harness adapter configured for third');
  await expect(
    runWorkflow(parent, {
      ...options,
      runId: 'forked',
      forkFrom: { runId: options.runId },
      allowHarnessChange: true,
    }),
  ).rejects.toThrow('No harness adapter configured for third');
  expect(gates).toBe(1);
  const resumed = await runWorkflow(parent, { ...options, resume: true, adapters });
  expect(resumed.output).toBe('childchild');
  expect(gates).toBe(2);
});

it('does not let a dynamic child with the same identity stand in for a declared child', async () => {
  let gates = 0;
  let fail = true;
  const child = workflow();
  const dynamic = defineWorkflow({
    ...base,
    async run() {
      return 'dynamic';
    },
  });
  const parent = defineWorkflow({
    ...base,
    name: 'parent',
    children: [child],
    async run(ctx) {
      const first = await ctx.workflow('dynamic', dynamic, null);
      await ctx.step('gate', {
        input: null,
        schema: z.null(),
        run: () => {
          gates++;
          if (fail) throw new Error('not yet');
          return null;
        },
      });
      return first + (await ctx.workflow('child', child, null));
    },
  });
  const options = await setup();
  const adapters = { third: { invoke: async () => response('child') } };
  await expect(runWorkflow(parent, { ...options, adapters })).rejects.toThrow('not yet');
  expect(Object.values((await readRun(options)).children ?? {})).toMatchObject([
    { declared: false, workflow: { name: 'registry', version: '1' } },
  ]);
  fail = false;
  await expect(
    runWorkflow(parent, { ...options, resume: true, allowHarnessChange: true }),
  ).rejects.toThrow('No harness adapter configured for third');
  expect(gates).toBe(1);
});
