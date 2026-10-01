// The non-secret launch policy (harness selection with fixture files, wait mode) is recorded on
// every CLI execution and inherited by a resume that does not repeat the flags. These tests drive
// WorkflowExecutor with plans shaped like the CLI's, a fixture harness and a virtual clock; no agent
// process starts except the repository's fake claude where a test switches to the CLI harness.
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import type { ExecutionLogger } from '../src/application/execution.js';
import { WorkflowExecutor, type WorkflowExecutorPlan } from '../src/workflow/loader/executor.js';
import { readHarnessSelection } from '../src/workflow/loader/harness-selection.js';
import type { WorkflowCommandResult } from '../src/workflow/loader/model.js';
import { analyzeTypecheckEntrypoint } from '../src/workflow/typecheck/plan.js';
import {
  FileRunStore,
  readRun,
  RunInterruptedError,
  type LaunchPolicy,
  type WorkflowClock,
} from '../src/index.js';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const fakeClaude = join(project, 'test/bin/fake-claude.mjs');
const roots: string[] = [];
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const fixtureText = (text: string) =>
  JSON.stringify({ version: 1, calls: [{ step: 'call', text }] });

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * A virtual clock. `park` holds every sleep until it is cancelled, so a wait 1.5 s ahead stays ahead
 * (suspend mode suspends it; block mode parks on it). `advance` moves time forward by each sleep, so
 * a blocking wait completes at once.
 */
function virtualClock() {
  let now = Date.now();
  const state: { mode: 'park' | 'advance'; onPark: () => void; sleeps: number } = {
    mode: 'park',
    onPark: () => undefined,
    sleeps: 0,
  };
  const clock: WorkflowClock = {
    now: () => now,
    sleep: (milliseconds, signal) => {
      state.sleeps++;
      if (state.mode === 'advance') {
        now += milliseconds;
        return Promise.resolve();
      }
      state.onPark();
      return new Promise((_resolve, reject) => {
        const cancel = () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error('Clock cancelled'));
        };
        if (signal.aborted) cancel();
        else signal.addEventListener('abort', cancel, { once: true });
      });
    },
  };
  return { clock, state };
}

async function setup(body: 'sleep' | 'ask' = 'sleep') {
  const root = await mkdtemp(join(tmpdir(), 'choir-launch-policy-'));
  roots.push(root);
  await symlink(join(project, 'node_modules'), join(root, 'node_modules'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'f.json'), fixtureText('from f'));
  await writeFile(join(root, 'g.json'), fixtureText('from g'));
  const file = join(root, 'workflow.ts');
  await writeFile(
    file,
    `import { z } from 'zod';
import { defineWorkflow } from ${JSON.stringify(join(project, 'src/workflow/runtime/model.js'))};
export default defineWorkflow({ name: 'launch-policy', version: '1', input: z.null(), output: z.string(),
  strictProfiles: false,
  run: async (ctx) => {
    ${
      body === 'sleep'
        ? "await ctx.sleep('nap', 1500);"
        : "await ctx.ask('gate', { prompt: 'Go?', schema: z.boolean() });"
    }
    return (await ctx.claude.text('call', { prompt: 'hi' })).output;
  } });
`,
  );
  const analysis = analyzeTypecheckEntrypoint(file, root);
  if (!analysis.ok) throw new Error(analysis.error.message);
  const stateDir = join(root, 'state');
  const warnings: string[] = [];
  const logger: ExecutionLogger = {
    log: (level, message) => {
      if (level === 'warn') warnings.push(message);
    },
  };
  const { clock, state } = virtualClock();
  const executor = (signal?: AbortSignal) =>
    new WorkflowExecutor({ logger, clock, ...(signal === undefined ? {} : { signal }) });
  const ids = { runId: 'run', stateDir };
  /** The CLI's selection for a flag set: `--harness` values (none means cli) and config. */
  const select = (harness?: string | string[], config?: string) =>
    readHarnessSelection(harness ?? 'cli', config, root);
  const execute = async (
    extra: Partial<Extract<WorkflowExecutorPlan, { kind: 'workflow.execute' }>> = {},
    signal?: AbortSignal,
  ) =>
    executor(signal).execute({
      kind: 'workflow.execute',
      typecheck: analysis.plan,
      ...ids,
      cwd: root,
      resume: false,
      input: null,
      grants: ['exec'],
      harness: await select('fixture:f.json'),
      ...extra,
    });
  /** `workflow resume run` with the given flags; no `--harness` inherits the recorded selection. */
  const resume = async (
    flags: { harness?: string | string[]; config?: string } = {},
    extra: Partial<Extract<WorkflowExecutorPlan, { kind: 'workflow.resume' }>> = {},
  ) =>
    executor().execute({
      kind: 'workflow.resume',
      ...ids,
      harness: await select(flags.harness, flags.config),
      inheritHarness: flags.harness === undefined,
      ...extra,
    });
  const record = () => readRun(ids);
  /** Rewrite the saved record, as an older build without the policy would have left it. */
  const dropPolicy = async () => {
    const owned = await new FileRunStore(stateDir).open('run');
    try {
      const saved = await owned.read();
      if (!saved?.launch) throw new Error('missing run');
      delete (saved.launch as { policy?: LaunchPolicy }).policy;
      await owned.append(saved, { durable: true });
    } finally {
      await owned.release();
    }
  };
  return { root, stateDir, state, warnings, execute, resume, record, dropPolicy, select };
}

