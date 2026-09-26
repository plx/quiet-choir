import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';

import { defineWorkflow, type Harness } from '../src/workflow/runtime/model.js';
import { runWorkflow } from '../src/workflow/runtime/runner.js';
import { readRun } from '../src/workflow/runtime/store.js';

const directories: string[] = [];

async function directory(): Promise<string> {
  const result = await mkdtemp(join(tmpdir(), 'quiet-choir-runtime-review-'));
  directories.push(result);
  return result;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (path) => rm(path, { recursive: true, force: true })),
  );
});

it('cancels a waiting map sibling immediately and retains the first mapper failure', async () => {
  const stateDir = await directory();
  let markReady = (): void => undefined;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  let siblingDrained = false;
  let thirdStarted = false;
  const controller = new AbortController();
  const workflow = defineWorkflow({
    name: 'map-cancellation',
    version: '1',
    input: z.null(),
    output: z.array(z.null()),
    run: async (context) =>
      context.map([0, 1, 2], 2, async (item) => {
        if (item === 0) {
          await ready;
          throw new Error('first mapper failed');
        }
        if (item === 2) thirdStarted = true;
        return context.step('waiting-sibling', {
          input: null,
          schema: z.null(),
          run: async ({ signal }) => {
            markReady();
            try {
              await delay(10_000, undefined, { signal });
            } finally {
              siblingDrained = true;
            }
            return null;
          },
        });
      }),
  });
  const invocation = runWorkflow(workflow, {
    runId: 'map',
    stateDir,
    input: null,
    signal: controller.signal,
  });
  const result = await Promise.race([
    invocation.then(
      () => 'unexpected success',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    ),
    delay(1_000).then(() => 'deadlocked'),
  ]);
  controller.abort();
  await invocation.catch(() => undefined);
  expect(result).toBe('first mapper failed');
  expect(siblingDrained).toBe(true);
  expect(thirdStarted).toBe(false);
  expect((await readRun({ stateDir, runId: 'map' })).error).toBe('first mapper failed');
});

it('snapshots mutable agent options before saving and invoking the harness', async () => {
  const stateDir = await directory();
  const observed: string[] = [];
  const harness: Harness = {
    invoke: (request) => {
      observed.push(request.options.prompt);
      if (request.provider === 'claude') observed.push(...(request.options.tools ?? []));
      return Promise.resolve({
        text: request.options.prompt,
        sessionId: null,
        usage: { inputTokens: null, outputTokens: null, costUsd: null },
      });
    },
  };
  const workflow = defineWorkflow({
    name: 'option-snapshot',
    version: '1',
    input: z.null(),
    output: z.string(),
    run: async (context) => {
      const options = { prompt: 'original prompt', tools: ['Read'] };
      const invocation = context.claude.text('agent', options);
      options.prompt = 'mutated prompt';
      options.tools.push('Bash');
      return (await invocation).output;
    },
  });
  const result = await runWorkflow(workflow, { runId: 'snapshot', stateDir, input: null, harness });
  expect(result.output).toBe('original prompt');
  expect(observed).toEqual(['original prompt', 'Read']);
});
