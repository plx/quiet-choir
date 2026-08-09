import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ThresholdLogger } from '../src/application/execution.js';
import { analyzeTypecheckEntrypoint } from '../src/workflow/typecheck/plan.js';
import { TypeScriptExecutor } from '../src/workflow/typecheck/typescript-executor.js';

const silentLogger = new ThresholdLogger('silent', () => {
  throw new Error('The silent logger must not write.');
});

const temporaryDirectories: string[] = [];

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

async function executeEntrypoint(root: string, entrypoint = 'workflow.ts') {
  const analysis = analyzeTypecheckEntrypoint(join(root, entrypoint), root);
  expect(analysis.ok).toBe(true);

  if (!analysis.ok) {
    throw new Error(analysis.error.message);
  }

  return new TypeScriptExecutor(silentLogger).execute(analysis.plan);
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

describe('TypeScriptExecutor', () => {
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
    expect(result.diagnostics).toEqual([]);
    expect(result.compilerVersion).toMatch(/^6\./);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

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
