import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { defineWorkflow, runWorkflow, z } from '../dist/index.js';
const root = await fs.mkdtemp(join(tmpdir(), 'quiet-choir-benchmark-'));
const originalOpen = fs.open;
let written = 0;
let flushes = 0;
const timings = [];
fs.open = async (...args) => {
  const file = await originalOpen(...args);
  if (String(args[0]).startsWith(root)) {
    const writeFile = file.writeFile.bind(file),
      write = file.write.bind(file),
      sync = file.sync.bind(file);
    file.writeFile = async (value, ...rest) => {
      written += typeof value === 'string' ? Buffer.byteLength(value) : value.byteLength;
      return writeFile(value, ...rest);
    };
    file.write = async (...values) => {
      const result = await write(...values);
      written += result.bytesWritten;
      return result;
    };
    file.sync = async () => {
      flushes++;
      return sync();
    };
  }
  return file;
};
syncBuiltinESMExports();
try {
  for (const [count, bytes, concurrency] of [
    [200, 0, 1],
    [200, 0, 16],
    [500, 5120, 8],
  ]) {
    written = 0;
    flushes = 0;
    const id = `steps-${count}-${bytes}-${concurrency}`;
    const definition = defineWorkflow({
      name: 'storage-benchmark',
      version: '1',
      input: z.null(),
      output: z.number(),
      run: async (ctx) => {
        const results = await ctx.map(
          'batch',
          Array.from({ length: count }, (_, i) => i),
          { concurrency },
          (i) =>
            ctx.step(`item-${i}`, {
              input: null,
              schema: z.string(),
              run: () => 'x'.repeat(bytes),
            }),
        );
        return results.length;
      },
    });
    const start = performance.now();
    const run = await runWorkflow(definition, { runId: id, stateDir: root, input: null });
    const elapsed = performance.now() - start;
    const finalBytes =
      (await fs.stat(join(root, id, 'run.json'))).size +
      (await fs.stat(join(root, id, 'journal.jsonl'))).size;
    timings.push(elapsed);
    assert.ok(written < finalBytes * 10, 'Write amplification must remain below 10x');
    console.log(
      JSON.stringify({
        count,
        bytes,
        concurrency,
        elapsed,
        written,
        finalBytes,
        amplification: written / finalBytes,
        flushes,
        status: run.status,
      }),
    );
  }
  const speedup = timings[0] / timings[1];
  assert.ok(speedup >= 4, `Expected at least 4x speedup; measured ${speedup}`);
  console.log(JSON.stringify({ speedup, node: process.version, platform: process.platform }));
} finally {
  fs.open = originalOpen;
  syncBuiltinESMExports();
  await fs.rm(root, { recursive: true, force: true });
}
