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
    async run(ctx) {
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
