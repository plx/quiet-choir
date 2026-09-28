import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  defineWorkflow,
  readRun,
  runWorkflow,
  writeAnswer,
  z,
  type WorkflowDeclaration,
  type WorkflowDefinition,
  type WorkflowEvent,
} from '../src/index.js';
import { describeWorkflow } from '../src/workflow/runtime/definition.js';
import { workflowSnapshot } from '../src/workflow/runtime/compatibility.js';
import { inspectRun } from '../src/workflow/loader/inspection.js';

const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'choir-children-'));
  directories.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const base = { version: '1', input: z.null(), output: z.null() };

it('runs typed and named three-level composition with scoped effects, frames, phases and events', async () => {
  const stateDir = await directory();
  const events: WorkflowEvent[] = [];
  let calls = 0;
  const tournament = defineWorkflow({
    name: 'design-tournament',
    version: '1',
    input: z.object({ topic: z.string().describe('Design topic') }),
    output: z.string(),
    description: 'Compare designs',
    whenToUse: 'Choosing a design',
    phases: [{ title: 'Review', detail: 'Read candidates' }],
    async run(ctx, input) {
      ctx.phase('Tournament');
      ctx.log('Reviewing');
      await ctx.scope('checks', () =>
        ctx.step('local', {
          input: null,
          schema: z.null(),
          run: () => {
            calls++;
            return null;
          },
        }),
      );
      return input.topic;
    },
  });
  const spec = defineWorkflow({
    name: 'prd-to-spec',
    ...base,
    output: z.string(),
    children: [tournament],
    async run(ctx) {
      return (await ctx.workflow('design', 'design-tournament', { topic: 'chosen' })) as string;
    },
  });
  const root = defineWorkflow({
    name: 'sdlc',
    ...base,
    output: z.string(),
    children: [spec],
    async run(ctx) {
      ctx.phase('Root');
      return ctx.workflow('spec', spec, null);
    },
  });
  const options = {
    stateDir,
    runId: 'tree',
    onEvent: (event: WorkflowEvent) => {
      events.push(event);
    },
  };
  const run = await runWorkflow(root, { ...options, input: null });
  expect(run.output).toBe('chosen');
  expect(run.children).toMatchObject({
    spec: {
      workflow: { name: 'prd-to-spec', version: '1' },
      parent: null,
      depth: 1,
      status: 'completed',
    },
    'spec/design': {
      workflow: { name: 'design-tournament' },
      parent: 'spec',
      depth: 2,
      status: 'completed',
    },
  });
  expect(run.steps['spec/design/checks/local']).toMatchObject({
    frame: 'spec/design',
    phase: 'Tournament',
  });
  expect(run.phase?.title).toBe('Root');
  expect(run.events?.find((event) => event.message === 'Reviewing')?.frame).toBe('spec/design');
  expect(
    events.filter((event) => event.type === 'child.completed').map((event) => event.frame),
  ).toEqual(['spec/design', 'spec']);
  await runWorkflow(root, { ...options, resume: true });
  expect(calls).toBe(1);
  const description = describeWorkflow(root);
  expect(description.children[0]?.children[0]).toMatchObject({
    description: 'Compare designs',
    phases: [{ title: 'Review' }],
    inputSchema: { required: ['topic'], properties: { topic: { description: 'Design topic' } } },
  });
});

it('attributes a replayed step to a same-ID child frame after a refactor from a root scope', async () => {
  const stateDir = await directory();
  const options = { stateDir, runId: 'reframe' };
  const initial = defineWorkflow({
    name: 'reframe-root',
    ...base,
    output: z.string(),
    async run(ctx) {
      return ctx.scope('review', () =>
        ctx.step('x', { input: null, schema: z.string(), run: () => 'ok' }),
      );
    },
  });
  await runWorkflow(initial, { ...options, input: null });
  expect((await readRun(options)).steps['review/x']?.frame).toBeUndefined();

  const child = defineWorkflow({
    name: 'reframe-child',
    ...base,
    output: z.string(),
    async run(ctx) {
      return ctx.step('x', { input: null, schema: z.string(), run: () => 'ok' });
    },
  });
  const changed: WorkflowDefinition<null, string> = {
    ...initial,
    async run(ctx) {
      return ctx.workflow('review', child, null);
    },
  };
  await runWorkflow(changed, { ...options, resume: true, acceptCodeChange: true });
  const after = await readRun(options);
  expect(after.steps['review/x']?.frame).toBe('review');
  const { summary } = await inspectRun(options);
  const reviewChild = summary.children.find((entry) => entry.id === 'review');
  expect(reviewChild).toMatchObject({ steps: 1 });
  expect(reviewChild?.usage).toEqual(summary.usage);
});

