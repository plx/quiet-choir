import { WorkflowRunError } from '../src/index.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import type * as Os from 'node:os';
import { getEventListeners } from 'node:events';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createAgentLimiter,
  defaultAgentLimits,
  runWorkflow,
  defineWorkflow,
  readRun,
  z,
  CliHarness,
  type AgentLimiter,
  type AgentPermit,
  type Harness,
  type WorkflowEvent,
} from '../src/index.js';
import { parseAgentLimits } from '../src/workflow/loader/agent-limits.js';

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof Os>()),
  availableParallelism: vi.fn(() => 10),
}));
let directory: string;
beforeEach(async () => {
  vi.mocked(availableParallelism).mockReturnValue(10);
  directory = await mkdtemp(join(tmpdir(), 'choir-limiter-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const signal = new AbortController().signal;
const options = () => ({
  runId: 'limited',
  stateDir: join(directory, 'state'),
  cwd: directory,
  input: null,
});
const reply = {
  text: 'ok',
  sessionId: null,
  usage: { inputTokens: 1, outputTokens: 1, costUsd: null },
};
const base = { name: 'limited', version: '1', input: z.null(), output: z.number() };
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('clamps CPU-derived defaults and applies safe integer validation', () => {
  for (const [cpus, total] of [
    [1, 1],
    [2, 1],
    [3, 1],
    [6, 4],
    [16, 8],
  ]) {
    vi.mocked(availableParallelism).mockReturnValue(cpus ?? 1);
    expect(defaultAgentLimits()).toEqual({ total });
  }
  for (const total of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => createAgentLimiter({ total })).toThrow();
    expect(() => createAgentLimiter({ total: 2, perProvider: { claude: total } })).toThrow();
  }
  expect(() => createAgentLimiter({ total: 1, perProvider: { '': 1 } })).toThrow();
});

it('admits FIFO among eligible providers, releases idempotently, and returns detached snapshots', async () => {
  const limits = { total: 4, perProvider: { codex: 1 } };
  const limiter = createAgentLimiter(limits);
  limits.total = 99;
  limits.perProvider.codex = 99;
  const first = await limiter.acquire('codex', signal);
  const order: string[] = [];
  const second = limiter.acquire('codex', signal).then((permit) => {
    order.push('second');
    return permit;
  });
  const third = limiter.acquire('codex', signal).then((permit) => {
    order.push('third');
    return permit;
  });
  const claude = await Promise.all(
    Array.from({ length: 3 }, () => limiter.acquire('claude', signal)),
  );
  expect(limiter.snapshot()).toEqual({ inFlight: { codex: 1, claude: 3 }, queued: 2 });
  const detached = limiter.snapshot();
  Object.assign(detached.inFlight, { codex: 100 });
  expect(limiter.snapshot().inFlight['codex']).toBe(1);
  first.release();
  first.release();
  const admitted = await second;
  expect(order).toEqual(['second']);
  expect(admitted.waitedMs).toBeGreaterThanOrEqual(0);
  admitted.release();
  (await third).release();
  claude.forEach((permit) => {
    permit.release();
  });
  expect(order).toEqual(['second', 'third']);
  expect(limiter.snapshot()).toEqual({ inFlight: {}, queued: 0 });
});

it('cancels an entire signal queue promptly with one resistant listener and no permit leak', async () => {
  const limiter = createAgentLimiter({ total: 1 });
  const held = await limiter.acquire('claude', signal);
  const controller = new AbortController();
  controller.signal.addEventListener('abort', (event) => {
    event.stopImmediatePropagation();
  });
  const queued = Array.from({ length: 30 }, () => limiter.acquire('claude', controller.signal));
  const outcomes = Promise.allSettled(queued);
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(2);
  const stop = new Error('queued stop');
  controller.abort(stop);
  expect(
    (await outcomes).every((result) => result.status === 'rejected' && result.reason === stop),
  ).toBe(true);
  expect(limiter.snapshot()).toEqual({ inFlight: { claude: 1 }, queued: 0 });
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
  held.release();
  await expect(limiter.acquire('claude', controller.signal)).rejects.toBe(stop);
  await expect(limiter.acquire('', signal)).rejects.toThrow('nonempty');
});

it('keeps an already admitted slot until release when its signal aborts', async () => {
  const limiter = createAgentLimiter({ total: 1 });
  const controller = new AbortController();
  const acquired = limiter.acquire('claude', controller.signal);
  controller.abort();
  const permit = await acquired;
  expect(limiter.snapshot()).toEqual({ inFlight: { claude: 1 }, queued: 0 });
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  permit.release();
  expect(limiter.snapshot().inFlight).toEqual({});
});

it.each([
  { dimensions: [4, 3], limit: 5 },
  { dimensions: [6, 8, 3], limit: 2 },
  { dimensions: [12], limit: undefined },
])('caps nested maps $dimensions at $limit without deadlock', async ({ dimensions, limit }) => {
  const cap = limit ?? defaultAgentLimits().total;
  let active = 0,
    peak = 0,
    calls = 0;
  const wave = deferred();
  const invoke = vi.fn<Harness['invoke']>().mockImplementation(async () => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    if (active === cap) wave.resolve();
    try {
      await wave.promise;
      await delay(5);
      return reply;
    } finally {
      active--;
    }
  });
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      const visit = async (depth: number): Promise<void> => {
        if (depth === dimensions.length) {
          await ctx.claude.text('agent', { prompt: 'x' });
          return;
        }
        const count = dimensions[depth] ?? 0;
        await ctx.map(
          'level',
          Array.from({ length: count }, (_, i) => i),
          { concurrency: count },
          async () => {
            await visit(depth + 1);
          },
        );
      };
      await visit(0);
      return calls;
    },
  });
  const result = await runWorkflow(definition, {
    ...options(),
    harness: { invoke },
    ...(limit === undefined ? {} : { agentLimit: limit }),
  });
  expect(result.output).toBe(dimensions.reduce((a, b) => a * b, 1));
  expect(peak).toBe(cap);
  expect(active).toBe(0);
});

