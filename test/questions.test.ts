import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, expect, expectTypeOf, it } from 'vitest';
import {
  assertCompleted,
  defineWorkflow,
  inspectRunOwnership,
  listPending,
  readRun,
  runWorkflow,
  writeAnswer,
  z,
  type Approval,
  type WorkflowContext,
} from '../src/index.js';
import { AnswerError, answerPath } from '../src/workflow/runtime/inbox.js';
import { writeRun } from '../src/workflow/runtime/store.js';

let stateDir: string;
const options = () => ({ stateDir, runId: 'questions', input: null });
const workflow = <T>(run: (ctx: WorkflowContext) => Promise<T>) =>
  defineWorkflow({ name: 'questions', version: '1', input: z.null(), output: z.unknown(), run });
const question = { prompt: 'Ship this revision?', schema: z.enum(['ship', 'revise']) };
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'choir-questions-'));
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

it('suspends outside catches and finally blocks, after saving an in-flight mapped sibling', async () => {
  let slowCalls = 0;
  let caught = false;
  let finalized = false;
  const definition = workflow(async (ctx) => {
    try {
      return await ctx.map('items', [0, 1, 2], { concurrency: 3 }, async (item) => {
        await ctx.step('before', { input: item, schema: z.number(), run: () => item });
        if (item === 1) {
          try {
            await ctx.ask('gate', question);
          } catch {
            caught = true;
          }
        }
        if (item === 2)
          await ctx.step('slow', {
            input: null,
            schema: z.number(),
            run: async ({ signal }) => {
              slowCalls++;
              await delay(80);
              expect(signal.aborted).toBe(false);
              return 2;
            },
          });
        return ctx.step('after', { input: item, schema: z.number(), run: () => item });
      });
    } finally {
      finalized = true;
    }
  });
  const events: string[] = [];
  const first = await runWorkflow(definition, {
    ...options(),
    onEvent: (e) => {
      events.push(e.type);
    },
  });
  expect(first.status).toBe('suspended');
  expect(caught).toBe(false);
  expect(finalized).toBe(false);
  expect(first.steps['items/2/slow']?.status).toBe('completed');
  expect(first.steps['items/2/after']?.status).toBe('completed');
  expect(events).toContain('step.waiting');
  expect(events.at(-1)).toBe('run.suspended');
  expect((await inspectRunOwnership(options())).locked).toBe(false);
  expect(() => {
    assertCompleted(first);
  }).toThrow('suspended');
  await writeAnswer({ ...options(), stepId: 'items/1/gate', value: 'revise' });
  const resumed = await runWorkflow(definition, { ...options(), resume: true });
  assertCompleted(resumed);
  expect(resumed.output).toEqual([0, 1, 2]);
  expect(slowCalls).toBe(1);
  expect(Object.values(resumed.steps).every((s) => s.attempts === 1)).toBe(true);
  expect(resumed.executions?.map((e) => e.outcome)).toEqual(['suspended', 'completed']);
  expect(finalized).toBe(true);
});

it('drains ten thousand microtask hops before deciding quiescence', async () => {
  let ran = false;
  const result = await runWorkflow(
    workflow(async (ctx) => {
      return Promise.all([
        ctx.ask('gate', question),
        (async () => {
          for (let n = 0; n < 10_000; n++) await Promise.resolve();
          return ctx.step('after-hops', {
            input: null,
            schema: z.boolean(),
            run: () => {
              ran = true;
              return true;
            },
          });
        })(),
      ]);
    }),
    options(),
  );
  expect(result.status).toBe('suspended');
  expect(ran).toBe(true);
  expect(result.steps['after-hops']?.status).toBe('completed');
});