it('rejects changed child versions even on completed embedded-run resume and checks empty frames', async () => {
  const stateDir = await directory();
  let version = '1';
  const root = defineWorkflow({
    name: 'parent',
    ...base,
    async run(ctx) {
      return ctx.workflow(
        'child',
        defineWorkflow({ name: 'leaf-review', ...base, version, run: () => Promise.resolve(null) }),
        null,
      );
    },
  });
  await runWorkflow(root, { stateDir, runId: 'version', input: null });
  version = '2';
  await expect(runWorkflow(root, { stateDir, runId: 'version', resume: true })).rejects.toThrow(
    /child.*leaf-review@1 -> leaf-review@2/u,
  );
  const withoutChild = defineWorkflow({
    name: 'parent',
    ...base,
    run: () => Promise.resolve(null),
  });
  await expect(
    runWorkflow(withoutChild, { stateDir, runId: 'version', resume: true }),
  ).rejects.toThrow('skipped completed child frames');
});

it('validates child input before effects and output before returning, with ordinary catchable failures', async () => {
  const stateDir = await directory();
  let calls = 0;
  const child = defineWorkflow({
    name: 'required',
    version: '1',
    input: z.object({ value: z.string() }),
    output: z.number(),
    async run(ctx) {
      await ctx.step('called', {
        input: null,
        schema: z.null(),
        run: () => {
          calls++;
          return null;
        },
      });
      return 'invalid' as unknown as number;
    },
  });
  const root = defineWorkflow({
    name: 'parent',
    ...base,
    children: [child],
    async run(ctx) {
      await expect(ctx.workflow('invalid-input', 'required', {})).rejects.toThrow(
        'invalid-input (required) input validation',
      );
      expect(calls).toBe(0);
      await expect(ctx.workflow('invalid-output', child, { value: 'x' })).rejects.toThrow(
        'invalid-output (required) output validation',
      );
      await expect(ctx.workflow('unknown', 'undeclared', null)).rejects.toThrow(
        'no declared child',
      );
      return null;
    },
  });
  const run = await runWorkflow(root, { stateDir, runId: 'io', input: null });
  expect(run.status).toBe('completed');
  expect(run.children?.['invalid-output']?.status).toBe('failed');
  expect(run.children?.['invalid-input']).toBeUndefined();
  expect(calls).toBe(1);
});

it('supports the configured deep chain with compact IDs and stops recursion with a frame chain', async () => {
  const stateDir = await directory();
  const recursive: WorkflowDefinition<number, null> = defineWorkflow({
    name: 'recursive',
    version: '1',
    input: z.number().int().nonnegative(),
    output: z.null(),
    async run(ctx, depth) {
      await ctx.step('visit', { input: depth, schema: z.null(), run: () => null });
      return depth ? ctx.workflow('long-child-stage-for-port', recursive, depth - 1) : null;
    },
  });
  const run = await runWorkflow(recursive, {
    stateDir,
    runId: 'depth',
    input: 8,
    maxChildDepth: 8,
  });
  expect(Object.values(run.children ?? {}).map((frame) => frame.depth)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8,
  ]);
  expect(Object.keys(run.steps).every((id) => id.length <= 200)).toBe(true);
  expect(Object.keys(run.children ?? {}).some((id) => id.startsWith('child:'))).toBe(true);
  await expect(
    runWorkflow(recursive, { stateDir, runId: 'limit', input: 9, maxChildDepth: 8 }),
  ).rejects.toThrow(/maxChildDepth 8: recursive > recursive/u);
});

