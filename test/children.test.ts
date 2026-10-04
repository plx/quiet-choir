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
      return ctx.workflow('design', 'design-tournament', { topic: 'chosen' });
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
  const refusal = runWorkflow(root, { stateDir, runId: 'version', resume: true });
  await expect(refusal).rejects.toThrow(/child.*leaf-review@1 -> leaf-review@2/u);
  // A completed frame has a committed outcome, so the unfinished-frame retry hint does not apply.
  await expect(refusal).rejects.not.toThrow(/accept-code-change/u);
  const withoutChild = defineWorkflow({
    name: 'parent',
    ...base,
    run: () => Promise.resolve(null),
  });
  await expect(
    runWorkflow(withoutChild, { stateDir, runId: 'version', resume: true }),
  ).rejects.toThrow('skipped completed or settled child frames');
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
      // @ts-expect-error -- the declared child's input type requires value; the runtime checks it too.
      await expect(ctx.workflow('invalid-input', 'required', {})).rejects.toThrow(
        'invalid-input (required) input validation',
      );
      expect(calls).toBe(0);
      await expect(ctx.workflow('invalid-output', child, { value: 'x' })).rejects.toThrow(
        'invalid-output (required) output validation',
      );
      // @ts-expect-error -- undeclared is not a declared child name; the runtime rejects it too.
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

