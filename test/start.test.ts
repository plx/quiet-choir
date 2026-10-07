import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defineWorkflow, NodeProcessRunner, runWorkflow, z } from '../src/index.js';
import { ProcessSupervisor } from '../src/processes/supervisor.js';
import { pidState } from '../src/processes/identity.js';
import type { WorkflowFailure } from '../src/workflow/loader/failure.js';
import { listRuns } from '../src/workflow/loader/inspection.js';
import { writeRunnerIdentity } from '../src/workflow/runtime/launch-leftovers.js';
import { removeRun } from '../src/workflow/runtime/run-removal.js';
import { readRun } from '../src/workflow/runtime/store.js';
import {
  observeStartedRun,
  prepareStartLaunch,
  StartWorkflowExecutor,
  type StartRunObservation,
  type StartWorkflowPlan,
  type StartWorkflowResult,
} from '../src/workflow/loader/start.js';

// The detached-start executor against fake runners: small `node -e` scripts that play the runner's
// observable parts (a record marker, a result document on stdout, an exit). The injected observer
// reads the marker instead of a real checkpoint.
let root: string;
let stateDir: string;
const spawned: number[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'choir-start-'));
  stateDir = join(root, 'runs');
});
afterEach(async () => {
  for (const pid of spawned.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* Already gone. */
    }
  }
  await rm(root, { recursive: true, force: true });
});

/** The marker a fake runner writes when it "creates" its record: `{status, ownerPid}`. */
function marker(): string {
  return join(root, 'record.json');
}

async function observeMarker(): Promise<StartRunObservation> {
  try {
    return JSON.parse(await readFile(marker(), 'utf8')) as StartRunObservation;
  } catch {
    return { status: null, ownerPid: null };
  }
}

function plan(script: string, overrides: Partial<StartWorkflowPlan> = {}): StartWorkflowPlan {
  return {
    kind: 'workflow.start',
    runId: 'r1',
    stateDir,
    cwd: root,
    argv: [process.execPath, '-e', script, marker()],
    timeoutMs: 10_000,
    killGraceMs: 100,
    ...overrides,
  };
}

function executor(options: ConstructorParameters<typeof StartWorkflowExecutor>[0] = {}) {
  return new StartWorkflowExecutor({
    observeRun: observeMarker,
    pollIntervalMs: 10,
    saveMarginMs: 100,
    commandLauncher: ['qc'],
    ...options,
  });
}

function started(result: StartWorkflowResult | WorkflowFailure): StartWorkflowResult {
  if (!result.ok) throw new Error(`Expected a start: ${result.code}: ${result.message}`);
  spawned.push(result.pid);
  return result;
}

function failed(result: StartWorkflowResult | WorkflowFailure): WorkflowFailure {
  if (result.ok) {
    spawned.push(result.pid);
    throw new Error('Expected a failure');
  }
  if (result.launch?.pid != null) spawned.push(result.launch.pid);
  return result;
}

const own = `require('fs').writeFileSync(process.argv[1], JSON.stringify({ status: 'running', ownerPid: process.pid }));`;
const forever = 'setInterval(() => {}, 1000);';
const typecheckFailure = JSON.stringify({
  kind: 'workflow.error',
  ok: false,
  exitCode: 4,
  error: {
    code: 'load.typecheck',
    message: 'Workflow type check failed.',
    stepId: null,
    details: null,
  },
  diagnostics: [
    {
      category: 'error',
      code: 2322,
      column: 7,
      filePath: '/w.ts',
      line: 2,
      message: 'Nope.',
      relatedInformation: [],
    },
  ],
  next: [],
});