it('maps declared profile grants, caps child limits and refuses direct or nested escalation before inference', async () => {
  const stateDir = await directory();
  let calls = 0;
  const writer = defineWorkflow({
    name: 'writer',
    ...base,
    profiles: { author: { extends: 'edit', maxTurns: 99 } },
    async run(ctx) {
      await ctx.claude.text('write', { profile: 'author', prompt: 'x', maxTurns: 99 });
      return null;
    },
  });
  const nested = defineWorkflow({
    name: 'nested',
    ...base,
    children: [writer],
    async run(ctx) {
      return ctx.workflow('writer', writer, null, { profiles: { author: 'edit' } });
    },
  });
  const root = defineWorkflow({
    name: 'parent',
    ...base,
    profiles: { editor: { extends: 'edit', maxTurns: 3, claude: { model: 'parent-model' } } },
    async run(ctx) {
      await expect(ctx.workflow('missing', writer, null)).rejects.toThrow('no parent grant');
      await ctx.workflow('granted', writer, null, { profiles: { author: 'editor' } });
      await expect(ctx.workflow('nested', nested, null)).rejects.toThrow('no parent grant');
      return null;
    },
  });
  const run = await runWorkflow(root, {
    stateDir,
    runId: 'profiles',
    input: null,
    grants: ['editor'],
    harness: {
      invoke: (request) => {
        calls++;
        expect(request.harness).toBe('claude');
        if (request.harness === 'claude') expect(request.options).toMatchObject({ maxTurns: 3 });
        expect(request.options.model).toBe('parent-model');
        return Promise.resolve({ text: 'ok', sessionId: null });
      },
    },
  });
  expect(run.status).toBe('completed');
  expect(calls).toBe(1);
});

it('suspends and resumes a child question in the same run', async () => {
  const stateDir = await directory();
  const child = defineWorkflow({
    name: 'question',
    ...base,
    output: z.string(),
    async run(ctx) {
      return ctx.ask('answer', { prompt: 'Choose', schema: z.string() });
    },
  });
  const root = defineWorkflow({
    name: 'parent',
    ...base,
    output: z.string(),
    async run(ctx) {
      return ctx.workflow('child', child, null);
    },
  });
  const options = { stateDir, runId: 'question' };
  const suspended = await runWorkflow(root, { ...options, input: null });
  expect(suspended.status).toBe('suspended');
  expect(suspended.children?.['child']?.status).toBe('suspended');
  expect(suspended.steps['child/answer']?.frame).toBe('child');
  await writeAnswer({ ...options, stepId: 'child/answer', value: 'chosen' });
  const resumed = await runWorkflow(root, { ...options, resume: true });
  expect(resumed.output).toBe('chosen');
  expect(resumed.children?.['child']?.status).toBe('completed');
});

it('claims child frames on settled-map replay without executing the mapper or child body again', async () => {
  const stateDir = await directory();
  let bodies = 0;
  const child = defineWorkflow({
    name: 'child',
    ...base,
    async run(ctx) {
      bodies++;
      return ctx.step('effect', { input: null, schema: z.null(), run: () => null });
    },
  });
  const root = defineWorkflow({
    name: 'parent',
    ...base,
    children: [child],
    async run(ctx) {
      await ctx.map('items', [0, 1], { concurrency: 2, onError: 'settle' }, async () =>
        ctx.workflow('child', child, null),
      );
      return null;
    },
  });
  await runWorkflow(root, { stateDir, runId: 'map', input: null });
  await runWorkflow(root, { stateDir, runId: 'map', resume: true });
  expect(bodies).toBe(2);
  const saved = await readRun({ stateDir, runId: 'map' });
  expect(saved.maps?.['items']?.items[0]?.children).toEqual(['items/0/child']);
});

it('checks declared child identity before replay skips a settled mapper and rejects unverifiable dynamic children', async () => {
  const stateDir = await directory();
  const make = (version: string, declared: boolean) => {
    const child = defineWorkflow({
      name: 'child',
      ...base,
      version,
      run: () => Promise.resolve(null),
    });
    return defineWorkflow({
      name: 'parent',
      ...base,
      ...(declared ? { children: [child] } : {}),
      async run(ctx) {
        await ctx.map('items', [0], { concurrency: 1, onError: 'settle' }, async () =>
          ctx.workflow('child', child, null),
        );
        return null;
      },
    });
  };
  await runWorkflow(make('1', true), { stateDir, runId: 'declared', input: null });
  await expect(
    runWorkflow(make('2', true), { stateDir, runId: 'declared', resume: true }),
  ).rejects.toThrow('child@1 -> child@2');
  await expect(
    runWorkflow(make('1', false), { stateDir, runId: 'dynamic', input: null }),
  ).rejects.toThrow("must appear in its parent's children declaration");
});

