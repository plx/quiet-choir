import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThresholdLogger } from '../src/application/execution.js';
import { WorkflowExecutor } from '../src/workflow/loader/executor.js';
import { TickWorkflowExecutor } from '../src/workflow/loader/tick.js';
import { analyzeTypecheckEntrypoint } from '../src/workflow/typecheck/plan.js';
import type { TickWorkflowsResult } from '../src/workflow/loader/tick.js';
import type { WorkflowFailure } from '../src/workflow/loader/failure.js';
import { FileRunStore, readRun, writeAnswer, type WorkflowClock } from '../src/index.js';
import { countCompletedSteps } from '../src/workflow/runtime/recovery-decision.js';
import { inspectRun } from '../src/workflow/loader/inspection.js';
import { harnessConfigDigest } from '../src/workflow/loader/harness-selection.js';
import type { CliHarnessOptions } from '../src/harnesses/cli.js';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const roots: string[] = [];
const logger = new ThresholdLogger('silent', () => undefined);
const tick = new TickWorkflowExecutor({ logger });
const pastClock: WorkflowClock = {
  now: () => Date.now() - 120_000,
  sleep: (_ms, signal) =>
    new Promise((_resolve, reject) => {
      if (signal.aborted)
        reject(signal.reason instanceof Error ? signal.reason : new Error('Clock cancelled'));
      else
        signal.addEventListener(
          'abort',
          () => {
            reject(signal.reason instanceof Error ? signal.reason : new Error('Clock cancelled'));
          },
          { once: true },
        );
    }),
};

/** Assert a successful tick result that lists each run at most once, and return it. */
function oneEntryPerRun(result: TickWorkflowsResult | WorkflowFailure): TickWorkflowsResult {
  if (!result.ok) throw new Error(`Tick failed: ${result.message}`);
  const ids = [...result.resumed, ...result.skipped].map(({ runId }) => runId);
  expect(new Set(ids).size).toBe(ids.length);
  return result;
}

const byRunId = <T extends { readonly runId: string }>(entries: readonly T[]): T[] =>
  [...entries].sort((a, b) => a.runId.localeCompare(b.runId));

async function fixture(
  kind:
    'due' | 'future' | 'signal' | 'failure' | 'agent' | 'cancel' | 'versioned' | 'gated' = 'due',
  notify: boolean | 'fail' = false,
  shared: {
    readonly stateDir?: string;
    readonly runId?: string;
    /** CLI harness configuration the agent run starts with; the default otherwise. */
    readonly harnessConfig?: CliHarnessOptions;
  } = {},
) {
  const runId = shared.runId ?? 'run';
  const root = await mkdtemp(join(tmpdir(), 'choir-tick-'));
  roots.push(root);
  await symlink(join(project, 'node_modules'), join(root, 'node_modules'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  const file = join(root, 'workflow.ts');
  const imports = join(root, 'imports.txt');
  const effects = join(root, 'effects.txt');
  const agentLog = join(root, 'agent.jsonl');
  const notifications = join(root, 'notifications.jsonl');
  const before = join(root, 'before.txt');
  const gate = join(root, 'gate');
  const notifyCommand =
    notify === 'fail' ? 'exit 7' : `cat >> '${notifications.replaceAll("'", "'\"'\"'")}'`;
  await writeFile(
    file,
    `
import { appendFileSync${kind === 'gated' ? ', existsSync' : ''} } from 'node:fs';
${kind === 'gated' ? "import { setTimeout as delay } from 'node:timers/promises';" : ''}
import { z } from 'zod';
import { defineWorkflow } from ${JSON.stringify(join(project, 'src/workflow/runtime/model.js'))};
${kind === 'cancel' ? `import { CancelledError } from ${JSON.stringify(join(project, 'src/workflow/runtime/fan-out.js'))};` : ''}
appendFileSync(${JSON.stringify(imports)}, 'import\\n');
export default defineWorkflow({ name: 'tick',
  version: ${kind === 'versioned' ? "process.env['QC_TICK_TEST_VERSION'] ?? '1'" : "'1'"}, input: z.null(), output: z.null(),
  ${kind === 'agent' ? 'strictProfiles: false,' : ''}
  run: async (ctx) => {
    ${
      kind === 'signal'
        ? "await ctx.ask('ready', { prompt: 'Ready?', schema: z.boolean() });"
        : "await ctx.sleep('timer', 60_000);"
    }
    ${kind === 'cancel' ? "throw new CancelledError(null, new Error('stop'));" : ''}
    ${
      kind === 'gated'
        ? `await ctx.step('before', { input: null, schema: z.null(), run: () => {
      appendFileSync(${JSON.stringify(before)}, 'before\\n');
      return null;
    } });
    // Honours its abort signal, so an interruption does not wait for the gate.
    await ctx.step('gate', { input: null, schema: z.null(), run: async ({ signal }) => {
      while (!existsSync(${JSON.stringify(gate)})) await delay(20, undefined, { signal });
      return null;
    } });`
        : ''
    }
    ${
      kind === 'agent'
        ? `await ctx.claude.text('call', { prompt: 'hi', env: { QUIET_CHOIR_FAKE_LOG: ${JSON.stringify(agentLog)} } });`
        : ''
    }
    await ctx.step('action', { input: null, schema: z.null(), run: async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
      appendFileSync(${JSON.stringify(effects)}, 'effect\\n');
      ${kind === 'failure' ? "throw new Error('failed action');" : 'return null;'}
    } });
    return null;
  }
});
`,
  );
  const analysis = analyzeTypecheckEntrypoint(file, root);
  if (!analysis.ok) throw new Error(analysis.error.message);
  const stateDir = shared.stateDir ?? join(root, 'state');
  const plan = {
    kind: 'workflow.execute' as const,
    typecheck: analysis.plan,
    runId,
    stateDir,
    cwd: root,
    resume: false,
    input: null,
    ...(notify ? { notifyCommand } : {}),
    ...(kind === 'agent'
      ? { harness: { kind: 'cli' as const, config: shared.harnessConfig ?? {} }, grants: ['exec'] }
      : {}),
  };
  const first = await new WorkflowExecutor({
    logger,
    ...(kind === 'future' || kind === 'signal' ? {} : { clock: pastClock }),
  }).execute(plan);
  expect(first).toMatchObject({
    ok: true,
    kind: 'workflow.run.result',
    run: { status: 'suspended' },
  });
  return {
    root,
    file,
    stateDir,
    imports,
    effects,
    agentLog,
    notifications,
    notifyCommand,
    before,
    gate,
    plan,
    tickPlan: { kind: 'workflow.tick' as const, runId, stateDir },
  };
}

/** Every file under a run directory, by relative path, to prove a tick changed nothing. */
async function runBytes(stateDir: string, runId: string): Promise<Record<string, string>> {
  const root = join(stateDir, runId);
  const files: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else files[relative(root, path)] = await readFile(path, 'utf8');
    }
  };
  await visit(root);
  return files;
}