it('closes leftover raw-timer continuations without an unhandled rejection or late effect', async () => {
  let ran = false;
  let release!: () => void;
  let continued!: () => void;
  const afterSuspension = new Promise<void>((resolve) => {
    release = resolve;
  });
  const continuation = new Promise<void>((resolve) => {
    continued = resolve;
  });
  const result = await runWorkflow(
    workflow(async (ctx) =>
      Promise.all([
        ctx.ask('gate', question),
        (async () => {
          // A fixed short timer can expire before suspension on a busy runner. Trigger the raw
          // timer only after ownership is released so this tests the closed continuation guard.
          await afterSuspension;
          await delay(0);
          try {
            return await ctx.step('too-late', {
              input: null,
              schema: z.boolean(),
              run: () => {
                ran = true;
                return true;
              },
            });
          } finally {
            continued();
          }
        })(),
      ]),
    ),
    options(),
  );
  expect(result.status).toBe('suspended');
  release();
  await continuation;
  await delay(0);
  expect(ran).toBe(false);
  expect((await readRun(options())).steps['too-late']).toBeUndefined();
});

it('withdraws an unanswered question abandoned by a completed body', async () => {
  const result = await runWorkflow(
    workflow((ctx) =>
      Promise.race([
        ctx.ask('race', { prompt: 'A number?', schema: z.number() }),
        ctx.step('winner', {
          input: null,
          schema: z.number(),
          run: async () => {
            await delay(20);
            return 7;
          },
        }),
      ]),
    ),
    options(),
  );
  assertCompleted(result);
  expect(result.output).toBe(7);
  expect(result.steps['race']?.status).toBe('withdrawn');
  expect(await listPending({ stateDir })).toEqual([]);
  await expect(writeAnswer({ ...options(), stepId: 'race', value: 8 })).rejects.toMatchObject({
    reason: 'conflict',
  });
});

it('preserves waiting questions on body failure and drains active work', async () => {
  let finished = false;
  await expect(
    runWorkflow(
      workflow(async (ctx) =>
        Promise.all([
          ctx.ask('gate', question),
          ctx.step('fail', {
            input: null,
            schema: z.null(),
            run: async () => {
              await delay(10);
              throw new Error('body failed');
            },
          }),
          ctx.step('slow', {
            input: null,
            schema: z.null(),
            run: async () => {
              await delay(60);
              finished = true;
              return null;
            },
          }),
        ]),
      ),
      options(),
    ),
  ).rejects.toThrow('body failed');
  const saved = await readRun(options());
  expect(saved.status).toBe('failed');
  expect(saved.steps['gate']?.status).toBe('waiting');
  expect(finished).toBe(true);
  expect((await inspectRunOwnership(options())).locked).toBe(false);
});

it('does not hang a settled mapper that returns after abandoning a question', async () => {
  const result = await runWorkflow(
    workflow((ctx) =>
      ctx.map('items', [1, 2], { concurrency: 2, onError: 'settle' }, async (item) => {
        return Promise.race([
          ctx.ask('gate', { prompt: 'A number?', schema: z.number() }),
          ctx.step('winner', {
            input: item,
            schema: z.number(),
            run: async () => {
              await delay(20);
              return item;
            },
          }),
        ]);
      }),
    ),
    options(),
  );
  assertCompleted(result);
  expect(result.output).toEqual([
    { ok: true, value: 1 },
    { ok: true, value: 2 },
  ]);
  expect(result.steps['items/0/gate']?.status).toBe('withdrawn');
  expect(result.steps['items/1/gate']?.status).toBe('withdrawn');
});

it('ingests a delivery while unrelated work is still running', async () => {
  let answerAt = 0;
  let slowAt = 0;
  const result = await runWorkflow(
    workflow(async (ctx) =>
      Promise.all([
        ctx.ask('live', question).then((value) => {
          answerAt = Date.now();
          return value;
        }),
        ctx.step('slow', {
          input: null,
          schema: z.null(),
          run: async () => {
            await delay(40);
            await writeAnswer({ ...options(), stepId: 'live', value: 'ship' });
            await delay(450);
            slowAt = Date.now();
            return null;
          },
        }),
      ]),
    ),
    options(),
  );
  assertCompleted(result);
  expect(result.output).toEqual(['ship', null]);
  expect(answerAt).toBeGreaterThan(0);
  expect(answerAt).toBeLessThan(slowAt - 100);
  expect(result.executions).toHaveLength(1);
});

