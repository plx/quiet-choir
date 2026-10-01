import { fork } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { NodeProcessRunner } from '../src/index.js';
import { WorktreeGit } from '../src/worktrees/git.js';
import { testInvocation } from './harness-invocation.js';

// Separate processes add, list and remove worktrees of one repository at the same time. Git's own
// commondir race does not reproduce reliably, so the proof is the shared log: no two processes are
// ever inside a critical section together.
let directory: string, repo: string, common: string;
const git = new WorktreeGit(new NodeProcessRunner());
const invocation = testInvocation();
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'choir-admin-race-')));
  repo = join(directory, 'repo');
  await mkdir(repo);
  await git.run(repo, ['init', '-q'], invocation);
  await writeFile(join(repo, 'file.txt'), 'base\n');
  await git.run(repo, ['add', '--all'], invocation);
  await git.run(
    repo,
    ['-c', 'user.name=test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'baseline'],
    invocation,
  );
  common = await realpath(join(repo, '.git'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const children = 4;
const cycles = 8;

// measured: 2.7 s alone, 9.3 s in the full coverage run on a loaded machine (four tsx child
// startups and 96 serialized Git commands dominate).
it(
  'serializes real worktree add, list and remove across racing processes',
  { timeout: 30_000 },
  async () => {
    const childPath = fileURLToPath(new URL('./worktree-admin-race-child.mjs', import.meta.url));
    const root = join(directory, 'worktrees');
    const log = join(directory, 'admin.log');
    await mkdir(root);
    await writeFile(log, '');
    const outcomes = await Promise.all(
      Array.from({ length: children }, () => {
        const child = fork(childPath, [repo, common, root, log, String(cycles)], {
          execArgv: ['--import', 'tsx'],
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        let stderr = '';
        child.stderr?.on('data', (chunk) => {
          stderr += String(chunk);
        });
        let completed = 0;
        child.on('message', (message) => {
          if (typeof message === 'object' && 'cycles' in message)
            completed = Number(message.cycles);
        });
        return new Promise<{ code: number | null; stderr: string; completed: number }>(
          (resolve, reject) => {
            child.once('error', reject);
            child.once('exit', (code) => {
              resolve({ code, stderr, completed });
            });
          },
        );
      }),
    );
    for (const outcome of outcomes) {
      expect(outcome.code, outcome.stderr).toBe(0);
      expect(outcome.completed).toBe(cycles);
    }
    const records = (await readFile(log, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { pid: number; event: 'enter' | 'exit'; label: string });
    expect(records).toHaveLength(children * cycles * 3 * 2);
    expect(new Set(records.map((record) => record.pid)).size).toBe(children);
    const overlaps: string[] = [];
    let holder: number | undefined;
    for (const [index, record] of records.entries()) {
      if (record.event === 'enter') {
        if (holder !== undefined)
          overlaps.push(
            `#${String(index)}: ${String(record.pid)} entered inside ${String(holder)}`,
          );
        holder = record.pid;
      } else {
        if (holder !== record.pid)
          overlaps.push(`#${String(index)}: ${String(record.pid)} exited outside its section`);
        holder = undefined;
      }
    }
    expect(overlaps).toEqual([]);
    const listed = await git.run(repo, ['worktree', 'list', '--porcelain', '-z'], invocation);
    expect(listed.stdout.split('\0').filter((field) => field.startsWith('worktree '))).toEqual([
      `worktree ${repo}`,
    ]);
    expect(await readdir(join(common, 'quiet-choir'))).toEqual([]);
  },
);
