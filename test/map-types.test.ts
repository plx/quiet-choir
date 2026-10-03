// The single named ctx.map signature reports a mistyped onError as the mismatched property, naming
// the valid literals, instead of TypeScript's "No overload matches this call" for its last overload.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { configuredProgram } from '../src/workflow/typecheck/typescript-executor.js';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
let directory: string;
let diagnostics: { readonly line: number; readonly text: string }[];

// One program over the temp workflow and the sources it imports, under the root tsconfig.
// measured: about 1 s alone, like the durability-lint fixture program.
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'choir-map-types-'));
  const file = join(directory, 'map.workflow.ts');
  const source = [
    `import { defineWorkflow, z } from ${JSON.stringify(join(projectRoot, 'src', 'index.js'))};`,
    `export default defineWorkflow({`,
    `  name: 'map-types', version: '1', input: z.null(), output: z.unknown(),`,
    `  run: (ctx) =>`,
    `    ctx.map('items', [1, 2], { concurrency: 2, onError: 'settled' }, (n) => Promise.resolve(n)),`,
    `});`,
    ``,
  ].join('\n');
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  await writeFile(file, source);
  const configured = configuredProgram([file], join(projectRoot, 'tsconfig.json'));
  if ('error' in configured) throw new Error('tsconfig.json could not be read');
  diagnostics = ts
    .getPreEmitDiagnostics(configured.program)
    .filter((diagnostic) => diagnostic.file?.fileName === file)
    .map((diagnostic) => ({
      line: diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line ?? -1,
      text: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    }));
}, 30_000);

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

it("names 'throw' and 'return' for a mistyped onError instead of a last-overload message", () => {
  expect(diagnostics).toHaveLength(1);
  const [diagnostic] = diagnostics;
  expect(diagnostic?.line).toBe(4);
  expect(diagnostic?.text).toContain('"throw"');
  expect(diagnostic?.text).toContain('"return"');
  expect(diagnostic?.text).toContain('"settled"');
  expect(diagnostic?.text).not.toContain('No overload matches');
});