it('shares one limiter across two simultaneously executing runs', async () => {
  const limiter = createAgentLimiter({ total: 2 });
  let active = 0,
    peak = 0;
  const wave = deferred();
  const invoke = vi.fn<Harness['invoke']>().mockImplementation(async () => {
    active++;
    peak = Math.max(peak, active);
    if (active === 2) wave.resolve();
    try {
      await wave.promise;
      await delay(5);
      return reply;
    } finally {
      active--;
    }
  });
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      await ctx.map('agents', [0, 1, 2, 3], { concurrency: 4 }, async () =>
        ctx.claude.text('ask', { prompt: 'x' }),
      );
      return 4;
    },
  });
  const runs = await Promise.all(
    ['one', 'two'].map((runId) =>
      runWorkflow(definition, { ...options(), runId, agentLimit: limiter, harness: { invoke } }),
    ),
  );
  expect(runs.map((run) => run.output)).toEqual([4, 4]);
  expect(peak).toBe(2);
  expect(invoke).toHaveBeenCalledTimes(8);
  expect(limiter.snapshot()).toEqual({ inFlight: {}, queued: 0 });
});

it('records queued cancellation without invocation and retains the original run cause', async () => {
  const held = createAgentLimiter({ total: 1 });
  const permit = await held.acquire('claude', signal);
  const controller = new AbortController();
  const allQueued = deferred();
  const events: WorkflowEvent[] = [];
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      await Promise.all([0, 1, 2].map((i) => ctx.claude.text(`ask-${String(i)}`, { prompt: 'x' })));
      return 3;
    },
  });
  const running = runWorkflow(definition, {
    ...options(),
    harness: { invoke },
    agentLimit: held,
    signal: controller.signal,
    onEvent(event) {
      events.push(event);
      if (event.type === 'agent.queued' && event.queued === 3) allQueued.resolve();
    },
  });
  const rejected = expect(running).rejects.toThrow('operator stop');
  await allQueued.promise;
  expect(
    Object.values((await readRun(options())).steps).every((step) => step.status === 'running'),
  ).toBe(true);
  controller.abort(new Error('operator stop'));
  await rejected;
  expect(invoke).not.toHaveBeenCalled();
  expect(held.snapshot()).toEqual({ inFlight: { claude: 1 }, queued: 0 });
  permit.release();
  const record = await readRun(options());
  expect(Object.values(record.steps).map((step) => step.status)).toEqual([
    'cancelled',
    'cancelled',
    'cancelled',
  ]);
  expect(Object.values(record.steps).every((step) => step.error === 'Workflow cancelled.')).toBe(
    true,
  );
  expect(record.rootCause).toEqual({ stepId: null, error: 'operator stop' });
  expect(events.filter((event) => event.type === 'agent.admitted')).toHaveLength(0);
  expect(
    events.filter((event) => event.type === 'agent.queued').map((event) => event.waitedMs),
  ).toEqual([0, 0, 0]);
});

