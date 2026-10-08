// Guards the Node-free authoring model (#290). Workflow files import `defineWorkflow` from
// src/workflow/runtime/model.ts and are type-checked under project tsconfigs that list no `types`;
// TypeScript 6 then loads no @types/node. So model.ts and every module it imports must type-check
// without Node types: no `store.js`, `record.js`, `node:*` import (even `import type`) and no
// `/// <reference types="node" />`. Without this suite a violation only surfaced as scattered
// @types/node diagnostics in the loader and registry suites.
//
// The guarded set is derived, not listed: a walk of model.ts's import graph, checked against the
// files a real Node-free TypeScriptExecutor check loads.
import { builtinModules } from 'node:module';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

import { ThresholdLogger } from '../src/application/execution.js';
import { analyzeTypecheckEntrypoint } from '../src/workflow/typecheck/plan.js';
import { TypecheckProgramCache } from '../src/workflow/typecheck/program-cache.js';
import { TypeScriptExecutor } from '../src/workflow/typecheck/typescript-executor.js';

const typecheckCache = new TypecheckProgramCache();

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceRoot = join(projectRoot, 'src') + '/';
const modelFile = join(projectRoot, 'src/workflow/runtime/model.ts');
const waitModelFile = join(projectRoot, 'src/workflow/runtime/wait-model.ts');
const forbiddenModules = new Map([
  [join(projectRoot, 'src/workflow/runtime/store.ts'), 'store.ts'],
  [join(projectRoot, 'src/workflow/runtime/record.ts'), 'record.ts'],
]);
const nodeBuiltins = new Set(builtinModules);

/**
 * The compiler options of a workflow type check under a tsconfig without `types`: no Node globals.
 * The `lib` is ES2023 plus DOM, the narrowest that works: the model names `AbortSignal`, which only
 * the DOM lib (or @types/node) declares, so an ES2023-only check fails on it.
 */
const nodeFreeOptions: ts.CompilerOptions = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2023,
  lib: ['lib.es2023.d.ts', 'lib.dom.d.ts'],
  strict: true,
  skipLibCheck: true,
  types: [],
  noEmit: true,
};

interface Violation {
  /** Importer, relative to the repository root. */
  readonly file: string;
  /** 1-based line of the import. */
  readonly line: number;
  readonly specifier: string;
  readonly source: string;
  /** Module names from model.ts down to the importer. */
  readonly chain: readonly string[];
}

interface Closure {
  /** Sorted absolute paths of every source module reached. */
  readonly files: readonly string[];
  readonly violations: readonly Violation[];
}

function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith('node:') || nodeBuiltins.has(specifier);
}

function lineOf(text: string, position: number): number {
  let line = 1;
  for (let index = 0; index < position; index += 1) if (text.charCodeAt(index) === 10) line += 1;
  return line;
}

function nameOf(file: string): string {
  return file.split('/').at(-1) ?? file;
}

/**
 * Walk the import graph from `root` through every `import`, `import type`, `export ... from`,
 * `import('...')` type query and `/// <reference types>` directive. A forbidden module (a Node
 * builtin, store.ts, record.ts or `types="node"`) is reported at its import edge and not entered.
 * `readFile` lets a test substitute one file's text without touching the checkout.
 */
function walkNodeFreeClosure(
  root: string,
  readFile: (file: string) => string | undefined = (file) => ts.sys.readFile(file),
): Closure {
  const visited = new Set<string>([root]);
  const violations: Violation[] = [];
  const queue: { file: string; chain: readonly string[] }[] = [
    { file: root, chain: [nameOf(root)] },
  ];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const { file, chain } = next;
    const text = readFile(file);
    if (text === undefined) throw new Error(`Cannot read ${file}`);
    const lines = text.split('\n');
    const report = (position: number, specifier: string): void => {
      const line = lineOf(text, position);
      violations.push({
        file: relative(projectRoot, file),
        line,
        specifier,
        source: (lines[line - 1] ?? '').trim(),
        chain,
      });
    };
    const info = ts.preProcessFile(text, true, true);
    for (const reference of info.typeReferenceDirectives) {
      if (reference.fileName === 'node') report(reference.pos, reference.fileName);
    }
    for (const reference of info.importedFiles) {
      const specifier = reference.fileName;
      if (isNodeBuiltin(specifier)) {
        report(reference.pos, specifier);
        continue;
      }
      const { resolvedModule } = ts.resolveModuleName(specifier, file, nodeFreeOptions, ts.sys);
      if (
        resolvedModule === undefined ||
        resolvedModule.isExternalLibraryImport === true ||
        !resolve(resolvedModule.resolvedFileName).startsWith(sourceRoot)
      ) {
        continue;
      }
      const target = resolve(resolvedModule.resolvedFileName);
      if (forbiddenModules.has(target)) {
        report(reference.pos, specifier);
        continue;
      }
      if (visited.has(target)) continue;
      visited.add(target);
      queue.push({ file: target, chain: [...chain, nameOf(target)] });
    }
  }
  return { files: [...visited].sort(), violations };
}

