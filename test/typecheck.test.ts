import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

import { ThresholdLogger } from '../src/application/execution.js';
import { analyzeTypecheckEntrypoint } from '../src/workflow/typecheck/plan.js';
import { TypecheckProgramCache } from '../src/workflow/typecheck/program-cache.js';
import {
  configuredProgram,
  TypeScriptExecutor,
} from '../src/workflow/typecheck/typescript-executor.js';

const silentLogger = new ThresholdLogger('silent', () => {
  throw new Error('The silent logger must not write.');
});

const temporaryDirectories: string[] = [];
const engineEntry = fileURLToPath(new URL('../src/index.js', import.meta.url));
// The small compiler cases share parsed lib and @types/node files, as the loader suites do.
const typecheckCache = new TypecheckProgramCache();

async function createFixture(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'quiet-choir-typecheck-'));
  temporaryDirectories.push(root);

  await Promise.all(
    Object.entries(files).map(async ([filePath, contents]) => {
      const destination = join(root, filePath);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, contents, 'utf8');
    }),
  );

  return root;
}

function planFor(root: string, entrypoint = 'workflow.ts') {
  const analysis = analyzeTypecheckEntrypoint(join(root, entrypoint), root);
  expect(analysis.ok).toBe(true);

  if (!analysis.ok) {
    throw new Error(analysis.error.message);
  }

  return analysis.plan;
}