describe('StartWorkflowExecutor', () => {
  it('returns once the record is readable and owned by the runner, leaving it running', async () => {
    const result = started(await executor().execute(plan(`${own} ${forever}`)));
    expect(result).toMatchObject({
      kind: 'workflow.start.result',
      ok: true,
      exitCode: 0,
      runId: 'r1',
      stateDir,
      status: 'running',
      log: join(stateDir, 'r1', 'launch', '1.log'),
      result: join(stateDir, 'r1', 'launch', '1.result.json'),
    });
    expect(result.next.map((entry) => entry.argv)).toEqual([
      ['qc', 'workflow', 'inspect', 'r1', '--state-dir', stateDir, '--json', '--summary'],
      ['qc', 'workflow', 'inspect', 'r1', '--state-dir', stateDir, '--watch'],
    ]);
    expect(pidState(result.pid)).toBe('alive');
    // The runner leads its own process group (setsid), so it survives start's session.
    expect(() => {
      process.kill(-result.pid, 0);
    }).not.toThrow();
  });

  it('waits while another process owns the record, then reports that runner’s refusal', async () => {
    const foreign = `require('fs').writeFileSync(process.argv[1], JSON.stringify({ status: 'running', ownerPid: 1 }));
      setTimeout(() => { process.stdout.write(${JSON.stringify(
        JSON.stringify({
          kind: 'workflow.error',
          ok: false,
          exitCode: 3,
          error: {
            code: 'run.locked',
            message: 'Run r1 is locked.',
            stepId: null,
            details: { pid: 1 },
          },
        }),
      )} + '\\n'); process.exit(3); }, 100);`;
    const failure = failed(await executor().execute(plan(foreign)));
    expect(failure).toMatchObject({
      code: 'run.locked',
      message: 'Run r1 is locked.',
      details: { pid: 1 },
      runId: 'r1',
      launch: { runId: 'r1', exitCode: 3, signal: null },
    });
  });

  it('reports a fast completion whose runner exited before the first poll', async () => {
    const complete = `require('fs').writeFileSync(process.argv[1], JSON.stringify({ status: 'completed', ownerPid: null }));
      process.stdout.write('noise\\n' + JSON.stringify({ kind: 'workflow.run.result', ok: true }) + '\\n');`;
    const result = started(await executor({ pollIntervalMs: 200 }).execute(plan(complete)));
    expect(result.status).toBe('completed');
  });

  it('propagates a pre-record failure document with no run ID and keeps the evidence', async () => {
    const script = `process.stdout.write(${JSON.stringify(typecheckFailure)} + '\\n'); console.error('compiler output'); process.exit(4);`;
    const failure = failed(await executor().execute(plan(script)));
    const launch = join(stateDir, 'r1', 'launch');
    expect(failure).toMatchObject({
      kind: 'workflow.error',
      code: 'load.typecheck',
      message: 'Workflow type check failed.',
      runId: null,
      stateDir,
      run: null,
      next: [],
      launch: {
        runId: 'r1',
        log: join(launch, '1.log'),
        result: join(launch, '1.result.json'),
        exitCode: 4,
        signal: null,
      },
    });
    expect(failure.diagnostics).toHaveLength(1);
    expect(await readFile(join(launch, '1.log'), 'utf8')).toBe('compiler output\n');
    expect(existsSync(join(stateDir, 'r1', 'run.json'))).toBe(false);
  });

  it('leaves a leftover that list reports and rm removes once the runner has exited', async () => {
    const script = `process.stdout.write(${JSON.stringify(typecheckFailure)} + '\\n'); console.error('compiler output'); process.exit(4);`;
    const failure = failed(await executor().execute(plan(script)));
    expect(failure.code).toBe('load.typecheck');
    const launch = join(stateDir, 'r1', 'launch');
    expect((await readdir(launch)).sort()).toEqual(['1.log', '1.result.json', '1.runner.json']);
    expect(JSON.parse(await readFile(join(launch, '1.runner.json'), 'utf8'))).toMatchObject({
      pid: failure.launch?.pid,
      host: hostname(),
    });
    const listed = await listRuns({ stateDir });
    expect(listed.runs).toEqual([]);
    expect(listed.leftoverLaunches).toEqual([
      expect.objectContaining({
        runId: 'r1',
        stateDir,
        path: join(stateDir, 'r1'),
        launches: [1],
        log: join(launch, '1.log'),
      }),
    ]);
    const outcome = await removeRun({ runId: 'r1', stateDir }, new NodeProcessRunner());
    expect(outcome).toMatchObject({
      kind: 'removed',
      result: { launchOnly: true, removed: true, paths: [join(stateDir, 'r1')] },
    });
    expect(existsSync(join(stateDir, 'r1'))).toBe(false);
    expect((await listRuns({ stateDir })).leftoverLaunches).toEqual([]);
  });

  it('reports start.exited for a runner that exits without a document', async () => {
    const failure = failed(await executor().execute(plan('process.exit(9)')));
    expect(failure).toMatchObject({
      code: 'start.exited',
      runId: null,
      launch: { exitCode: 9, signal: null },
    });
    expect(failure.message).toContain('exited with code 9 without creating its record');
  });

  it('reports start.exited for a runner that reports success without a record', async () => {
    const script = `process.stdout.write(JSON.stringify({ ok: true }) + '\\n');`;
    expect(failed(await executor().execute(plan(script))).code).toBe('start.exited');
  });

  it('treats an unknown error code as start.exited', async () => {
    const script = `process.stdout.write(JSON.stringify({ ok: false, error: { code: 'nope' } }) + '\\n'); process.exit(1);`;
    expect(failed(await executor().execute(plan(script))).code).toBe('start.exited');
  });

  it('stops a runner that never creates a record and reports start.timeout', async () => {
    const failure = failed(await executor().execute(plan(forever, { timeoutMs: 150 })));
    expect(failure).toMatchObject({ code: 'start.timeout', runId: null, next: [] });
    expect(failure.launch?.signal).toBe('SIGTERM');
    expect(pidState(failure.launch?.pid ?? 0)).toBe('dead');
  });

  it('escalates to SIGKILL when the runner ignores SIGTERM past the grace', async () => {
    // As in the next test, the timeout must outlast the child's startup: a SIGTERM sent before
    // Node installs the ignoring handler kills it outright, and the launch reports SIGTERM.
    const stubborn = `process.on('SIGTERM', () => {}); ${forever}`;
    const failure = failed(await executor().execute(plan(stubborn, { timeoutMs: 2_000 })));
    expect(failure.code).toBe('start.timeout');
    expect(failure.launch?.signal).toBe('SIGKILL');
    expect(pidState(failure.launch?.pid ?? 0)).toBe('dead');
  });

  it('reports the record of a runner it stopped, with a resume entry when it saved one', async () => {
    // The fake runner "saves" a record on SIGTERM, as the real one saves an interrupted suspension.
    // The start timeout must outlast the child's startup: under load, Node can take well over
    // 100 ms to install the SIGTERM handler, and a runner stopped before that saves nothing.
    const script = `process.on('SIGTERM', () => { require('fs').writeFileSync(process.argv[1], JSON.stringify({ status: 'suspended', ownerPid: null })); process.exit(130); }); ${forever}`;
    const supervisor = new ProcessSupervisor();
    const failure = failed(
      await executor({ processSupervisor: supervisor }).execute(plan(script, { timeoutMs: 2_000 })),
    );
    expect(failure).toMatchObject({
      code: 'start.timeout',
      runId: 'r1',
      launch: { exitCode: 130 },
    });
    // Untracked once reported: a later force kill must not reach a reused PID.
    expect(supervisor.forceKill()).toEqual([]);
  });

  it('stops the runner and reports workflow.interrupted when aborted mid-wait', async () => {
    const controller = new AbortController();
    const pending = executor({ signal: controller.signal }).execute(plan(forever));
    await delay(150);
    controller.abort();
    const failure = failed(await pending);
    expect(failure).toMatchObject({ code: 'workflow.interrupted', runId: null });
    expect(pidState(failure.launch?.pid ?? 0)).toBe('dead');
  });

  it('refuses before launching when aborted first', async () => {
    const controller = new AbortController();
    controller.abort();
    const failure = failed(await executor({ signal: controller.signal }).execute(plan(forever)));
    expect(failure).toMatchObject({ code: 'workflow.interrupted', launch: { pid: null } });
  });

  it('numbers launch files exclusively and keeps them owner-only', async () => {
    const run = executor();
    failed(await run.execute(plan('process.exit(2)')));
    failed(await run.execute(plan('process.exit(2)')));
    const launch = join(stateDir, 'r1', 'launch');
    expect((await readdir(launch)).sort()).toEqual([
      '1.log',
      '1.result.json',
      '1.runner.json',
      '2.log',
      '2.result.json',
      '2.runner.json',
    ]);
    expect((await stat(launch)).mode & 0o777).toBe(0o700);
    expect((await stat(join(stateDir, 'r1'))).mode & 0o777).toBe(0o700);
    for (const name of await readdir(launch))
      expect((await stat(join(launch, name))).mode & 0o777).toBe(0o600);
  });

  it('records the spawned runner after spawn, numbered with its log', async () => {
    const result = started(await executor().execute(plan(`${own} ${forever}`)));
    const recorded = join(stateDir, 'r1', 'launch', '1.runner.json');
    expect(JSON.parse(await readFile(recorded, 'utf8'))).toEqual({
      pid: result.pid,
      host: hostname(),
      osStartTime: expect.any(String) as unknown,
    });
    expect((await stat(recorded)).mode & 0o777).toBe(0o600);
  });

  it('starts as usual when the runner record cannot be written', async () => {
    let calls = 0;
    const result = started(
      await executor({
        recordRunner: () => {
          calls++;
          return Promise.reject(new Error('read-only'));
        },
      }).execute(plan(`${own} ${forever}`)),
    );
    expect(calls).toBe(1);
    expect(result.status).toBe('running');
    expect(existsSync(join(stateDir, 'r1', 'launch', '1.runner.json'))).toBe(false);
  });

  it('tracks the runner before the runner record write settles', async () => {
    const tracked: number[] = [];
    const supervisor = new ProcessSupervisor();
    const track = supervisor.track.bind(supervisor);
    supervisor.track = (record) => {
      tracked.push(record.pid);
      return track(record);
    };
    const write: { pid: number | null; release: (() => void) | null } = {
      pid: null,
      release: null,
    };
    const gate = new Promise<boolean>((resolve) => {
      write.release = () => {
        resolve(true);
      };
    });
    const pending = executor({
      processSupervisor: supervisor,
      recordRunner: (_launchDir, _n, pid) => {
        write.pid = pid;
        return gate;
      },
    }).execute(plan(`${own} ${forever}`));
    while (write.pid === null) await delay(10);
    // The record write is still pending, yet an interrupt could already reach the runner.
    expect(tracked).toEqual([write.pid]);
    write.release?.();
    const result = started(await pending);
    expect(result.pid).toBe(write.pid);
    expect(tracked).toEqual([write.pid]);
  });

  it('never overwrites a runner record, and skips its slot when allocating', async () => {
    const launch = join(stateDir, 'r1', 'launch');
    await mkdir(launch, { recursive: true });
    await writeFile(join(launch, '1.runner.json'), 'kept');
    expect(await writeRunnerIdentity(launch, 1, process.pid)).toBe(false);
    expect(await readFile(join(launch, '1.runner.json'), 'utf8')).toBe('kept');
    const failure = failed(await executor().execute(plan('process.exit(2)')));
    expect(failure.launch?.log).toBe(join(launch, '2.log'));
    expect(await readFile(join(launch, '1.runner.json'), 'utf8')).toBe('kept');
    expect(existsSync(join(launch, '2.runner.json'))).toBe(true);
  });

  it('removes the partial runner record when writing it fails', async () => {
    const launch = join(stateDir, 'r1', 'launch');
    await mkdir(launch, { recursive: true });
    const failingOpen = (async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      handle.writeFile = () => Promise.reject(new Error('disk full'));
      return handle;
    }) as typeof open;
    expect(await writeRunnerIdentity(launch, 1, process.pid, failingOpen)).toBe(false);
    expect(existsSync(join(launch, '1.runner.json'))).toBe(false);
  });

  it('skips a slot whose result file already exists', async () => {
    const launch = join(stateDir, 'r1', 'launch');
    await mkdir(launch, { recursive: true });
    await writeFile(join(launch, '1.result.json'), 'kept');
    const failure = failed(await executor().execute(plan('process.exit(2)')));
    expect(failure.launch?.result).toBe(join(launch, '2.result.json'));
    expect(await readFile(join(launch, '1.result.json'), 'utf8')).toBe('kept');
  });

  it('writes stdin input to an owner-only file and passes it as @file', async () => {
    const script = `require('fs').writeFileSync(${JSON.stringify(join(root, 'argv.json'))}, JSON.stringify(process.argv.slice(1))); process.exit(2);`;
    const failure = failed(
      await executor().execute(
        plan(script, {
          argv: [process.execPath, '-e', script, '--', '--input', '-'],
          stdinInput: { value: { from: 'stdin' }, argvIndex: 5 },
        }),
      ),
    );
    const input = join(stateDir, 'r1', 'launch', '1.input.json');
    expect(failure.code).toBe('start.exited');
    expect(JSON.parse(await readFile(join(root, 'argv.json'), 'utf8'))).toEqual([
      '--input',
      `@${input}`,
    ]);
    expect(JSON.parse(await readFile(input, 'utf8'))).toEqual({ from: 'stdin' });
    expect((await stat(input)).mode & 0o777).toBe(0o600);
  });

  it('refuses run.exists without spawning or creating launch files', async () => {
    await mkdir(join(stateDir, 'r1'), { recursive: true });
    await writeFile(join(stateDir, 'r1', 'run.json'), '{}');
    const failure = failed(await executor().execute(plan(`${own} ${forever}`)));
    expect(failure).toMatchObject({ code: 'run.exists', runId: 'r1', stateDir });
    expect(failure.launch).toBeUndefined();
    expect(existsSync(join(stateDir, 'r1', 'launch'))).toBe(false);
    expect(existsSync(marker())).toBe(false);
  });

  it('refuses a legacy flat checkpoint too', async () => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'r1.json'), '{}');
    expect(failed(await executor().execute(plan(forever))).code).toBe('run.exists');
  });

  it('names the unlock entry of a held legacy guard at the top level', async () => {
    const guard = join(stateDir, 'r1.json.lock');
    await mkdir(guard, { recursive: true });
    await writeFile(
      join(guard, 'owner.json'),
      JSON.stringify({ pid: 2_000_000_000, host: `${hostname()}-gone`, token: 'far' }),
    );
    const failure = failed(await executor().execute(plan(`${own} ${forever}`)));
    expect(failure).toMatchObject({ code: 'run.locked', stateDir });
    expect(failure.runId ?? null).toBeNull();
    const details = failure.details as { next: { argv: string[] }[] };
    expect(details.next.length).toBeGreaterThan(0);
    expect(failure.next).toEqual(details.next);
    expect(failure.next?.some((entry) => entry.argv.includes('--force-remote'))).toBe(true);
    expect(failure.next?.[0]?.argv.slice(0, 4)).toEqual(['qc', 'workflow', 'unlock', 'r1']);
    expect(existsSync(marker())).toBe(false);
  });

  it('reports a runner that cannot be spawned', async () => {
    const failure = failed(
      await executor().execute(plan('', { argv: [join(root, 'missing-binary')] })),
    );
    expect(failure).toMatchObject({ code: 'start.exited', launch: { pid: null } });
    expect(failure.message).toContain('Could not launch the runner');
  });

  it('reports launch-file storage failures as workflow.storage', async () => {
    await writeFile(join(root, 'file'), '');
    const failure = failed(
      await executor().execute(plan(forever, { stateDir: join(root, 'file', 'runs') })),
    );
    expect(failure.code).toBe('workflow.storage');
  });
});

