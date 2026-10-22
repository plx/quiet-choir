// The durable steps of the merge-down package (packages/merge-down.quiet-choir/lib, #589) run for
// real against a scratch Git repository.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defineWorkflow,
  NodeProcessRunner,
  runWorkflow,
  z,
  type WorkflowContext,
} from '../src/index.js';
import { runCheck } from '../packages/merge-down.quiet-choir/lib/checks.js';

let real: string;
beforeEach(async () => {
  real = await realpath(await mkdtemp(join(tmpdir(), 'choir-merge-down-steps-')));
});
afterEach(async () => {
  await rm(real, { recursive: true, force: true });
});

const definition = (run: (ctx: WorkflowContext) => Promise<unknown>) =>
  defineWorkflow({
    name: 'merge-down-steps',
    version: '1',
    input: z.null(),
    output: z.unknown(),
    run,
  });
const setup = (resume = false) => ({
  cwd: real,
  stateDir: join(real, 'runs'),
  runId: 'test',
  input: null,
  processRunner: new NodeProcessRunner(),
  ...(resume ? { resume: true } : {}),
});

/** A repository with one commit at `dir`; returns its HEAD. */
async function repository(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();
  git('init', '-q', '-b', 'main');
  await writeFile(join(dir, 'README.md'), 'hello\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return git('rev-parse', 'HEAD');
}

describe('runCheck', () => {
  it('logs every part of a compound command, including one with a trailing comment', async () => {
    const workdir = join(real, 'worktree');
    const dir = join(real, 'state');
    await repository(workdir);
    const run = await runWorkflow(
      definition((ctx) =>
        runCheck(ctx, 'check', {
          workdir,
          dir,
          label: 'check-0',
          command: 'echo first part failed; false && echo second part # trailing comment',
        }),
      ),
      setup(),
    );
    expect(run.output).toMatchObject({ passed: false, exitCode: 1, error: null });
    expect(await readFile(join(dir, 'check-0.log'), 'utf8')).toBe('first part failed\n');
    expect(await readFile(join(dir, 'check-0.excerpt.txt'), 'utf8')).toBe('first part failed\n');
  });
});