it('releases after failures before retry backoff and never acquires for local work, sleep or replay', async () => {
  const limiter = createAgentLimiter({ total: 1 });
  const acquire = vi.spyOn(limiter, 'acquire');
  const first = deferred();
  const order: string[] = [];
  let attempts = 0;
  const invoke = vi.fn<Harness['invoke']>().mockImplementation((request) => {
    order.push(request.options.prompt);
    if (request.options.prompt === 'first' && attempts++ === 0) {
      first.resolve();
      return Promise.reject(new Error('retry'));
    }
    return Promise.resolve(reply);
  });
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      const retry = ctx.claude.text('first', {
        prompt: 'first',
        // Generous margin: the local step, sleep and second agent call below must all observe
        // and settle before this retry backoff elapses, even on a loaded CI runner.
        retry: { maxAttempts: 2, delayMs: 1000 },
      });
      await first.promise;
      await ctx.step('local', { input: null, schema: z.number(), run: () => 1 });
      await ctx.sleep('sleep', 1);
      await ctx.codex.text('second', { prompt: 'second' });
      await retry;
      return 2;
    },
  });
  await runWorkflow(definition, { ...options(), harness: { invoke }, agentLimit: limiter });
  expect(order).toEqual(['first', 'second', 'first']);
  expect(acquire).toHaveBeenCalledTimes(3);
  await runWorkflow(definition, {
    ...options(),
    harness: { invoke },
    agentLimit: limiter,
    resume: true,
  });
  expect(acquire).toHaveBeenCalledTimes(3);
  expect(limiter.snapshot()).toEqual({ inFlight: {}, queued: 0 });
});

it('allows a different limit on resume while completed agent effects replay', async () => {
  const invoke = vi
    .fn<Harness['invoke']>()
    .mockResolvedValueOnce(reply)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(reply);
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      await ctx.claude.text('one', { prompt: 'x' });
      await ctx.claude.text('two', { prompt: 'y' });
      return 2;
    },
  });
  await expect(
    runWorkflow(definition, { ...options(), harness: { invoke }, agentLimit: 1 }),
  ).rejects.toThrow('offline');
  const result = await runWorkflow(definition, {
    ...options(),
    harness: { invoke },
    agentLimit: { total: 4, perProvider: { claude: 2 } },
    resume: true,
  });
  expect(result.output).toBe(2);
  expect(invoke).toHaveBeenCalledTimes(3);
  expect(result.steps['one']?.attempts).toBe(1);
});

