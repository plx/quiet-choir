import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defineWorkflow,
  readRun,
  runWorkflow,
  writeAnswer,
  z,
  type WorkflowContext,
} from '../src/index.js';
import WorkflowEvents from '../src/commands/workflow/events.js';
import { watchExitCodes } from '../src/cli/inspection-view.js';
import { workflowExitCodes } from '../src/cli/workflow-errors.js';
import { WorkflowExecutor } from '../src/workflow/loader/executor.js';
import type { EventsWorkflowPlan } from '../src/workflow/loader/model.js';
import type { EventLine } from '../src/workflow/loader/event-line.js';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
let stateDir: string;

const workflow = <T>(run: (ctx: WorkflowContext) => Promise<T>) =>
  defineWorkflow({ name: 'follow', version: '1', input: z.null(), output: z.unknown(), run });
const options = (runId: string) => ({ stateDir, runId, input: null });
const brief = (lines: readonly string[]): string[] =>
  lines.map((line) => {
    const parsed = JSON.parse(line) as EventLine;
    return `${parsed.ev}${parsed.step === undefined ? '' : ` ${parsed.step}`}`;
  });

/** Follow through the executor, as the command does, and map the outcome to its exit code. */
async function follow(
  runId: string,
  plan: Partial<Omit<EventsWorkflowPlan, 'kind' | 'runId' | 'stateDir'>> = {},
  onLine?: (line: string) => void,
): Promise<{ lines: string[]; exit: number; code: string | null }> {
  const lines: string[] = [];
  const executor = new WorkflowExecutor({
    logger: { log: () => undefined },
    onEventLine: (line) => {
      lines.push(line);
      onLine?.(line);
    },
  });
  const result = await executor.execute({
    kind: 'workflow.events',
    runId,
    stateDir,
    follow: true,
    start: 'all',
    intervalMs: 5,
    ...plan,
  });
  if (!result.ok) return { lines, exit: workflowExitCodes[result.code], code: result.code };
  if (result.kind !== 'workflow.run.result' || !result.summary) throw new Error('No summary.');
  return { lines, exit: watchExitCodes[result.summary.status], code: null };
}

/** Terminal runs of each status, built with the real runner or, for stale, an ownerless record. */
async function prepare(status: 'completed' | 'failed' | 'suspended' | 'cancelled' | 'stale') {
  const runId = `run-${status}`;
  if (status === 'completed')
    await runWorkflow(
      workflow((ctx) => ctx.step('a', { input: null, schema: z.number(), run: () => 1 })),
      options(runId),
    );
  if (status === 'failed')
    await runWorkflow(
      workflow((ctx) =>
        ctx.step('a', {
          input: null,
          schema: z.number(),
          run: () => {
            throw new Error('a broke');
          },
        }),
      ),
      options(runId),
    ).catch(() => undefined);
  if (status === 'suspended')
    await runWorkflow(
      workflow((ctx) => ctx.ask('gate', { prompt: 'Ship?', schema: z.boolean() })),
      options(runId),
    );
  if (status === 'cancelled') {
    const controller = new AbortController();
    await runWorkflow(
      workflow(async (ctx) => {
        await ctx.step('a', {
          input: null,
          schema: z.number(),
          run: () => {
            controller.abort(new Error('stop'));
            return 1;
          },
        });
        return ctx.step('b', { input: null, schema: z.number(), run: () => 2 });
      }),
      { ...options(runId), signal: controller.signal },
    ).catch(() => undefined);
  }
  if (status === 'stale') {
    // A running record with no lock: its owner is gone.
    const path = join(stateDir, `${runId}.json`);
    await writeFile(
      `${path}.tmp`,
      JSON.stringify({
        formatVersion: 1,
        id: runId,
        workflow: { name: 'follow', version: '1', fingerprint: null },
        status: 'running',
        cwd: '/',
        input: null,
        output: null,
        error: null,
        steps: {},
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    await rename(`${path}.tmp`, path);
  }
  if (status !== 'stale') expect((await readRun({ stateDir, runId })).status).toBe(status);
  return runId;
}

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'choir-events-follow-'));
});
afterEach(async () => {
  process.exitCode = undefined;
  await rm(stateDir, { recursive: true, force: true });
});