/** A real completed run with one recorded execution, the baseline a resume must exceed. */
async function completedRun(runId = 'r1'): Promise<void> {
  const workflow = defineWorkflow({
    name: 'observed',
    version: '1',
    input: z.null(),
    output: z.string(),
    run: () => Promise.resolve('done'),
  });
  await runWorkflow(workflow, { runId, stateDir, input: null });
}

/** A fake runner script that marks the record with these executions; `$pid` is its own PID. */
function markExecutions(status: string, executions: string, ownerPid = 'null'): string {
  return `require('fs').writeFileSync(process.argv[1], JSON.stringify({ status: ${JSON.stringify(status)}, ownerPid: ${ownerPid}, executions: ${executions} }));`;
}

describe('StartWorkflowExecutor resume', () => {
  it('reports a resume once the runner records an execution above the baseline', async () => {
    await completedRun();
    const script = `${markExecutions('running', '[{ n: 1, pid: 1 }, { n: 2, pid: process.pid }]', 'process.pid')} ${forever}`;
    const result = started(await executor().execute(plan(script, { resume: true })));
    expect(result).toMatchObject({
      runId: 'r1',
      status: 'running',
      log: join(stateDir, 'r1', 'launch', '1.log'),
    });
    expect(pidState(result.pid)).toBe('alive');
  });

  it('does not count an execution at or below the baseline that carries the runner’s PID', async () => {
    // PID reuse: the record's last execution (n 1) names the new runner's PID, but it is old.
    await completedRun();
    const script = `${markExecutions('running', '[{ n: 1, pid: process.pid }]', 'process.pid')} ${forever}`;
    const failure = failed(
      await executor().execute(plan(script, { resume: true, timeoutMs: 1_000 })),
    );
    expect(failure).toMatchObject({ code: 'start.timeout', runId: 'r1' });
    expect(failure.message).toContain('no execution recorded by its resuming runner');
  });

  it('reports a refusal under the lock with its own code and the run ID', async () => {
    // The runner owned the lock, then refused before recording an execution.
    await completedRun();
    const incompatible = JSON.stringify({
      kind: 'workflow.error',
      ok: false,
      exitCode: 3,
      error: {
        code: 'run.incompatible',
        message: 'Run r1 is incompatible.',
        stepId: null,
        details: null,
      },
      next: [],
    });
    const script = `${markExecutions('completed', '[{ n: 1, pid: 1 }]', 'process.pid')}
      setTimeout(() => { process.stdout.write(${JSON.stringify(incompatible)} + '\\n'); process.exit(3); }, 100);`;
    const failure = failed(await executor().execute(plan(script, { resume: true })));
    expect(failure).toMatchObject({
      code: 'run.incompatible',
      message: 'Run r1 is incompatible.',
      runId: 'r1',
      launch: { runId: 'r1', exitCode: 3 },
    });
  });

  it('reports the stored status of a completed run whose resume records no execution', async () => {
    await completedRun();
    const script = `${markExecutions('completed', '[{ n: 1, pid: 1 }]')}
      process.stdout.write(JSON.stringify({ kind: 'workflow.run.result', ok: true }) + '\\n');`;
    const result = started(await executor().execute(plan(script, { resume: true })));
    expect(result.status).toBe('completed');
  });

  it('refuses a missing run with run.not_found without spawning or creating its directory', async () => {
    const failure = failed(await executor().execute(plan(`${own} ${forever}`, { resume: true })));
    expect(failure).toMatchObject({ code: 'run.not_found', runId: null, stateDir });
    expect(failure.launch).toBeUndefined();
    expect(existsSync(join(stateDir, 'r1'))).toBe(false);
    expect(existsSync(marker())).toBe(false);
  });

  it('takes the next launch number and keeps the earlier launch’s files', async () => {
    await completedRun();
    const launch = join(stateDir, 'r1', 'launch');
    await mkdir(launch, { recursive: true });
    await writeFile(join(launch, '1.log'), 'first');
    await writeFile(join(launch, '1.result.json'), 'first');
    const script = `${markExecutions('running', '[{ n: 1, pid: 1 }, { n: 2, pid: process.pid }]')} ${forever}`;
    const result = started(await executor().execute(plan(script, { resume: true })));
    expect(result.log).toBe(join(launch, '2.log'));
    expect(result.result).toBe(join(launch, '2.result.json'));
    expect(await readFile(join(launch, '1.log'), 'utf8')).toBe('first');
    expect(await readFile(join(launch, '1.result.json'), 'utf8')).toBe('first');
  });

  it('launches beside an unmigrated flat run, which the runner then migrates', async () => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, 'legacy.json'),
      await readFile(new URL('./fixtures/storage/v1.json', import.meta.url), 'utf8'),
    );
    const prepared = await prepareStartLaunch({
      runId: 'legacy',
      stateDir,
      cwd: root,
      resume: true,
    });
    if (!prepared.ok) throw new Error(`Expected launch files: ${prepared.code}`);
    await Promise.all(prepared.files.handles.map((handle) => handle.close()));
    const launch = join(stateDir, 'legacy', 'launch');
    expect(prepared.files.log).toBe(join(launch, '1.log'));
    // The resume's migration (as in test/run-removal.test.ts) creates `legacy/` around launch/.
    const definition = defineWorkflow({
      name: 'legacy-v1',
      version: '1',
      input: z.null(),
      output: z.string(),
      run: async (ctx) => {
        const value = await ctx.step('local', { input: null, schema: z.number(), run: () => 7 });
        const agent = await ctx.claude.text('agent', { prompt: 'legacy question' });
        await ctx.sleep('pause', 0);
        return `${String(value)}/${agent.output}`;
      },
    });
    await expect(
      runWorkflow(definition, {
        stateDir,
        runId: 'legacy',
        cwd: '/quiet-choir/legacy-project',
        input: null,
        resume: true,
        fingerprint: 'fixed-source',
        acceptCodeChange: true,
      }),
    ).rejects.toThrow('no pinned isolation mode');
    expect((await readRun({ stateDir, runId: 'legacy' })).formatVersion).toBe(7);
    expect((await readdir(launch)).sort()).toEqual(['1.log', '1.result.json']);
  });
});

describe('observeStartedRun', () => {
  it('reads nothing for a missing record and the status and executions of a released one', async () => {
    expect(await observeStartedRun(stateDir, 'missing')).toEqual({
      status: null,
      ownerPid: null,
      executions: [],
    });
    await completedRun('done');
    expect(await observeStartedRun(stateDir, 'done')).toEqual({
      status: 'completed',
      ownerPid: null,
      executions: [{ n: 1, pid: process.pid }],
    });
  });
});
