// Git mechanics: pin the delivered work as a commit, then list and diff it, all in code. The pin is
// one local step, so the snapshot (uncommitted and untracked work included) is decided once and
// replayed, and every checker reads exactly the tree the verdict is about.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StepExecOptions, WorkflowContext } from 'quiet-choir';
import * as std from 'quiet-choir/std';
import { ChangedFile, Pinned } from '../contracts.js';

/** The author of snapshot commits, so a repository without user.name still pins. */
const identity = {
  GIT_AUTHOR_NAME: 'acceptance-qa-deep',
  GIT_AUTHOR_EMAIL: 'acceptance-qa-deep@localhost',
  GIT_COMMITTER_NAME: 'acceptance-qa-deep',
  GIT_COMMITTER_EMAIL: 'acceptance-qa-deep@localhost',
};

/**
 * Pin HEAD, a snapshot commit of the working tree and the base of the delivered change. A dirty
 * tree is staged into a temporary index (never the repository's own), so the index, the refs and
 * the files stay untouched; ignored files stay out, as Git would leave them. Without `base`, a
 * dirty tree is judged from HEAD and a clean one from HEAD's first parent (the empty tree for a
 * root commit), the upstream's "uncommitted changes, else the latest commit".
 */
export const pin = (ctx: WorkflowContext, base: string | null) =>
  ctx.step('pin', {
    input: { base },
    version: 'pin/1',
    schema: Pinned,
    async run({ exec }) {
      const git = async (args: string[], options: Omit<StepExecOptions, 'onError'> = {}) =>
        (await exec(['git', ...args], options)).stdout.trim();
      const head = await git(['rev-parse', '--verify', 'HEAD^{commit}']);
      const scratch = await mkdtemp(join(tmpdir(), 'acceptance-qa-deep-'));
      let tree: string;
      try {
        const index = { env: { GIT_INDEX_FILE: join(scratch, 'index') } };
        await git(['read-tree', head], index);
        await git(['add', '--all'], index);
        tree = await git(['write-tree'], index);
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
      const uncommitted = tree !== (await git(['rev-parse', `${head}^{tree}`]));
      const snapshot = uncommitted
        ? await git(['commit-tree', tree, '-p', head, '-m', 'acceptance-qa-deep snapshot'], {
            env: identity,
          })
        : head;
      const parent = (await git(['rev-list', '--parents', '-n', '1', head])).split(' ')[1];
      const resolved =
        base !== null
          ? await git(['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`])
          : uncommitted
            ? head
            : (parent ?? (await git(['mktree'], { input: '' })));
      return { head, snapshot, base: resolved, uncommitted };
    },
  });

const fileStatus = { A: 'added', D: 'deleted' } as const;

/** The files the delivered change touches, from `git diff --name-status` without rename pairing. */
export async function changedFiles(ctx: WorkflowContext, pinned: Pinned, paths: string[]) {
  const listed = await std.exec.git(ctx, 'files', [
    '--literal-pathspecs',
    'diff',
    '--name-status',
    '--no-renames',
    '-z',
    pinned.base,
    pinned.snapshot,
    '--',
    ...paths,
  ]);
  const fields = listed.split('\0').filter(Boolean);
  const files: ChangedFile[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const letter = fields[index]?.[0] as keyof typeof fileStatus;
    files.push(
      ChangedFile.parse({ path: fields[index + 1], status: fileStatus[letter] ?? 'modified' }),
    );
  }
  return files;
}

/**
 * The patch of the delivered change, capped at `maxBytes` per stream: an oversized patch keeps its
 * head and tail and reports `truncated`, and the checkers read the files for the rest.
 */
export async function patch(
  ctx: WorkflowContext,
  pinned: Pinned,
  paths: string[],
  maxBytes: number,
) {
  const diff = await ctx.exec(
    'patch',
    [
      'git',
      '--literal-pathspecs',
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-renames',
      pinned.base,
      pinned.snapshot,
      '--',
      ...paths,
    ],
    { maxOutputBytes: maxBytes },
  );
  return { text: diff.stdout, truncated: diff.truncated };
}

/** The criteria text: the input itself, or the ticket file the workflow reads and records. */
export async function readCriteria(
  ctx: WorkflowContext,
  input: { criteria: string | null; criteriaFile: string | null },
) {
  if (input.criteria !== null) return input.criteria;
  if (input.criteriaFile === null) throw new Error('Give exactly one of criteria or criteriaFile');
  return (await ctx.readFile('criteria-file', input.criteriaFile)).content;
}