it('checks skipped declared descendants when their dynamic parent is rediscovered on resume', async () => {
  const stateDir = await directory();
  let bodies = 0;
  const make = (version: string) => {
    const leaf = defineWorkflow({
      name: 'leaf',
      ...base,
      version,
      run: () => {
        bodies++;
        return Promise.resolve(null);
      },
    });
    const middle = defineWorkflow({
      name: 'middle',
      ...base,
      children: [leaf],
      async run(ctx) {
        await ctx.map('items', [0], { concurrency: 1, onError: 'settle' }, () =>
          ctx.workflow('leaf', leaf, null),
        );
        return null;
      },
    });
    return defineWorkflow({
      name: 'root',
      ...base,
      run: (ctx) => ctx.workflow('middle', middle, null),
    });
  };
  await runWorkflow(make('1'), { stateDir, runId: 'dynamic-parent', input: null });
  await runWorkflow(make('1'), { stateDir, runId: 'dynamic-parent', resume: true });
  expect(bodies).toBe(1);
  await expect(
    runWorkflow(make('2'), { stateDir, runId: 'dynamic-parent', resume: true }),
  ).rejects.toThrow(/middle\/items\/0\/leaf.*leaf@1 -> leaf@2/u);
  expect(bodies).toBe(1);
});

it('validates a dynamic child declaration tree before its frame or effects', async () => {
  const stateDir = await directory();
  let effects = 0;
  const leaf = (version: string) =>
    defineWorkflow({ name: 'leaf', ...base, version, run: () => Promise.resolve(null) });
  const middle = defineWorkflow({
    name: 'middle',
    ...base,
    children: [leaf('1'), leaf('2')],
    async run(ctx) {
      await ctx.step('effect', {
        input: null,
        schema: z.null(),
        run: () => {
          effects++;
          return null;
        },
      });
      return ctx.workflow('leaf', 'leaf', null) as Promise<null>;
    },
  });
  const root = defineWorkflow({
    name: 'root',
    ...base,
    async run(ctx) {
      await expect(ctx.workflow('middle', middle, null)).rejects.toThrow(
        'Workflow middle declares duplicate child name leaf.',
      );
      return null;
    },
  });
  const run = await runWorkflow(root, { stateDir, runId: 'dynamic-duplicates', input: null });
  expect(run.status).toBe('completed');
  expect(effects).toBe(0);
  expect(run.children?.['middle']).toBeUndefined();
  expect(run.steps['middle/effect']).toBeUndefined();
});

it('does not let raw read capabilities or nested aliases escape delegated profiles', async () => {
  const stateDir = await directory();
  let calls = 0;
  const child = defineWorkflow({
    name: 'raw',
    ...base,
    strictProfiles: false,
    async run(ctx) {
      await ctx.claude.text('escape', { prompt: 'x', tools: ['WebFetch'] });
      return null;
    },
  });
  const root = defineWorkflow({
    name: 'parent',
    ...base,
    async run(ctx) {
      return ctx.workflow('child', child, null);
    },
  });
  await expect(
    runWorkflow(root, {
      stateDir,
      runId: 'raw',
      input: null,
      grants: ['all'],
      harness: {
        invoke: () => {
          calls++;
          return Promise.resolve({ text: 'wrong', sessionId: null });
        },
      },
    }),
  ).rejects.toThrow('exceeds parent profile text: tools');
  expect(calls).toBe(0);
});

it('keeps a failing parent denial policy in children and refuses a weaker call override', async () => {
  const stateDir = await directory();
  let calls = 0;
  const inheriting = defineWorkflow({
    name: 'inheriting',
    ...base,
    output: z.string(),
    profiles: { scout: { extends: 'readonly' } },
    async run(ctx) {
      const result = await ctx.claude.text('look', {
        profile: 'scout',
        prompt: 'x',
        onError: 'return',
      });
      return result.ok ? 'accepted' : result.error.kind;
    },
  });
  const weakening = defineWorkflow({
    name: 'weakening',
    ...base,
    profiles: { scout: { extends: 'readonly' } },
    async run(ctx) {
      await ctx.claude.text('look', { profile: 'scout', prompt: 'x', onPermissionDenied: 'warn' });
      return null;
    },
  });
  const root = defineWorkflow({
    name: 'parent',
    ...base,
    output: z.string(),
    profiles: { scout: { extends: 'readonly', onPermissionDenied: 'fail' } },
    async run(ctx) {
      await expect(ctx.workflow('weakening', weakening, null)).rejects.toThrow(
        'exceeds parent profile scout: onPermissionDenied',
      );
      return ctx.workflow('inheriting', inheriting, null);
    },
  });
  const run = await runWorkflow(root, {
    stateDir,
    runId: 'denials',
    input: null,
    harness: {
      invoke: () => {
        calls++;
        return Promise.resolve({ text: 'ok', sessionId: null, permissionDenials: 1 });
      },
    },
  });
  expect(run.output).toBe('permission');
  expect(calls).toBe(1);
  expect(run.steps['weakening/look']).toBeUndefined();
});