function ok(result: WorkflowCommandResult) {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  if (result.kind !== 'workflow.run.result') throw new Error(`Unexpected ${result.kind}`);
  return result.run;
}

const policyOf = (path: string, text: string, waitMode: 'suspend' | 'block'): LaunchPolicy => ({
  harness: { kind: 'fixture', fixtures: [{ path, sha256: sha256(text) }] },
  waitMode,
});

// Each test type-checks and imports a temporary workflow module several times through tsImport.
// measured: 1.1-2.4 s alone per test; tsImport compiles dominate, as in the loader suites.
describe('sticky launch policy', { timeout: 30_000 }, () => {
  it('keeps --harness fixture and --wait-mode block across an interruption, a tick and a plain resume', async () => {
    const f = await setup();
    const path = join(f.root, 'f.json');
    const flags = ['--harness', `fixture:${path}`, '--wait-mode', 'block'];
    // 1. execute --harness fixture:f.json --wait-mode block, interrupted once the block wait parks.
    const controller = new AbortController();
    f.state.onPark = () => {
      controller.abort(new RunInterruptedError('Operator stop.'));
    };
    const interrupted = await f.execute({ waitMode: 'block' }, controller.signal);
    if (interrupted.ok) throw new Error('Expected an interruption.');
    expect(interrupted.code).toBe('workflow.interrupted');
    expect(interrupted.run?.status).toBe('suspended');
    expect((await f.record()).launch?.policy).toEqual(
      policyOf(path, fixtureText('from f'), 'block'),
    );
    expect(interrupted.next?.at(-1)?.argv.slice(-flags.length)).toEqual(flags);

    // 2. A tick resumes with a one-execution suspend: the run suspends cleanly, and the recorded
    // policy (and so the emitted resume command) still says block.
    f.state.onPark = () => undefined;
    const ticked = ok(await f.resume({}, { waitModeOnce: 'suspend' }));
    expect(ticked.status).toBe('suspended');
    expect(ticked.resumeCommand?.slice(-flags.length)).toEqual(flags);
    expect((await f.record()).launch?.policy?.waitMode).toBe('block');

    // 3. resume ID alone: block keeps the 1.5 s wait in this process instead of suspending, and the
    // fixture, not a CLI adapter, answers the agent call.
    f.state.mode = 'advance';
    const sleeps = f.state.sleeps;
    const completed = ok(await f.resume());
    expect(completed.status).toBe('completed');
    expect(completed.output).toBe('from f');
    expect(f.state.sleeps).toBeGreaterThan(sleeps);
    expect(completed.harness?.kind).toBe('fixture');
    expect((await f.record()).launch?.policy).toEqual(
      policyOf(path, fixtureText('from f'), 'block'),
    );
  });

  it('lets explicit --harness override the recorded kind only with --allow-harness-change', async () => {
    const f = await setup();
    expect(ok(await f.execute()).status).toBe('suspended');
    const before = await readFile(join(f.stateDir, 'run', 'run.json'), 'utf8');
    const refused = await f.resume({ harness: 'cli' });
    expect(refused).toMatchObject({ ok: false, code: 'run.incompatible' });
    expect(refused.ok ? '' : refused.message).toMatch(/--allow-harness-change/u);
    expect(await readFile(join(f.stateDir, 'run', 'run.json'), 'utf8')).toBe(before);
    f.state.mode = 'advance';
    const changed = ok(
      await f.resume(
        { harness: 'cli', config: JSON.stringify({ claudeBinary: fakeClaude }) },
        { allowHarnessChange: true, waitMode: 'block' },
      ),
    );
    expect(changed.status).toBe('completed');
    expect(changed.harness?.kind).toBe('cli');
    expect((await f.record()).launch?.policy).toEqual({
      harness: { kind: 'cli' },
      waitMode: 'block',
    });
  });

  it('lets explicit --wait-mode and --harness fixture:<file> replace the recorded values', async () => {
    const f = await setup();
    const controller = new AbortController();
    f.state.onPark = () => {
      controller.abort(new RunInterruptedError('Operator stop.'));
    };
    expect(await f.execute({ waitMode: 'block' }, controller.signal)).toMatchObject({
      ok: false,
      code: 'workflow.interrupted',
    });
    expect((await f.record()).launch?.policy?.waitMode).toBe('block');
    f.state.onPark = () => undefined;
    // Explicit suspend on a block run suspends, and suspend becomes the recorded mode.
    const suspended = ok(await f.resume({}, { waitMode: 'suspend' }));
    expect(suspended.status).toBe('suspended');
    expect((await f.record()).launch?.policy?.waitMode).toBe('suspend');
    expect(suspended.resumeCommand).not.toContain('--wait-mode');
    // An explicit fixture replaces the recorded path and digest.
    const other = ok(await f.resume({ harness: 'fixture:g.json' }));
    expect(other.status).toBe('suspended');
    const path = join(f.root, 'g.json');
    expect((await f.record()).launch?.policy).toEqual(
      policyOf(path, fixtureText('from g'), 'suspend'),
    );
    expect(other.resumeCommand?.slice(-2)).toEqual(['--harness', `fixture:${path}`]);
    f.state.mode = 'advance';
    expect(ok(await f.resume({}, { waitMode: 'block' })).output).toBe('from g');
  });

  it('resumes a checkpoint without a recorded policy as before', async () => {
    const f = await setup();
    expect(ok(await f.execute()).status).toBe('suspended');
    await f.dropPolicy();
    // Without a policy the default cli selection applies, so the fixture run needs a harness change.
    const refused = await f.resume();
    expect(refused).toMatchObject({ ok: false, code: 'run.incompatible' });
    expect(refused.ok ? [] : refused.next).toBeUndefined();
    // Repeating the flags still works, and records the policy again.
    const repeated = ok(await f.resume({ harness: 'fixture:f.json' }));
    expect(repeated.status).toBe('suspended');
    expect((await f.record()).launch?.policy?.harness.kind).toBe('fixture');
  });

  it('warns about an edited fixture and refuses a deleted one', async () => {
    const f = await setup();
    expect(ok(await f.execute()).status).toBe('suspended');
    const path = join(f.root, 'f.json');
    await writeFile(path, fixtureText('edited'));
    const edited = ok(await f.resume());
    expect(edited.status).toBe('suspended');
    expect(f.warnings).toEqual([
      expect.stringMatching(
        new RegExp(
          `^Fixture ${path.replaceAll(/[.*+?^${}()|[\]\\/]/gu, '\\$&')} changed since the run last executed \\(sha256 ${sha256(fixtureText('from f')).slice(0, 12)}, now ${sha256(fixtureText('edited')).slice(0, 12)}\\)`,
          'u',
        ),
      ),
    ]);
    expect((await f.record()).launch?.policy).toEqual(
      policyOf(path, fixtureText('edited'), 'suspend'),
    );
    await rm(path);
    const missing = await f.resume();
    expect(missing).toMatchObject({ ok: false, code: 'usage.flag' });
    expect(missing.ok ? '' : missing.message).toContain(path);
    expect(missing.ok ? '' : missing.message).toContain('--harness');
    expect((await f.record()).status).toBe('suspended');
  });

  it('inherits the policy on answer --resume', async () => {
    const f = await setup('ask');
    expect(ok(await f.execute()).status).toBe('suspended');
    const answered = await new WorkflowExecutor({
      logger: { log: () => undefined },
    }).execute({
      kind: 'workflow.answer',
      runId: 'run',
      stateDir: f.stateDir,
      stepId: 'gate',
      value: true,
      resume: true,
      harness: await f.select(),
      inheritHarness: true,
    });
    const run = ok(answered);
    expect(run.status).toBe('completed');
    expect(run.output).toBe('from f');
    expect(run.harness?.kind).toBe('fixture');
  });

  it('records no configuration values in the policy', async () => {
    const f = await setup();
    const config = JSON.stringify({
      claudeBinary: './secret-claude',
      harnesses: { third: { token: 'sekrit-value' } },
    });
    expect(ok(await f.execute({ harness: await f.select('fixture:f.json', config) })).status).toBe(
      'suspended',
    );
    const saved = await f.record();
    expect(saved.launch?.policy).toEqual(
      policyOf(join(f.root, 'f.json'), fixtureText('from f'), 'suspend'),
    );
    expect(Object.keys(saved.launch?.policy ?? {}).sort()).toEqual(['harness', 'waitMode']);
    const bytes = await readFile(join(f.stateDir, 'run', 'run.json'), 'utf8');
    expect(bytes).not.toContain('sekrit-value');
    expect(bytes).not.toContain('secret-claude');
  });
});