describe('workflow.events follow exits', () => {
  it.each([
    ['completed', 0, 'run.completed'],
    ['failed', 1, 'run.failed a'],
    ['suspended', 75, 'run.suspended'],
    ['cancelled', 130, 'run.cancelled'],
    ['stale', 3, undefined],
  ] as const)('exits for a %s run with %i', async (status, exit, last) => {
    const runId = await prepare(status);
    const followed = await follow(runId);
    expect(followed.exit).toBe(exit);
    if (last !== undefined) expect(brief(followed.lines).at(-1)).toBe(last);
    else expect(followed.lines).toEqual([]);
    // The default start is the current end: a terminal run prints nothing and exits at once.
    const fromEnd = await follow(runId, { start: 'end' });
    expect(fromEnd).toEqual({ lines: [], exit, code: null });
  });

  it.each([
    ['completed', 0],
    ['failed', 1],
    ['suspended', 75],
    ['cancelled', 130],
    ['stale', 3],
  ] as const)('sets the command exit code for a %s run to %i', async (status, exit) => {
    const runId = await prepare(status);
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await WorkflowEvents.run(
      [runId, '--state-dir', stateDir, '--follow', '--from-start', '--interval', '5ms'],
      { root: projectRoot },
    );
    expect(process.exitCode).toBe(exit);
    for (const chunk of written) {
      expect(chunk.endsWith('\n')).toBe(true);
      expect(chunk.split('\n')).toHaveLength(2);
      JSON.parse(chunk);
    }
    if (status !== 'stale') expect(written.length).toBeGreaterThan(0);
  });

  it('prints lines while a run is active and exits 0 once it completes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = runWorkflow(
      workflow(async (ctx) => {
        ctx.phase('hold');
        ctx.log('waiting for release');
        await ctx.step('hold', { input: null, schema: z.null(), run: () => gate.then(() => null) });
        return 'done';
      }),
      options('live'),
    );
    const followed = follow('live', { waitCreatedMs: 10_000 }, (line) => {
      if ((JSON.parse(line) as EventLine).ev === 'log') release();
    });
    const result = await followed;
    await running;
    expect(result.exit).toBe(0);
    expect(brief(result.lines)).toEqual([
      'run.started',
      'phase',
      'log',
      'step.completed hold',
      'run.completed',
    ]);
  });

  it('waits past an old suspended status for a later execution with afterExecution', async () => {
    const definition = workflow(async (ctx) => {
      ctx.log('asking');
      return ctx.ask('gate', { prompt: 'Ship?', schema: z.boolean() });
    });
    await runWorkflow(definition, options('resumed'));
    const snapshot = await readRun({ stateDir, runId: 'resumed' });
    expect(snapshot.status).toBe('suspended');
    let settled = false;
    const followed = follow('resumed', { start: { afterExecution: 1 } }).finally(() => {
      settled = true;
    });
    await delay(50);
    expect(settled).toBe(false);
    await writeAnswer({ ...options('resumed'), stepId: 'gate', value: true });
    await runWorkflow(definition, { ...options('resumed'), resume: true });
    const result = await followed;
    expect(result.exit).toBe(0);
    // Only the second execution's lines: the replayed log is not recorded again.
    expect(brief(result.lines)).toEqual(['run.started', 'step.completed gate', 'run.completed']);
    // Without the flag, the follower stops at once on the old status.
    expect((await follow('resumed', { start: 'end' })).exit).toBe(0);
  });

  it('passes the watch bounds through: watch.timeout 79 and watch.record_not_created 66', async () => {
    const runId = await prepare('suspended');
    const timedOut = await follow(runId, { start: { afterExecution: 1 }, timeoutMs: 20 });
    expect(timedOut).toMatchObject({ exit: 79, code: 'watch.timeout' });
    expect(await follow('missing', { waitCreatedMs: 20 })).toMatchObject({
      exit: 66,
      code: 'watch.record_not_created',
    });
    // Without --wait-created a missing record fails at once.
    expect(await follow('missing')).toMatchObject({ exit: 3, code: 'run.not_found' });
  });

  it('prints once without following, all or after an execution', async () => {
    const runId = await prepare('suspended');
    const once = await follow(runId, { follow: false });
    expect(brief(once.lines)).toEqual(['run.started', 'wait.opened gate', 'run.suspended']);
    expect((await follow(runId, { follow: false, start: { afterExecution: 1 } })).lines).toEqual(
      [],
    );
    expect(await follow(runId, { follow: false, start: 'end' })).toMatchObject({
      code: 'usage.flag',
    });
  });
});

describe('workflow events command', () => {
  async function capture(argv: string[]): Promise<{ stdout: string; error: unknown }> {
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
      written.push(`${String(message)}\n`);
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let error: unknown;
    try {
      await WorkflowEvents.run(argv, { root: projectRoot });
    } catch (caught) {
      error = caught;
    }
    return { stdout: written.join(''), error };
  }

  it.each([
    [['--follow', '--from-start', '--after-execution', '1'], 'usage.flag'],
    [['--interval', '5ms'], 'usage.flag'],
    [['--follow', '--timeout', '0s'], 'usage.flag'],
    [['--follow', '--wait-created', 'soon'], 'usage.flag'],
    [['--after-execution', '-1'], 'usage.flag'],
  ])('refuses %j with %s', async (flags, code) => {
    const { stdout, error } = await capture(['run', '--state-dir', stateDir, ...flags, '--json']);
    expect(error).toMatchObject({ oclif: { exit: 2 } });
    expect(JSON.parse(stdout.trim().split('\n').at(-1) ?? '')).toMatchObject({
      kind: 'workflow.error',
      error: { code },
    });
  });

  it('prints a run once and exits 0 without --follow, even for a failed run', async () => {
    const runId = await prepare('failed');
    const { stdout, error } = await capture([runId, '--state-dir', stateDir]);
    expect(error).toBeUndefined();
    expect(process.exitCode).toBeUndefined();
    expect(brief(stdout.trim().split('\n'))).toEqual([
      'run.started',
      'step.failed a',
      'run.failed a',
    ]);
  });

  it('reports a missing run as run.not_found and keeps error documents compact', async () => {
    const { stdout, error } = await capture([
      'missing',
      '--state-dir',
      stateDir,
      '--follow',
      '--json',
    ]);
    expect(error).toMatchObject({ oclif: { exit: 3 } });
    const document = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(document).toMatchObject({ kind: 'workflow.error', error: { code: 'run.not_found' } });
    expect(document).not.toHaveProperty('run');
  });
});
