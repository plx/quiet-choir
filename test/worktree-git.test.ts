import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NodeProcessRunner, type ExecResult, type ProcessRunner } from '../src/index.js';
import {
  WorktreeGit,
  alternateEntry,
  changedFiles,
  commitId,
  mergeTreeOutput,
} from '../src/worktrees/git.js';
import { testInvocation } from './harness-invocation.js';

let directory: string;
const invocation = testInvocation();
const git = new WorktreeGit(new NodeProcessRunner());
const identity = {
  GIT_AUTHOR_NAME: 'quiet-choir',
  GIT_AUTHOR_EMAIL: 'quiet-choir@localhost',
  GIT_COMMITTER_NAME: 'quiet-choir',
  GIT_COMMITTER_EMAIL: 'quiet-choir@localhost',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
};
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'choir-git-')));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
async function commit(content: string, parent?: string) {
  return commitIn(directory, content, parent);
}
async function commitIn(cwd: string, content: string, parent?: string) {
  const blob = commitId(
    (
      await git.run(cwd, ['hash-object', '-w', '--stdin'], invocation, { input: content })
    ).stdout.trim(),
  );
  const tree = commitId(
    (
      await git.run(cwd, ['mktree', '-z'], invocation, {
        input: `100644 blob ${blob}\tline\nname\0`,
      })
    ).stdout.trim(),
  );
  return commitId(
    (
      await git.run(
        cwd,
        ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'snapshot'],
        invocation,
        { env: identity },
      )
    ).stdout.trim(),
  );
}

it('reads NUL-separated conflict paths while leaving HEAD and checkout untouched', async () => {
  await git.run(directory, ['init', '-q'], invocation);
  const base = await commit('baseline\n');
  await git.run(directory, ['update-ref', 'HEAD', base], invocation);
  const first = await commit('first\n', base);
  const second = await commit('second\n', base);
  const status = await git.text(directory, ['status', '--porcelain'], invocation);
  const result = await git.run(
    directory,
    ['merge-tree', '--write-tree', '--name-only', '-z', '--no-messages', first, second],
    invocation,
    { codes: [0, 1] },
  );
  expect(result.code).toBe(1);
  const parsed = mergeTreeOutput(result);
  expect(parsed.conflicts).toEqual(['line\nname']);
  expect(await git.text(directory, ['rev-parse', 'HEAD'], invocation)).toBe(base);
  expect(await git.text(directory, ['status', '--porcelain'], invocation)).toBe(status);
  expect(
    mergeTreeOutput(
      await git.run(
        directory,
        ['merge-tree', '--write-tree', '--name-only', '-z', '--no-messages', base, first],
        invocation,
      ),
    ),
  ).toEqual({
    tree: await git.text(directory, ['rev-parse', `${first}^{tree}`], invocation),
    conflicts: [],
  });
});

it('parses rename/copy/type-change paths without splitting whitespace', () => {
  expect(
    changedFiles(
      'A\0new name\0M\0changed\0D\0gone\0R100\0old\0line\nname\0C90\0source\0copy\0T\0link\0',
    ),
  ).toEqual([
    { path: 'new name', status: 'added' },
    { path: 'changed', status: 'modified' },
    { path: 'gone', status: 'deleted' },
    { path: 'line\nname', status: 'renamed' },
    { path: 'copy', status: 'added' },
    { path: 'link', status: 'modified' },
  ]);
  expect(changedFiles('')).toEqual([]);
  for (const invalid of ['M', 'R100\0old\0', 'U\0file\0'])
    expect(() => changedFiles(invalid)).toThrow();
});

it('clears inherited Git repository/index redirects and keeps fixed operation policy', async () => {
  vi.stubEnv('GIT_DIR', '/unexpected/repository');
  vi.stubEnv('GIT_INDEX_FILE', '/unexpected/index');
  // Git for Windows honors any casing; the filter must not rely on uppercase names.
  vi.stubEnv('Git_Dir', '/unexpected/mixed-case');
  const run = vi.fn<ProcessRunner['run']>(() =>
    Promise.resolve({
      code: 0,
      signal: null,
      stdout: 'ok\n',
      stderr: '',
      truncated: false,
      durationMs: 0,
    }),
  );
  expect(await new WorktreeGit({ run }).text(directory, ['status'], invocation)).toBe('ok');
  const request = run.mock.calls[0]?.[0];
  expect(request).toMatchObject({
    inheritEnv: false,
    capture: 'error',
    cwd: directory,
    timeoutMs: 120000,
  });
  expect(request?.env).not.toHaveProperty('GIT_DIR');
  expect(request?.env).not.toHaveProperty('GIT_INDEX_FILE');
  expect(request?.env).not.toHaveProperty('Git_Dir');
  expect(request?.command).toContain('core.fsmonitor=false');
});

