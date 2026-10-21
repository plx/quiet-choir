// Prompt values in workflow runs (ADR 0064 sections 2-3, #581): the runtime turns a Prompt into its
// text before identity, a prompt authoring error is fatal, and declared prompt sets are checked
// before the body runs.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, expect } from 'vitest';

import {
  defineRoster,
  definePrompts,
  defineWorkflow,
  PromptError,
  readRun,
  z,
  type AgentRequest,
  type Harness,
  type WorkflowContext,
} from '../src/index.js';
import { it } from './setup/state-dir.js';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const prompts = definePrompts(join(repository, 'test/fixtures/prompts'), {
  Optional: {
    file: 'Optional.md',
    params: z.object({ name: z.string(), greeting: z.string().optional() }),
  },
});
const text = 'Hello Ada.\nWelcome';
const render = () => prompts.Optional({ name: 'Ada', greeting: 'Welcome' });

/** A harness that records each request and answers with plain text. */
function capture() {
  const requests: AgentRequest[] = [];
  const harness: Harness = {
    // eslint-disable-next-line @typescript-eslint/require-await -- an immediate fake harness
    invoke: async (request) => {
      requests.push(request);
      return { text: 'ok', sessionId: null };
    },
  };
  return { requests, harness };
}

const base = { version: '1', input: z.null(), output: z.unknown() } as const;
type Body = (ctx: WorkflowContext) => Promise<unknown>;

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

it('sends a Prompt as its text and fingerprints it exactly like the literal string', async ({
  runs,
}) => {
  const sides = [];
  for (const prompt of [render(), text]) {
    const stateDir = await mkdtemp(join(tmpdir(), 'choir-prompt-runtime-'));
    directories.push(stateDir);
    const fake = capture();
    await runs.run(
      defineWorkflow({
        ...base,
        name: 'identity',
        run: async (ctx) => {
          await ctx.claude.text('claude', {
            prompt,
            systemPrompt: prompt,
            appendSystemPrompt: prompt,
          });
          await ctx.codex.text('codex', { prompt });
          return null;
        },
      }),
      { stateDir, runId: 'identity', input: null, harness: fake.harness },
    );
    const record = await readRun({ stateDir, runId: 'identity' });
    sides.push({
      requests: fake.requests.map((request) => request.options),
      steps: Object.fromEntries(
        Object.entries(record.steps).map(([id, step]) => [
          id,
          {
            fingerprint: step.fingerprint,
            preview: step.request?.promptPreview,
            request: step.attemptHistory?.[0]?.request,
          },
        ]),
      ),
    });
  }
  const [prompted, literal] = sides;
  expect(prompted).toEqual(literal);
  expect(prompted?.requests[0]).toMatchObject({
    prompt: text,
    systemPrompt: text,
    appendSystemPrompt: text,
  });
  expect(prompted?.requests[1]).toMatchObject({ prompt: text });
});

it('replays a step recorded from a Prompt when the resumed body spells the literal', async ({
  runs,
  stateDir,
}) => {
  const state = { literal: false, fail: true };
  const fake = capture();
  const definition = defineWorkflow({
    ...base,
    name: 'resume',
    run: async (ctx) => {
      const reply = await ctx.claude.text('ask', { prompt: state.literal ? text : render() });
      if (state.fail) throw new Error('stop after the call');
      return reply;
    },
  });
  const options = { stateDir, runId: 'resume', input: null, harness: fake.harness };
  await expect(runs.run(definition, options)).rejects.toThrow('stop after the call');
  Object.assign(state, { literal: true, fail: false });
  const result = await runs.run(definition, { ...options, resume: true });
  expect(result).toMatchObject({ status: 'completed', output: { output: 'ok' } });
  expect(fake.requests).toHaveLength(1);
});

it('accepts a Prompt in a bound agent and a roster entry', async ({ runs, stateDir }) => {
  const fake = capture();
  const roster = defineRoster({
    Reviewer: { harness: 'claude', appendSystemPrompt: render(), model: 'haiku' },
  });
  expect(roster.Reviewer.appendSystemPrompt).toBe(text);
  const run: Body = async (ctx) => {
    const agent = ctx.claude.bind({ systemPrompt: render() });
    await agent.text('bound', { prompt: render() });
    await ctx.agent('claude').text('named', { prompt: render() });
    return null;
  };
  await runs.run(
    defineWorkflow({
      ...base,
      name: 'bound',
      roster,
      run: async (ctx) => {
        await run(ctx as never);
        await ctx.roster.Reviewer.text('roster', { prompt: render() });
        return null;
      },
    }),
    { stateDir, runId: 'bound', input: null, harness: fake.harness },
  );
  expect(fake.requests.map((request) => [request.stepId, request.options])).toEqual([
    ['bound', expect.objectContaining({ prompt: text, systemPrompt: text })],
    ['named', expect.objectContaining({ prompt: text })],
    ['roster', expect.objectContaining({ prompt: text, appendSystemPrompt: text })],
  ]);
});

it('fails the run on a render error in a settled map instead of journaling the item', async ({
  runs,
  stateDir,
}) => {
  const fake = capture();
  const definition = defineWorkflow({
    ...base,
    name: 'fatal',
    run: (ctx) =>
      ctx.map('items', ['x'], { concurrency: 1, onError: 'return' }, () =>
        // Strict undefined: the omitted optional greeting fails the render.
        ctx.claude.text('call', { prompt: prompts.Optional({ name: 'Ada' }) }),
      ),
  });
  const failure = await runs
    .run(definition, { stateDir, runId: 'fatal', input: null, harness: fake.harness })
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('Prompt Optional (Optional.md)');
  const record = await readRun({ stateDir, runId: 'fatal' });
  expect(record.status).toBe('failed');
  expect(record.maps?.['items']?.items[0]?.status).toBe('running');
  expect(record.steps).toEqual({});
  expect(fake.requests).toEqual([]);
});