/** Check an entrypoint through the suite's cache, a given one, or, for `null`, no shared cache. */
async function executeEntrypoint(
  root: string,
  entrypoint = 'workflow.ts',
  cache: TypecheckProgramCache | null = typecheckCache,
) {
  return new TypeScriptExecutor(silentLogger, { cache: cache ?? undefined }).execute(
    planFor(root, entrypoint),
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('typecheck plan analysis', () => {
  it('selects the closest tsconfig and stores only plain data', async () => {
    const root = await createFixture({
      'nested/tsconfig.json': '{"compilerOptions":{"strict":true}}',
      'nested/workflow.ts': 'export const value = 1;\n',
      'tsconfig.json': '{"compilerOptions":{"strict":false}}',
    });

    const analysis = analyzeTypecheckEntrypoint('nested/workflow.ts', root);

    expect(analysis).toEqual({
      ok: true,
      plan: {
        configuration: { kind: 'tsconfig', path: join(root, 'nested/tsconfig.json') },
        entrypoint: join(root, 'nested/workflow.ts'),
        kind: 'workflow.typecheck',
      },
    });
    expect(() => JSON.stringify(analysis)).not.toThrow();
  });

  it('uses strict Node defaults when there is no tsconfig', async () => {
    const root = await createFixture({ 'workflow.mts': 'export const value = 1;\n' });

    expect(analyzeTypecheckEntrypoint('workflow.mts', root)).toEqual({
      ok: true,
      plan: {
        configuration: { kind: 'defaults', profile: 'node22-es2023-strict' },
        entrypoint: join(root, 'workflow.mts'),
        kind: 'workflow.typecheck',
      },
    });
  });

  it('rejects non-TypeScript source extensions', () => {
    expect(analyzeTypecheckEntrypoint('workflow.js', '/workspace')).toEqual({
      error: {
        code: 'UNSUPPORTED_TYPESCRIPT_EXTENSION',
        message:
          'Expected a TypeScript source file (.ts, .tsx, .mts, .cts) but received: workflow.js',
      },
      ok: false,
    });
  });

  it.each(['workflow.d.ts', 'workflow.d.mts', 'workflow.d.cts'])(
    'rejects declaration file entrypoint %s',
    (entrypoint) => {
      expect(analyzeTypecheckEntrypoint(entrypoint, '/workspace')).toEqual({
        error: {
          code: 'DECLARATION_TYPESCRIPT_ENTRYPOINT',
          message: `A TypeScript declaration file cannot be a workflow entrypoint: ${entrypoint}`,
        },
        ok: false,
      });
    },
  );
});

// Compiler integration tests share CI CPUs with the loader suites under coverage. measured: apart from
// schema-only inference, the slowest case takes 0.6 s alone, 1.7-2.1 s in local full coverage runs
// and up to 8.6 s on the Node 24 CI leg before the shared cache (lib and @types/node parsing).
describe('TypeScriptExecutor', { timeout: 20_000 }, () => {
  it('checks Node workflows with strict defaults and returns plain data', async () => {
    const root = await createFixture({
      'workflow.ts': [
        "import { readFile } from 'node:fs/promises';",
        "export const contents: Promise<string> = readFile('input.txt', 'utf8');",
        '',
      ].join('\n'),
    });

    const result = await executeEntrypoint(root);

    expect(result.ok).toBe(true);
    expect(result.configPath).toBeNull();
    expect(result.compilerOptions).toMatchObject({
      strict: true,
      noUncheckedIndexedAccess: true,
      target: 'ES2023',
      module: 'NodeNext',
      noEmit: true,
      noCheck: false,
    });
    expect(result.compilerOptions).not.toHaveProperty('exactOptionalPropertyTypes');
    expect(result.diagnostics).toEqual([]);
    expect(result.compilerVersion).toMatch(/^6\./);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('catches unchecked array access by default but honors explicit project policy', async () => {
    const root = await createFixture({
      'workflow.ts': 'export const first = ([] as string[])[0].split(".");',
    });
    const defaults = await executeEntrypoint(root);
    expect(defaults.ok).toBe(false);
    expect(defaults.diagnostics).toContainEqual(expect.objectContaining({ code: 2532 }));
    await writeFile(
      join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true, noUncheckedIndexedAccess: false } }),
    );
    const configured = await executeEntrypoint(root);
    expect(configured.ok).toBe(true);
    expect(configured.compilerOptions).toMatchObject({
      strict: true,
      noUncheckedIndexedAccess: false,
      noEmit: true,
      noCheck: false,
    });
  });

  // The suite's one uncached full-engine check under the repository tsconfig.
  it('checks schema-only inference and agent value overloads with the packaged TypeScript 6 compiler', async () => {
    const fixture = join(process.cwd(), 'test/fixtures/schema-first-types.ts');
    const analysis = analyzeTypecheckEntrypoint(fixture, process.cwd());
    if (!analysis.ok) throw new Error(analysis.error.message);
    const result = await new TypeScriptExecutor(silentLogger).execute(analysis.plan);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    // measured: 1.8 s alone and 5.2-6.5 s in local full coverage runs, both unchanged by the cache,
    // and 8.6 s on the Node 22.13 and 16.6 s on the Node 24 CI legs with it (8.1-9.6 s and
    // 12.2-15.8 s before it; one whole engine compile under the repository tsconfig)
  }, 35_000);

  it('targets the minimum supported Node declarations in the default profile', async () => {
    const root = await createFixture({
      'workflow.ts': "import { suffix } from 'node:ffi';\nvoid suffix;\n",
    });

    const result = await executeEntrypoint(root);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 2307 }));
  });

  it('normalizes semantic and syntax diagnostics with one-based locations', async () => {
    const root = await createFixture({
      'semantic.ts': "const count: number = 'wrong';\n",
      'syntax.ts': 'export const broken = ;\n',
    });

    const semantic = await executeEntrypoint(root, 'semantic.ts');
    const syntax = await executeEntrypoint(root, 'syntax.ts');
    const semanticDiagnostic = semantic.diagnostics.find((diagnostic) => diagnostic.code === 2322);

    expect(semantic.ok).toBe(false);
    expect(semanticDiagnostic).toMatchObject({
      category: 'error',
      code: 2322,
      filePath: join(root, 'semantic.ts'),
      line: 1,
    });
    expect(typeof semanticDiagnostic?.column).toBe('number');
    expect(syntax.ok).toBe(false);
    expect(syntax.diagnostics).toContainEqual(
      expect.objectContaining({
        category: 'error',
        filePath: join(root, 'syntax.ts'),
        line: 1,
      }),
    );
  });

  it('preserves related diagnostic locations as plain data', async () => {
    const root = await createFixture({
      'workflow.ts': [
        'interface Workflow {',
        '  name: string;',
        '}',
        'export const workflow: Workflow = {};',
        '',
      ].join('\n'),
    });

    const result = await executeEntrypoint(root);
    const diagnostic = result.diagnostics.find((candidate) => candidate.code === 2741);

    expect(diagnostic?.relatedInformation).toContainEqual(
      expect.objectContaining({ filePath: join(root, 'workflow.ts'), line: 2 }),
    );
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('honors config options, overrides noCheck, ignores unrelated roots, and emits nothing', async () => {
    const root = await createFixture({
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          declaration: true,
          noCheck: true,
          outDir: './generated',
          strict: true,
        },
        include: ['*.ts'],
      }),
      'unrelated.ts': "const unrelated: number = 'wrong';\n",
      'workflow.ts': 'export function identity(value) { return value; }\n',
    });

    const result = await executeEntrypoint(root);

    expect(result.ok).toBe(false);
    expect(result.configPath).toBe(join(root, 'tsconfig.json'));
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 7006, filePath: join(root, 'workflow.ts') }),
    );
    expect(result.diagnostics).not.toContainEqual(
      expect.objectContaining({ filePath: join(root, 'unrelated.ts') }),
    );
    await expect(stat(join(root, 'generated'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('checks imported dependencies', async () => {
    const root = await createFixture({
      'dependency.ts': "export const count: number = 'wrong';\n",
      'tsconfig.json': '{"compilerOptions":{"strict":true,"module":"NodeNext"}}',
      'workflow.ts': "import { count } from './dependency.js';\nexport { count };\n",
    });

    const result = await executeEntrypoint(root);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 2322, filePath: join(root, 'dependency.ts') }),
    );
  });

  it('preserves ambient declarations selected by tsconfig without checking unrelated sources', async () => {
    const root = await createFixture({
      'globals.d.ts': 'declare const WORKFLOW_NAME: string;\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { strict: true },
        include: ['*.ts'],
      }),
      'unrelated.ts': "const unrelated: number = 'wrong';\n",
      'workflow.ts': 'export const name: string = WORKFLOW_NAME;\n',
    });

    const result = await executeEntrypoint(root);

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it('honors extended compiler configuration', async () => {
    const root = await createFixture({
      'base.json': '{"compilerOptions":{"noImplicitAny":true}}',
      'nested/tsconfig.json': '{"extends":"../base.json"}',
      'nested/workflow.ts': 'export function identity(value) { return value; }\n',
    });

    const result = await executeEntrypoint(root, 'nested/workflow.ts');

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 7006 }));
  });

  it('preserves invalid compiler-option diagnostics', async () => {
    const root = await createFixture({
      'tsconfig.json': '{"compilerOptions":{"notACompilerOption":true}}',
      'workflow.ts': 'export const value = 1;\n',
    });

    const result = await executeEntrypoint(root);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ category: 'error', code: 5023, filePath: null }),
    );
  });

  it('returns malformed tsconfig diagnostics as data', async () => {
    const root = await createFixture({
      'tsconfig.json': '{"compilerOptions": {',
      'workflow.ts': 'export const value = 1;\n',
    });

    const result = await executeEntrypoint(root);
    const firstDiagnostic = result.diagnostics[0];

    expect(result.ok).toBe(false);
    expect(firstDiagnostic?.category).toBe('error');
    expect(typeof firstDiagnostic?.code).toBe('number');
  });

  it('does not alter source files while checking', async () => {
    const source = 'export const value: number = 1;\n';
    const root = await createFixture({ 'workflow.cts': source });

    await executeEntrypoint(root, 'workflow.cts');

    await expect(readFile(join(root, 'workflow.cts'), 'utf8')).resolves.toBe(source);
  });
});

