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
import { resumeOutcome, TickWorkflowExecutor } from '../src/workflow/loader/tick.js';
import { workflowFailure } from '../src/workflow/loader/failure.js';
import { analyzeTypecheckEntrypoint } from '../src/workflow/typecheck/plan.js';
import { TypecheckProgramCache } from '../src/workflow/typecheck/program-cache.js';
import type { TickWorkflowsResult } from '../src/workflow/loader/tick.js';
import type { WorkflowFailure } from '../src/workflow/loader/failure.js';
import type { RunRecord } from '../src/workflow/runtime/store.js';
import {
  FileRunStore,
  OrphanProcessesError,
  readRun,
  writeAnswer,
  type LaunchPolicy,
  type WorkflowClock,
} from '../src/index.js';
import { countCompletedSteps } from '../src/workflow/runtime/recovery-decision.js';
import { inspectRun } from '../src/workflow/loader/inspection.js';
import {
  harnessConfigDigest,
  readHarnessSelection,
} from '../src/workflow/loader/harness-selection.js';
import type { CliHarnessOptions } from '../src/harnesses/cli.js';
import { FixtureHarness, parseHarnessFixtures } from '../src/harnesses/fixture.js';
import type { Harness } from '../src/workflow/runtime/model.js';
import * as store from '../src/workflow/runtime/store.js';
import * as inbox from '../src/workflow/runtime/inbox.js';
import * as requiredRun from '../src/workflow/runtime/read-required-run.js';