/** Leave the run's primary lock behind with a local owner whose process has exited. */
async function deadOwnerLock(stateDir: string, runId: string): Promise<string> {
  const exited = spawnSync(process.execPath, ['-e', '']);
  const lock = join(stateDir, runId, 'lock');
  await mkdir(lock);
  await writeFile(
    join(lock, 'owner.json'),
    JSON.stringify({ pid: exited.pid, host: hostname(), token: randomUUID() }),
  );
  return lock;
}

/** Make a suspended fixture look like a run whose owner died mid-execution, without a lock. */
async function crashedWhileRunning(
  stateDir: string,
  runId: string,
  staleRecovery?: (completedSteps: number) => { count: number; completedSteps: number },
): Promise<void> {
  const owned = await new FileRunStore(stateDir).open(runId);
  try {
    const run = await owned.read();
    if (!run) throw new Error('missing run');
    run.status = 'running';
    if (staleRecovery)
      run.staleRecovery = {
        ...staleRecovery(countCompletedSteps(run)),
        at: new Date().toISOString(),
      };
    await owned.append(run, { durable: true });
  } finally {
    await owned.release();
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Each test spawns real tick-loader child processes against temporary fixtures.
// measured: the slowest case takes 1.9 s alone, 5.1-13.4 s in local full coverage runs and 19.5 s on
// the Node 22.13 CI leg (child Node startup and tsImport compiles).
describe('tick loader and operator hooks', { timeout: 40_000 }, () => {
  it('resumes a due timer from its saved entrypoint and skips completed imports', async () => {
    const f = await fixture();
    expect(oneEntryPerRun(await tick.execute(f.tickPlan))).toMatchObject({
      resumed: [{ runId: 'run', outcome: 'completed' }],
      skipped: [],
      observed: 0,
      exitCode: 0,
    });
    const bytes = await readFile(f.imports, 'utf8');
    expect(bytes.split('\n').filter(Boolean)).toHaveLength(2);
    expect(await readFile(f.effects, 'utf8')).toBe('effect\n');
    // --run on an already-completed run reports it only as observed and exits 0.
    expect(oneEntryPerRun(await tick.execute(f.tickPlan))).toEqual({
      kind: 'workflow.tick.result',
      ok: true,
      resumed: [],
      skipped: [],
      observed: 1,
      exitCode: 0,
    });
    expect(await readFile(f.imports, 'utf8')).toBe(bytes);
  });

  it('does not import an undue run and bounds a watch timeout', async () => {
    const f = await fixture('future');
    const saved = await readRun(f.plan);
    const notDue = oneEntryPerRun(await tick.execute(f.tickPlan));
    expect(notDue).toMatchObject({
      resumed: [],
      skipped: [{ runId: 'run', reason: 'not due', nextWakeAt: saved.nextWakeAt }],
      observed: 0,
      exitCode: 75,
    });
    expect(notDue.resumed).toHaveLength(0);
    const start = Date.now();
    expect(
      oneEntryPerRun(await tick.execute({ ...f.tickPlan, watch: true, timeoutMs: 70 })),
    ).toMatchObject({
      resumed: [],
      skipped: [{ runId: 'run', reason: 'not due' }],
      exitCode: 75,
    });
    expect(Date.now() - start).toBeGreaterThanOrEqual(60);
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(await readRun(f.plan)).toEqual(saved);
    expect(await readFile(f.imports, 'utf8')).toBe('import\n');
  });

  // measured: 2.4 s alone; 27 s in a full coverage run on a loaded machine, where the 15 s watch
  // deadline cut the second resume off as an interruption. The watch ends at the first resume, so
  // the larger tick timeout only matters on failure; the test timeout covers it with headroom.
  it(
    'reports changed source without importing or changing the checkpoint',
    { timeout: 90_000 },
    async () => {
      const f = await fixture();
      const saved = await readRun(f.plan);
      await appendFile(f.file, '\n// changed source\n');
      expect(oneEntryPerRun(await tick.execute(f.tickPlan))).toEqual({
        kind: 'workflow.tick.result',
        ok: true,
        resumed: [],
        skipped: [
          {
            runId: 'run',
            reason: 'incompatible',
            message: 'Stored workflow source hashes are missing or changed.',
          },
        ],
        observed: 0,
        exitCode: 1,
      });
      expect(await readRun(f.plan)).toEqual(saved);
      expect(await readFile(f.imports, 'utf8')).toBe('import\n');
      // A refusal before import is not a resume attempt: a watch limited to one resume refuses the
      // changed run, keeps watching, and still resumes a run that becomes due later.
      const watching = tick.execute({
        kind: 'workflow.tick',
        stateDir: f.stateDir,
        maxRuns: 1,
        watch: true,
        timeoutMs: 45_000,
      });
      const other = await fixture('due', false, { stateDir: f.stateDir, runId: 'other' });
      expect(oneEntryPerRun(await watching)).toMatchObject({
        resumed: [{ runId: 'other', outcome: 'completed' }],
        skipped: [{ runId: 'run', reason: 'incompatible' }],
        exitCode: 0,
      });
      expect(await readFile(other.effects, 'utf8')).toBe('effect\n');
    },
  );

  it('skips a locked run and gives concurrent ticks only one importer and effect', async () => {
    const f = await fixture();
    const held = await new FileRunStore(f.stateDir).open('run');
    try {
      expect(oneEntryPerRun(await tick.execute(f.tickPlan))).toEqual({
        kind: 'workflow.tick.result',
        ok: true,
        resumed: [],
        skipped: [{ runId: 'run', reason: 'locked' }],
        observed: 0,
        exitCode: 75,
      });
    } finally {
      await held.release();
    }
    const results = (await Promise.all([tick.execute(f.tickPlan), tick.execute(f.tickPlan)])).map(
      oneEntryPerRun,
    );
    expect(results.reduce((n, result) => n + result.resumed.length, 0)).toBe(1);
    // The loser saw the winner holding the run (75) or found it already completed (0).
    const loser = results.find((result) => result.resumed.length === 0);
    expect([
      { skipped: [{ runId: 'run', reason: 'locked' }], observed: 0, exitCode: 75 },
      { skipped: [], observed: 1, exitCode: 0 },
    ]).toContainEqual({
      skipped: loser?.skipped,
      observed: loser?.observed,
      exitCode: loser?.exitCode,
    });
    expect(await readFile(f.imports, 'utf8')).toBe('import\nimport\n');
    expect(await readFile(f.effects, 'utf8')).toBe('effect\n');
  });

  it('wakes a bounded watcher when an external answer arrives', async () => {
    const f = await fixture('signal');
    const watching = tick.execute({ ...f.tickPlan, watch: true, timeoutMs: 10_000 });
    await delay(50);
    await writeAnswer({ stateDir: f.stateDir, runId: 'run', stepId: 'ready', value: true });
    expect(oneEntryPerRun(await watching)).toMatchObject({
      resumed: [{ runId: 'run', outcome: 'completed' }],
      skipped: [],
      exitCode: 0,
    });
  });

  it('debounces a poll on its previous note across a suspend and a tick', async () => {
    const root = await mkdtemp(join(tmpdir(), 'choir-tick-'));
    roots.push(root);
    await symlink(join(project, 'node_modules'), join(root, 'node_modules'));
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    const file = join(root, 'workflow.ts');
    const status = join(root, 'status.txt');
    const reads = join(root, 'reads.txt');
    await writeFile(status, 'Completed');
    // Each check runs in a fresh import, so only the persisted note can carry the first sighting.
    await writeFile(
      file,
      `
import { appendFileSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { defineWorkflow } from ${JSON.stringify(join(project, 'src/workflow/runtime/model.js'))};
export default defineWorkflow({ name: 'debounce', version: '1', input: z.null(), output: z.unknown(),
  run: (ctx) => ctx.poll('settled', {
    input: null,
    schema: z.literal('Completed'),
    every: 30_000,
    timeoutMs: 3_600_000,
    observe: async ({ previous }) => {
      const state = readFileSync(${JSON.stringify(status)}, 'utf8');
      appendFileSync(${JSON.stringify(reads)}, state + '\\n');
      const seen = z.object({ seenComplete: z.boolean() }).nullable().parse(previous.note);
      if (state !== 'Completed') return { done: false, note: { seenComplete: false } };
      return seen?.seenComplete ? { done: true, value: 'Completed' } : { done: false, note: { seenComplete: true } };
    },
  }),
});
`,
    );
    const analysis = analyzeTypecheckEntrypoint(file, root);
    if (!analysis.ok) throw new Error(analysis.error.message);
    const stateDir = join(root, 'state');
    const first = await new WorkflowExecutor({ logger }).execute({
      kind: 'workflow.execute',
      typecheck: analysis.plan,
      runId: 'run',
      stateDir,
      cwd: root,
      resume: false,
      input: null,
    });
    expect(first).toMatchObject({ ok: true, run: { status: 'suspended' } });
    const futureClock: WorkflowClock = {
      now: () => Date.now() + 120_000,
      sleep: (ms, signal) => pastClock.sleep(ms, signal),
    };
    expect(
      oneEntryPerRun(
        await new TickWorkflowExecutor({ logger, clock: futureClock }).execute({
          kind: 'workflow.tick',
          runId: 'run',
          stateDir,
        }),
      ),
    ).toMatchObject({ resumed: [{ runId: 'run', outcome: 'completed' }], exitCode: 0 });
    const run = await readRun({ stateDir, runId: 'run' });
    expect(run.output).toMatchObject({ by: 'poll', value: 'Completed', checks: 2 });
    expect(await readFile(reads, 'utf8')).toBe('Completed\nCompleted\n');
  });

  it('limits batch resumes and keeps per-run failure separate from command failure', async () => {
    const f = await fixture('failure');
    const executor = new WorkflowExecutor({ logger, clock: pastClock });
    expect(await executor.execute({ ...f.plan, runId: 'second' })).toMatchObject({ ok: true });
    const batch = { kind: 'workflow.tick' as const, stateDir: f.stateDir, maxRuns: 1 };
    const first = oneEntryPerRun(await tick.execute(batch));
    expect(first).toMatchObject({
      resumed: [
        { outcome: 'failed', message: expect.stringContaining('failed action') as unknown },
      ],
      exitCode: 0,
    });
    const [attempted] = first.resumed;
    const untouched = attempted?.runId === 'run' ? 'second' : 'run';
    expect(first.skipped.map(({ runId }) => runId)).not.toContain(untouched);
    expect((await readRun({ stateDir: f.stateDir, runId: untouched })).status).toBe('suspended');
    expect(
      oneEntryPerRun(await tick.execute({ ...f.tickPlan, runId: attempted?.runId ?? 'run' })),
    ).toMatchObject({ resumed: [], skipped: [], observed: 1, exitCode: 1 });
  });

  it('delivers opened/suspended/completed hooks and deduplicates the first signal notification', async () => {
    const f = await fixture('signal', true);
    const types = async () =>
      (await readFile(f.notifications, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => (JSON.parse(line) as { type: string }).type);
    expect(await types()).toEqual(['wait.opened', 'run.suspended']);
    expect(
      await new WorkflowExecutor({ logger }).execute({ ...f.plan, resume: true }),
    ).toMatchObject({ ok: true, run: { status: 'suspended' } });
    expect(await types()).toEqual(['wait.opened', 'run.suspended', 'run.suspended']);
    await writeAnswer({ stateDir: f.stateDir, runId: 'run', stepId: 'ready', value: true });
    expect(await tick.execute({ ...f.tickPlan, notifyCommand: f.notifyCommand })).toMatchObject({
      exitCode: 0,
    });
    expect(await types()).toEqual([
      'wait.opened',
      'run.suspended',
      'run.suspended',
      'run.completed',
    ]);
    const first = JSON.parse(
      (await readFile(f.notifications, 'utf8')).split('\n')[0] ?? '',
    ) as Record<string, unknown>;
    expect(first).toMatchObject({
      runId: 'run',
      stepId: 'ready',
      stateDir: f.stateDir,
      data: { question: { prompt: 'Ready?' } },
    });
  });

  it('emits run.failed and ignores notification-command failures', async () => {
    const f = await fixture('failure', true);
    expect(await tick.execute({ ...f.tickPlan, notifyCommand: f.notifyCommand })).toMatchObject({
      exitCode: 1,
    });
    const types = (await readFile(f.notifications, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { type: string }).type);
    expect(types).toEqual(['run.suspended', 'run.failed']);
    const failing = await fixture('due', 'fail');
    expect(
      await tick.execute({ ...failing.tickPlan, notifyCommand: failing.notifyCommand }),
    ).toMatchObject({ exitCode: 0 });
    expect((await readRun(failing.plan)).status).toBe('completed');
  });

  it('carries a matching --harness-config into the resumed CLI run', async () => {
    const claudeBinary = join(project, 'test/bin/fake-claude.mjs');
    const f = await fixture('agent', false, { harnessConfig: { claudeBinary } });
    const harness = { kind: 'cli' as const, config: { claudeBinary } };
    expect((await readRun(f.plan)).harness?.configDigest).toBe(harnessConfigDigest(harness));
    expect(await tick.execute({ ...f.tickPlan, harness })).toMatchObject({
      ok: true,
      resumed: [{ runId: 'run', outcome: 'completed' }],
      skipped: [],
      exitCode: 0,
    });
    const capture = JSON.parse(await readFile(f.agentLog, 'utf8')) as Record<string, unknown>;
    expect(capture).toMatchObject({ harness: 'claude', scenario: 'claude-text-success' });
  });

  it('refuses a tick under a different --harness-config unless the change is allowed', async () => {
    const claudeBinary = join(project, 'test/bin/fake-claude.mjs');
    const f = await fixture('agent', false, { harnessConfig: { claudeBinary } });
    const bytes = await runBytes(f.stateDir, 'run');
    // No --harness-config means the default configuration, which this run was not started with.
    expect(oneEntryPerRun(await tick.execute(f.tickPlan))).toEqual({
      kind: 'workflow.tick.result',
      ok: true,
      resumed: [
        {
          runId: 'run',
          outcome: 'incompatible',
          message: expect.stringContaining('--allow-harness-config-change') as unknown,
        },
      ],
      skipped: [],
      observed: 0,
      exitCode: 1,
    });
    expect(await runBytes(f.stateDir, 'run')).toEqual(bytes);
    expect((await readRun(f.plan)).status).toBe('suspended');
    await expect(stat(f.agentLog)).rejects.toMatchObject({ code: 'ENOENT' });
    // Another binary path is another configuration, accepted only with the override.
    const other = join(f.root, 'other-claude.mjs');
    await symlink(claudeBinary, other);
    const changed = { kind: 'cli' as const, config: { claudeBinary: other } };
    expect(oneEntryPerRun(await tick.execute({ ...f.tickPlan, harness: changed }))).toMatchObject({
      resumed: [{ runId: 'run', outcome: 'incompatible' }],
      exitCode: 1,
    });
    await expect(stat(f.agentLog)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      oneEntryPerRun(
        await tick.execute({ ...f.tickPlan, harness: changed, allowHarnessConfigChange: true }),
      ),
    ).toMatchObject({ resumed: [{ runId: 'run', outcome: 'completed' }], exitCode: 0 });
    const capture = JSON.parse(await readFile(f.agentLog, 'utf8')) as Record<string, unknown>;
    expect(capture).toMatchObject({ harness: 'claude', scenario: 'claude-text-success' });
    expect((await readRun(f.plan)).harness?.configDigest).toBe(harnessConfigDigest(changed));
  });

  it('ticks a run started with the default configuration without a --harness-config', async () => {
    const f = await fixture('agent');
    expect((await readRun(f.plan)).harness?.configDigest).toBe(harnessConfigDigest());
    // The default configuration finds claude on PATH; point that at the fake binary.
    const bin = join(f.root, 'bin');
    await mkdir(bin);
    await symlink(join(project, 'test/bin/fake-claude.mjs'), join(bin, 'claude'));
    const path = process.env['PATH'];
    process.env['PATH'] = `${bin}:${path ?? ''}`;
    try {
      expect(oneEntryPerRun(await tick.execute(f.tickPlan))).toMatchObject({
        resumed: [{ runId: 'run', outcome: 'completed' }],
        exitCode: 0,
      });
    } finally {
      if (path === undefined) delete process.env['PATH'];
      else process.env['PATH'] = path;
    }
    const capture = JSON.parse(await readFile(f.agentLog, 'utf8')) as Record<string, unknown>;
    expect(capture).toMatchObject({ harness: 'claude', scenario: 'claude-text-success' });
  });

  it('uses the injected clock, not the system clock, to judge readiness', async () => {
    const futureByRealClock = await fixture('future');
    const futureClock: WorkflowClock = {
      now: () => Date.now() + 120_000,
      sleep: (ms, signal) => pastClock.sleep(ms, signal),
    };
    expect(
      await new TickWorkflowExecutor({ logger, clock: futureClock }).execute(
        futureByRealClock.tickPlan,
      ),
    ).toMatchObject({
      ok: true,
      resumed: [{ runId: 'run', outcome: 'completed' }],
      skipped: [],
      exitCode: 0,
    });

    const dueByRealClock = await fixture('due');
    const farPastClock: WorkflowClock = {
      now: () => Date.now() - 200_000,
      sleep: (ms, signal) => pastClock.sleep(ms, signal),
    };
    expect(
      await new TickWorkflowExecutor({ logger, clock: farPastClock }).execute(
        dueByRealClock.tickPlan,
      ),
    ).toMatchObject({
      ok: true,
      resumed: [],
      skipped: [{ runId: 'run', reason: 'not due' }],
      exitCode: 75,
    });
  });

  it('reports each run once: resumed outcomes, then only observed terminal runs', async () => {
    const done = await fixture('due', false, { runId: 'done' });
    const { stateDir } = done;
    await fixture('failure', false, { stateDir, runId: 'broken' });
    await fixture('cancel', false, { stateDir, runId: 'stopped' });
    await fixture('future', false, { stateDir, runId: 'later' });
    const batch = { kind: 'workflow.tick' as const, stateDir };
    const first = oneEntryPerRun(await tick.execute(batch));
    expect(byRunId(first.resumed)).toEqual([
      {
        runId: 'broken',
        outcome: 'failed',
        message: expect.stringContaining('failed action') as unknown,
      },
      { runId: 'done', outcome: 'completed' },
      { runId: 'stopped', outcome: 'cancelled', message: expect.any(String) as unknown },
    ]);
    expect(first).toMatchObject({
      skipped: [{ runId: 'later', reason: 'not due', nextWakeAt: expect.any(Number) as unknown }],
      observed: 0,
      exitCode: 0,
    });
    expect((await readRun({ stateDir, runId: 'stopped' })).status).toBe('cancelled');
    expect(oneEntryPerRun(await tick.execute(batch))).toEqual({
      kind: 'workflow.tick.result',
      ok: true,
      resumed: [],
      skipped: [{ runId: 'later', reason: 'not due', nextWakeAt: expect.any(Number) as unknown }],
      observed: 3,
      exitCode: 0,
    });
  });

  it('reports a resume refused after import as one incompatible outcome', async () => {
    const f = await fixture('versioned');
    const saved = await readRun(f.plan);
    const previous = process.env['QC_TICK_TEST_VERSION'];
    process.env['QC_TICK_TEST_VERSION'] = '2';
    try {
      expect(oneEntryPerRun(await tick.execute(f.tickPlan))).toEqual({
        kind: 'workflow.tick.result',
        ok: true,
        resumed: [
          {
            runId: 'run',
            outcome: 'incompatible',
            message: expect.stringMatching(/^Workflow version changed;/u) as unknown,
          },
        ],
        skipped: [],
        observed: 0,
        exitCode: 1,
      });
    } finally {
      if (previous === undefined) delete process.env['QC_TICK_TEST_VERSION'];
      else process.env['QC_TICK_TEST_VERSION'] = previous;
    }
    expect((await readRun(f.plan)).status).toBe('suspended');
    expect((await readRun(f.plan)).steps).toEqual(saved.steps);
  });

  it('reports a cancelled resume as cancelled and exits 1 for it with --run', async () => {
    const f = await fixture('cancel');
    expect(oneEntryPerRun(await tick.execute(f.tickPlan))).toEqual({
      kind: 'workflow.tick.result',
      ok: true,
      resumed: [{ runId: 'run', outcome: 'cancelled', message: expect.any(String) as unknown }],
      skipped: [],
      observed: 0,
      exitCode: 1,
    });
    expect(oneEntryPerRun(await tick.execute(f.tickPlan))).toMatchObject({
      resumed: [],
      skipped: [],
      observed: 1,
      exitCode: 1,
    });
  });

  it('reports a missing --run target as unreadable', async () => {
    const f = await fixture();
    expect(oneEntryPerRun(await tick.execute({ ...f.tickPlan, runId: 'absent' }))).toEqual({
      kind: 'workflow.tick.result',
      ok: true,
      resumed: [],
      skipped: [{ runId: 'absent', reason: 'unreadable', message: expect.any(String) as unknown }],
      observed: 0,
      exitCode: 1,
    });
  });
  it('resumes a due suspended run behind a dead owner lock without counting a stale recovery', async () => {
    const f = await fixture();
    await deadOwnerLock(f.stateDir, 'run');
    expect(oneEntryPerRun(await tick.execute(f.tickPlan))).toEqual({
      kind: 'workflow.tick.result',
      ok: true,
      resumed: [{ runId: 'run', outcome: 'completed' }],
      skipped: [],
      observed: 0,
      exitCode: 0,
    });
    expect(await readFile(f.effects, 'utf8')).toBe('effect\n');
    const saved = await readRun(f.plan);
    expect(saved.status).toBe('completed');
    expect(saved.staleRecovery).toBeUndefined();
    await expect(stat(join(f.stateDir, 'run', 'lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('skips orphans behind a dead owner without importing or changing the run', async () => {
    const f = await fixture();
    const lock = await deadOwnerLock(f.stateDir, 'run');
    await mkdir(join(lock, 'processes'));
    await writeFile(join(lock, 'processes', 'x.json'), '{not json');
    const before = await runBytes(f.stateDir, 'run');
    const result = oneEntryPerRun(await tick.execute(f.tickPlan));
    expect(result).toEqual({
      kind: 'workflow.tick.result',
      ok: true,
      resumed: [],
      skipped: [
        {
          runId: 'run',
          reason: 'orphans',
          message: expect.stringContaining('live or unverified harness processes') as unknown,
        },
      ],
      observed: 0,
      exitCode: 75,
    });
    expect(await runBytes(f.stateDir, 'run')).toEqual(before);
    expect(before['lock/processes/x.json']).toBe('{not json');
    expect(await readFile(f.imports, 'utf8')).toBe('import\n');
    expect((await readRun(f.plan)).status).toBe('suspended');
  });

  it('resumes a run whose recoverer died, reclaiming its recovery marker', async () => {
    const f = await fixture();
    const lock = await deadOwnerLock(f.stateDir, 'run');
    const exited = spawnSync(process.execPath, ['-e', '']);
    await writeFile(
      join(lock, 'recovery.json'),
      JSON.stringify({ pid: exited.pid, host: hostname(), token: randomUUID() }),
    );
    expect(oneEntryPerRun(await tick.execute(f.tickPlan))).toMatchObject({
      resumed: [{ runId: 'run', outcome: 'completed' }],
      skipped: [],
      exitCode: 0,
    });
    expect((await readRun(f.plan)).status).toBe('completed');
    await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('skips a run as locked while a recoverer lives or the guard lock is held', async () => {
    const f = await fixture();
    const lock = await deadOwnerLock(f.stateDir, 'run');
    const live = JSON.stringify({ pid: process.pid, host: hostname(), token: randomUUID() });
    await writeFile(join(lock, 'recovery.json'), live);
    const before = await runBytes(f.stateDir, 'run');
    const locked = {
      resumed: [],
      skipped: [{ runId: 'run', reason: 'locked' }],
    };
    expect(oneEntryPerRun(await tick.execute(f.tickPlan))).toMatchObject(locked);
    expect(await runBytes(f.stateDir, 'run')).toEqual(before);

    // A dead primary owner does not make the run reclaimable while the guard's owner lives.
    await rm(join(lock, 'recovery.json'));
    const guard = join(f.stateDir, 'run.json.lock');
    await mkdir(guard);
    await writeFile(join(guard, 'owner.json'), live);
    const beforeGuard = await runBytes(f.stateDir, 'run');
    expect(oneEntryPerRun(await tick.execute(f.tickPlan))).toMatchObject(locked);
    expect(await runBytes(f.stateDir, 'run')).toEqual(beforeGuard);
    expect(await readFile(join(guard, 'owner.json'), 'utf8')).toBe(live);
    expect(await readFile(f.imports, 'utf8')).toBe('import\n');
    expect((await readRun(f.plan)).status).toBe('suspended');
  });

  it('recovers a running run whose owner is gone and clears the counter on completion', async () => {
    const f = await fixture();
    await crashedWhileRunning(f.stateDir, 'run');
    expect(oneEntryPerRun(await tick.execute(f.tickPlan))).toEqual({
      kind: 'workflow.tick.result',
      ok: true,
      resumed: [{ runId: 'run', outcome: 'completed' }],
      skipped: [],
      observed: 0,
      exitCode: 0,
    });
    expect(await readFile(f.effects, 'utf8')).toBe('effect\n');
    const saved = await readRun(f.plan);
    expect(saved.status).toBe('completed');
    expect(saved.staleRecovery).toBeUndefined();

    // A failed resume keeps the durable count that tick saved before handing over the run.
    const failing = await fixture('failure');
    await crashedWhileRunning(failing.stateDir, 'run');
    const baseline = countCompletedSteps(await readRun(failing.plan));
    expect(oneEntryPerRun(await tick.execute(failing.tickPlan))).toMatchObject({
      resumed: [{ runId: 'run', outcome: 'failed' }],
      exitCode: 1,
    });
    expect((await readRun(failing.plan)).staleRecovery).toEqual({
      count: 1,
      completedSteps: baseline,
      at: expect.any(String) as unknown,
    });
  });

  it('stops at the crash-loop cap without writing, but resumes after progress', async () => {
    const f = await fixture();
    await crashedWhileRunning(f.stateDir, 'run', (completedSteps) => ({
      count: 3,
      completedSteps,
    }));
    const before = await runBytes(f.stateDir, 'run');
    expect(oneEntryPerRun(await tick.execute(f.tickPlan))).toEqual({
      kind: 'workflow.tick.result',
      ok: true,
      resumed: [],
      skipped: [
        {
          runId: 'run',
          reason: 'crash-loop',
          message: expect.stringMatching(
            /recovered 3 times .*cap 3\).*'quiet-choir workflow resume run'/u,
          ) as unknown,
        },
      ],
      observed: 0,
      exitCode: 1,
    });
    expect(await runBytes(f.stateDir, 'run')).toEqual(before);
    expect(await readFile(f.imports, 'utf8')).toBe('import\n');

    // A baseline other than the current completed-step count means a step completed since.
    const progressed = await fixture();
    await crashedWhileRunning(progressed.stateDir, 'run', (completedSteps) => ({
      count: 3,
      completedSteps: completedSteps + 1,
    }));
    expect(oneEntryPerRun(await tick.execute(progressed.tickPlan))).toMatchObject({
      resumed: [{ runId: 'run', outcome: 'completed' }],
      exitCode: 0,
    });
    expect((await readRun(progressed.plan)).staleRecovery).toBeUndefined();
  });
});

/** Shift Date.now by `offsetMs` after its first call, which is the tick's deadline computation. */
function jumpAfterDeadline(offsetMs: number): () => void {
  const real = Date.now.bind(Date);
  let calls = 0;
  const spy = vi
    .spyOn(Date, 'now')
    .mockImplementation(() => real() + (calls++ === 0 ? 0 : offsetMs));
  return () => {
    spy.mockRestore();
  };
}

// Issue #199: tick's deadline interrupts into a resumable suspension, and a margin stops claims.
// measured: 6.7 s alone for the timeout case (a fixed 6 s tick timeout, sized for a slow import on
// a loaded CI leg, plus tsImport compiles) and 2.3 s for the margin case; the loader suite's 40 s
// raise covers the compile-heavy tail.
describe('tick deadline interruption and claim margin', { timeout: 40_000 }, () => {
  it('suspends a run interrupted by the tick timeout and completes it on the next tick', async () => {
    const f = await fixture('gated');
    // The timeout must leave room to import the workflow and complete `before` on a loaded runner.
    const first = oneEntryPerRun(
      await tick.execute({ ...f.tickPlan, timeoutMs: 6_000, claimMarginMs: 0 }),
    );
    expect(first).toEqual({
      kind: 'workflow.tick.result',
      ok: true,
      resumed: [
        {
          runId: 'run',
          outcome: 'suspended',
          nextWakeAt: expect.any(Number) as unknown,
          message: 'Tick timeout reached.',
        },
      ],
      skipped: [],
      observed: 0,
      exitCode: 75,
    });
    expect(first.resumed[0]?.nextWakeAt).toBeLessThanOrEqual(Date.now());
    const saved = await readRun(f.plan);
    expect(saved).toMatchObject({
      status: 'suspended',
      interruptedBy: { reason: 'Tick timeout reached.' },
      error: null,
      rootCause: null,
      steps: { before: { status: 'completed' }, gate: { status: 'cancelled' } },
    });
    const inspection = await inspectRun({ stateDir: f.stateDir, runId: 'run' });
    expect(inspection.summary).toMatchObject({
      status: 'suspended',
      interruptedBy: { reason: 'Tick timeout reached.' },
    });
    await writeFile(f.gate, '');
    expect(oneEntryPerRun(await tick.execute(f.tickPlan))).toMatchObject({
      resumed: [{ runId: 'run', outcome: 'completed' }],
      exitCode: 0,
    });
    const completed = await readRun(f.plan);
    expect(completed.status).toBe('completed');
    expect(completed.interruptedBy).toBeUndefined();
    expect(await readFile(f.before, 'utf8')).toBe('before\n');
    expect(await readFile(f.effects, 'utf8')).toBe('effect\n');
  });

  it('stops claiming inside the margin and reports the rest as skipped for the deadline', async () => {
    const gated = await fixture('gated', false, { runId: 'a' });
    const { stateDir } = gated;
    const waiting = await fixture('due', false, { stateDir, runId: 'b' });
    const before = await runBytes(stateDir, 'b');
    // The margin starts 1 s in; run a is claimed at once and held open well past that.
    const started = Date.now();
    const ticking = tick.execute({
      kind: 'workflow.tick',
      stateDir,
      timeoutMs: 10_000,
      claimMarginMs: 9_000,
    });
    await delay(1_500);
    await writeFile(gated.gate, '');
    const result = oneEntryPerRun(await ticking);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_500);
    expect(result).toEqual({
      kind: 'workflow.tick.result',
      ok: true,
      resumed: [{ runId: 'a', outcome: 'completed' }],
      skipped: [{ runId: 'b', reason: 'deadline', nextWakeAt: expect.any(Number) as unknown }],
      observed: 0,
      exitCode: 0,
    });
    expect(await runBytes(stateDir, 'b')).toEqual(before);
    expect(await readFile(waiting.imports, 'utf8')).toBe('import\n');

    // With --run, a run skipped for the deadline is still pending.
    const restore = jumpAfterDeadline(5_000);
    let single: TickWorkflowsResult | WorkflowFailure;
    try {
      single = await tick.execute({ ...waiting.tickPlan, timeoutMs: 10_000, claimMarginMs: 6_000 });
    } finally {
      restore();
    }
    expect(oneEntryPerRun(single)).toMatchObject({
      resumed: [],
      skipped: [{ runId: 'b', reason: 'deadline' }],
      exitCode: 75,
    });
    expect(await runBytes(stateDir, 'b')).toEqual(before);
    expect(await readFile(waiting.imports, 'utf8')).toBe('import\n');
  });

  it('defaults the margin to 10% of the timeout, and 0 disables it', async () => {
    const f = await fixture();
    const before = await runBytes(f.stateDir, 'run');
    // 500 ms left of a 10 s timeout is inside the default 1 s margin.
    let restore = jumpAfterDeadline(9_500);
    let skipped: TickWorkflowsResult | WorkflowFailure;
    try {
      skipped = await tick.execute({ ...f.tickPlan, timeoutMs: 10_000 });
    } finally {
      restore();
    }
    expect(oneEntryPerRun(skipped)).toMatchObject({
      skipped: [{ runId: 'run', reason: 'deadline' }],
      exitCode: 75,
    });
    expect(await runBytes(f.stateDir, 'run')).toEqual(before);
    // The same 500 ms is enough with the margin disabled.
    restore = jumpAfterDeadline(9_500);
    let resumed: TickWorkflowsResult | WorkflowFailure;
    try {
      resumed = await tick.execute({ ...f.tickPlan, timeoutMs: 10_000, claimMarginMs: 0 });
    } finally {
      restore();
    }
    expect(oneEntryPerRun(resumed)).toMatchObject({
      resumed: [{ runId: 'run', outcome: 'completed' }],
      exitCode: 0,
    });
  });

  it('counts a fired deadline as inside the margin even when the clock is still behind it', async () => {
    const f = await fixture();
    const before = await runBytes(f.stateDir, 'run');
    // Fire the tick's deadline timer at once while Date.now stays at the start, so the margin
    // arithmetic alone (0 ms margin) would still allow a claim.
    const frozen = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(frozen);
    const realSetTimeout = globalThis.setTimeout;
    const timers = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((handler: () => void, ms?: number) => {
        if (ms !== 10_000) return realSetTimeout(handler, ms);
        handler();
        return realSetTimeout(() => undefined, 0);
      });
    let result: TickWorkflowsResult | WorkflowFailure;
    try {
      result = await tick.execute({ ...f.tickPlan, timeoutMs: 10_000, claimMarginMs: 0 });
    } finally {
      timers.mockRestore();
      now.mockRestore();
    }
    expect(oneEntryPerRun(result)).toMatchObject({
      resumed: [],
      skipped: [{ runId: 'run', reason: 'deadline' }],
      exitCode: 75,
    });
    expect(await runBytes(f.stateDir, 'run')).toEqual(before);
  });

  it.each([
    [{ timeoutMs: 1_000, claimMarginMs: 1_000 }],
    [{ timeoutMs: 1_000, claimMarginMs: 5_000 }],
    [{ timeoutMs: 1_000, claimMarginMs: -1 }],
    [{ timeoutMs: 1_000, claimMarginMs: 0.5 }],
  ])('refuses an invalid claim margin %j', async (limits) => {
    const stateDir = await mkdtemp(join(tmpdir(), 'choir-tick-'));
    roots.push(stateDir);
    expect(await tick.execute({ kind: 'workflow.tick', stateDir, ...limits })).toMatchObject({
      ok: false,
      code: 'usage.flag',
    });
  });
});