it('shares run budgets across frames and resumes with per-frame usage retained', async () => {
  const stateDir = await directory();
  let calls = 0;
  const child = defineWorkflow({
    name: 'agent',
    ...base,
    async run(ctx) {
      await ctx.claude.text('call', { prompt: 'x' });
      return null;
    },
  });
  const root = defineWorkflow({
    name: 'parent',
    ...base,
    async run(ctx) {
      for (const label of ['one', 'two', 'three']) await ctx.workflow(label, child, null);
      return null;
    },
  });
  const options = {
    stateDir,
    runId: 'budget',
    harness: {
      invoke: () => {
        calls++;
        return Promise.resolve({ text: 'ok', sessionId: null, usage: { costUsd: 0.1 } });
      },
    },
  };
  await expect(
    runWorkflow(root, { ...options, input: null, maxRunAgentAttempts: 2 }),
  ).rejects.toThrow('maxRunAgentAttempts');
  expect(calls).toBe(2);
  const run = await runWorkflow(root, { ...options, resume: true, maxRunAgentAttempts: 3 });
  expect(calls).toBe(3);
  expect(run.steps['one/call']?.attempts).toBe(1);
  expect(Object.values(run.steps).map((step) => step.frame)).toEqual(['one', 'two', 'three']);
});

it('keeps child metadata out of runtime identity and describes recursive declarations finitely', () => {
  const declarations: WorkflowDeclaration[] = [];
  const recursive = defineWorkflow({
    name: 'recursive',
    ...base,
    children: declarations,
    run: () => Promise.resolve(null),
  });
  declarations.push(recursive);
  expect(describeWorkflow(recursive).children[0]).toMatchObject({ recursive: true, children: [] });
  expect(() => describeWorkflow({ ...recursive, children: [recursive, recursive] })).toThrow(
    'duplicate child name',
  );
  expect(() => describeWorkflow({ ...recursive, phases: [{ title: 4 }] })).toThrow();
  const descriptiveEdit = { ...recursive, description: 'Changed description' };
  expect(workflowSnapshot(descriptiveEdit, {}).fingerprint).toBe(
    workflowSnapshot(recursive, {}).fingerprint,
  );
});

it('withdraws an unawaited parked child when the root body finishes', async () => {
  const stateDir = await directory();
  const child = defineWorkflow({
    name: 'parked',
    ...base,
    async run(ctx) {
      await ctx.ask('answer', { prompt: 'Choose', schema: z.string() });
      return null;
    },
  });
  const root = defineWorkflow({
    name: 'parent',
    ...base,
    async run(ctx) {
      void ctx.workflow('child', child, null);
      await ctx.step('local', { input: null, schema: z.null(), run: () => null });
      return null;
    },
  });
  const run = await runWorkflow(root, { stateDir, runId: 'withdraw', input: null });
  expect(run.status).toBe('completed');
  expect(run.children?.['child']?.status).toBe('cancelled');
  expect(run.steps['child/answer']?.status).toBe('withdrawn');
});

it('journals new frames without quadratic serialized child collections', async () => {
  const stateDir = await directory();
  const sizes: number[] = [];
  const child = defineWorkflow({ name: 'empty', ...base, run: () => Promise.resolve(null) });
  const root = defineWorkflow({
    name: 'parent',
    ...base,
    input: z.number(),
    async run(ctx, count) {
      for (let index = 0; index < count; index++)
        await ctx.workflow(`child-${String(index)}`, child, null);
      sizes.push((await readFile(join(stateDir, String(count), 'journal.jsonl'))).length);
      return null;
    },
  });
  await runWorkflow(root, { stateDir, runId: '20', input: 20 });
  await runWorkflow(root, { stateDir, runId: '40', input: 40 });
  expect(sizes[0]).toBeGreaterThan(0);
  expect(sizes[1]).toBeLessThan((sizes[0] ?? 0) * 2.8);
});