it('drops delegated Claude-only limits from a Codex call in a child workflow', async () => {
  const stateDir = await directory();
  const seen: { options: object; policy: object | undefined }[] = [];
  const child = defineWorkflow({
    name: 'child',
    ...base,
    async run(ctx) {
      await ctx.codex.text('ask', { prompt: 'x' });
      return null;
    },
  });
  const root = defineWorkflow({
    name: 'parent',
    ...base,
    children: [child],
    async run(ctx) {
      // The delegated text ceiling carries maxTurns 10 and maxBudgetUsd 0.5, which Codex lacks.
      return ctx.workflow('child', child, null);
    },
  });
  const run = await runWorkflow(root, {
    stateDir,
    runId: 'codex-child',
    input: null,
    harness: {
      invoke: (request, invocation) => {
        seen.push({ options: request.options, policy: invocation.policy });
        return Promise.resolve({ text: 'ok', sessionId: null });
      },
    },
  });
  expect(run.status).toBe('completed');
  expect(seen).toHaveLength(1);
  const attempt = run.steps['child/ask']?.attemptHistory?.[0];
  for (const values of [attempt?.policy, attempt?.sources, seen[0]?.options, seen[0]?.policy]) {
    expect(values).toBeDefined();
    expect(values).not.toHaveProperty('maxTurns');
    expect(values).not.toHaveProperty('maxBudgetUsd');
  }
  // Limits Codex shares, such as timeoutMs, still apply.
  expect(attempt?.policy).toHaveProperty('timeoutMs', 300_000);
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
      await ctx.map('items', [0, 1], { concurrency: 2, onError: 'return' }, async () =>
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
        await ctx.map('items', [0], { concurrency: 1, onError: 'return' }, async () =>
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
        await ctx.map('items', [0], { concurrency: 1, onError: 'return' }, () =>
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
      return ctx.workflow('leaf', 'leaf', null);
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
          ctx.map('same', [], { concurrency: 1, onError: 'return' }, () => Promise.resolve(null));
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
      await ctx.map('items', [0, 1], { concurrency: 2, cancelSiblings: true }, async (item) => {
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

const pause = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 5);
  });
const typesOf = (events: readonly WorkflowEvent[]) => events.map((event) => event.type);

it('supersedes a failed child frame that a resumed run no longer invokes, once', async () => {
  const stateDir = await directory();
  let invoke = true;
  let broken = true;
  const kid = defineWorkflow({
    name: 'kid',
    ...base,
    async run(ctx) {
      if (broken) throw new Error('kid broke before its first step');
      return ctx.step('work', { input: null, schema: z.null(), run: () => null });
    },
  });
  const root = defineWorkflow({
    name: 'parent',
    ...base,
    async run(ctx) {
      if (invoke) await ctx.workflow('kid', kid, null);
      return null;
    },
  });
  const options = { stateDir, runId: 'supersede-failed' };
  await expect(runWorkflow(root, { ...options, input: null })).rejects.toThrow('kid broke');
  const failed = (await readRun(options)).children?.['kid'];
  expect(failed).toMatchObject({ status: 'failed', error: 'kid broke before its first step' });
  await pause();

  invoke = false;
  const events: WorkflowEvent[] = [];
  const resumed = await runWorkflow(root, {
    ...options,
    resume: true,
    onEvent: (event) => {
      events.push(event);
    },
  });
  expect(resumed.status).toBe('completed');
  const frame = resumed.children?.['kid'];
  expect(frame).toMatchObject({
    status: 'superseded',
    error: 'kid broke before its first step',
    startedAt: failed?.startedAt,
  });
  expect(Date.parse(frame?.finishedAt ?? '')).toBeGreaterThan(Date.parse(failed?.finishedAt ?? ''));
  const superseded = events.filter((event) => event.type === 'child.superseded');
  expect(superseded).toHaveLength(1);
  expect(superseded[0]).toMatchObject({ frame: 'kid', stepId: null });
  expect(typesOf(events).indexOf('child.superseded')).toBeGreaterThan(
    typesOf(events).indexOf('run.completed'),
  );
  expect((await readRun(options)).children?.['kid']).toEqual(frame);

  // A later plain resume replays the body again (frames exist) but retires nothing twice.
  const again: WorkflowEvent[] = [];
  await runWorkflow(root, {
    ...options,
    resume: true,
    onEvent: (event) => {
      again.push(event);
    },
  });
  expect(typesOf(again)).toContain('run.completed');
  expect(typesOf(again)).not.toContain('child.superseded');
  expect((await readRun(options)).children?.['kid']).toEqual(frame);

  // Invoking the frame again with the same identity treats it like any unfinished prior frame.
  invoke = true;
  broken = false;
  const revived = await runWorkflow(root, { ...options, resume: true });
  expect(revived.children?.['kid']).toMatchObject({ status: 'completed', error: null });
  expect(revived.steps['kid/work']?.status).toBe('completed');
});

it('supersedes an externally cancelled child frame that a resume skips', async () => {
  const stateDir = await directory();
  const controller = new AbortController();
  let invoke = true;
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
      if (invoke) await ctx.workflow('child', child, null);
      return null;
    },
  });
  const options = { stateDir, runId: 'supersede-cancelled' };
  const pending = runWorkflow(root, { ...options, input: null, signal: controller.signal });
  await ready;
  controller.abort(new Error('stop'));
  await expect(pending).rejects.toThrow('stop');
  const cancelled = (await readRun(options)).children?.['child'];
  expect(cancelled?.status).toBe('cancelled');
  await pause();

  invoke = false;
  const resumed = await runWorkflow(root, { ...options, resume: true });
  expect(resumed.status).toBe('completed');
  expect(resumed.children?.['child']).toMatchObject({
    status: 'superseded',
    error: cancelled?.error,
  });
  expect(Date.parse(resumed.children?.['child']?.finishedAt ?? '')).toBeGreaterThan(
    Date.parse(cancelled?.finishedAt ?? ''),
  );
  expect(resumed.steps['child/blocked']?.status).toBe('superseded');
});

it('supersedes, rather than cancels, a parked child frame the resumed body never invokes', async () => {
  const stateDir = await directory();
  let invoke = true;
  const child = defineWorkflow({
    name: 'question',
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
      if (invoke) await ctx.workflow('child', child, null);
      return null;
    },
  });
  const options = { stateDir, runId: 'supersede-parked' };
  const suspended = await runWorkflow(root, { ...options, input: null });
  expect(suspended.children?.['child']?.status).toBe('suspended');

  invoke = false;
  const events: WorkflowEvent[] = [];
  const resumed = await runWorkflow(root, {
    ...options,
    resume: true,
    onEvent: (event) => {
      events.push(event);
    },
  });
  expect(resumed.status).toBe('completed');
  expect(resumed.children?.['child']).toMatchObject({
    status: 'superseded',
    error: 'Superseded: the completed workflow no longer invoked this child frame.',
  });
  expect(resumed.children?.['child']?.finishedAt).not.toBeNull();
  // Body completion withdraws open questions (ADR 0018), whether or not their frame was reached.
  expect(resumed.steps['child/answer']?.status).toBe('withdrawn');
  expect(events.filter((event) => event.type === 'child.superseded')).toHaveLength(1);
});

