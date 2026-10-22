// The durable steps of the merge-down package (packages/merge-down.quiet-choir/lib, #589) run for
// real against a scratch Git repository.
import { execFileSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defineWorkflow,
  NodeProcessRunner,
  runWorkflow,
  z,
  type WorkflowContext,
} from '../src/index.js';

// The package imports `quiet-choir`, which resolves to dist/, and npm run check typechecks and
// tests before it builds. So the import maps to src/ here, and the modules load by a computed
// specifier the root typecheck does not follow; the package's own typecheck covers them.
vi.mock('quiet-choir', () => import('../src/index.js'));
const lib = async <T>(name: string): Promise<T> => {
  const url = new URL(`../packages/merge-down.quiet-choir/lib/${name}.ts`, import.meta.url);
  return (await import(url.href)) as T;
};
const { runCheck } = await lib<{
  runCheck: (
    ctx: WorkflowContext,
    id: string,
    input: { workdir: string; dir: string; label: string; command: string },
  ) => Promise<unknown>;
}>('checks');
const { localCodexReview } = await lib<{
  localCodexReview: (
    ctx: WorkflowContext,
    input: {
      label: string;
      paths: { root: string; workdir: string; stateDir: string; dir: string };
      base: string;
      sha: string;
      model: string;
      effort: string | null;
    },
  ) => Promise<unknown>;
}>('codex');

let real: string;
beforeEach(async () => {
  real = await realpath(await mkdtemp(join(tmpdir(), 'choir-merge-down-steps-')));
});
afterEach(async () => {
  vi.unstubAllEnvs();
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

describe('localCodexReview', () => {
  it('resumes a finished review after teardown under a symlinked root', async () => {
    // The root is reached through a symlink, so the review worktree's path is not canonical.
    const root = join(real, 'link');
    await mkdir(join(real, 'target'));
    await symlink(join(real, 'target'), root);
    const workdir = join(root, 'worktree');
    const dir = join(root, 'state', 'pr-1');
    await mkdir(dir, { recursive: true });
    const sha = await repository(workdir);
    const bin = join(real, 'bin');
    const calls = join(real, 'codex-calls');
    await mkdir(bin);
    await writeFile(
      join(bin, 'codex'),
      `#!/bin/sh\necho run >> '${calls}'\necho 'No issues found.'\n`,
    );
    await chmod(join(bin, 'codex'), 0o755);
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env['PATH'] ?? ''}`);

    let crash = true;
    const workflow = definition(async (ctx) => {
      const review = await localCodexReview(ctx, {
        label: 'r0',
        paths: { root, workdir, stateDir: join(root, 'state'), dir },
        base: 'main',
        sha,
        model: 'gpt-test',
        effort: null,
      });
      if (crash) throw new Error('crashed after the review');
      return review;
    });
    await expect(runWorkflow(workflow, setup())).rejects.toThrow('crashed after the review');
    crash = false;
    const resumed = await runWorkflow(workflow, setup(true));
    expect(resumed.status).toBe('completed');
    expect(resumed.output).toMatchObject({ sha, deps: 'none', findings: 0, error: null });
    expect(await readFile(calls, 'utf8')).toBe('run\n');
  });
});