it('validates early without writing and permits exactly one concurrent writer', async () => {
  const definition = workflow((ctx) => ctx.ask('gate', question));
  await runWorkflow(definition, options());
  await expect(writeAnswer({ ...options(), stepId: 'gate', value: 'maybe' })).rejects.toMatchObject(
    { reason: 'invalid' },
  );
  expect(await readdir(stateDir)).not.toContain('questions.inbox');
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, () => writeAnswer({ ...options(), stepId: 'gate', value: 'ship' })),
  );
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  for (const result of results)
    if (result.status === 'rejected') expect(result.reason).toMatchObject({ reason: 'conflict' });
  expect((await stat(answerPath(stateDir, 'questions', 'gate'))).mode & 0o777).toBe(0o600);
  expect(await readdir(join(stateDir, 'questions', 'inbox'))).toEqual([
    answerPath(stateDir, 'questions', 'gate').split('/').at(-1),
  ]);
  const result = await runWorkflow(definition, { ...options(), resume: true });
  assertCompleted(result);
  expect(result.output).toBe('ship');
  await expect(
    writeAnswer({ ...options(), stepId: 'gate', value: 'revise' }),
  ).rejects.toMatchObject({ reason: 'conflict' });
});

it('quarantines authoritative refinement failures and accepts a corrected delivery', async () => {
  const definition = workflow((ctx) =>
    ctx.ask('refined', {
      prompt: 'Even number?',
      schema: z.number().refine((n) => n % 2 === 0, 'Must be even'),
    }),
  );
  await runWorkflow(definition, options());
  await writeAnswer({ ...options(), stepId: 'refined', value: 3 });
  const rejected = await runWorkflow(definition, { ...options(), resume: true });
  expect(rejected.status).toBe('suspended');
  const pending = await listPending({ stateDir });
  expect(pending[0]?.rejections[0]?.error).toContain('Must be even');
  expect(await readdir(join(stateDir, 'questions', 'inbox'))).toHaveLength(1);
  expect((await readdir(join(stateDir, 'questions', 'inbox')))[0]).toContain('.rejected.');
  await writeAnswer({ ...options(), stepId: 'refined', value: 4 });
  const result = await runWorkflow(definition, { ...options(), resume: true });
  expect(result.output).toBe(4);
  expect(result.steps['refined']?.question?.resolution?.via).toBe('inbox');
});

it('quarantines stale fingerprints and spoofed human attribution from direct inbox writes', async () => {
  const definition = workflow((ctx) =>
    ctx.approve('approval', { prompt: 'Apply?', audience: 'human', subject: { revision: 'abc' } }),
  );
  const first = await runWorkflow(definition, options());
  await expect(
    writeAnswer({ ...options(), stepId: 'approval', value: { approved: true } }),
  ).rejects.toMatchObject({ reason: 'invalid' });
  await writeAnswer({
    ...options(),
    stepId: 'approval',
    value: { approved: true },
    by: 'human:Pat',
  });
  const path = answerPath(stateDir, 'questions', 'approval');
  const envelope: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (typeof envelope !== 'object' || !envelope) throw new Error('Missing envelope');
  await writeFile(path, JSON.stringify({ ...envelope, questionFingerprint: '0'.repeat(64) }));
  expect((await runWorkflow(definition, { ...options(), resume: true })).status).toBe('suspended');
  await writeFile(path, JSON.stringify({ ...envelope, by: 'agent:guessed' }));
  expect((await runWorkflow(definition, { ...options(), resume: true })).status).toBe('suspended');
  expect((await listPending({ stateDir }))[0]?.rejections).toHaveLength(2);
  await writeAnswer({
    ...options(),
    stepId: 'approval',
    value: { approved: false, comment: 'revise' },
    by: 'human:Pat',
  });
  const result = await runWorkflow(definition, { ...options(), resume: true });
  expect(result.output).toEqual({ approved: false, comment: 'revise' });
  expect(first.steps['approval']?.attempts).toBe(1);
});