it('starts the native call deadline after queueing and emits admission counts and wait time', async () => {
  const binary = join(directory, 'claude');
  await writeFile(
    binary,
    `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('2.1.283');process.exit(0);}process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>console.log(JSON.stringify({type:'result',subtype:'success',result:'ok'})),30));`,
    { mode: 0o700 },
  );
  const limiter = createAgentLimiter({ total: 1 });
  const held = await limiter.acquire('claude', signal);
  const queued = deferred();
  const events: WorkflowEvent[] = [];
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      await ctx.claude.text('ask', { prompt: 'x', timeoutMs: 750 });
      return 1;
    },
  });
  const running = runWorkflow(definition, {
    ...options(),
    harness: new CliHarness({ claudeBinary: binary }),
    agentLimit: limiter,
    onEvent(event) {
      events.push(event);
      if (event.type === 'agent.queued') queued.resolve();
    },
  });
  await queued.promise;
  await delay(1000);
  held.release();
  expect((await running).output).toBe(1);
  const requested = events.find((event) => event.type === 'agent.queued');
  const admitted = events.find((event) => event.type === 'agent.admitted');
  expect(requested).toMatchObject({
    harness: 'claude',
    inFlight: { claude: 1 },
    queued: 1,
    waitedMs: 0,
    stepId: 'ask',
  });
  expect(admitted).toMatchObject({
    harness: 'claude',
    inFlight: { claude: 1 },
    queued: 0,
    stepId: 'ask',
  });
  expect(admitted?.waitedMs).toBeGreaterThanOrEqual(950);
});

it('releases permits when admission observers abort, throw, reject, or expose broken diagnostics', async () => {
  const controller = new AbortController();
  const backing = createAgentLimiter({ total: 1 });
  let last: AgentPermit | undefined;
  const limiter: AgentLimiter = {
    async acquire(provider, signal) {
      last = await backing.acquire(provider, signal);
      return last;
    },
    snapshot() {
      throw new Error('broken diagnostics');
    },
  };
  const invoke = vi.fn<Harness['invoke']>().mockRejectedValue(new Error('call failed'));
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      await ctx.claude.text('ask', { prompt: 'x' });
      return 1;
    },
  });
  await expect(
    runWorkflow(definition, { ...options(), harness: { invoke }, agentLimit: limiter }),
  ).rejects.toThrow('call failed');
  expect(last).toBeDefined();
  expect(backing.snapshot()).toEqual({ inFlight: {}, queued: 0 });
  invoke.mockClear();
  await expect(
    runWorkflow(definition, {
      ...options(),
      runId: 'abort',
      harness: { invoke },
      agentLimit: backing,
      signal: controller.signal,
      onEvent(event) {
        if (event.type === 'agent.admitted') controller.abort(new Error('admission stop'));
      },
    }),
  ).rejects.toThrow('admission stop');
  expect(invoke).not.toHaveBeenCalled();
  expect(backing.snapshot()).toEqual({ inFlight: {}, queued: 0 });
  invoke.mockResolvedValue(reply);
  const result = await runWorkflow(definition, {
    ...options(),
    runId: 'observers',
    harness: { invoke },
    agentLimit: backing,
    onEvent(event) {
      if (event.type === 'agent.queued') throw new Error('observer');
      return Promise.reject(new Error('async observer'));
    },
  });
  expect(result.output).toBe(1);
  expect(backing.snapshot()).toEqual({ inFlight: {}, queued: 0 });
});

it('rejects invalid run and CLI limit data before the body and preserves provider keys safely', async () => {
  const body = vi.fn(() => Promise.resolve(1));
  const definition = defineWorkflow({ ...base, run: body });
  await expect(runWorkflow(definition, { ...options(), agentLimit: 0 })).rejects.toThrow();
  expect(body).not.toHaveBeenCalled();
  for (const total of ['0', '-2', '1.5', 'NaN', '1e3', '9007199254740992'])
    expect(() => parseAgentLimits(total, [])).toThrow();
  for (const rule of [
    'claude=0',
    'codex=-1',
    'codex=1.2',
    'claude',
    'claude=Infinity',
    '=2',
    'codex=9007199254740992',
  ])
    expect(() => parseAgentLimits('2', [rule])).toThrow();
  expect(parseAgentLimits(undefined, ['codex=1', 'claude=3', 'codex=2'])).toEqual({
    total: 8,
    perProvider: { codex: 2, claude: 3 },
  });
  const unusual = createAgentLimiter({
    total: 1,
    perProvider: JSON.parse('{"__proto__":1}') as Record<string, number>,
  });
  const permit = await unusual.acquire('__proto__', signal);
  expect(Object.hasOwn(unusual.snapshot().inFlight, '__proto__')).toBe(true);
  permit.release();
});