function formatViolation(violation: Violation): string {
  return `${violation.file}:${String(violation.line)} imports '${violation.specifier}' (via ${violation.chain.join(' -> ')}): ${violation.source}`;
}

function formatViolations(violations: readonly Violation[]): string {
  return violations.length === 0
    ? 'no violations'
    : `The Node-free authoring model (src/workflow/runtime/model.ts and its imports) must not reach store, record or Node modules:\n${violations.map(formatViolation).join('\n')}`;
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Node-free authoring model', () => {
  it('keeps the authoring model closure free of store, record and Node imports', () => {
    const { files, violations } = walkNodeFreeClosure(modelFile);
    expect(files).toContain(waitModelFile);
    expect(violations, formatViolations(violations)).toEqual([]);
  });

  it('matches what the Node-free workflow type check loads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quiet-choir-node-free-'));
    roots.push(root);
    const file = join(root, 'workflow.ts');
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    await writeFile(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'NodeNext',
          target: 'ES2023',
          lib: ['ES2023', 'DOM'],
          strict: true,
          skipLibCheck: true,
        },
      }),
    );
    await symlink(join(projectRoot, 'node_modules'), join(root, 'node_modules'));
    await writeFile(
      file,
      `import { z } from 'zod';
import { defineWorkflow } from ${JSON.stringify(modelFile.replace(/\.ts$/, '.js'))};
export default defineWorkflow({
  name: 'node-free', version: '1', input: z.object({}), output: z.number(),
  async run() { return 1; },
});
`,
    );
    const analysis = analyzeTypecheckEntrypoint(file, projectRoot);
    if (!analysis.ok) throw new Error(analysis.error.message);
    const result = await new TypeScriptExecutor(new ThresholdLogger('silent', () => undefined), {
      cache: typecheckCache,
    }).execute(analysis.plan);

    const messages = result.diagnostics.map(
      (diagnostic) =>
        `${diagnostic.filePath ?? '(global)'}:${String(diagnostic.line ?? 0)} ${diagnostic.message}`,
    );
    expect(messages).toEqual([]);
    expect(result.sourceFiles.filter((source) => source.startsWith(sourceRoot))).toEqual(
      walkNodeFreeClosure(modelFile).files,
    );
  });

  describe('guard', () => {
    const injections = [
      {
        name: 'a type-only store import',
        text: "import type { RunRecord } from './store.js';",
        specifier: './store.js',
      },
      {
        name: 'a value import of record',
        text: "import { RunRecord } from './record.js';",
        specifier: './record.js',
      },
      {
        name: 'an import() type query of record',
        text: "type Injected = import('./record.js').RunRecord;",
        specifier: './record.js',
      },
      {
        name: 'an export-from of record',
        text: "export type { RunRecord } from './record.js';",
        specifier: './record.js',
      },
      {
        name: 'a node: value import',
        text: "import { readFile } from 'node:fs';",
        specifier: 'node:fs',
      },
      {
        name: 'a bare Node builtin import',
        text: "import { join } from 'path';",
        specifier: 'path',
      },
      {
        name: 'a Node types reference directive',
        text: '/// <reference types="node" />',
        specifier: 'node',
      },
    ];

    it.each(injections)('names $name added to wait-model.ts', ({ text, specifier }) => {
      const original = ts.sys.readFile(waitModelFile) ?? '';
      // A reference directive is only recognised in the leading comments, so inject at the top.
      const injected = `${text}\n${original}`;
      const { violations } = walkNodeFreeClosure(modelFile, (file) =>
        file === waitModelFile ? injected : ts.sys.readFile(file),
      );
      expect(violations).toEqual([
        {
          file: 'src/workflow/runtime/wait-model.ts',
          line: 1,
          specifier,
          source: text,
          chain: ['model.ts', 'wait-model.ts'],
        },
      ]);
      expect(violations.map(formatViolation)).toEqual([
        `src/workflow/runtime/wait-model.ts:1 imports '${specifier}' (via model.ts -> wait-model.ts): ${text}`,
      ]);
    });

    it('names the line of an import added after existing code', () => {
      const original = ts.sys.readFile(waitModelFile) ?? '';
      const injected = `${original}\nimport type { RunRecord } from './store.js';\n`;
      const { violations } = walkNodeFreeClosure(modelFile, (file) =>
        file === waitModelFile ? injected : ts.sys.readFile(file),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.line).toBe(original.split('\n').length + 1);
    });
  });
});