it('pins all presentation and subject fields even before an answer arrives', async () => {
  const original = {
    ...question,
    details: 'Plan A',
    title: 'Review',
    audience: 'any' as const,
    subject: { revision: 1 },
    choices: [{ label: 'Ship', value: 'ship' as const }],
  };
  await runWorkflow(
    workflow((ctx) => ctx.ask('gate', original)),
    options(),
  );
  for (const change of [
    { prompt: 'Different question?' },
    { details: 'Plan B' },
    { title: 'Changed' },
    { audience: 'human' as const },
    { subject: { revision: 2 } },
    { choices: [{ label: 'Changed label', value: 'ship' as const }] },
    { schema: z.enum(['ship', 'revise', 'stop']) },
  ]) {
    await expect(
      runWorkflow(
        workflow((ctx) => ctx.ask('gate', { ...original, ...change })),
        { ...options(), resume: true },
      ),
    ).rejects.toThrow('question changed');
  }
  await expect(
    runWorkflow(
      workflow((ctx) => ctx.step('gate', { input: null, schema: z.null(), run: () => null })),
      { ...options(), resume: true },
    ),
  ).rejects.toThrow('question cannot be redefined');
});

it('binds questions to scopes, validates metadata and supports long legal IDs', async () => {
  const longId = `a${'/a'.repeat(95)}`;
  const definition = workflow(async (ctx) => {
    const approval = ctx.within('review').approve('gate', { prompt: 'Apply?' });
    expectTypeOf(approval).toEqualTypeOf<Promise<Approval>>();
    return Promise.all([approval, ctx.ask(longId, { prompt: 'Value?', schema: z.string() })]);
  });
  const first = await runWorkflow(definition, options());
  expect(first.status).toBe('suspended');
  await writeAnswer({ ...options(), stepId: 'review/gate', value: { approved: true } });
  await writeAnswer({ ...options(), stepId: longId, value: 'ok' });
  expect((await runWorkflow(definition, { ...options(), resume: true })).status).toBe('completed');
  for (const invalid of [
    { prompt: 'two\nlines' },
    { title: 'longer than twelve' },
    { details: 'x'.repeat(16_385) },
  ]) {
    await expect(
      runWorkflow(
        workflow((ctx) => ctx.ask('invalid', { ...question, ...invalid })),
        { ...options(), runId: `invalid-${Object.keys(invalid)[0] ?? ''}` },
      ),
    ).rejects.toThrow();
  }
});

it('cancels real question waits without converting an interrupt into suspension', async () => {
  const controller = new AbortController();
  await expect(
    runWorkflow(
      workflow((ctx) => ctx.ask('gate', question)),
      {
        ...options(),
        signal: controller.signal,
        onEvent(event) {
          if (event.type === 'step.waiting') controller.abort(new Error('operator stopped'));
        },
      },
    ),
  ).rejects.toThrow('operator stopped');
  const record = await readRun(options());
  expect(record.status).toBe('cancelled');
  expect(record.steps['gate']?.status).toBe('waiting');
  expect((await inspectRunOwnership(options())).locked).toBe(false);
});

it('guards strict replay before presenting a new question and rejects oversized deliveries early', async () => {
  await expect(
    runWorkflow(
      workflow(async (ctx) => {
        await ctx.step('saved', { input: null, schema: z.null(), run: () => null });
        throw new Error('tail');
      }),
      options(),
    ),
  ).rejects.toThrow('tail');
  await expect(
    runWorkflow(
      workflow((ctx) => ctx.ask('new', question)),
      { ...options(), resume: true, strictReplay: true },
    ),
  ).rejects.toThrow('Replay divergence');
  expect((await readRun(options())).steps['new']).toBeUndefined();
  await runWorkflow(
    workflow((ctx) => ctx.ask('text', { prompt: 'Text?', schema: z.string() })),
    { ...options(), runId: 'large' },
  );
  await expect(
    writeAnswer({ ...options(), runId: 'large', stepId: 'text', value: 'x'.repeat(1_048_576) }),
  ).rejects.toMatchObject({ reason: 'invalid' });
  expect(await readdir(stateDir)).not.toContain('large.inbox');
});