// Spy through to the real implementations, so the deadline tests can count (or slow) tick's
// per-run reads and checks; every other test sees the actual behaviour.
vi.mock('../src/workflow/runtime/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof store>();
  return { ...actual, inspectRunOwnership: vi.fn(actual.inspectRunOwnership) };
});
vi.mock('../src/workflow/runtime/inbox.js', async (importOriginal) => {
  const actual = await importOriginal<typeof inbox>();
  return { ...actual, questionCodeChanged: vi.fn(actual.questionCodeChanged) };
});
vi.mock('../src/workflow/runtime/read-required-run.js', async (importOriginal) => {
  const actual = await importOriginal<typeof requiredRun>();
  return { ...actual, readRequiredRun: vi.fn(actual.readRequiredRun) };
});
const actualStore = await vi.importActual<typeof store>('../src/workflow/runtime/store.js');
const actualInbox = await vi.importActual<typeof inbox>('../src/workflow/runtime/inbox.js');
const actualRequiredRun = await vi.importActual<typeof requiredRun>(
  '../src/workflow/runtime/read-required-run.js',
);
const ownershipSpy = vi.mocked(store.inspectRunOwnership);
const sourcesSpy = vi.mocked(inbox.questionCodeChanged);
const readSpy = vi.mocked(requiredRun.readRequiredRun);

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
    | 'due'
    | 'future'
    | 'signal'
    | 'failure'
    | 'agent'
    | 'cancel'
    | 'versioned'
    | 'gated'
    | 'twice' = 'due',
  notify: boolean | 'fail' = false,
  shared: {
    readonly stateDir?: string;
    readonly runId?: string;
    /** CLI harness configuration the agent run starts with; the default otherwise. */
    readonly harnessConfig?: CliHarnessOptions;
    /** Start the agent run with `--harness fixture:f.json`, whose rule answers its call. */
    readonly fixtureHarness?: boolean;
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
    ${kind === 'twice' ? "await ctx.sleep('again', 60_000);" : ''}
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
      ? {
          harness: shared.fixtureHarness
            ? await fixtureSelection(root, 'f.json', 'from f')
            : { kind: 'cli' as const, config: shared.harnessConfig ?? {} },
          grants: ['exec'],
        }
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

/** Write a fixture file answering the agent call and read it the way `--harness` does. */
async function fixtureSelection(root: string, name: string, text: string) {
  await writeFile(
    join(root, name),
    JSON.stringify({ version: 1, calls: [{ step: 'call', text }] }),
  );
  return readHarnessSelection(`fixture:${name}`, undefined, root);
}

/** Change a saved run's recorded launch policy (or drop it, as an older build left it). */
async function editPolicy(
  stateDir: string,
  runId: string,
  edit: (policy: LaunchPolicy) => LaunchPolicy | undefined,
): Promise<void> {
  const owned = await new FileRunStore(stateDir).open(runId);
  try {
    const run = await owned.read();
    if (!run?.launch?.policy) throw new Error('missing launch policy');
    const { policy, ...launch } = run.launch;
    const next = edit(policy);
    run.launch = next === undefined ? launch : { ...launch, policy: next };
    await owned.append(run, { durable: true });
  } finally {
    await owned.release();
  }
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
  ownershipSpy.mockReset().mockImplementation(actualStore.inspectRunOwnership);
  sourcesSpy.mockReset().mockImplementation(actualInbox.questionCodeChanged);
  readSpy.mockReset().mockImplementation(actualRequiredRun.readRequiredRun);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Issue #206: an interruption is classified by the status the run was actually saved with.
describe('resumeOutcome', () => {
  const failure = (
    code: 'workflow.interrupted' | 'workflow.failed' | 'run.incompatible',
    status: string | null,
  ): WorkflowFailure =>
    workflowFailure(code, 'Tick timeout reached.', {
      runId: 'run',
      run: status === null ? null : ({ id: 'run', status, nextWakeAt: 5 } as unknown as RunRecord),
    });

  it.each([
    [
      'interrupted while saved suspended',
      failure('workflow.interrupted', 'suspended'),
      { outcome: 'suspended', nextWakeAt: 5, message: 'Tick timeout reached.' },
    ],
    [
      'interrupted while saved running',
      failure('workflow.interrupted', 'running'),
      {
        outcome: 'interrupted',
        message: expect.stringContaining('recovers it as stale') as unknown,
      },
    ],
    [
      'interrupted while saved cancelled',
      failure('workflow.interrupted', 'cancelled'),
      { outcome: 'cancelled', message: 'Tick timeout reached.' },
    ],
    [
      'interrupted with an unreadable record',
      failure('workflow.interrupted', null),
      { outcome: 'failed', message: 'Tick timeout reached.' },
    ],
    [
      'failed while saved cancelled',
      failure('workflow.failed', 'cancelled'),
      { outcome: 'cancelled', message: 'Tick timeout reached.' },
    ],
    [
      'incompatible',
      failure('run.incompatible', 'suspended'),
      { outcome: 'incompatible', message: 'Tick timeout reached.' },
    ],
  ])('maps %s', (_name, result, expected) => {
    const entry = resumeOutcome('run', result);
    expect(entry).toMatchObject({ runId: 'run', ...expected });
    if (entry.outcome !== 'suspended') expect(entry).not.toHaveProperty('nextWakeAt');
  });

  it('keeps the original message in an interrupted outcome', () => {
    expect(resumeOutcome('run', failure('workflow.interrupted', 'running')).message).toContain(
      'Tick timeout reached.',
    );
  });
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

  it('debounces a command poll in done on its previous note across a suspend and a tick', async () => {
    const root = await mkdtemp(join(tmpdir(), 'choir-tick-'));
    roots.push(root);
    await symlink(join(project, 'node_modules'), join(root, 'node_modules'));
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    const file = join(root, 'workflow.ts');
    const status = join(root, 'status.txt');
    const reads = join(root, 'reads.txt');
    await writeFile(status, 'Completed');
    // The command reports the status; done keeps the first sighting in the note, since each check
    // runs in a fresh import.
    const script = `const fs = require('node:fs'); const state = fs.readFileSync(${JSON.stringify(status)}, 'utf8'); fs.appendFileSync(${JSON.stringify(reads)}, state + '\\n'); process.stdout.write(JSON.stringify({ state }));`;
    await writeFile(
      file,
      `
import { z } from 'zod';
import { defineWorkflow } from ${JSON.stringify(join(project, 'src/workflow/runtime/model.js'))};
export default defineWorkflow({ name: 'debounce', version: '1', input: z.null(), output: z.unknown(),
  run: (ctx) => ctx.poll('settled', {
    input: null,
    schema: z.literal('Completed'),
    every: 30_000,
    timeoutMs: 3_600_000,
    command: [process.execPath, '-e', ${JSON.stringify(script)}],
    output: z.object({ state: z.string() }),
    done: ({ state }, previous) => {
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
    if (!first.ok) throw new Error(JSON.stringify(first));
    expect(first).toMatchObject({ ok: true, run: { status: 'suspended' } });
    expect((await readRun({ stateDir, runId: 'run' })).steps['settled']?.wait).toMatchObject({
      checks: 1,
      note: { seenComplete: true },
    });
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
    // Created last but first in ascending run-ID order, so the file system's listing order and
    // creation order both disagree with the order tick must follow.
    expect(await executor.execute({ ...f.plan, runId: 'early' })).toMatchObject({ ok: true });
    const batch = { kind: 'workflow.tick' as const, stateDir: f.stateDir, maxRuns: 1 };
    const first = oneEntryPerRun(await tick.execute(batch));
    expect(first).toMatchObject({
      resumed: [
        {
          runId: 'early',
          outcome: 'failed',
          message: expect.stringContaining('failed action') as unknown,
        },
      ],
      skipped: [],
      exitCode: 0,
    });
    for (const runId of ['run', 'second'])
      expect((await readRun({ stateDir: f.stateDir, runId })).status).toBe('suspended');
    // The failed run is observed as terminal and does not use up the budget: the next run in
    // ascending order is resumed.
    const second = oneEntryPerRun(await tick.execute(batch));
    expect(second).toMatchObject({
      resumed: [{ runId: 'run', outcome: 'failed' }],
      skipped: [],
    });
    expect((await readRun({ stateDir: f.stateDir, runId: 'second' })).status).toBe('suspended');
    expect(oneEntryPerRun(await tick.execute({ ...f.tickPlan, runId: 'early' }))).toMatchObject({
      resumed: [],
      skipped: [],
      observed: 1,
      exitCode: 1,
    });
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
    // Tick predicts the runtime's refusal and skips the run before importing it.
    expect(oneEntryPerRun(await tick.execute(f.tickPlan))).toEqual({
      kind: 'workflow.tick.result',
      ok: true,
      resumed: [],
      skipped: [
        {
          runId: 'run',
          reason: 'incompatible',
          message: expect.stringMatching(
            /different harness configuration .*Repeat the original --harness-config, or pass --allow-harness-config-change/u,
          ) as unknown,
        },
      ],
      observed: 0,
      exitCode: 1,
    });
    expect(await runBytes(f.stateDir, 'run')).toEqual(bytes);
    expect((await readRun(f.plan)).status).toBe('suspended');
    await expect(stat(f.agentLog)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(f.imports, 'utf8')).toBe('import\n');
    // Another binary path is another configuration, accepted only with the override.
    const other = join(f.root, 'other-claude.mjs');
    await symlink(claudeBinary, other);
    const changed = { kind: 'cli' as const, config: { claudeBinary: other } };
    expect(oneEntryPerRun(await tick.execute({ ...f.tickPlan, harness: changed }))).toMatchObject({
      resumed: [],
      skipped: [
        {
          runId: 'run',
          reason: 'incompatible',
          message: expect.stringContaining('--allow-harness-config-change') as unknown,
        },
      ],
      exitCode: 1,
    });
    expect(await runBytes(f.stateDir, 'run')).toEqual(bytes);
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

  it('ticks a fixture-harness run with its recorded fixture, and an explicit harness overrides', async () => {
    const f = await fixture('agent', false, { fixtureHarness: true });
    const recorded = (await readRun(f.plan)).launch?.policy;
    expect(recorded?.harness).toMatchObject({
      kind: 'fixture',
      fixtures: [{ path: join(f.root, 'f.json') }],
    });
    // An explicit cli selection applies as given, so the fixture run needs a harness change.
    expect(
      oneEntryPerRun(
        await tick.execute({
          ...f.tickPlan,
          harness: { kind: 'cli', config: {} },
          inheritHarness: false,
        }),
      ),
    ).toMatchObject({
      resumed: [
        {
          runId: 'run',
          outcome: 'incompatible',
          message: expect.stringContaining('fixture') as unknown,
        },
      ],
      skipped: [],
      exitCode: 1,
    });
    // No harness: the recorded fixture answers the call, and the run appears once, as completed.
    expect(oneEntryPerRun(await tick.execute(f.tickPlan))).toEqual({
      kind: 'workflow.tick.result',
      ok: true,
      resumed: [{ runId: 'run', outcome: 'completed' }],
      skipped: [],
      observed: 0,
      exitCode: 0,
    });
    const saved = await readRun(f.plan);
    expect(saved.harness?.kind).toBe('fixture');
    expect(saved.steps['call']?.status).toBe('completed');
    expect(saved.launch?.policy).toEqual(recorded);
    await expect(stat(f.agentLog)).rejects.toMatchObject({ code: 'ENOENT' });

    // An explicit fixture replaces the recorded one.
    const g = await fixture('agent', false, { fixtureHarness: true, runId: 'other' });
    expect(
      oneEntryPerRun(
        await tick.execute({
          ...g.tickPlan,
          harness: await fixtureSelection(g.root, 'g.json', 'from g'),
          inheritHarness: false,
        }),
      ),
    ).toMatchObject({ resumed: [{ runId: 'other', outcome: 'completed' }], exitCode: 0 });
    expect((await readRun(g.plan)).launch?.policy?.harness.fixtures).toEqual([
      { path: join(g.root, 'g.json'), sha256: expect.any(String) as unknown },
    ]);
  });

  it('suspends a block-mode run for this tick only, keeping block on record', async () => {
    const f = await fixture('twice');
    await editPolicy(f.stateDir, 'run', (policy) => ({ ...policy, waitMode: 'block' }));
    expect(oneEntryPerRun(await tick.execute(f.tickPlan))).toMatchObject({
      resumed: [{ runId: 'run', outcome: 'suspended', nextWakeAt: expect.any(Number) as unknown }],
      exitCode: 75,
    });
    const saved = await readRun(f.plan);
    expect(saved.steps['timer']?.status).toBe('completed');
    expect(saved.steps['again']?.status).toBe('waiting');
    expect(saved.launch?.policy?.waitMode).toBe('block');
  });

  it('keeps the older rule for runs without a recorded policy', async () => {
    // A fixture run: no harness is forwarded, so the default cli selection needs a harness change.
    const fixtureRun = await fixture('agent', false, { fixtureHarness: true });
    await editPolicy(fixtureRun.stateDir, 'run', () => undefined);
    expect(oneEntryPerRun(await tick.execute(fixtureRun.tickPlan))).toMatchObject({
      resumed: [{ runId: 'run', outcome: 'incompatible' }],
      exitCode: 1,
    });
    // A CLI run receives the tick's configuration.
    const claudeBinary = join(project, 'test/bin/fake-claude.mjs');
    const cliRun = await fixture('agent', false, { harnessConfig: { claudeBinary } });
    await editPolicy(cliRun.stateDir, 'run', () => undefined);
    const harness = { kind: 'cli' as const, config: { claudeBinary } };
    expect(
      oneEntryPerRun(await tick.execute({ ...cliRun.tickPlan, harness, inheritHarness: true })),
    ).toMatchObject({ resumed: [{ runId: 'run', outcome: 'completed' }], exitCode: 0 });
    expect((await readRun(cliRun.plan)).launch?.policy).toEqual({
      harness: { kind: 'cli' },
      waitMode: 'suspend',
    });
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
    const message = result.skipped[0]?.message ?? '';
    expect(message).toContain(`workflow resume run --state-dir ${f.stateDir} --kill-orphans`);
    expect(message).toContain('Tick never signals a process');
    expect(message).not.toContain('Stop confirmed processes with --kill-orphans');
    expect(await runBytes(f.stateDir, 'run')).toEqual(before);
    expect(before['lock/processes/x.json']).toBe('{not json');
    expect(await readFile(f.imports, 'utf8')).toBe('import\n');
    expect((await readRun(f.plan)).status).toBe('suspended');
  });

  it('shell-quotes the state directory in the orphans recovery command', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'choir-tick-'));
    roots.push(parent);
    const stateDir = join(parent, 'state dir');
    const f = await fixture('due', false, { stateDir });
    const lock = await deadOwnerLock(f.stateDir, 'run');
    await mkdir(join(lock, 'processes'));
    await writeFile(join(lock, 'processes', 'x.json'), '{not json');
    const result = oneEntryPerRun(await tick.execute(f.tickPlan));
    const message = result.skipped[0]?.message ?? '';
    expect(message).toContain(`workflow resume run --state-dir '${stateDir}' --kill-orphans.`);
  });

  it('starts the orphans recovery command with the detected command launcher', async () => {
    const f = await fixture();
    const lock = await deadOwnerLock(f.stateDir, 'run');
    await mkdir(join(lock, 'processes'));
    await writeFile(join(lock, 'processes', 'x.json'), '{not json');
    const launched = new TickWorkflowExecutor({
      logger,
      commandLauncher: ['node', '/opt/qc/bin/run.js'],
    });
    const result = oneEntryPerRun(await launched.execute(f.tickPlan));
    const message = result.skipped[0]?.message ?? '';
    expect(message).toContain(
      `node /opt/qc/bin/run.js workflow resume run --state-dir ${f.stateDir} --kill-orphans`,
    );
  });

  it('words an orphans refusal raised while claiming a run for tick, not for resume', async () => {
    const f = await fixture();
    const before = await runBytes(f.stateDir, 'run');
    const open = vi
      .spyOn(FileRunStore.prototype, 'open')
      .mockRejectedValueOnce(
        new OrphanProcessesError('run', [
          { file: '1.json', process: null, state: 'unknown', detail: 'bad record' },
        ]),
      );
    let result: TickWorkflowsResult;
    try {
      result = oneEntryPerRun(await tick.execute(f.tickPlan));
    } finally {
      open.mockRestore();
    }
    expect(result).toEqual({
      kind: 'workflow.tick.result',
      ok: true,
      resumed: [],
      skipped: [
        {
          runId: 'run',
          reason: 'orphans',
          message: expect.stringContaining('1.json: bad record') as unknown,
        },
      ],
      observed: 0,
      exitCode: 75,
    });
    const message = result.skipped[0]?.message ?? '';
    expect(message).toContain(`workflow resume run --state-dir ${f.stateDir} --kill-orphans`);
    expect(message).toContain('Tick never signals a process');
    expect(message).not.toContain('Stop confirmed processes with --kill-orphans');
    expect(await runBytes(f.stateDir, 'run')).toEqual(before);
    expect(await readFile(f.imports, 'utf8')).toBe('import\n');
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
            /recovered 3 times .*cap 3\).*run quiet-choir workflow resume run --state-dir \S+ to retry/u,
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

  it('starts the crash-loop resume command with the detected command launcher', async () => {
    const f = await fixture();
    await crashedWhileRunning(f.stateDir, 'run', (completedSteps) => ({
      count: 3,
      completedSteps,
    }));
    const launched = new TickWorkflowExecutor({
      logger,
      commandLauncher: ['node', '/opt/qc/bin/run.js'],
    });
    const result = oneEntryPerRun(await launched.execute(f.tickPlan));
    const message = result.skipped[0]?.message ?? '';
    expect(result.skipped[0]?.reason).toBe('crash-loop');
    expect(message).toContain(
      `node /opt/qc/bin/run.js workflow resume run --state-dir ${f.stateDir} to retry`,
    );
    expect(message).not.toContain('quiet-choir workflow');
  });

  // Issue #235: a refusal that no recovery attempt follows must not count toward the cap.
  it('refuses a crashed running run with a different harness configuration before counting a stale recovery', async () => {
    const claudeBinary = join(project, 'test/bin/fake-claude.mjs');
    const harness = { kind: 'cli' as const, config: { claudeBinary } };
    const refused = {
      kind: 'workflow.tick.result',
      ok: true,
      resumed: [],
      skipped: [
        {
          runId: 'run',
          reason: 'incompatible',
          message: expect.stringContaining('Repeat the original --harness-config') as unknown,
        },
      ],
      observed: 0,
      exitCode: 1,
    };
    const f = await fixture('agent', false, { harnessConfig: { claudeBinary } });
    await crashedWhileRunning(f.stateDir, 'run');
    const before = await runBytes(f.stateDir, 'run');
    // More ticks than the cap: a cron tick without --harness-config is never a crash loop.
    for (let pass = 0; pass < 4; pass++) {
      expect(oneEntryPerRun(await tick.execute(f.tickPlan))).toEqual(refused);
      expect(await runBytes(f.stateDir, 'run')).toEqual(before);
    }
    const saved = await readRun(f.plan);
    expect(saved.status).toBe('running');
    expect(saved.staleRecovery).toBeUndefined();
    expect(await readFile(f.imports, 'utf8')).toBe('import\n');
    await expect(stat(f.agentLog)).rejects.toMatchObject({ code: 'ENOENT' });

    // An earlier count, from real crashes, is kept exactly as it was, including its time.
    const counted = await fixture('agent', false, { harnessConfig: { claudeBinary } });
    await crashedWhileRunning(counted.stateDir, 'run', (completedSteps) => ({
      count: 2,
      completedSteps,
    }));
    const original = (await readRun(counted.plan)).staleRecovery;
    expect(original).toMatchObject({ count: 2 });
    const countedBytes = await runBytes(counted.stateDir, 'run');
    for (let pass = 0; pass < 4; pass++)
      expect(oneEntryPerRun(await tick.execute(counted.tickPlan))).toEqual(refused);
    expect(await runBytes(counted.stateDir, 'run')).toEqual(countedBytes);
    expect((await readRun(counted.plan)).staleRecovery).toEqual(original);

    // The original configuration recovers both runs, and completion clears the counter.
    for (const run of [f, counted]) {
      expect(oneEntryPerRun(await tick.execute({ ...run.tickPlan, harness }))).toMatchObject({
        resumed: [{ runId: 'run', outcome: 'completed' }],
        skipped: [],
        exitCode: 0,
      });
      const recovered = await readRun(run.plan);
      expect(recovered.status).toBe('completed');
      expect(recovered.staleRecovery).toBeUndefined();
    }
  });

  it('leaves the configuration check to the runtime when a live harness is injected', async () => {
    const claudeBinary = join(project, 'test/bin/fake-claude.mjs');
    const f = await fixture('agent', false, { harnessConfig: { claudeBinary } });
    await crashedWhileRunning(f.stateDir, 'run');
    // An injected harness carries its own configuration, so no digest is compared or predicted.
    const answers = new FixtureHarness(
      parseHarnessFixtures({ version: 1, calls: [{ step: 'call', text: 'injected' }] }),
    );
    const injected: Harness = {
      kind: 'cli',
      invoke: (request, invocation) => answers.invoke(request, invocation),
    };
    expect(
      oneEntryPerRun(
        await new TickWorkflowExecutor({ logger, harness: injected }).execute(f.tickPlan),
      ),
    ).toMatchObject({
      resumed: [{ runId: 'run', outcome: 'completed' }],
      skipped: [],
      exitCode: 0,
    });
    expect((await readRun(f.plan)).steps['call']?.status).toBe('completed');
    await expect(stat(f.agentLog)).rejects.toMatchObject({ code: 'ENOENT' });
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

/**
 * Make `count` due runs in one state directory: one fixture, then the analysed plan executed again
 * under a new id for each extra run, which saves a compile per run.
 */
async function manyDueRuns(count: number) {
  const f = await fixture('due', false, { runId: 'due-00' });
  // The shared program cache turns every start after the first into an incremental type check.
  const executor = new WorkflowExecutor({
    logger,
    clock: pastClock,
    typecheckCache: new TypecheckProgramCache(),
  });
  const ids = Array.from({ length: count }, (_, i) => `due-${String(i).padStart(2, '0')}`);
  for (const runId of ids.slice(1))
    expect(await executor.execute({ ...f.plan, runId })).toMatchObject({
      ok: true,
      run: { status: 'suspended' },
    });
  return { f, executor, ids };
}

/** The spied calls whose options name this state directory and, if given, one of these runs. */
function callsFor(
  spy: typeof ownershipSpy | typeof readSpy,
  stateDir: string,
  runIds?: readonly string[],
) {
  return spy.mock.calls.filter(
    ([options]) =>
      options.stateDir === stateDir && (runIds === undefined || runIds.includes(options.runId)),
  );
}

/** The spied source checks for runs whose working directory is this fixture root. */
function sourceChecksFor(root: string) {
  return sourcesSpy.mock.calls.filter(([run]) => run.cwd === root);
}

const unreadDeadline = "Tick's timeout passed before this run was read; a later tick checks it.";

// Issue #199: tick's deadline interrupts into a resumable suspension, and a margin stops claims.
// measured: 6.7 s alone for the timeout case (a fixed 6 s tick timeout, sized for a slow import on
// a loaded CI leg, plus tsImport compiles) and 2.3 s for the margin case; the loader suite's 40 s
// raise covers the compile-heavy tail. Issue #205's many-run cases measured 4.6 s and 3.6 s alone
// (twelve run starts with a shared program cache dominate), and the watch case 1.9 s.
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

  // Issue #206: the deadline fires after tick saved the stale-recovery count, before the runtime open.
  it('reports a deadline between the stale-recovery save and the runtime open as interrupted', async () => {
    const f = await fixture();
    await crashedWhileRunning(f.stateDir, 'run');
    const realSetTimeout = globalThis.setTimeout;
    let fire: (() => void) | undefined;
    const timers = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((handler: () => void, ms?: number) => {
        if (ms !== 30_000) return realSetTimeout(handler, ms);
        fire = handler;
        return realSetTimeout(() => undefined, 0);
      });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called with the instance below
    const realOpen = FileRunStore.prototype.open;
    const opened = vi.spyOn(FileRunStore.prototype, 'open').mockImplementation(async function (
      this: FileRunStore,
      ...args
    ) {
      const owned = await realOpen.apply(this, args);
      const append = owned.append.bind(owned);
      owned.append = async (record, options) => {
        await append(record, options);
        if (options?.context === 'Could not save stale recovery count') fire?.();
      };
      return owned;
    });
    let result: TickWorkflowsResult | WorkflowFailure;
    try {
      result = await tick.execute({ ...f.tickPlan, timeoutMs: 30_000, claimMarginMs: 0 });
    } finally {
      opened.mockRestore();
      timers.mockRestore();
    }
    expect(fire).toBeDefined();
    expect(oneEntryPerRun(result)).toEqual({
      kind: 'workflow.tick.result',
      ok: true,
      resumed: [
        {
          runId: 'run',
          outcome: 'interrupted',
          message: expect.stringContaining('Tick timeout reached.') as unknown,
        },
      ],
      skipped: [],
      observed: 0,
      exitCode: 75,
    });
    expect(await readRun(f.plan)).toMatchObject({ status: 'running', staleRecovery: { count: 1 } });
    await expect(readFile(f.effects, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      await actualStore.inspectRunOwnership({ stateDir: f.stateDir, runId: 'run' }),
    ).toMatchObject({
      locked: false,
    });

    // The run is still recoverable: the next tick takes it as stale and completes it.
    expect(oneEntryPerRun(await tick.execute(f.tickPlan))).toMatchObject({
      resumed: [{ runId: 'run', outcome: 'completed' }],
      exitCode: 0,
    });
    expect(await readFile(f.effects, 'utf8')).toBe('effect\n');
    expect((await readRun(f.plan)).staleRecovery).toBeUndefined();
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
    // Past the fired deadline tick reads nothing: the run is reported unread, still pending.
    expect(oneEntryPerRun(result)).toEqual({
      kind: 'workflow.tick.result',
      ok: true,
      resumed: [],
      skipped: [{ runId: 'run', reason: 'deadline', message: unreadDeadline }],
      observed: 0,
      exitCode: 75,
    });
    expect(callsFor(readSpy, f.stateDir)).toEqual([]);
    expect(callsFor(ownershipSpy, f.stateDir)).toEqual([]);
    expect(sourceChecksFor(f.root)).toEqual([]);
    expect(await runBytes(f.stateDir, 'run')).toEqual(before);
  });

  // Issue #205: past the margin and the timeout, tick's per-run scan stops costing I/O.
  it('skips lock and source checks for runs seen inside the margin', async () => {
    const { f, executor, ids } = await manyDueRuns(12);
    const { stateDir } = f;
    // A completed run and a run whose timer is still in the future share the directory.
    const done = await executor.execute({ ...f.plan, runId: 'done' });
    expect(done).toMatchObject({ ok: true, run: { status: 'suspended' } });
    expect(
      oneEntryPerRun(await tick.execute({ kind: 'workflow.tick', stateDir, runId: 'done' })),
    ).toMatchObject({ resumed: [{ runId: 'done', outcome: 'completed' }], exitCode: 0 });
    const later = await new WorkflowExecutor({ logger }).execute({ ...f.plan, runId: 'later' });
    expect(later).toMatchObject({ ok: true, run: { status: 'suspended' } });
    const before = Object.fromEntries(
      await Promise.all(ids.map(async (id) => [id, await runBytes(stateDir, id)] as const)),
    );
    const imports = await readFile(f.imports, 'utf8');
    ownershipSpy.mockClear();
    sourcesSpy.mockClear();
    readSpy.mockClear();
    // 4 s of a 10 s timeout remain, inside the 6 s margin, and the deadline timer has not fired.
    const restore = jumpAfterDeadline(6_000);
    let result: TickWorkflowsResult | WorkflowFailure;
    try {
      result = await tick.execute({
        kind: 'workflow.tick',
        stateDir,
        timeoutMs: 10_000,
        claimMarginMs: 6_000,
      });
    } finally {
      restore();
    }
    const report = oneEntryPerRun(result);
    expect(report).toMatchObject({ resumed: [], observed: 1, exitCode: 0 });
    // Every record is still read and classified, but no lock, orphan or source check runs.
    expect(callsFor(readSpy, stateDir)).toHaveLength(ids.length + 2);
    expect(callsFor(ownershipSpy, stateDir)).toEqual([]);
    expect(sourceChecksFor(f.root)).toEqual([]);
    expect(byRunId(report.skipped)).toEqual([
      ...ids.map((runId) => ({
        runId,
        reason: 'deadline',
        nextWakeAt: expect.any(Number) as unknown,
      })),
      { runId: 'later', reason: 'not due', nextWakeAt: expect.any(Number) as unknown },
    ]);
    for (const id of ids) expect(await runBytes(stateDir, id)).toEqual(before[id]);
    expect(await readFile(f.imports, 'utf8')).toBe(imports);
  });

  it('stops reading runs once the timeout fires and reports the rest as deadline', async () => {
    const { f, ids } = await manyDueRuns(12);
    const { stateDir } = f;
    const before = Object.fromEntries(
      await Promise.all(ids.map(async (id) => [id, await runBytes(stateDir, id)] as const)),
    );
    readSpy.mockClear();
    ownershipSpy.mockClear();
    sourcesSpy.mockClear();
    // Each read takes at least 200 ms, so a scan that kept reading would take 2.4 s or more.
    readSpy.mockImplementation(async (options) => {
      await delay(200);
      return actualRequiredRun.readRequiredRun(options);
    });
    const started = Date.now();
    // A 299 ms margin of a 300 ms timeout: nothing is claimed, and the timeout fires mid-scan.
    const result = oneEntryPerRun(
      await tick.execute({ kind: 'workflow.tick', stateDir, timeoutMs: 300, claimMarginMs: 299 }),
    );
    const elapsed = Date.now() - started;
    expect(result).toMatchObject({ resumed: [], observed: 0, exitCode: 0 });
    expect(byRunId(result.skipped).map(({ runId }) => runId)).toEqual(ids);
    const read = new Set(callsFor(readSpy, stateDir).map(([options]) => options.runId));
    expect(read.size).toBeGreaterThan(0);
    expect(read.size).toBeLessThan(ids.length);
    for (const entry of result.skipped)
      expect(entry).toEqual(
        read.has(entry.runId)
          ? { runId: entry.runId, reason: 'deadline', nextWakeAt: expect.any(Number) as unknown }
          : { runId: entry.runId, reason: 'deadline', message: unreadDeadline },
      );
    expect(callsFor(ownershipSpy, stateDir)).toEqual([]);
    expect(sourceChecksFor(f.root)).toEqual([]);
    // The bound rests on the read count above; the time only has to stay well below a full scan.
    expect(elapsed).toBeLessThan(1_500);
    for (const id of ids) expect(await runBytes(stateDir, id)).toEqual(before[id]);
  });

  it('keeps an earlier watch pass entry for a run left unread after the timeout', async () => {
    const f = await fixture('future', false, { runId: 'a-later' });
    const { stateDir } = f;
    expect(
      await new WorkflowExecutor({ logger }).execute({ ...f.plan, runId: 'b-later' }),
    ).toMatchObject({ ok: true, run: { status: 'suspended' } });
    // Capture the deadline timer and fire it from the third read: the first read of the second
    // watch pass, so b-later is never read again.
    let fire: (() => void) | undefined;
    const realSetTimeout = globalThis.setTimeout;
    const timers = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((handler: () => void, ms?: number) => {
        if (ms !== 10_000) return realSetTimeout(handler, ms);
        fire = handler;
        return realSetTimeout(() => undefined, 0);
      });
    readSpy.mockClear();
    readSpy.mockImplementation((options) => {
      if (callsFor(readSpy, stateDir).length === 3) fire?.();
      return actualRequiredRun.readRequiredRun(options);
    });
    let result: TickWorkflowsResult | WorkflowFailure;
    try {
      result = await tick.execute({
        kind: 'workflow.tick',
        stateDir,
        watch: true,
        timeoutMs: 10_000,
        claimMarginMs: 0,
      });
    } finally {
      timers.mockRestore();
    }
    const reads = callsFor(readSpy, stateDir).map(([options]) => options.runId);
    expect(reads).toEqual(['a-later', 'b-later', 'a-later']);
    expect(oneEntryPerRun(result)).toMatchObject({ resumed: [], observed: 0, exitCode: 0 });
    expect(byRunId(result.ok ? result.skipped : [])).toEqual([
      { runId: 'a-later', reason: 'not due', nextWakeAt: expect.any(Number) as unknown },
      { runId: 'b-later', reason: 'not due', nextWakeAt: expect.any(Number) as unknown },
    ]);
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
