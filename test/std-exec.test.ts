// quiet-choir/std exec helpers (#588): json, git and committedArtifact against a real temporary Git
// repository, with an inert harness (none of these workflows calls an agent).
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  NodeProcessRunner,
  defineWorkflow,
  readRun,
  runWorkflow,
  z,
  ExecError,
  type ExecOptions,
  type Harness,
  type WorkflowContext,
  type WorkflowDefinition,
} from '../src/index.js';
import * as std from '../src/std/index.js';
import { digest } from '../src/workflow/runtime/json.js';

const execute = promisify(execFile);
let root: string;
let repo: string;

const inert: Harness = {
  kind: 'std-exec-inert',
  invoke() {
    throw new Error('These workflows call no agent.');
  },
};

async function git(...args: string[]): Promise<string> {
  const identity = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid'];
  const { stdout } = await execute('git', [...identity, '-c', 'commit.gpgSign=false', ...args], {
    cwd: repo,
  });
  return stdout;
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'choir-std-exec-')));
  repo = join(root, 'repo');
  await mkdir(repo);
  await git('init', '--quiet');
  const hooks = join(root, 'empty-hooks');
  await mkdir(hooks);
  await git('config', '--local', 'core.hooksPath', hooks);
  await mkdir(join(root, 'outside'));
  await writeFile(join(repo, 'exists.md'), 'old\n');
  await symlink(join(root, 'outside'), join(repo, 'link'));
  await git('add', '--all');
  await git('commit', '--quiet', '-m', 'base');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A workflow whose body is `body`, run with a real process runner and runtime worktrees. */
function workflow<O>(
  output: z.ZodType<O>,
  body: (ctx: WorkflowContext) => Promise<O>,
): WorkflowDefinition<null, O> {
  return defineWorkflow({
    name: 'std-exec',
    version: '1',
    input: z.null(),
    output,
    run: (ctx) => body(ctx),
  });
}
const options = (runId: string) => ({
  runId,
  cwd: repo,
  stateDir: join(root, 'state'),
  fingerprint: 'std-exec-v1',
  input: null,
  harness: inert,
  processRunner: new NodeProcessRunner(),
  worktrees: { root: join(root, 'worktrees') },
});

it('json pretty-prints with two spaces', () => {
  expect(std.exec.json({ a: [1, 'b'] })).toBe('{\n  "a": [\n    1,\n    "b"\n  ]\n}');
});

it.each([[undefined], [() => 1], [Symbol('s')]])(
  'json refuses a value JSON.stringify cannot serialize to text (%s)',
  (value) => {
    expect(() => std.exec.json(value)).toThrow(new TypeError('Value is not JSON-serializable'));
  },
);

it('git returns complete stdout and refuses truncated output', async () => {
  const head = (await git('rev-parse', 'HEAD')).trim();
  const read = workflow(z.string(), (ctx) => std.exec.git(ctx, 'head', ['rev-parse', 'HEAD']));
  const result = await runWorkflow(read, options('git'));
  expect(result.output?.trim()).toBe(head);
  const truncated = workflow(z.string(), (ctx) =>
    std.exec.git(ctx, 'head', ['rev-parse', 'HEAD'], { maxOutputBytes: 8 }),
  );
  await expect(runWorkflow(truncated, options('git-truncated'))).rejects.toThrow(
    'Incomplete Git output: head',
  );
});

it('git saves a truncated read as a completed command, so a resume with a larger cap throws again', async () => {
  let maxOutputBytes = 8;
  const read = workflow(z.string(), (ctx) =>
    std.exec.git(ctx, 'head', ['rev-parse', 'HEAD'], { maxOutputBytes }),
  );
  await expect(runWorkflow(read, options('git-sticky'))).rejects.toThrow(
    'Incomplete Git output: head',
  );
  const run = await readRun({ stateDir: join(root, 'state'), runId: 'git-sticky' });
  expect(run.steps['head']?.status).toBe('completed');
  expect(run.steps['head']?.output).toMatchObject({ truncated: true });
  // The cap is policy, so the resume replays the truncated read instead of running Git again.
  // #ISSUE-C11-1 tracks a recoverable read; resolving it flips these assertions.
  maxOutputBytes = 1_048_576;
  await expect(runWorkflow(read, { ...options('git-sticky'), resume: true })).rejects.toThrow(
    'Incomplete Git output: head',
  );
});

it('git always throws a failure, even when the options were widened to onError return', async () => {
  const widened: ExecOptions = { onError: 'return' };
  const failing = workflow(z.string(), async (ctx) => {
    try {
      await std.exec.git(ctx, 'missing', ['rev-parse', '--verify', 'refs/heads/none'], widened);
      return 'returned';
    } catch (error) {
      return error instanceof ExecError ? 'ExecError' : 'other';
    }
  });
  const failure = await runWorkflow(failing, options('git-widened-failure'));
  expect(failure.output).toBe('ExecError');
  const head = (await git('rev-parse', 'HEAD')).trim();
  const succeeding = workflow(z.string(), (ctx) =>
    std.exec.git(ctx, 'head', ['rev-parse', 'HEAD'], widened),
  );
  const result = await runWorkflow(succeeding, options('git-widened-success'));
  expect(result.output?.trim()).toBe(head);
});