it('finishes failure bookkeeping after withdrawing a question from an invalid body result', async () => {
  const definition = defineWorkflow({
    name: 'invalid-tail',
    version: '1',
    input: z.null(),
    output: z.number().min(10),
    run: (ctx) =>
      Promise.race([
        ctx.ask('abandoned', { prompt: 'Number?', schema: z.number() }),
        ctx.step('winner', {
          input: null,
          schema: z.number(),
          run: async () => {
            await delay(20);
            return 3;
          },
        }),
      ]),
  });
  await expect(runWorkflow(definition, options())).rejects.toThrow();
  const saved = await readRun(options());
  expect(saved.status).toBe('failed');
  expect(saved.steps['abandoned']?.status).toBe('withdrawn');
  expect((await inspectRunOwnership(options())).locked).toBe(false);
});

it('keeps hashed long-ID filenames disjoint from every legal short ID', async () => {
  const long = `a${'/a'.repeat(95)}`;
  const short = `sha256-${createHash('sha256').update(JSON.stringify(long)).digest('hex')}`;
  const definition = workflow((ctx) =>
    Promise.all([
      ctx.ask(long, { prompt: 'Long ID?', schema: z.number() }),
      ctx.ask(short, { prompt: 'Short ID?', schema: z.number() }),
    ]),
  );
  await runWorkflow(definition, options());
  await writeAnswer({ ...options(), stepId: long, value: 1 });
  await writeAnswer({ ...options(), stepId: short, value: 2 });
  expect((await runWorkflow(definition, { ...options(), resume: true })).output).toEqual([1, 2]);
});

it('keeps case-variant questions distinct on case-insensitive filesystems', async () => {
  const definition = workflow((ctx) =>
    Promise.all([ctx.ask('Case', question), ctx.ask('case', question)]),
  );
  expect((await runWorkflow(definition, options())).status).toBe('suspended');
  const [upper, lower] = await Promise.all([
    writeAnswer({ ...options(), stepId: 'Case', value: 'ship' }),
    writeAnswer({ ...options(), stepId: 'case', value: 'revise' }),
  ]);
  expect(upper.path.toLowerCase()).not.toBe(lower.path.toLowerCase());
  expect((await runWorkflow(definition, { ...options(), resume: true })).output).toEqual([
    'ship',
    'revise',
  ]);
});

it('ingests an answer published in the flat-layout inbox of a directory run', async () => {
  const definition = workflow((ctx) => ctx.ask('gate', question));
  expect((await runWorkflow(definition, options())).status).toBe('suspended');
  const delivery = await writeAnswer({ ...options(), stepId: 'gate', value: 'ship' });
  const oldInbox = join(stateDir, 'questions.inbox');
  await mkdir(oldInbox);
  await rename(delivery.path, join(oldInbox, basename(delivery.path)));
  await expect(
    writeAnswer({ ...options(), stepId: 'gate', value: 'revise' }),
  ).rejects.toMatchObject({ reason: 'conflict' });
  expect((await runWorkflow(definition, { ...options(), resume: true })).output).toBe('ship');
});

it('keeps one exclusive inbox for a flat run before and after migration', async () => {
  const definition = workflow(async (ctx) => [
    await ctx.ask('first', question),
    await ctx.ask('second', question),
  ]);
  expect((await runWorkflow(definition, options())).status).toBe('suspended');
  const record = await readRun(options());
  record.formatVersion = 6;
  delete record.seq;
  delete record.engine;
  // Format 6 predates wait progress; its questions carry none.
  for (const step of Object.values(record.steps)) delete step.wait;
  await rm(join(stateDir, 'questions'), { recursive: true });
  await writeRun(stateDir, record);
  const inbox = join(stateDir, 'questions.inbox');
  const before = await writeAnswer({ ...options(), stepId: 'first', value: 'ship' });
  expect(before.path).toBe(join(inbox, basename(before.path)));
  expect((await runWorkflow(definition, { ...options(), resume: true })).status).toBe('suspended');
  expect((await readRun(options())).formatVersion).toBe(7);
  expect(await readdir(join(stateDir, 'questions'))).not.toContain('inbox');
  const after = await writeAnswer({ ...options(), stepId: 'second', value: 'revise' });
  expect(after.path).toBe(join(inbox, basename(after.path)));
  await expect(
    writeAnswer({ ...options(), stepId: 'second', value: 'ship' }),
  ).rejects.toMatchObject({ reason: 'conflict' });
  // Earlier builds moved migrated inboxes into the run directory; those deliveries still count.
  const moved = join(stateDir, 'questions', 'inbox');
  await mkdir(moved);
  await rename(after.path, join(moved, basename(after.path)));
  await expect(
    writeAnswer({ ...options(), stepId: 'second', value: 'ship' }),
  ).rejects.toMatchObject({ reason: 'conflict' });
  expect((await runWorkflow(definition, { ...options(), resume: true })).output).toEqual([
    'ship',
    'revise',
  ]);
});

