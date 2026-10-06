import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RunRecord } from '../src/index.js';
import { formatRunSummary } from '../src/cli/inspection-view.js';
import { NodeProcessRunner } from '../src/processes/runner.js';
import { WorkflowExecutor } from '../src/workflow/loader/executor.js';
import type { WorkflowCommandResult } from '../src/workflow/loader/model.js';
import type { ProcessRunner } from '../src/workflow/runtime/exec-model.js';

// Plain `workflow inspect` reports the worktree administration lock of a run's repository (#243).

let root: string, stateDir: string, repo: string, common: string, lockPath: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'choir-inspect-admin-')));
  stateDir = join(root, 'state');
  repo = join(root, 'repo');
  await mkdir(stateDir);
  await mkdir(repo);
  execFileSync('git', ['-C', repo, 'init', '--quiet']);
  common = await realpath(join(repo, '.git'));
  lockPath = join(common, 'quiet-choir', 'worktree-admin.lock');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const time = '2026-01-01T00:00:00.000Z';
async function save(worktrees: { repo: string } | undefined): Promise<void> {
  const run: RunRecord = {
    formatVersion: 1,
    id: 'run',
    workflow: { name: 'example', version: '1', fingerprint: null },
    status: 'completed',
    cwd: '/',
    input: null,
    output: null,
    error: null,
    steps: {},
    createdAt: time,
    updatedAt: time,
    ...(worktrees === undefined
      ? {}
      : {
          worktrees: {
            namespace: '00000000-0000-4000-8000-000000000000',
            repo: worktrees.repo,
            root: join(root, 'caches'),
            caches: {},
            handles: {},
            refs: {},
          },
        }),
  };
  await writeFile(join(stateDir, 'run.json'), JSON.stringify(run));
}

async function plant(owner: { pid: number; host?: string }): Promise<void> {
  await mkdir(lockPath, { recursive: true });
  await writeFile(
    join(lockPath, 'owner.json'),
    JSON.stringify({ host: hostname(), token: 'tok', osStartTime: null, ...owner }),
  );
}

/** A runner that records every command, then runs it for real. */
function recording(): { runner: ProcessRunner; commands: string[][] } {
  const commands: string[][] = [];
  const real = new NodeProcessRunner();
  return {
    commands,
    runner: {
      run: (request, invocation) => {
        if (!('shell' in request.command)) commands.push([...request.command]);
        return real.run(request, invocation);
      },
    },
  };
}

async function inspect(
  options: { runner?: ProcessRunner; worktreeAdminLock?: boolean; log?: () => void } = {},
): Promise<Extract<WorkflowCommandResult, { kind: 'workflow.run.result' }>> {
  const executor = new WorkflowExecutor({
    logger: { log: options.log ?? (() => undefined) },
    ...(options.runner === undefined ? {} : { processRunner: options.runner }),
  });
  const result = await executor.execute({
    kind: 'workflow.inspect',
    runId: 'run',
    stateDir,
    ...(options.worktreeAdminLock === undefined
      ? {}
      : { worktreeAdminLock: options.worktreeAdminLock }),
  });
  if (result.kind !== 'workflow.run.result')
    throw new Error(`Unexpected ${result.kind}: ${JSON.stringify(result)}`);
  return result;
}

function text(result: Awaited<ReturnType<typeof inspect>>): string {
  if (!result.summary) throw new Error('No summary.');
  return formatRunSummary(
    result.summary,
    false,
    undefined,
    result.worktreeAdminLock,
    Date.parse(result.worktreeAdminLock?.owner?.acquiredAt ?? time) + 90_000,
  );
}

it('shows a dead holder with its age and the unlock command', async () => {
  await save({ repo });
  const pid = spawnSync(process.execPath, ['-e', '']).pid;
  await plant({ pid });
  const result = await inspect();
  expect(result.worktreeAdminLock).toEqual({
    commonGitDir: common,
    path: lockPath,
    owner: {
      pid,
      host: hostname(),
      token: 'tok',
      state: 'dead',
      osStartTime: null,
      acquiredAt: expect.any(String) as unknown,
    },
    recovery: null,
  });
  const lines = text(result).split('\n');
  expect(lines).toContain(
    `Worktree admin lock ${lockPath}: owner pid ${String(pid)} (dead) on ${hostname()}, held 1m30s`,
  );
  expect(lines).toContain(`Unlock: quiet-choir workflow unlock --worktree-admin ${common}`);
});

it('gives no unlock hint for a live holder', async () => {
  await save({ repo });
  await plant({ pid: process.ppid });
  const output = text(await inspect());
  expect(output).toContain(
    `Worktree admin lock ${lockPath}: owner pid ${String(process.ppid)} (alive)`,
  );
  expect(output).not.toContain('--worktree-admin');
});

it('adds --force-remote and its caveat for a foreign holder', async () => {
  await save({ repo });
  await plant({ pid: 4242, host: 'elsewhere.invalid' });
  expect(text(await inspect())).toContain(
    `Unlock: quiet-choir workflow unlock --worktree-admin ${common} --force-remote (only if elsewhere.invalid is this machine under an old name or is permanently gone)`,
  );
});

it('reports nothing without a held lock, or when the plan opts out', async () => {
  await save({ repo });
  const free = await inspect();
  expect(free).not.toHaveProperty('worktreeAdminLock');
  expect(text(free)).not.toContain('Worktree admin lock');
  await plant({ pid: 4242, host: 'elsewhere.invalid' });
  const { runner, commands } = recording();
  expect(await inspect({ runner, worktreeAdminLock: false })).not.toHaveProperty(
    'worktreeAdminLock',
  );
  expect(commands).toEqual([]);
});

it('runs no Git for a run without a worktree ledger, and one rev-parse for a run with one', async () => {
  await save(undefined);
  const { runner, commands } = recording();
  await plant({ pid: 4242, host: 'elsewhere.invalid' });
  expect(await inspect({ runner })).not.toHaveProperty('worktreeAdminLock');
  expect(commands).toEqual([]);
  await save({ repo });
  expect((await inspect({ runner })).worktreeAdminLock?.owner?.host).toBe('elsewhere.invalid');
  expect(commands).toHaveLength(1);
  expect(commands[0]).toContain('rev-parse');
});

it('never fails the inspection when the repository is gone', async () => {
  await save({ repo: join(root, 'missing') });
  const log = vi.fn();
  const result = await inspect({ log });
  expect(result).toMatchObject({ ok: true });
  expect(result).not.toHaveProperty('worktreeAdminLock');
  expect(log).toHaveBeenCalledWith(
    'debug',
    expect.stringContaining('could not read the worktree administration lock'),
  );
});