it('rejects truncated or unsuccessful Git results and malformed merge protocol', async () => {
  const result: ExecResult = {
    code: 0,
    signal: null,
    stdout: '',
    stderr: 'failure',
    truncated: false,
    durationMs: 0,
  };
  for (const output of [
    { ...result, truncated: true },
    { ...result, code: 128 },
    { ...result, code: null, signal: 'SIGTERM' },
  ]) {
    await expect(
      new WorktreeGit({ run: () => Promise.resolve(output) }).run(directory, [], invocation),
    ).rejects.toThrow();
  }
  expect(() => commitId('HEAD')).toThrow('full object ID');
  expect(commitId('a'.repeat(64))).toBe('a'.repeat(64));
  expect(() => mergeTreeOutput({ ...result, code: 128, stdout: 'a'.repeat(40) + '\0' })).toThrow(
    'did not complete',
  );
  expect(mergeTreeOutput({ ...result, code: 1, stdout: 'a'.repeat(40) + '\0' })).toEqual({
    tree: 'a'.repeat(40),
    conflicts: [],
  });
});

it('runs a quarantined driver only for object computations, after the GIT_* scrub', async () => {
  vi.stubEnv('GIT_OBJECT_DIRECTORY', '/unexpected/objects');
  vi.stubEnv('GIT_QUARANTINE_PATH', '/unexpected/quarantine');
  const run = vi.fn<ProcessRunner['run']>(() =>
    Promise.resolve({
      code: 0,
      signal: null,
      stdout: 'ok\n',
      stderr: '',
      truncated: false,
      durationMs: 0,
    }),
  );
  const quarantined = new WorktreeGit(
    { run },
    { quarantine: { objects: '/tmp/quarantine', alternate: '/repo/.git/objects' } },
  );
  for (const command of ['rev-parse', 'merge-tree', 'commit-tree', 'var'])
    // A per-call environment cannot redirect the object directory either.
    await quarantined.run(directory, [command], invocation, {
      env: { GIT_OBJECT_DIRECTORY: '/caller/objects', GIT_AUTHOR_NAME: 'kept' },
    });
  expect(run.mock.calls.map(([request]) => request.env)).toEqual(
    Array.from(
      { length: 4 },
      (): unknown =>
        expect.objectContaining({
          GIT_OBJECT_DIRECTORY: '/tmp/quarantine',
          GIT_ALTERNATE_OBJECT_DIRECTORIES: '/repo/.git/objects',
          GIT_QUARANTINE_PATH: '/tmp/quarantine',
          GIT_NO_LAZY_FETCH: '1',
          GIT_AUTHOR_NAME: 'kept',
        }) as unknown,
    ),
  );
  run.mockClear();
  for (const args of [
    ['update-ref', 'refs/x', 'a'.repeat(40)],
    ['worktree', 'add', 'x'],
    ['status'],
    ['hash-object', '-w', '--stdin'],
    ['-c', 'x=y', 'merge-tree'],
    [],
  ])
    await expect(quarantined.run(directory, args, invocation)).rejects.toThrow(
      'Quarantined Git refuses',
    );
  expect(run).not.toHaveBeenCalled();
  // The read-only mode runs rev-parse, --version, one config listing, one boolean read and the exact
  // merge target checks and index listing (tested below), and nothing that could write.
  const readOnly = new WorktreeGit({ run }, true);
  for (const args of [
    ['var'],
    ['config', 'merge.x.driver', 'touch y'],
    ['config', '--name-only', '--get-regexp'],
    ['config', '--name-only', '--get-regexp', 'merge', 'value'],
    ['config', '--get-regexp', '--name-only', 'merge'],
    ['config', '--type=bool', '--get', 'merge.renormalize', 'true'],
    ['config', '--type=bool', 'merge.renormalize', 'true'],
    ['config', '--get', '--type=bool', 'merge.renormalize'],
    ['--version', '--build-options'],
    ['--exec-path=/tmp', '--version'],
  ])
    await expect(readOnly.run(directory, args, invocation)).rejects.toThrow(
      `Read-only Git refuses ${args[0] ?? ''}; only ${readOnlyForms} run.`,
    );
  expect(run).not.toHaveBeenCalled();
  await readOnly.run(directory, ['config', '--name-only', '--get-regexp', '^merge\\.'], invocation);
  await readOnly.run(
    directory,
    ['config', '--type=bool', '--get', 'merge.renormalize'],
    invocation,
  );
  await readOnly.run(directory, ['--version'], invocation);
  expect(run).toHaveBeenCalledTimes(3);
});