it('publishes the format-6 filename in a migrated run so both writer versions share one link', async () => {
  const long = `a${'/a'.repeat(95)}`;
  const definition = workflow(async (ctx) => [
    await ctx.ask('first', question),
    await ctx.ask('review/second', question),
    await ctx.ask(long, question),
  ]);
  expect((await runWorkflow(definition, options())).status).toBe('suspended');
  const record = await readRun(options());
  record.formatVersion = 6;
  delete record.seq;
  delete record.engine;
  // Format 6 predates wait progress; its questions carry none.
  for (const step of Object.values(record.steps)) delete step.wait;
  await rm(join(stateDir, 'questions'), { recursive: true });
  await writeRun(stateDir, record);
  const inbox = join(stateDir, 'questions.inbox');
  const first = await writeAnswer({ ...options(), stepId: 'first', value: 'ship' });
  expect(first.path).toBe(join(inbox, 'first.answer.json'));
  expect((await runWorkflow(definition, { ...options(), resume: true })).status).toBe('suspended');
  expect((await readRun(options())).formatVersion).toBe(7);
  // A pre-upgrade writer links `<encoded>.answer.json` into the same flat inbox.
  const legacy = join(inbox, 'review%2Fsecond.answer.json');
  expect(answerPath(stateDir, 'questions', 'review/second')).toBe(legacy);
  const envelope = JSON.stringify({
    value: 'revise',
    by: 'agent:legacy',
    at: new Date().toISOString(),
    questionFingerprint: (await readRun(options())).steps['review/second']?.fingerprint,
  });
  await writeFile(legacy, envelope);
  await expect(
    writeAnswer({ ...options(), stepId: 'review/second', value: 'ship' }),
  ).rejects.toMatchObject({ reason: 'conflict' });
  expect(await readFile(legacy, 'utf8')).toBe(envelope);
  expect((await readdir(inbox)).filter((name) => name.includes('second'))).toEqual([
    'review%2Fsecond.answer.json',
  ]);
  expect((await runWorkflow(definition, { ...options(), resume: true })).status).toBe('suspended');
  const hashed = await writeAnswer({ ...options(), stepId: long, value: 'ship' });
  const digest = createHash('sha256').update(JSON.stringify(long)).digest('hex');
  expect(hashed.path).toBe(join(inbox, `~sha256-${digest}.answer.json`));
  expect((await runWorkflow(definition, { ...options(), resume: true })).output).toEqual([
    'ship',
    'revise',
    'ship',
  ]);
});

it('builds resumeCommand and answerCommand behind an explicit launcher, quiet-choir by default', async () => {
  const definition = workflow((ctx) => ctx.ask('gate', question));
  const launch = { entrypoint: '/project/gate.workflow.ts', tsconfig: null };
  const launcher = ['/x/node', '/y/run.js'];
  const suspended = await runWorkflow(definition, {
    ...options(),
    launch,
    commandLauncher: launcher,
  });
  if (suspended.status !== 'suspended') throw new Error('Expected a suspension.');
  expect(suspended.resumeCommand).toEqual([
    ...launcher,
    'workflow',
    'resume',
    'questions',
    '--state-dir',
    stateDir,
  ]);
  expect(suspended.pending[0]?.answerCommand?.slice(0, 4)).toEqual([
    ...launcher,
    'workflow',
    'answer',
  ]);
  expect((await listPending({ stateDir, commandLauncher: launcher }))[0]?.answerCommand).toEqual([
    ...launcher,
    'workflow',
    'answer',
    'questions',
    'gate',
    '--state-dir',
    stateDir,
    '--json',
    '<ANSWER_JSON>',
  ]);
  expect((await listPending({ stateDir }))[0]?.answerCommand?.slice(0, 2)).toEqual([
    'quiet-choir',
    'workflow',
  ]);
  const resumed = await runWorkflow(definition, { ...options(), resume: true, launch });
  if (resumed.status !== 'suspended') throw new Error('Expected a suspension.');
  expect(resumed.resumeCommand?.slice(0, 3)).toEqual(['quiet-choir', 'workflow', 'resume']);
});