// Lib files without lib checking or DOM declarations keep the option-set cases small.
const smallLib = { lib: ['es2023'], skipLibCheck: true, types: [] };

function diagnosticSummary(diagnostics: readonly ts.Diagnostic[]) {
  return diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    file: diagnostic.file?.fileName,
    start: diagnostic.start,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
  }));
}

function libFile(program: ts.Program): ts.SourceFile | undefined {
  return program.getSourceFiles().find((file) => program.isSourceFileDefaultLibrary(file));
}

function checkedProgram(
  root: string,
  entrypoint: string,
  cache: TypecheckProgramCache,
  config = 'tsconfig.json',
) {
  const checked = configuredProgram([join(root, entrypoint)], join(root, config), cache);
  if ('error' in checked) throw new Error('The fixture tsconfig must be readable.');
  return { program: checked.program, diagnostics: checked.diagnostics() };
}

// measured: the parity case, the only one importing the engine, takes 2.4 s alone and 6.8-7.6 s in
// local full coverage runs (one full engine compile, then cached checks); the others stay under 0.6 s
// alone and 2 s in full runs.
describe('TypecheckProgramCache', { timeout: 40_000 }, () => {
  it('returns the same results as an uncached check, also when reused', async () => {
    const root = await createFixture({
      'package.json': '{"type":"module"}',
      'clean.ts': [
        `import { defineWorkflow, z } from ${JSON.stringify(engineEntry)};`,
        "export default defineWorkflow({ name: 'clean', version: '1', input: z.null(), output: z.null(), async run() { return null; } });",
        '',
      ].join('\n'),
      'broken.ts': [
        `import { defineWorkflow, z } from ${JSON.stringify(engineEntry)};`,
        'interface Named {',
        '  name: string;',
        '}',
        'export const named: Named = {};',
        "export default defineWorkflow({ version: '1', input: z.null(), output: z.null(), async run() { return null; } });",
        '',
      ].join('\n'),
    });
    // An executor without a cache checks through a fresh one, so the first check of a fresh cache is
    // the uncached result. Only that check compiles the whole engine; the others reuse it.
    const cache = new TypecheckProgramCache();
    const results = [];
    for (const entrypoint of ['broken.ts', 'clean.ts', 'broken.ts', 'clean.ts', 'broken.ts'])
      results.push(await executeEntrypoint(root, entrypoint, cache));
    const [uncached, clean, ...reused] = results;

    expect(uncached?.ok).toBe(false);
    expect(uncached?.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 2741,
        relatedInformation: [expect.objectContaining({ filePath: join(root, 'broken.ts') })],
      }),
    );
    expect(clean).toMatchObject({ ok: true, diagnostics: [] });
    expect(reused).toEqual([uncached, clean, uncached]);
  });

  it('reports an edit to an imported file and clears it when reverted', async () => {
    const root = await createFixture({
      'helper.ts': 'export const value: number = 1;\n',
      'workflow.ts': "import { value } from './helper.js';\nexport const total: number = value;\n",
    });
    const cache = new TypecheckProgramCache();

    expect(await executeEntrypoint(root, 'workflow.ts', cache)).toMatchObject({ ok: true });
    await writeFile(join(root, 'helper.ts'), "export const value: string = 'one';\n");
    const edited = await executeEntrypoint(root, 'workflow.ts', cache);
    expect(edited.ok).toBe(false);
    expect(edited.diagnostics).toContainEqual(
      expect.objectContaining({ code: 2322, filePath: join(root, 'workflow.ts'), line: 2 }),
    );
    await writeFile(join(root, 'helper.ts'), 'export const value: number = 1;\n');
    expect(await executeEntrypoint(root, 'workflow.ts', cache)).toMatchObject({
      ok: true,
      diagnostics: [],
    });
  });

  it('locates related information in a file that moved without changing its declarations', async () => {
    const helper = (blankLines: number) =>
      `${'\n'.repeat(blankLines)}export interface Named {\n  name: string;\n}\n`;
    const root = await createFixture({
      'helper.ts': helper(0),
      'workflow.ts': "import type { Named } from './helper.js';\nexport const named: Named = {};\n",
    });
    const cache = new TypecheckProgramCache();

    // The first edit changes the helper's recorded signature from its version to its declaration
    // text; later layout-only edits keep that signature, so the builder keeps workflow.ts's results.
    for (const blankLines of [0, 2, 5, 9]) {
      await writeFile(join(root, 'helper.ts'), helper(blankLines));
      const cached = await executeEntrypoint(root, 'workflow.ts', cache);
      expect(cached).toEqual(await executeEntrypoint(root, 'workflow.ts', null));
      expect(cached.diagnostics).toContainEqual(
        expect.objectContaining({
          code: 2741,
          relatedInformation: [
            expect.objectContaining({ filePath: join(root, 'helper.ts'), line: blankLines + 2 }),
          ],
        }),
      );
    }
  });

  it('leaves unreadable files to the compiler host', async () => {
    const root = await createFixture({ 'present.ts': 'export const value = 1;\n' });
    const cached = await executeEntrypoint(root, 'missing.ts', new TypecheckProgramCache());

    expect(cached.ok).toBe(false);
    expect(cached).toEqual(await executeEntrypoint(root, 'missing.ts', null));
  });

  it('keeps default-profile and tsconfig option sets apart', async () => {
    const root = await createFixture({
      'workflow.ts': 'export const first = ([] as string[])[0].split(".");',
    });
    const cache = new TypecheckProgramCache();
    const defaults = await executeEntrypoint(root, 'workflow.ts', cache);
    await writeFile(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { ...smallLib, strict: true, noUncheckedIndexedAccess: false },
      }),
    );
    const configured = await executeEntrypoint(root, 'workflow.ts', cache);
    await rm(join(root, 'tsconfig.json'));
    const defaultsAgain = await executeEntrypoint(root, 'workflow.ts', cache);

    expect(defaults.diagnostics).toContainEqual(expect.objectContaining({ code: 2532 }));
    expect(configured).toMatchObject({ ok: true, diagnostics: [] });
    expect(defaultsAgain).toEqual(defaults);
  });

  it('reuses parsed files across entrypoints under the same options', async () => {
    const root = await createFixture({
      'a.ts': "import { value } from './shared.js';\nexport const a = value;\n",
      'b.ts': "import { value } from './shared.js';\nexport const b = value;\n",
      'shared.ts': 'export const value = 1;\n',
      'tsconfig.json':
        '{"compilerOptions":{"skipLibCheck":true,"strict":true,"module":"NodeNext"}}',
    });
    const cache = new TypecheckProgramCache();
    const a = checkedProgram(root, 'a.ts', cache);
    const b = checkedProgram(root, 'b.ts', cache);
    const uncached = checkedProgram(root, 'b.ts', new TypecheckProgramCache());
    const shared = join(root, 'shared.ts');

    expect([a.diagnostics, b.diagnostics]).toEqual([[], []]);
    expect(b.program.getSourceFile(shared)).toBe(a.program.getSourceFile(shared));
    expect(libFile(a.program)).toBeDefined();
    expect(libFile(b.program)).toBe(libFile(a.program));
    expect(uncached.program.getSourceFile(shared)).not.toBe(a.program.getSourceFile(shared));
  });

  it('evicts the least recently used option set beyond its limit and still checks it correctly', async () => {
    const root = await createFixture({
      'loose/tsconfig.json': JSON.stringify({ compilerOptions: { ...smallLib, strict: false } }),
      'strict/tsconfig.json': JSON.stringify({ compilerOptions: { ...smallLib, strict: true } }),
      'other/tsconfig.json': JSON.stringify({
        compilerOptions: { ...smallLib, strict: true, noImplicitReturns: true },
      }),
      'workflow.ts': 'export function identity(value) { return value; }\n',
    });
    const check = (cache: TypecheckProgramCache, config: string) =>
      checkedProgram(root, 'workflow.ts', cache, join(config, 'tsconfig.json'));
    const cache = new TypecheckProgramCache(2);
    const strict = check(cache, 'strict');
    check(cache, 'loose');
    const strictAgain = check(cache, 'strict');
    check(cache, 'other');
    const strictKept = check(cache, 'strict');
    check(cache, 'loose');
    check(cache, 'other');
    const strictEvicted = check(cache, 'strict');

    expect(strict.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([7006]);
    expect(libFile(strictAgain.program)).toBe(libFile(strict.program));
    expect(libFile(strictKept.program)).toBe(libFile(strict.program));
    expect(libFile(strictEvicted.program)).not.toBe(libFile(strict.program));
    expect(strictEvicted.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([7006]);
    expect(diagnosticSummary(strictEvicted.diagnostics)).toEqual(
      diagnosticSummary(ts.getPreEmitDiagnostics(strictEvicted.program)),
    );
    expect(check(cache, 'loose').diagnostics).toEqual([]);
  });
});