it.each([true, false])(
  'rejects child/map frame collisions before committing ambiguous replay (child first: %s)',
  async (childFirst) => {
    const stateDir = await directory();
    const child = defineWorkflow({ name: 'empty', ...base, run: () => Promise.resolve(null) });
    const root = defineWorkflow({
      name: 'parent',
      ...base,
      children: [child],
      async run(ctx) {
        const frame = () => ctx.workflow('same', child, null);
        const map = () =>
          ctx.map('same', [], { concurrency: 1, onError: 'settle' }, () => Promise.resolve(null));
        if (childFirst) {
          await frame();
          await map();
        } else {
          await map();
          await frame();
        }
        return null;
      },
    });
    await expect(runWorkflow(root, { stateDir, runId: 'collision', input: null })).rejects.toThrow(
      /collides|Duplicate child frame/u,
    );
  },
);

it('cancels a running child frame when the run is interrupted externally', async () => {
  const stateDir = await directory();
  const controller = new AbortController();
  let started: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const child = defineWorkflow({
    name: 'child',
    ...base,
    async run(ctx) {
      return ctx.step('blocked', {
        input: null,
        schema: z.null(),
        run: ({ signal }) =>
          new Promise<null>((_resolve, reject) => {
            started?.();
            signal.addEventListener(
              'abort',
              () => {
                reject(new DOMException('stopped', 'AbortError'));
              },
              { once: true },
            );
          }),
      });
    },
  });
  const root = defineWorkflow({
    name: 'parent',
    ...base,
    children: [child],
    run: (ctx) => ctx.workflow('child', child, null),
  });
  const pending = runWorkflow(root, {
    stateDir,
    runId: 'interrupt',
    input: null,
    signal: controller.signal,
  });
  await ready;
  controller.abort(new Error('stop'));
  await expect(pending).rejects.toThrow('stop');
  const saved = await readRun({ stateDir, runId: 'interrupt' });
  expect(saved.status).toBe('cancelled');
  expect(saved.children?.['child']?.status).toBe('cancelled');
});

it('cancels a sibling map item child frame when the map aborts on another item failure', async () => {
  const stateDir = await directory();
  let started: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const child = defineWorkflow({
    name: 'child',
    ...base,
    async run(ctx) {
      return ctx.step('blocked', {
        input: null,
        schema: z.null(),
        run: ({ signal }) =>
          new Promise<null>((_resolve, reject) => {
            started?.();
            signal.addEventListener(
              'abort',
              () => {
                reject(new DOMException('stopped', 'AbortError'));
              },
              { once: true },
            );
          }),
      });
    },
  });
  const root = defineWorkflow({
    name: 'parent',
    ...base,
    children: [child],
    async run(ctx) {
      await ctx.map('items', [0, 1], { concurrency: 2, onError: 'abort' }, async (item) => {
        if (item === 0) {
          await ready;
          throw new Error('item failure');
        }
        return ctx.workflow('child', child, null);
      });
      return null;
    },
  });
  await expect(runWorkflow(root, { stateDir, runId: 'map-cancel', input: null })).rejects.toThrow(
    'item failure',
  );
  const saved = await readRun({ stateDir, runId: 'map-cancel' });
  expect(saved.children?.['items/1/child']?.status).toBe('cancelled');
});

it('fails, rather than cancels, a child frame whose body throws its own AbortError', async () => {
  const stateDir = await directory();
  const child = defineWorkflow({
    name: 'child',
    ...base,
    run: () => {
      throw new DOMException('x', 'AbortError');
    },
  });
  const root = defineWorkflow({
    name: 'parent',
    ...base,
    children: [child],
    async run(ctx) {
      await expect(ctx.workflow('child', child, null)).rejects.toThrow('x');
      return null;
    },
  });
  const run = await runWorkflow(root, { stateDir, runId: 'own-abort-error', input: null });
  expect(run.status).toBe('completed');
  expect(run.children?.['child']?.status).toBe('failed');
});
