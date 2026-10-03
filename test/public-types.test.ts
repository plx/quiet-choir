import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

/**
 * The published declarations must type every public export. `stripInternal` removes `@internal`
 * declarations from `dist`, so an entry point that re-exports one compiles to a `.d.ts` that names
 * a missing member: consumers get TS2305 with `skipLibCheck: false` and a silent `any` with it.
 * vitest runs before `npm run build`, so these tests emit the declarations themselves with the
 * real build configuration and resolve them through the package `exports` map.
 */

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const tsc = join(root, 'node_modules', '@typescript', 'native', 'bin', 'tsc');

/** Run the repository's tsc; resolve to its error diagnostics, one per line. */
async function compiler(cwd: string, args: readonly string[]): Promise<string[]> {
  try {
    await run(process.execPath, [tsc, ...args], { cwd, maxBuffer: 16 * 1024 * 1024 });
    return [];
  } catch (error) {
    const output = (error as { stdout?: string }).stdout ?? '';
    const diagnostics = output.split('\n').filter((line) => /error TS\d+/u.test(line));
    if (diagnostics.length === 0) throw error;
    return diagnostics;
  }
}

interface ConsumedEntry {
  /** Module specifier resolved through a package `exports` map. */
  readonly specifier: string;
  /** Runtime export names, each of which must have a declared, non-`any` type. */
  readonly names: readonly string[];
}

/**
 * Compile a consumer that references every runtime export of each entry with a `NotAny` check,
 * against `packages` linked into its node_modules, and return the diagnostics. `--skipLibCheck
 * false` also checks every declaration file in the program, which covers type-only re-exports.
 */
async function consumerDiagnostics(
  directory: string,
  packages: Readonly<Record<string, string>>,
  entries: readonly ConsumedEntry[],
): Promise<string[]> {
  await mkdir(join(directory, 'node_modules'), { recursive: true });
  for (const [name, target] of Object.entries(packages))
    await symlink(target, join(directory, 'node_modules', name), 'dir');
  await symlink(
    join(root, 'node_modules', '@types'),
    join(directory, 'node_modules', '@types'),
    'dir',
  );
  await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  const source = [
    'type NotAny<T> = 0 extends 1 & T ? false : true;',
    ...entries.flatMap((entry, index) => [
      `import * as m${String(index)} from ${JSON.stringify(entry.specifier)};`,
      ...entry.names.map(
        (name) =>
          `export const k${String(index)}_${name}: NotAny<typeof m${String(index)}.${name}> = true;`,
      ),
    ]),
  ].join('\n');
  await writeFile(join(directory, 'consumer.ts'), `${source}\n`);
  return compiler(directory, [
    '--noEmit',
    '--strict',
    '--skipLibCheck',
    'false',
    '--module',
    'nodenext',
    '--moduleResolution',
    'nodenext',
    '--types',
    'node',
    'consumer.ts',
  ]);
}

/** Emit declarations only, as `tsconfig.build.json` would, into `outDir`. */
function emitDeclarations(cwd: string, project: string, outDir: string): Promise<string[]> {
  return compiler(cwd, [
    '-p',
    project,
    '--emitDeclarationOnly',
    '--outDir',
    outDir,
    '--declarationMap',
    'false',
    '--sourceMap',
    'false',
    '--inlineSources',
    'false',
  ]);
}

describe('published declarations', () => {
  // Fits the default timeout: 0.8 s alone and 0.9 s in a full coverage run (one native tsc emit and
  // one compile).
  it('type every runtime export of quiet-choir, its harness kit, decision and github helpers', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'qc-public-types-'));
    try {
      const pkg = join(temp, 'pkg');
      expect(await emitDeclarations(root, 'tsconfig.build.json', join(pkg, 'dist'))).toEqual([]);
      await copyFile(join(root, 'package.json'), join(pkg, 'package.json'));
      await symlink(join(root, 'node_modules'), join(pkg, 'node_modules'), 'dir');
      const entries = [
        { specifier: 'quiet-choir', names: Object.keys(await import('../src/index.js')) },
        {
          specifier: 'quiet-choir/harness-kit',
          names: Object.keys(await import('../src/harness-kit.js')),
        },
        {
          specifier: 'quiet-choir/decision',
          names: Object.keys(await import('../src/integrations/decision.js')),
        },
        {
          specifier: 'quiet-choir/github',
          names: Object.keys(await import('../src/integrations/github.js')),
        },
      ];
      // Guard against a vacuous pass: the helpers this check exists for must be listed.
      expect(entries[1]?.names).toEqual(
        expect.arrayContaining([
          'attachHarnessEvidence',
          'usageObject',
          'JsonLines',
          'childEnvironment',
          'createInvocationStream',
          'standaloneInvocation',
          'outputLimitError',
          'promptedStructuredOutput',
        ]),
      );
      expect(entries[2]?.names).toContain('decision');
      expect(entries[3]?.names).toEqual(
        expect.arrayContaining([
          'github',
          'IncompleteCollectionError',
          'parseGithubRepo',
          'summarizeChecks',
          'reviewThreadsResponseSchema',
        ]),
      );
      expect(
        await consumerDiagnostics(join(temp, 'consumer'), { 'quiet-choir': pkg }, entries),
      ).toEqual([]);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  // Fits the default timeout: 0.3 s alone and 0.5 s in a full coverage run.
  it('fail when an entry point re-exports a declaration that stripInternal removes', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'qc-public-types-strip-'));
    try {
      const pkg = join(temp, 'strip-probe');
      await mkdir(join(pkg, 'src'), { recursive: true });
      await writeFile(
        join(pkg, 'package.json'),
        JSON.stringify({
          name: 'strip-probe',
          type: 'module',
          exports: { '.': { types: './dist/entry.d.ts', default: './dist/entry.js' } },
        }),
      );
      await writeFile(
        join(pkg, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            module: 'nodenext',
            moduleResolution: 'nodenext',
            declaration: true,
            stripInternal: true,
            strict: true,
            types: [],
            rootDir: 'src',
          },
          include: ['src/*.ts'],
        }),
      );
      await writeFile(
        join(pkg, 'src', 'internal.ts'),
        [
          '/** Public. */',
          'export function shown(): number { return 1; }',
          '/** Stripped. @internal */',
          'export function hidden(): number { return 2; }',
        ].join('\n'),
      );
      await writeFile(
        join(pkg, 'src', 'entry.ts'),
        "export { hidden, shown } from './internal.js';\n",
      );
      expect(await emitDeclarations(pkg, 'tsconfig.json', join(pkg, 'dist'))).toEqual([]);
      const diagnostics = await consumerDiagnostics(
        join(temp, 'consumer'),
        { 'strip-probe': pkg },
        [{ specifier: 'strip-probe', names: ['hidden', 'shown'] }],
      );
      expect(diagnostics.some((line) => line.includes('TS2305') && line.includes('hidden'))).toBe(
        true,
      );
      expect(diagnostics.some((line) => line.includes('shown'))).toBe(false);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