it('cancels only queued calls in the failed map subtree and admits its root sibling', async () => {
  const limiter = createAgentLimiter({ total: 1 });
  const held = await limiter.acquire('claude', signal);
  const queued = deferred();
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      const mapped = ctx.map(
        'group',
        [0, 1],
        { concurrency: 2, onError: 'abort' },
        async (item) => {
          if (item === 0) return (await ctx.claude.text('ask', { prompt: 'inside' })).output;
          await queued.promise;
          return ctx.step('fail', {
            input: null,
            schema: z.string(),
            run() {
              throw new Error('subtree failure');
            },
          });
        },
      );
      const outside = ctx.claude.text('outside', { prompt: 'outside' });
      await Promise.all([mapped, outside]);
      return 1;
    },
  });
  await expect(
    runWorkflow(definition, {
      ...options(),
      harness: { invoke },
      agentLimit: limiter,
      onEvent(event) {
        if (event.type === 'agent.queued' && event.stepId === 'group/0/ask') queued.resolve();
        if (event.type === 'step.cancelled' && event.stepId === 'group/0/ask') held.release();
      },
    }),
  ).rejects.toThrow('subtree failure');
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke.mock.calls[0]?.[0].options.prompt).toBe('outside');
  const record = await readRun(options());
  expect(record.steps['group/0/ask']).toMatchObject({
    status: 'cancelled',
    cancelledBy: 'group/1/fail',
    error: 'Map cancelled by step group/1/fail.',
  });
  expect(record.steps['outside']?.status).toBe('completed');
  expect(limiter.snapshot()).toEqual({ inFlight: {}, queued: 0 });
});

it('releases the invocation slot before validating and checkpointing the response', async () => {
  const limiter = createAgentLimiter({ total: 1 });
  const seen: number[] = [];
  const schema = z.object({
    value: z.number().refine((value) => {
      seen.push(Object.values(limiter.snapshot().inFlight).reduce((a, b) => a + b, 0));
      return value === 7;
    }),
  });
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      return (await ctx.claude.object('answer', { prompt: 'x', schema })).output.value;
    },
  });
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue({ ...reply, text: '{"value":7}' });
  const result = await runWorkflow(definition, {
    ...options(),
    harness: { invoke },
    agentLimit: limiter,
  });
  expect(result.output).toBe(7);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((count) => count === 0)).toBe(true);
});

it('propagates a custom typed admission refusal without invoking the harness', async () => {
  class Refused extends Error {}
  const reason = new Refused('policy refused admission');
  const limiter: AgentLimiter = {
    acquire: () => Promise.reject(reason),
    snapshot: () => ({ inFlight: {}, queued: 0 }),
  };
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      await ctx.codex.text('ask', { prompt: 'x' });
      return 1;
    },
  });
  const failed: unknown = await runWorkflow(definition, {
    ...options(),
    harness: { invoke },
    agentLimit: limiter,
  }).catch((cause: unknown) => cause);
  expect(failed).toBeInstanceOf(WorkflowRunError);
  if (!(failed instanceof WorkflowRunError)) throw failed;
  expect(failed.cause).toBe(reason);
  expect(invoke).not.toHaveBeenCalled();
  expect((await readRun(options())).steps['ask']).toMatchObject({
    status: 'failed',
    error: 'policy refused admission',
  });
});
