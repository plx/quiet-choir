// The raw material as durable effects: code reads each file once, so every lens sees the same bytes
// and the output records what was read.
import { createHash } from 'node:crypto';
import type { WorkflowContext } from 'quiet-choir';

/** One piece of material: the label its quotes are attributed to, its text and its receipt. */
export interface Document {
  readonly label: string;
  readonly text: string;
  readonly source: {
    readonly source: 'file' | 'text';
    readonly path: string | null;
    readonly sha256: string;
    readonly bytes: number;
  };
}

/**
 * The material: inline text when the input spans lines, else a memoized snapshot of each listed
 * file. The total is bounded by `maxBytes`, which a single file may not exceed either.
 */
export async function readMaterial(
  ctx: WorkflowContext,
  input: string | readonly string[],
  maxBytes: number,
): Promise<Document[]> {
  if (typeof input === 'string' && input.includes('\n'))
    return [
      {
        label: 'text',
        text: input,
        source: {
          source: 'text',
          path: null,
          sha256: createHash('sha256').update(input).digest('hex'),
          bytes: Buffer.byteLength(input),
        },
      },
    ];
  const documents: Document[] = [];
  for (const [index, path] of (typeof input === 'string' ? [input] : input).entries()) {
    const read = await ctx.readFile(ctx.id('material', index), path, { maxBytes });
    documents.push({
      label: path,
      text: read.content,
      source: { source: 'file', path, sha256: read.sha256, bytes: Buffer.byteLength(read.content) },
    });
  }
  const total = documents.reduce((sum, document) => sum + document.source.bytes, 0);
  if (total > maxBytes)
    throw new Error(
      `The material is ${String(total)} bytes, over maxMaterialBytes ${String(maxBytes)}`,
    );
  return documents;
}
