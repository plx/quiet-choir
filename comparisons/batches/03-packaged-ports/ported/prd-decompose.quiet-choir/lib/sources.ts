// The PRD and the codebase listing as durable effects: code reads the PRD once, so every agent sees
// the same bytes, and lists the tracked files the lenses may reference.
import { createHash } from 'node:crypto';
import type { WorkflowContext } from 'quiet-choir';
import * as std from 'quiet-choir/std';

/** The PRD text: inline when the input spans lines, else a memoized snapshot of the file. */
export async function readPrd(ctx: WorkflowContext, prd: string, maxBytes: number) {
  if (prd.includes('\n'))
    return {
      text: prd,
      source: {
        source: 'text' as const,
        path: null,
        sha256: createHash('sha256').update(prd).digest('hex'),
        bytes: Buffer.byteLength(prd),
      },
    };
  const read = await ctx.readFile('prd', prd, { maxBytes });
  return {
    text: read.content,
    source: {
      source: 'file' as const,
      path: prd,
      sha256: read.sha256,
      bytes: Buffer.byteLength(read.content),
    },
  };
}

/**
 * Tracked files under `path`, the first `max` of them for the prompts and the full count. A
 * directory with no tracked file is refused before any agent call: Git lists nothing for a typo or
 * a prose hint. Only the repository root may be empty (a new repository with an inline PRD).
 */
export async function listCodebase(ctx: WorkflowContext, path: string, max: number) {
  // A complete listing or a failure: std.exec.git refuses truncated output.
  const listed = await std.exec.git(ctx, 'codebase', ['ls-files', '-z', '--', path], {
    maxOutputBytes: 16 * 1024 * 1024,
  });
  const files = listed.split('\0').filter(Boolean);
  if (!files.length && path !== '.')
    throw new Error(
      `The codebase "${path}" has no tracked files; pass a repository directory, '.' or null`,
    );
  return { path, files: files.slice(0, max), omitted: Math.max(0, files.length - max) };
}
