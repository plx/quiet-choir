import { executionAsyncResource } from 'node:async_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { defineWorkflow, runWorkflow, z } from '../src/index.js';
import { ContextSlot } from '../src/workflow/runtime/context-slot.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'choir-context-slot-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it('keeps each slot to the values it ran with, across awaits', async () => {
  const outer = new ContextSlot<string>();
  const inner = new ContextSlot<number>();
  expect(outer.getStore()).toBeUndefined();
  await outer.run('a', async () => {
    await inner.run(1, async () => {
      await delay(1);
      expect([outer.getStore(), inner.getStore()]).toEqual(['a', 1]);
      await outer.run('b', async () => {
        await delay(1);
        expect([outer.getStore(), inner.getStore()]).toEqual(['b', 1]);
      });
      expect([outer.getStore(), inner.getStore()]).toEqual(['a', 1]);
    });
    expect([outer.getStore(), inner.getStore()]).toEqual(['a', undefined]);
  });
  expect(outer.getStore()).toBeUndefined();
});

it('keeps concurrent runs of one slot apart', async () => {
  const slot = new ContextSlot<string>();
  const seen = await Promise.all(
    ['x', 'y'].map((value) =>
      slot.run(value, async () => {
        await delay(value === 'x' ? 5 : 1);
        return slot.getStore();
      }),
    ),
  );
  expect(seen).toEqual(['x', 'y']);
});

it('does not grow the context every later async resource carries as runs accumulate', async () => {
  const kid = defineWorkflow({
    name: 'kid',
    version: '1',
    input: z.null(),
    output: z.number(),
    run: (ctx) => ctx.step('k', { input: null, schema: z.number(), run: () => 0 }),
  });
  // Root phase, mapper scopes, names, the in-effect guard and child frames each hold a slot.
  const definition = defineWorkflow({
    name: 'context-slot',
    version: '1',
    input: z.null(),
    output: z.number(),
    async run(ctx) {
      await ctx.workflow('kid', kid, null);
      return ctx
        .map('items', [1, 2], { concurrency: 2 }, (item) =>
          ctx.step('double', { input: item, schema: z.number(), run: () => item * 2 }),
        )
        .then((values) => values.reduce((sum, value) => sum + value, 0));
    },
  });
  // Before AsyncContextFrame, a resource carries one property per AsyncLocalStorage ever run.
  const carried = (): Promise<number> =>
    new Promise((resolve) => {
      setTimeout(() => {
        resolve(Object.getOwnPropertySymbols(executionAsyncResource()).length);
      }, 0);
    });
  const run = (n: number) =>
    runWorkflow(definition, {
      runId: `slot-${String(n)}`,
      stateDir: join(directory, 'state'),
      cwd: directory,
      input: null,
      harness: {
        invoke: () => Promise.reject(new Error('This workflow calls no agent.')),
      },
    });
  expect((await run(0)).output).toBe(6);
  const after = await carried();
  for (let n = 1; n <= 10; n++) await run(n);
  expect(await carried()).toBe(after);
});