const readOnlyForms =
  'rev-parse, --version, check-ref-format <ref>, symbolic-ref -q <ref>, worktree list --porcelain -z, status --porcelain --untracked-files=normal --no-renames, ls-files --stage -z, config --name-only --get-regexp and config --type=bool --get';

it('runs exactly the merge target checks and the index listing through a read-only driver, and no close variant', async () => {
  const run = vi.fn<ProcessRunner['run']>(() =>
    Promise.resolve({
      code: 0,
      signal: null,
      stdout: '',
      stderr: '',
      truncated: false,
      durationMs: 0,
    }),
  );
  const readOnly = new WorktreeGit({ run }, true);
  for (const args of [
    // A second operand, or -d, makes symbolic-ref write the ref.
    ['symbolic-ref', '-q', 'HEAD', 'refs/heads/x'],
    ['symbolic-ref', '-q', '-d'],
    ['symbolic-ref', '-q', '--delete'],
    ['symbolic-ref', 'refs/heads/x'],
    ['symbolic-ref', '-d', 'refs/heads/x'],
    ['symbolic-ref', '-q'],
    ['status'],
    ['status', '--porcelain'],
    ['status', '--porcelain', '--untracked-files=all'],
    ['status', '--porcelain', '--untracked-files=normal', '-z'],
    // Rename detection reads blob contents, which older Git could lazy-fetch in a partial clone.
    ['status', '--porcelain', '--untracked-files=normal'],
    ['status', '--porcelain', '--untracked-files=normal', '--find-renames'],
    ['status', '--porcelain', '--untracked-files=normal', '--no-renames', '-z'],
    ['status', '--short', '--untracked-files=normal'],
    ['worktree', 'add', 'x'],
    ['worktree', 'list'],
    ['worktree', 'list', '--porcelain'],
    ['worktree', 'prune', '--porcelain', '-z'],
    ['worktree', 'list', '--porcelain', '-z', '--expire=now'],
    ['check-ref-format', '--normalize', 'x', 'y'],
    ['check-ref-format', '--normalize'],
    ['check-ref-format'],
    ['check-ref-format', 'refs/heads/x', 'y'],
    ['ls-files'],
    ['ls-files', '--stage'],
    ['ls-files', '-z', '--stage'],
    ['ls-files', '--stage', '-z', '--with-tree=HEAD'],
    ['ls-files', '--stage', '-z', 'lib'],
  ])
    await expect(readOnly.run(directory, args, invocation)).rejects.toThrow(
      `Read-only Git refuses ${args[0] ?? ''}; only ${readOnlyForms} run.`,
    );
  expect(run).not.toHaveBeenCalled();
  const accepted = [
    ['check-ref-format', 'refs/heads/feature'],
    ['symbolic-ref', '-q', 'refs/heads/feature'],
    ['worktree', 'list', '--porcelain', '-z'],
    ['status', '--porcelain', '--untracked-files=normal', '--no-renames'],
    ['ls-files', '--stage', '-z'],
  ];
  for (const args of accepted) await readOnly.run(directory, args, invocation);
  expect(
    run.mock.calls.map(([request]) => {
      const argv: readonly string[] = 'shell' in request.command ? [] : request.command;
      return argv.slice(argv.indexOf('-C') + 2);
    }),
  ).toEqual(accepted);
});

