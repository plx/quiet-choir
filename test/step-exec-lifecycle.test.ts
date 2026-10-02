import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { groupState } from '../src/processes/identity.js';
import { NodeProcessRunner, runWorkflow } from '../src/index.js';
import { fingerprint, lifecycle, pollLifecycle } from './step-exec-workflow.js';

let directory: string;
const groups: number[] = [];
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'choir-step-exec-lifecycle-')));
});
afterEach(async () => {
  for (const pgid of groups.splice(0))
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  await rm(directory, { recursive: true, force: true });
});

interface ProcessRecord {
  readonly pid: number;
  readonly pgid: number | null;
  readonly stepId: string;
  readonly attempt: number;
}

/**
 * Fork a runner of `mode`'s workflow, SIGKILL it while its command hangs, and check that the
 * command was recorded under `stepId`, refused as an orphan on resume and reaped by killOrphans.
 */
async function orphanAfterSigkill(mode: 'step' | 'poll', stepId: string): Promise<void> {
  const stateDir = join(directory, 'state');
  const ready = join(directory, 'ready');
  const resumed = join(directory, 'resumed');
  const child = fork(
    fileURLToPath(new URL('./step-exec-lifecycle-child.mjs', import.meta.url)),
    [stateDir, directory, ready, resumed, mode],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const exited = once(child, 'exit');
  const processes = join(stateDir, 'lifecycle', 'lock', 'processes');
  let recorded: ProcessRecord | undefined;
  try {
    await vi.waitFor(
      async () => {
        if (child.exitCode !== null) throw new Error(`Runner exited early: ${stderr}`);
        await readFile(ready, 'utf8');
        const [file] = await readdir(processes);
        if (file === undefined) throw new Error('No process record yet.');
        recorded = JSON.parse(await readFile(join(processes, file), 'utf8')) as ProcessRecord;
      },
      { timeout: 20_000, interval: 50 },
    );
  } finally {
    child.kill('SIGKILL');
    await exited;
  }
  if (!recorded) throw new Error('missing process record');
  groups.push(recorded.pgid ?? recorded.pid);
  expect(recorded).toMatchObject({ stepId, attempt: 1 });
  expect(recorded.pid).toBe(Number(await readFile(ready, 'utf8')));
  expect(groupState(recorded)).toBe('alive');

  const options = {
    runId: 'lifecycle',
    stateDir,
    cwd: directory,
    resume: true,
    fingerprint,
    processRunner: new NodeProcessRunner(),
  };
  const workflow = mode === 'poll' ? pollLifecycle : lifecycle;
  const refused = await runWorkflow(workflow, options).catch((error: unknown) => error);
  expect(refused).toMatchObject({
    code: 'run.orphans',
    details: { processes: [{ state: 'alive', process: { stepId, attempt: 1 } }] },
  });
  expect(groupState(recorded)).toBe('alive');

  await writeFile(resumed, '');
  const run = await runWorkflow(workflow, { ...options, killOrphans: true, killGraceMs: 100 });
  expect(run).toMatchObject({ status: 'completed', output: 'done' });
  expect(groupState(recorded)).toBe('dead');
  await expect(stat(join(stateDir, 'lifecycle', 'lock'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
}

// measured: 0.5 s alone (one tsx child startup, then two in-process resumes); the child's tsx
// startup dominates, so this keeps a raised limit like lock-race.test.ts.
it.skipIf(process.platform === 'win32')(
  'records an inner command under the parent step and recovers it as an orphan after SIGKILL',
  { timeout: 15_000 },
  () => orphanAfterSigkill('step', 'parent'),
);

// measured: 0.5 s alone, like the case above (one tsx child startup, two in-process resumes).
it.skipIf(process.platform === 'win32')(
  'records a command poll command under its wait and recovers it as an orphan after SIGKILL',
  { timeout: 15_000 },
  () => orphanAfterSigkill('poll', 'ci'),
);