it('fails the run on a render error in a retried, settled step without retrying or settling it', async ({
  runs,
  stateDir,
}) => {
  let calls = 0;
  const definition = defineWorkflow({
    ...base,
    name: 'fatal-step',
    run: (ctx) =>
      ctx.step('render', {
        input: null,
        schema: z.string(),
        retry: { maxAttempts: 3, delayMs: 0 },
        onError: 'return',
        run: () => {
          calls += 1;
          // Strict undefined: the omitted optional greeting fails the render.
          return prompts.Optional({ name: 'Ada' }).text;
        },
      }),
  });
  await expect(
    runs.run(definition, { stateDir, runId: 'fatal', input: null, harness: capture().harness }),
  ).rejects.toThrow('Prompt Optional (Optional.md)');
  expect(calls).toBe(1);
  const record = await readRun({ stateDir, runId: 'fatal' });
  expect(record.status).toBe('failed');
  expect(record.steps['render']).toMatchObject({ status: 'failed', attempts: 1 });
  expect(Object.values(record.steps).map((step) => step.status)).not.toContain('settled-failed');
});

it.for([
  ['an unknown parameter key', () => prompts.Optional({ name: 'Ada', extra: 1 } as never)],
  ['a missing include', () => broken.Missing({})],
  ['an include outside the root', () => broken.Outside({})],
  ['a syntax error', () => broken.Syntax({})],
] as const)('treats %s inside a settled mapper as fatal', async ([, make], { runs, stateDir }) => {
  const definition = defineWorkflow({
    ...base,
    name: 'fatal-kinds',
    run: (ctx) =>
      ctx.map('items', ['x'], { concurrency: 1, onError: 'return' }, () => {
        make();
        return Promise.resolve('unreachable');
      }),
  });
  await expect(
    runs.run(definition, { stateDir, runId: 'fatal', input: null, harness: capture().harness }),
  ).rejects.toThrow(/Prompt \w+ \(\w+\.md\)/u);
  const record = await readRun({ stateDir, runId: 'fatal' });
  expect(record.maps?.['items']?.items[0]?.status).toBe('running');
});

let broken: ReturnType<typeof brokenSet>;
function brokenSet(directory: string) {
  return definePrompts(directory, {
    Missing: { file: 'Missing.md', params: z.object({}) },
    Outside: { file: 'Outside.md', params: z.object({}) },
    Syntax: { file: 'Syntax.md', params: z.object({}) },
  });
}
beforeAll(async () => {
  const parent = await mkdtemp(join(tmpdir(), 'choir-prompt-broken-'));
  directories.push(parent);
  await writeFile(join(parent, 'Missing.md'), '{% include "nope.md" %}');
  await writeFile(join(parent, 'Outside.md'), '{% include "../x.md" %}');
  await writeFile(join(parent, 'Syntax.md'), '{% if %}');
  broken = brokenSet(parent);
});

it('rejects a workflow whose prompt set fails its checks before the body runs', async ({
  runs,
  stateDir,
}) => {
  const parent = await mkdtemp(join(tmpdir(), 'choir-prompt-preflight-'));
  directories.push(parent);
  await writeFile(join(parent, 'Bad.md'), '{{ missing }} {% include name %}');
  const set = definePrompts(parent, {
    Bad: { file: 'Bad.md', params: z.object({ name: z.string() }) },
  });
  let ran = false;
  const definition = defineWorkflow({
    ...base,
    name: 'preflight',
    prompts: [set],
    run: () => {
      ran = true;
      return Promise.resolve(null);
    },
  });
  await expect(
    runs.run(definition, { stateDir, runId: 'preflight', input: null, harness: capture().harness }),
  ).rejects.toThrow(
    /prompt templates failed their load-time checks:\n- Prompt Bad \(Bad\.md\): .*computed[\s\S]*- Prompt Bad \(Bad\.md\): reads variable missing/u,
  );
  expect(ran).toBe(false);
  await expect(readRun({ stateDir, runId: 'preflight' })).rejects.toThrow();
  // A child's prompt sets are checked too, and a valid set lets the body run.
  const child = defineWorkflow({
    ...base,
    name: 'child',
    prompts: [set],
    run: () => Promise.resolve(null),
  });
  await expect(
    runs.run(
      defineWorkflow({
        ...base,
        name: 'parent',
        children: [child],
        run: () => Promise.resolve(null),
      }),
      { stateDir, runId: 'parent', input: null, harness: capture().harness },
    ),
  ).rejects.toThrow(/Prompt Bad \(Bad\.md\)/u);
  await expect(
    runs.run(
      defineWorkflow({ ...base, name: 'valid', prompts: [prompts], run: () => Promise.resolve(1) }),
      { stateDir, runId: 'valid', input: null, harness: capture().harness },
    ),
  ).resolves.toMatchObject({ output: 1 });
  expect(() =>
    defineWorkflow({
      ...base,
      name: 'plain',
      prompts: [{} as never],
      run: () => Promise.resolve(null),
    }),
  ).not.toThrow();
  await expect(
    runs.run(
      defineWorkflow({
        ...base,
        name: 'plain',
        prompts: [{} as never],
        run: () => Promise.resolve(null),
      }),
      { stateDir, runId: 'plain', input: null, harness: capture().harness },
    ),
  ).rejects.toThrow('prompts must be an array of definePrompts(...) sets');
  expect(new PromptError('x', { prompt: null, file: null, kind: 'K', line: null }).name).toBe(
    'PromptError',
  );
});