it('never lazy-fetches through a read-only driver, whatever the caller sets', async () => {
  vi.stubEnv('GIT_NO_LAZY_FETCH', '0');
  const run = vi.fn<ProcessRunner['run']>(() =>
    Promise.resolve({
      code: 0,
      signal: null,
      stdout: 'ok\n',
      stderr: '',
      truncated: false,
      durationMs: 0,
    }),
  );
  await new WorktreeGit({ run }, true).run(directory, ['rev-parse', 'HEAD'], invocation, {
    env: { GIT_NO_LAZY_FETCH: '0', GIT_AUTHOR_NAME: 'kept' },
  });
  expect(run.mock.calls[0]?.[0].env).toMatchObject({
    GIT_NO_LAZY_FETCH: '1',
    GIT_AUTHOR_NAME: 'kept',
  });
});

it('keeps a read-only status from refreshing the index, whatever the caller sets', async () => {
  vi.stubEnv('GIT_OPTIONAL_LOCKS', '1');
  const run = vi.fn<ProcessRunner['run']>(() =>
    Promise.resolve({
      code: 0,
      signal: null,
      stdout: '',
      stderr: '',
      truncated: false,
      durationMs: 0,
    }),
  );
  await new WorktreeGit({ run }, true).run(
    directory,
    ['status', '--porcelain', '--untracked-files=normal', '--no-renames'],
    invocation,
    { env: { GIT_OPTIONAL_LOCKS: '1' } },
  );
  expect(run.mock.calls[0]?.[0].env).toMatchObject({ GIT_OPTIONAL_LOCKS: '0' });
  // A read-write driver leaves optional locks to Git.
  await new WorktreeGit({ run }).run(directory, ['status'], invocation);
  expect(run.mock.calls[1]?.[0].env).not.toHaveProperty('GIT_OPTIONAL_LOCKS');
});

it('quotes an alternate object directory Git would split or unquote', () => {
  expect(alternateEntry('/plain/objects', ':')).toBe('/plain/objects');
  expect(alternateEntry('/a:b/objects', ':')).toBe('"/a:b/objects"');
  expect(alternateEntry('"quoted/objects', ':')).toBe('"\\"quoted/objects"');
  expect(alternateEntry('C:\\x;y\\objects', ';')).toBe('"C:\\\\x;y\\\\objects"');
  expect(alternateEntry('/a:b\nc', ':')).toBe('"/a:b\\012c"');
});

it('writes quarantined objects outside the repository, reads it through the alternate and refuses refs', async () => {
  const repo = join(directory, 'repo:with-delimiter');
  await mkdir(repo);
  await git.run(repo, ['init', '-q'], invocation);
  const base = await commitIn(repo, 'baseline\n');
  const objects = await git.text(
    repo,
    ['rev-parse', '--path-format=absolute', '--git-path', 'objects'],
    invocation,
  );
  const quarantine = await mkdtemp(join(directory, 'quarantine-'));
  const count = () => git.text(repo, ['count-objects', '-v'], invocation);
  const before = await count();
  const quarantined = new WorktreeGit(new NodeProcessRunner(), {
    quarantine: { objects: quarantine, alternate: objects },
  });
  const tree = await quarantined.text(repo, ['rev-parse', `${base}^{tree}`], invocation);
  const preview = commitId(
    (
      await quarantined.run(repo, ['commit-tree', tree, '-p', base, '-m', 'preview'], invocation, {
        env: identity,
      })
    ).stdout.trim(),
  );
  expect(await quarantined.text(repo, ['rev-parse', `${preview}^{commit}`], invocation)).toBe(
    preview,
  );
  expect(await count()).toBe(before);
  const plain = await git.run(repo, ['cat-file', '-e', preview], invocation, {
    codes: [0, 1, 128],
  });
  expect(plain.code).not.toBe(0);
  // Even if a ref update slipped past the allowlist, Git itself refuses it in the quarantine. The
  // alternate keeps the target commit readable, so older Git cannot refuse it as a missing object
  // before it checks the quarantine.
  const unsafe = await new WorktreeGit(new NodeProcessRunner()).run(
    repo,
    ['update-ref', 'refs/heads/preview', base],
    invocation,
    {
      codes: [0, 1, 128],
      env: {
        GIT_OBJECT_DIRECTORY: quarantine,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: alternateEntry(objects),
        GIT_QUARANTINE_PATH: quarantine,
      },
    },
  );
  expect(unsafe.code).not.toBe(0);
  expect(unsafe.stderr).toContain('quarantine');
});