it('repeats a recorded launch policy in resumeCommand, validating and replacing it per execution', async () => {
  const definition = workflow((ctx) => ctx.ask('gate', question));
  const policy = {
    harness: {
      kind: 'fixture' as const,
      fixtures: [{ path: '/project/f.json', sha256: 'a'.repeat(64) }],
    },
    waitMode: 'block' as const,
  };
  const launch = { entrypoint: '/project/gate.workflow.ts', tsconfig: null, policy };
  const suspended = await runWorkflow(definition, { ...options(), launch });
  if (suspended.status !== 'suspended') throw new Error('Expected a suspension.');
  expect(suspended.resumeCommand).toEqual([
    'quiet-choir',
    'workflow',
    'resume',
    'questions',
    '--state-dir',
    stateDir,
    '--harness',
    'fixture:/project/f.json',
    '--wait-mode',
    'block',
  ]);
  expect((await readRun(options())).launch?.policy).toEqual(policy);
  // A malformed policy is refused before anything is written.
  await expect(
    runWorkflow(definition, {
      ...options(),
      resume: true,
      launch: { ...launch, policy: { ...policy, harness: { kind: 'fixture' as const } } },
    }),
  ).rejects.toThrow();
  // A launch without a policy (an embedder) replaces the recorded one, and adds no flags.
  const resumed = await runWorkflow(definition, {
    ...options(),
    resume: true,
    launch: { entrypoint: launch.entrypoint, tsconfig: null },
  });
  if (resumed.status !== 'suspended') throw new Error('Expected a suspension.');
  expect(resumed.resumeCommand).toEqual([
    'quiet-choir',
    'workflow',
    'resume',
    'questions',
    '--state-dir',
    stateDir,
  ]);
  expect((await readRun(options())).launch?.policy).toBeUndefined();
});

it('lists runStatus and delivery on every pending row, unfiltered', async () => {
  const definition = workflow((ctx) => ctx.ask('gate', question));
  const suspended = await runWorkflow(definition, options());
  if (suspended.status !== 'suspended') throw new Error('Expected a suspension.');
  // The runner's own suspended-run result keeps the plain operation shape.
  for (const entry of suspended.pending) {
    expect(Object.keys(entry)).not.toContain('runStatus');
    expect(Object.keys(entry)).not.toContain('delivery');
  }
  expect(await listPending({ stateDir })).toEqual([
    {
      ...suspended.pending[0],
      runStatus: 'suspended',
      delivery: { state: 'none', at: null, by: null },
    },
  ]);
  const before = Date.now();
  await writeAnswer({ ...options(), stepId: 'gate', value: 'ship', by: 'agent:test' });
  const [queued] = await listPending({ stateDir });
  expect(queued).toMatchObject({
    stepId: 'gate',
    runStatus: 'suspended',
    delivery: { state: 'queued', by: 'agent:test' },
  });
  const at = Date.parse(queued?.delivery?.at ?? '');
  expect(at).toBeGreaterThanOrEqual(before);
  expect(at).toBeLessThanOrEqual(Date.now());
  const envelope = JSON.parse(
    await readFile(answerPath(stateDir, 'questions', 'gate'), 'utf8'),
  ) as { at: string };
  expect(queued?.delivery?.at).toBe(envelope.at);
});