it('still fails a resume that skips a failed frame holding a completed step, without superseding it', async () => {
  const stateDir = await directory();
  let invoke = true;
  const child = defineWorkflow({
    name: 'partial',
    ...base,
    async run(ctx) {
      await ctx.step('done', { input: null, schema: z.null(), run: () => null });
      throw new Error('failed after a step');
    },
  });
  const root = defineWorkflow({
    name: 'parent',
    ...base,
    async run(ctx) {
      if (invoke) await ctx.workflow('child', child, null);
      return null;
    },
  });
  const options = { stateDir, runId: 'supersede-skipped-step' };
  await expect(runWorkflow(root, { ...options, input: null })).rejects.toThrow('after a step');
  const before = (await readRun(options)).children?.['child'];

  invoke = false;
  const events: WorkflowEvent[] = [];
  await expect(
    runWorkflow(root, {
      ...options,
      resume: true,
      onEvent: (event) => {
        events.push(event);
      },
    }),
  ).rejects.toThrow('Replay skipped recorded steps (child/done)');
  const saved = await readRun(options);
  expect(saved.status).toBe('failed');
  expect(saved.children?.['child']).toEqual(before);
  expect(typesOf(events)).not.toContain('child.superseded');
});

it('supersedes a grandchild that a revisited parent frame no longer invokes', async () => {
  const stateDir = await directory();
  let callLeaf = true;
  const leaf = defineWorkflow({
    name: 'leaf',
    ...base,
    run: () => Promise.reject<null>(new Error('leaf broke')),
  });
  const middle = defineWorkflow({
    name: 'middle',
    ...base,
    async run(ctx) {
      if (callLeaf) await ctx.workflow('leaf', leaf, null);
      return null;
    },
  });
  const root = defineWorkflow({
    name: 'parent',
    ...base,
    run: (ctx) => ctx.workflow('middle', middle, null),
  });
  const options = { stateDir, runId: 'supersede-nested' };
  await expect(runWorkflow(root, { ...options, input: null })).rejects.toThrow('leaf broke');
  expect((await readRun(options)).children).toMatchObject({
    middle: { status: 'failed' },
    'middle/leaf': { status: 'failed', parent: 'middle' },
  });

  callLeaf = false;
  const resumed = await runWorkflow(root, { ...options, resume: true });
  expect(resumed.children).toMatchObject({
    middle: { status: 'completed', error: null },
    'middle/leaf': { status: 'superseded', error: 'leaf broke', parent: 'middle' },
  });
});

it.each([true, false])(
  'suggests --accept-code-change when a changed child identity hits an unfinished frame (declared: %s)',
  async (declared) => {
    const stateDir = await directory();
    let version = '1';
    const child = () =>
      defineWorkflow({
        name: 'kid',
        ...base,
        version,
        run: () => Promise.reject<null>(new Error('kid broke')),
      });
    const root = () => {
      const kid = child();
      return defineWorkflow({
        name: 'parent',
        ...base,
        ...(declared ? { children: [kid] } : {}),
        run: (ctx) => ctx.workflow('kid', kid, null),
      });
    };
    const options = { stateDir, runId: `hint-${String(declared)}` };
    await expect(runWorkflow(root(), { ...options, input: null })).rejects.toThrow('kid broke');
    version = '2';
    const refusal = runWorkflow(root(), { ...options, resume: true });
    await expect(refusal).rejects.toThrow(/Child frame kid changed: kid@1 -> kid@2/u);
    await expect(refusal).rejects.toThrow(
      /saved frame is failed, not completed: to retry a fixed child, keep its name, version, input and schemas and resume with --accept-code-change/u,
    );
  },
);