it('committedArtifact writes a nested file, merges it into the checkout and returns the receipt', async () => {
  const content = '# Notes\n';
  const publish = workflow(
    z.object({
      path: z.string(),
      sha256: z.string(),
      bytes: z.number(),
      previousSha256: z.null(),
    }),
    async (ctx) => {
      const receipt = await std.exec.committedArtifact(ctx, 'docs/notes/out.md', content);
      return { ...receipt, previousSha256: null };
    },
  );
  const result = await runWorkflow(publish, options('publish'));
  expect(result.output).toEqual({
    path: join(repo, 'docs/notes/out.md'),
    sha256: createHash('sha256').update(content).digest('hex'),
    bytes: Buffer.byteLength(content),
    previousSha256: null,
  });
  expect(await readFile(join(repo, 'docs/notes/out.md'), 'utf8')).toBe(content);
  expect(await git('show', 'HEAD:docs/notes/out.md')).toBe(content);
  expect(await git('status', '--porcelain')).toBe('');
  expect(Object.keys(result.steps)).toEqual(
    expect.arrayContaining(['document', 'write', 'publish']),
  );
  // The write is identified by a versioned constant, not the library's callback text, so a release
  // that only reformats the helper keeps completed writes replayable.
  const write = (await readRun({ stateDir: join(root, 'state'), runId: 'publish' })).steps['write'];
  expect(write?.identity).not.toHaveProperty('callback');
  expect(write?.identity?.['version']).toBe(digest('committed-artifact/1'));
});

it('committedArtifact accepts a parent whose name only begins with two dots', async () => {
  const publish = workflow(z.number(), async (ctx) => {
    return (await std.exec.committedArtifact(ctx, '..generated/out.md', 'x')).bytes;
  });
  expect((await runWorkflow(publish, options('dotted'))).output).toBe(1);
  expect(await readFile(join(repo, '..generated/out.md'), 'utf8')).toBe('x');
});

it.each(['../x.md', '.git/x.md', '/abs/x.md', 'a\\b.md', 'a//b.md', './x.md', ''])(
  'committedArtifact refuses the path %j before any effect',
  async (path) => {
    const publish = workflow(z.null(), async (ctx) => {
      await std.exec.committedArtifact(ctx, path, 'x');
      return null;
    });
    await expect(runWorkflow(publish, options('bad-path'))).rejects.toThrow(
      'Use a repository-relative path without dot segments or .git',
    );
  },
);

it('committedArtifact refuses an existing file and a parent that escapes the checkout', async () => {
  const existing = workflow(z.null(), async (ctx) => {
    await std.exec.committedArtifact(ctx, 'exists.md', 'new\n');
    return null;
  });
  const refusal: unknown = await runWorkflow(existing, options('existing')).catch(
    (error: unknown) => error,
  );
  if (!(refusal instanceof Error)) throw new Error('Expected the existing file to be refused');
  // The refusal names the repository path, not the run's private worktree directory.
  expect(refusal.message).toContain('Artifact exists.md already exists at HEAD');
  expect(refusal.message).not.toContain(join(root, 'worktrees'));
  expect(await readFile(join(repo, 'exists.md'), 'utf8')).toBe('old\n');
  const escaping = workflow(z.null(), async (ctx) => {
    await std.exec.committedArtifact(ctx, 'link/x.md', 'x');
    return null;
  });
  await expect(runWorkflow(escaping, options('escaping'))).rejects.toThrow(
    'Artifact parent escapes checkout',
  );
});

it('committedArtifact gets past an untracked file at the path and refuses the dirty checkout', async () => {
  const head = await git('rev-parse', 'HEAD');
  await writeFile(join(repo, 'fresh.md'), 'local\n');
  const publish = workflow(z.null(), async (ctx) => {
    await std.exec.committedArtifact(ctx, 'fresh.md', 'x');
    return null;
  });
  // The write checks the `document` worktree, which starts from HEAD; only the merge sees the file.
  await expect(runWorkflow(publish, options('untracked'))).rejects.toThrow(
    'Merge target checkout is dirty',
  );
  expect(await readFile(join(repo, 'fresh.md'), 'utf8')).toBe('local\n');
  expect(await git('rev-parse', 'HEAD')).toBe(head);
  expect(await git('status', '--porcelain')).toBe('?? fresh.md\n');
  // Cleaning the checkout and resuming publishes the completed write.
  await rm(join(repo, 'fresh.md'));
  await runWorkflow(publish, { ...options('untracked'), resume: true });
  expect(await git('show', 'HEAD:fresh.md')).toBe('x');
});

it.each(['C:/outside/file', 'C:outside', 'c:\\x', '/abs/file', 'z:'])(
  'committedArtifact refuses the absolute or drive-letter path %s before any effect',
  async (path) => {
    const refused = workflow(z.null(), async (ctx) => {
      await std.exec.committedArtifact(ctx, path, 'x');
      return null;
    });
    await expect(runWorkflow(refused, options('drive-path'))).rejects.toThrow(
      'Use a repository-relative path without dot segments or .git',
    );
    expect(await git('worktree', 'list', '--porcelain')).not.toContain('document');
    expect(await git('branch', '--list')).not.toContain('document');
  },
);

it('committedArtifact replays after a tail failure without writing again', async () => {
  const publish = workflow(z.string(), async (ctx) => {
    const receipt = await ctx.scope('notes', () =>
      std.exec.committedArtifact(ctx, 'notes.md', 'once\n'),
    );
    await ctx.step('tail', {
      input: null,
      schema: z.null(),
      run({ attempt }) {
        if (attempt === 1) throw new Error('Injected tail failure');
        return null;
      },
    });
    return receipt.sha256;
  });
  await expect(runWorkflow(publish, options('resume'))).rejects.toThrow('Injected tail failure');
  const result = await runWorkflow(publish, { ...options('resume'), resume: true });
  expect(result.status).toBe('completed');
  expect(result.steps['notes/write']?.attempts).toBe(1);
  expect(result.steps['notes/publish']?.attempts).toBe(1);
  expect(await readFile(join(repo, 'notes.md'), 'utf8')).toBe('once\n');
});