it('lists a corrupted inbox file as queued without attribution', async () => {
  await runWorkflow(
    workflow((ctx) => ctx.ask('gate', question)),
    options(),
  );
  const path = answerPath(stateDir, 'questions', 'gate');
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, '{not json');
  expect((await listPending({ stateDir }))[0]?.delivery).toEqual({
    state: 'queued',
    at: null,
    by: null,
  });
  await writeFile(path, JSON.stringify({ value: 'ship' }));
  expect((await listPending({ stateDir }))[0]?.delivery).toEqual({
    state: 'queued',
    at: null,
    by: null,
  });
});

it('reports a legacy flat-inbox delivery as queued', async () => {
  await runWorkflow(
    workflow((ctx) => ctx.ask('gate', question)),
    options(),
  );
  await mkdir(join(stateDir, 'questions.inbox'), { recursive: true });
  await writeFile(join(stateDir, 'questions.inbox', 'gate.answer.json'), '{}');
  expect((await listPending({ stateDir }))[0]?.delivery?.state).toBe('queued');
});

it('explains an invalid answer as normalized one-line issues', async () => {
  await runWorkflow(
    workflow((ctx) => ctx.approve('approval', { prompt: 'Apply?' })),
    options(),
  );
  const error = await writeAnswer({
    ...options(),
    stepId: 'approval',
    value: { approved: 'yes' },
  }).catch((thrown: unknown) => thrown);
  if (!(error instanceof AnswerError)) throw new Error('Expected an AnswerError.');
  expect(error.reason).toBe('invalid');
  expect(error.issues[0]).toMatchObject({ code: 'invalid_type', path: ['approved'] });
  expect(error.message).not.toContain('\n');
  expect(error.message).toMatch(/^Answer does not match the question schema: approved: /u);
  // A root-level mismatch names (root).
  const root = await writeAnswer({ ...options(), stepId: 'approval', value: 3 }).catch(
    (thrown: unknown) => thrown,
  );
  expect(root).toMatchObject({ issues: [{ path: [] }] });
  expect((root as Error).message).toContain('(root): ');
});

it('reports author, size and JSON refusals as one documented synthetic issue each', async () => {
  await runWorkflow(
    workflow((ctx) =>
      Promise.all([
        ctx.approve('human', { prompt: 'Apply?', audience: 'human' }),
        ctx.ask('text', { prompt: 'Text?', schema: z.string() }),
      ]),
    ),
    options(),
  );
  const refusal = async (stepId: string, value: unknown, by?: string): Promise<AnswerError> => {
    try {
      await writeAnswer({ ...options(), stepId, value, ...(by === undefined ? {} : { by }) });
    } catch (thrown) {
      if (thrown instanceof AnswerError) return thrown;
      throw thrown;
    }
    throw new Error('Expected a refusal.');
  };
  const author = await refusal('human', { approved: true }, 'agent:x');
  expect(author).toBeInstanceOf(AnswerError);
  expect(author).toMatchObject({
    reason: 'invalid',
    issues: [
      {
        code: 'answer_author',
        path: [],
        message: expect.stringContaining('human:<name>') as unknown,
      },
    ],
  });
  expect(author.message).not.toContain('\n');
  const large = await refusal('text', 'x'.repeat(1_048_576));
  expect(large).toMatchObject({
    reason: 'invalid',
    issues: [{ code: 'answer_too_large', path: [], message: 'Answer envelope exceeds 1 MiB.' }],
  });
  const notJson = await refusal('text', undefined);
  expect(notJson).toMatchObject({ reason: 'invalid', issues: [{ code: 'answer_not_json' }] });
  expect(notJson.issues).toHaveLength(1);
  expect(notJson.message).not.toContain('\n');
});

it('gives a conflict no issues', async () => {
  await runWorkflow(
    workflow((ctx) => ctx.ask('gate', question)),
    options(),
  );
  await writeAnswer({ ...options(), stepId: 'gate', value: 'ship' });
  await expect(
    writeAnswer({ ...options(), stepId: 'gate', value: 'revise' }),
  ).rejects.toMatchObject({ reason: 'conflict', issues: [] });
  await expect(
    writeAnswer({ ...options(), stepId: 'missing', value: 'revise' }),
  ).rejects.toMatchObject({ reason: 'conflict', issues: [] });
});
