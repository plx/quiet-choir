// Git mechanics as durable commands. The base commit, the doc listing, sizes and outlines, every
// doc's text and the approved patch are read from Git by code; agents never choose what is audited.
import { z, type WorkflowContext } from 'quiet-choir';
import * as std from 'quiet-choir/std';
import { Path, Sha, type Listed } from '../contracts.js';

/** History does not drift: changelogs are never listed, whatever the pathspecs. */
const HISTORY = [
  ':(top,exclude,glob,icase)**/changelog*',
  ':(top,exclude,glob,icase)**/changes.md',
];
/** Listings are complete or the step fails; 16 MiB holds any listing a doc set produces. */
const listing = { maxOutputBytes: 16 * 1024 * 1024 };

/**
 * The commit the audit reads: HEAD. Every reader works in its own checkout of it, so a report-only
 * run ignores the state of the source checkout. A fix run publishes to that checkout, so it is
 * refused before any agent call by the rule `ctx.merge` applies to a checkout target: no tracked
 * change and no untracked, non-ignored path.
 */
export async function pinBase(ctx: WorkflowContext, fix: boolean) {
  if (fix) {
    const dirt = await std.exec.git(ctx, 'clean', [
      'status',
      '--porcelain',
      '--untracked-files=normal',
      '--no-renames',
    ]);
    if (dirt !== '')
      throw new Error(
        `Commit, stash or remove these paths before a fix run, which publishes to the checkout:\n${dirt.trimEnd()}`,
      );
  }
  return Sha.parse((await std.exec.git(ctx, 'base', ['rev-parse', 'HEAD'])).trim());
}

/**
 * The way up from the run's directory to the repository root ('' at the root). An isolated call
 * keeps the run's position in the repository, so the checker and the fixer get it as `cwd` to
 * start at the root that the root-relative doc paths in their prompts assume.
 */
export const toRoot = async (ctx: WorkflowContext) =>
  (await std.exec.git(ctx, 'root', ['rev-parse', '--show-cdup'])).trim().replace(/\/$/u, '');

/**
 * The text files at `base` that match `paths`, in path order, with their sizes. `git grep -I`
 * lists only files with a line of text, so binaries and empty files drop out; exit 1 means none.
 */
export async function listDocs(ctx: WorkflowContext, base: string, paths: string[]) {
  const listed = await std.exec.git(
    ctx,
    'inventory',
    ['grep', '-I', '-l', '-z', '--full-name', '-e', '', base, '--', ...paths, ...HISTORY],
    { ...listing, okExitCodes: [0, 1] },
  );
  const all = listed
    .split('\0')
    .filter(Boolean)
    .map((entry) => entry.slice(base.length + 1));
  const docs = all.filter((path) => Path.safeParse(path).success);
  const sized = docs.length
    ? await std.exec.git(ctx, 'sizes', ['cat-file', '--batch-check=%(objectsize)'], {
        ...listing,
        input: docs.map((path) => `${base}:${path}\n`).join(''),
      })
    : '';
  const sizes = z
    .array(z.coerce.number().int().nonnegative())
    .parse(sized.split('\n').slice(0, -1));
  if (sizes.length !== docs.length) throw new Error('Git sized a different number of docs');
  return {
    docs: docs.map((path, index) => ({ path, bytes: sizes[index] ?? 0 })),
    unsupported: all.filter((path) => !Path.safeParse(path).success),
  };
}

/** Up to three markdown headings of each listed doc, for the librarian. */
export async function outline(
  ctx: WorkflowContext,
  base: string,
  docs: string[],
): Promise<Listed[]> {
  const found = await std.exec.git(
    ctx,
    'outline',
    [
      'grep',
      '-I',
      '-n',
      '-z',
      '--full-name',
      '-m',
      '3',
      '-E',
      '^#{1,3} ',
      base,
      '--',
      // Listed paths are root-relative, so they are `top` pathspecs in a subdirectory run too.
      ...docs.map((path) => `:(top,literal)${path}`),
    ],
    { ...listing, okExitCodes: [0, 1] },
  );
  const headings = new Map<string, string[]>();
  for (const line of found.split('\n').filter(Boolean)) {
    const [location = '', , text = ''] = line.split('\0');
    const path = location.slice(base.length + 1);
    headings.set(path, [...(headings.get(path) ?? []), text.trim().slice(0, 120)]);
  }
  return docs.map((path) => ({ path, headings: headings.get(path) ?? [] }));
}

/** One doc's complete text at `base`; its size was checked against the cap when it was listed. */
export const readDoc = (ctx: WorkflowContext, base: string, path: string) =>
  std.exec.git(ctx, 'read', ['show', `${base}:${path}`], listing);

/** The doc's text in a fixer's snapshot commit. */
export const fixedText = (ctx: WorkflowContext, commit: string, path: string) =>
  std.exec.git(ctx, 'fixed', ['show', `${commit}:${path}`], listing);

/**
 * Whether the checkout's HEAD is still the base. `ctx.merge` with `target: 'checkout'` would
 * rebase onto a moved HEAD, publishing a tree that the verification commands never ran on.
 */
export const stillAt = async (ctx: WorkflowContext, base: string) =>
  (await std.exec.git(ctx, 'head', ['rev-parse', 'HEAD'])).trim() === base;

/** The exact patch a human approves: every fixed doc, from the base to the integrated commit. */
export const patch = (ctx: WorkflowContext, base: string, commit: string) =>
  std.exec.git(ctx, 'patch', ['diff', '--no-color', '--no-ext-diff', base, commit, '--'], listing);
