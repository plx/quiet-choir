import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defineWorkflow, readRun, runWorkflow, z } from '../src/index.js';
import type { RunOptions, WorkflowContext, WorkflowEvent } from '../src/index.js';
import * as store from '../src/workflow/runtime/store.js';

// Runner arms the replay-decision and attempt-failure tables cannot reach: effect() definition
// validation, retry backoff interrupted by a checkpoint failure, and run option validation.
vi.mock('../src/workflow/runtime/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof store>();
  return { ...actual, writeRun: vi.fn(actual.writeRun) };
});
const actualStore = await vi.importActual<typeof store>('../src/workflow/runtime/store.js');
let stateDir: string;

function workflow(run: (ctx: WorkflowContext) => Promise<string>) {
  return defineWorkflow({ name: 'arms', version: '1', input: z.null(), output: z.string(), run });
}
function options(): { runId: string; stateDir: string; input: null } {
  return { runId: 'run', stateDir, input: null };
}
const ok = workflow(() => Promise.resolve('ok'));

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'quiet-choir-effect-arms-'));
  vi.mocked(store.writeRun).mockImplementation(actualStore.writeRun);
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe('effect() definition validation', () => {
  it('rejects a local effect without a run callback', async () => {
    const run = 'not a function' as unknown as () => string;
    await expect(
      runWorkflow(
        workflow((ctx) => ctx.step('bad', { input: null, schema: z.string(), run })),
        options(),
      ),
    ).rejects.toThrow(
      'Step bad: Local effects require a run callback and, when supplied, a nonempty string version.',
    );
    expect((await readRun(options())).steps['bad']).toBeUndefined();
  });

  it('rejects a blank local effect version', async () => {
    const run = vi.fn(() => 'never');
    await expect(
      runWorkflow(
        workflow((ctx) => ctx.step('bad', { input: null, schema: z.string(), version: ' ', run })),
        options(),
      ),
    ).rejects.toThrow('Step bad: Local effects require a run callback');
    expect(run).not.toHaveBeenCalled();
  });
});

describe('retry backoff', () => {
  it("stops a backoff without retrying when a sibling's checkpoint write fails", async () => {
    vi.mocked(store.writeRun).mockImplementation((directory, record) =>
      record.steps['sibling']?.status === 'completed'
        ? Promise.reject(Object.assign(new Error('injected EIO'), { code: 'EIO' }))
        : actualStore.writeRun(directory, record),
    );
    let backingOff: () => void = () => undefined;
    const inBackoff = new Promise<void>((resolve) => {
      backingOff = resolve;
    });
    const flaky = vi.fn((): string => {
      throw new Error('transient');
    });
    const definition = workflow(async (ctx) => {
      const [value] = await Promise.all([
        ctx.step('flaky', {
          input: null,
          schema: z.string(),
          // A long delay: only the checkpoint failure can end this backoff within the test.
          retry: { maxAttempts: 3, delayMs: 60_000 },
          run: flaky,
        }),
        ctx.step('sibling', {
          input: null,
          schema: z.string(),
          run: async () => {
            await inBackoff;
            await delay(10);
            return 'done';
          },
        }),
      ]);
      return value;
    });
    await expect(
      runWorkflow(definition, {
        ...options(),
        onEvent(event: WorkflowEvent) {
          if (event.type === 'step.failed' && event.stepId === 'flaky') backingOff();
        },
      }),
    ).rejects.toMatchObject({ cause: { name: 'CheckpointError', operation: 'save' } });
    expect(flaky).toHaveBeenCalledTimes(1);
    const saved = await readRun(options());
    expect(saved.steps['flaky']).toMatchObject({ status: 'failed', attempts: 1 });
    expect(saved.steps['flaky']?.error).toBe('transient');
  });
});

describe('run option validation', () => {
  it.each<[string, Partial<RunOptions>, string]>([
    ['a zero killGraceMs', { killGraceMs: 0 }, 'killGraceMs must be an integer from 1 to'],
    ['a fractional killGraceMs', { killGraceMs: 1.5 }, 'killGraceMs must be an integer from 1 to'],
    [
      'a killGraceMs above the timer limit',
      { killGraceMs: 2_147_483_648 },
      'killGraceMs must be an integer from 1 to 2147483647.',
    ],
    [
      'an unknown waitMode',
      { waitMode: 'later' as NonNullable<RunOptions['waitMode']> },
      'waitMode must be suspend or block.',
    ],
    [
      'a clock without sleep',
      { clock: { now: () => 0 } as unknown as NonNullable<RunOptions['clock']> },
      'Workflow clock requires now and sleep methods.',
    ],
    [
      'rehearsal hooks without a dry-run harness',
      { rehearsal: {} },
      'Rehearsal hooks require a dry-run harness.',
    ],
  ])('rejects %s before opening the run', async (_name, extra, message) => {
    await expect(runWorkflow(ok, { ...options(), ...extra })).rejects.toThrow(message);
    await expect(readRun(options())).rejects.toThrow();
  });
});
