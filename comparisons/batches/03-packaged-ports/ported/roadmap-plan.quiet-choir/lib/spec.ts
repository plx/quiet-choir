// The spec as a durable effect: code reads it once, so every agent sees the same bytes, and the
// output records its digest.
import { createHash } from 'node:crypto';
import type { WorkflowContext } from 'quiet-choir';

/** The spec text: inline when the input spans lines, else a memoized snapshot of the file. */
export async function readSpec(ctx: WorkflowContext, spec: string, maxBytes: number) {
  if (spec.includes('\n'))
    return {
      text: spec,
      source: {
        source: 'text' as const,
        path: null,
        sha256: createHash('sha256').update(spec).digest('hex'),
        bytes: Buffer.byteLength(spec),
      },
    };
  const read = await ctx.readFile('spec', spec, { maxBytes });
  return {
    text: read.content,
    source: {
      source: 'file' as const,
      path: spec,
      sha256: read.sha256,
      bytes: Buffer.byteLength(read.content),
    },
  };
}
