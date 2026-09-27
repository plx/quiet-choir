import { appendFile, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { ThresholdLogger } from '../src/application/execution.js';
import { WorkflowExecutor } from '../src/workflow/loader/executor.js';
import { TickWorkflowExecutor } from '../src/workflow/loader/tick.js';
import { analyzeTypecheckEntrypoint } from '../src/workflow/typecheck/plan.js';
import { FileRunStore, readRun, writeAnswer, type WorkflowClock } from '../src/index.js';

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

async function fixture(
  kind: 'due' | 'future' | 'signal' | 'failure' | 'agent' = 'due',
  notify: boolean | 'fail' = false,
) {
  const root = await mkdtemp(join(tmpdir(), 'choir-tick-'));
  roots.push(root);
  await symlink(join(project, 'node_modules'), join(root, 'node_modules'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  const file = join(root, 'workflow.ts');
  const imports = join(root, 'imports.txt');
  const effects = join(root, 'effects.txt');
  const agentLog = join(root, 'agent.jsonl');
  const notifications = join(root, 'notifications.jsonl');
  const notifyCommand =
    notify === 'fail' ? 'exit 7' : `cat >> '${notifications.replaceAll("'", "'\"'\"'")}'`;
  await writeFile(
    file,
    `
import { appendFileSync } from 'node:fs';
import { z } from 'zod';
import { defineWorkflow } from ${JSON.stringify(join(project, 'src/workflow/runtime/model.js'))};
appendFileSync(${JSON.stringify(imports)}, 'import\\n');
export default defineWorkflow({ name: 'tick', version: '1', input: z.null(), output: z.null(),
  ${kind === 'agent' ? 'strictProfiles: false,' : ''}
  run: async (ctx) => {
    ${
      kind === 'signal'
        ? "await ctx.ask('ready', { prompt: 'Ready?', schema: z.boolean() });"
        : "await ctx.sleep('timer', 60_000);"
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
  const stateDir = join(root, 'state');
  const plan = {
    kind: 'workflow.execute' as const,
    typecheck: analysis.plan,
    runId: 'run',
    stateDir,
    cwd: root,
    resume: false,
    input: null,
    ...(notify ? { notifyCommand } : {}),
    ...(kind === 'agent'
      ? { harness: { kind: 'cli' as const, config: {} }, grants: ['exec'] }
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
    plan,
    tickPlan: { kind: 'workflow.tick' as const, runId: 'run', stateDir },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Each test spawns real tick-loader child processes against temporary fixtures; on the oldest
// supported Node version under loaded CI this occasionally clears 20s by a few hundred ms.
describe('tick loader and operator hooks', { timeout: 40_000 }, () => {
  it('resumes a due timer from its saved entrypoint and skips completed imports', async () => {
    const f = await fixture();
    expect(await tick.execute(f.tickPlan)).toMatchObject({
      ok: true,
      resumed: 1,
      completed: ['run'],
      exitCode: 0,
    });
    const bytes = await readFile(f.imports, 'utf8');
    expect(bytes.split('\n').filter(Boolean)).toHaveLength(2);
    expect(await readFile(f.effects, 'utf8')).toBe('effect\n');
    expect(await tick.execute(f.tickPlan)).toMatchObject({
      ok: true,
      resumed: 0,
      completed: ['run'],
      exitCode: 0,
    });
    expect(await readFile(f.imports, 'utf8')).toBe(bytes);
  });

  it('does not import an undue run and bounds a watch timeout', async () => {
    const f = await fixture('future');
    const saved = await readRun(f.plan);
    expect(await tick.execute(f.tickPlan)).toMatchObject({
      ok: true,
      resumed: 0,
      skipped: [{ runId: 'run', reason: 'not due' }],
      exitCode: 75,
    });
    const start = Date.now();
    expect(await tick.execute({ ...f.tickPlan, watch: true, timeoutMs: 70 })).toMatchObject({
      ok: true,
      resumed: 0,
      exitCode: 75,
    });
    expect(Date.now() - start).toBeGreaterThanOrEqual(60);
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(await readRun(f.plan)).toEqual(saved);
    expect(await readFile(f.imports, 'utf8')).toBe('import\n');
  });

  it('reports changed source without importing or changing the checkpoint', async () => {
    const f = await fixture();
    const saved = await readRun(f.plan);
    await appendFile(f.file, '\n// changed source\n');
    expect(await tick.execute(f.tickPlan)).toMatchObject({
      ok: true,
      resumed: 0,
      incompatible: [{ runId: 'run' }],
      exitCode: 1,
    });
    expect(await readRun(f.plan)).toEqual(saved);
    expect(await readFile(f.imports, 'utf8')).toBe('import\n');
  });

  it('skips a locked run and gives concurrent ticks only one importer and effect', async () => {
    const f = await fixture();
    const held = await new FileRunStore(f.stateDir).open('run');
    try {
      expect(await tick.execute(f.tickPlan)).toMatchObject({
        ok: true,
        resumed: 0,
        skipped: [{ runId: 'run', reason: 'locked' }],
        exitCode: 75,
      });
    } finally {
      await held.release();
    }
    const results = await Promise.all([tick.execute(f.tickPlan), tick.execute(f.tickPlan)]);
    expect(results.reduce((n, result) => n + (result.ok ? result.resumed : 0), 0)).toBe(1);
    expect(await readFile(f.imports, 'utf8')).toBe('import\nimport\n');
    expect(await readFile(f.effects, 'utf8')).toBe('effect\n');
  });

  it('wakes a bounded watcher when an external answer arrives', async () => {
    const f = await fixture('signal');
    const watching = tick.execute({ ...f.tickPlan, watch: true, timeoutMs: 10_000 });
    await delay(50);
    await writeAnswer({ stateDir: f.stateDir, runId: 'run', stepId: 'ready', value: true });
    expect(await watching).toMatchObject({ ok: true, resumed: 1, completed: ['run'], exitCode: 0 });
  });

  it('limits batch resumes and keeps per-run failure separate from command failure', async () => {
    const f = await fixture('failure');
    const executor = new WorkflowExecutor({ logger, clock: pastClock });
    expect(await executor.execute({ ...f.plan, runId: 'second' })).toMatchObject({ ok: true });
    const batch = { kind: 'workflow.tick' as const, stateDir: f.stateDir, maxRuns: 1 };
    expect(await tick.execute(batch)).toMatchObject({
      ok: true,
      resumed: 1,
      failed: [{ runId: 'run' }],
      exitCode: 0,
    });
    expect((await readRun({ stateDir: f.stateDir, runId: 'second' })).status).toBe('suspended');
    expect(await tick.execute(f.tickPlan)).toMatchObject({
      ok: true,
      resumed: 0,
      failed: [{ runId: 'run' }],
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

  it(
    'emits run.failed and ignores notification-command failures',
    { timeout: 60_000 },
    async () => {
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
    },
  );

  it('carries a supplied --harness-config into the resumed CLI run', async () => {
    const f = await fixture('agent');
    const claudeBinary = join(project, 'test/bin/fake-claude.mjs');
    expect(
      await tick.execute({
        ...f.tickPlan,
        harness: { kind: 'cli', config: { claudeBinary } },
      }),
    ).toMatchObject({ ok: true, resumed: 1, completed: ['run'], exitCode: 0 });
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
    ).toMatchObject({ ok: true, resumed: 1, completed: ['run'], exitCode: 0 });

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
      resumed: 0,
      skipped: [{ runId: 'run', reason: 'not due' }],
      exitCode: 75,
    });
  });
});
