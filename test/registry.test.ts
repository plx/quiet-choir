import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThresholdLogger } from '../src/application/execution.js';
import { WorkflowExecutor } from '../src/workflow/loader/executor.js';
import type { TypecheckPlan } from '../src/workflow/typecheck/model.js';
import { TypecheckProgramCache } from '../src/workflow/typecheck/program-cache.js';
import {
  definitionFiles,
  discoverDefinitions,
  engineCodeDigest,
  listDefinitions,
  listingName,
  selectDefinition,
} from '../src/workflow/loader/registry.js';
import type { ValidatedWorkflow } from '../src/workflow/loader/model.js';
import { readRun } from '../src/workflow/runtime/store.js';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const roots: string[] = [];
async function project() {
  const root = await mkdtemp(join(tmpdir(), 'choir-registry-'));
  roots.push(root);
  await symlink(join(repository, 'node_modules'), join(root, 'node_modules'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  vi.stubEnv('XDG_CACHE_HOME', join(root, 'cache'));
  return root;
}
function source(name: string, body = 'return null;'): string {
  return `import {z} from 'zod'; import {defineWorkflow} from ${JSON.stringify(join(repository, 'src/workflow/runtime/model.js'))}; export default defineWorkflow({name:${JSON.stringify(name)},version:'1',input:z.null(),output:z.null(),run:async()=>{${body}}});`;
}
// One program cache for the suite: the first compile checks the whole engine, later ones reuse it.
const typecheckCache = new TypecheckProgramCache();
const executor = () =>
  new WorkflowExecutor({ logger: new ThresholdLogger('silent', () => undefined), typecheckCache });
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// measured: the slowest case (cache refresh) takes 1.3 s alone, 3.3-3.6 s in local full coverage
// runs, and 8.0 s on the Node 22.13 and 12.7 s on the Node 24 CI legs; before the shared program cache
// it took 10.1-13.1 s locally and up to 13.1 s on the Node 22.13 and 28.3 s on the Node 24 CI legs
// (dominated by the suite's first full engine compile and tsImport).
describe('trusted definition registry', { timeout: 30_000 }, () => {
  it('deduplicates overlapping directories and ignores generated trees and directory symlinks', async () => {
    const root = await project();
    await mkdir(join(root, 'nested'));
    await mkdir(join(root, 'dist'));
    await writeFile(join(root, 'nested', 'a.workflow.ts'), source('a'));
    await writeFile(join(root, 'dist', 'skip.workflow.ts'), source('skip'));
    await symlink(root, join(root, 'nested', 'cycle'));
    expect(await definitionFiles([root, join(root, 'nested')])).toEqual([
      await realpath(join(root, 'nested', 'a.workflow.ts')),
    ]);
  });

  it('discovers .workflow.ts, .mts and .cts files and ignores declaration and tsx files', async () => {
    const root = await project();
    for (const name of [
      'a.workflow.mts',
      'b.workflow.cts',
      'c.workflow.d.ts',
      'd.workflow.tsx',
      'e.workflow.mjs',
    ])
      await writeFile(join(root, name), '');
    expect(await definitionFiles([root])).toEqual([
      await realpath(join(root, 'a.workflow.mts')),
      await realpath(join(root, 'b.workflow.cts')),
    ]);
  });

  it('caches validated source metadata, refreshes edited dependencies, and recovers a corrupt cache', async () => {
    const root = await project();
    const marker = join(root, 'imported');
    const dependency = join(root, 'description.ts');
    await writeFile(dependency, "export const description = 'original';");
    await writeFile(
      join(root, 'cached.workflow.ts'),
      `import {appendFileSync} from 'node:fs'; import {description} from './description.js'; appendFileSync(${JSON.stringify(marker)},'x'); ${source('cached').replace("version:'1',", "version:'1',description,")}`,
    );
    const engine = executor();
    const plan = { kind: 'workflow.list-defs' as const, directories: [root] };
    const first = await engine.execute(plan);
    expect(first).toMatchObject({
      ok: true,
      definitions: [{ workflow: { description: 'original' } }],
    });
    expect(await readFile(marker, 'utf8')).toBe('x');
    expect(await engine.execute(plan)).toEqual(first);
    expect(await readFile(marker, 'utf8')).toBe('x');
    await writeFile(dependency, "export const description = 'updated';");
    expect(await engine.execute(plan)).toMatchObject({
      ok: true,
      definitions: [{ workflow: { description: 'updated' } }],
    });
    expect(await readFile(marker, 'utf8')).toBe('xx');
    const cache = join(root, 'cache', 'quiet-choir', 'definitions');
    // A version-7 entry holds a single result without package entries (#585), a version-6 entry
    // hashed prompt-root files by bytes alone and a version-5 entry has no prompts section or
    // prompt-root sources (#581), a version-4 entry is keyed on the version string alone (#345),
    // and a version-3 entry may hold plaintext registered harness options (#247): none is served,
    // all are rewritten.
    for (const [index, stale] of [7, 6, 5, 4, 3].entries()) {
      for (const file of await readdir(cache)) {
        const entry = JSON.parse(await readFile(join(cache, file), 'utf8')) as { version: number };
        expect(entry.version).toBe(8);
        await writeFile(join(cache, file), JSON.stringify({ ...entry, version: stale }));
      }
      expect(await engine.execute(plan)).toMatchObject({ ok: true });
      expect(await readFile(marker, 'utf8')).toBe('x'.repeat(3 + index));
      for (const file of await readdir(cache))
        expect(JSON.parse(await readFile(join(cache, file), 'utf8'))).toMatchObject({ version: 8 });
    }
    for (const file of await readdir(cache)) await writeFile(join(cache, file), 'invalid JSON');
    expect(await engine.execute(plan)).toMatchObject({ ok: true });
    expect(await readFile(marker, 'utf8')).toBe('x'.repeat(8));
    expect(await engine.execute({ ...plan, refresh: true })).toMatchObject({ ok: true });
    expect(await readFile(marker, 'utf8')).toBe('x'.repeat(9));
  });

  it('revalidates when the validation key changes and serves the new key afterwards (#345)', async () => {
    const root = await project();
    const marker = join(root, 'imported');
    await writeFile(
      join(root, 'keyed.workflow.ts'),
      `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(marker)},'x'); ${source('keyed')}`,
    );
    const runner = executor();
    const validate = (typecheck: TypecheckPlan) =>
      runner.execute({ kind: 'workflow.validate', typecheck, durabilityLint: 'warn' });
    const list = (engine: string) => listDefinitions([root], validate, { engine });
    const cache = join(root, 'cache', 'quiet-choir', 'definitions');
    const recorded = async () => {
      const [file] = await readdir(cache);
      return (JSON.parse(await readFile(join(cache, file ?? ''), 'utf8')) as { engine: string })
        .engine;
    };
    expect(await list('rules-a')).toMatchObject({ ok: true });
    expect(await list('rules-a')).toMatchObject({ ok: true });
    expect(await readFile(marker, 'utf8')).toBe('x');
    expect(await recorded()).toBe('rules-a');
    expect(await list('rules-b')).toMatchObject({ ok: true });
    expect(await readFile(marker, 'utf8')).toBe('xx');
    expect(await recorded()).toBe('rules-b');
    expect(await list('rules-b')).toMatchObject({ ok: true });
    expect(await readFile(marker, 'utf8')).toBe('xx');
  });

  it('digests engine code files by content and path and ignores source maps (#345)', async () => {
    const root = await project();
    const tree = join(root, 'engine');
    await mkdir(join(tree, 'nested'), { recursive: true });
    await writeFile(join(tree, 'a.ts'), 'export const a = 1;');
    await writeFile(join(tree, 'nested', 'b.js'), 'export const b = 1;');
    await writeFile(join(tree, 'a.js.map'), '{}');
    await writeFile(join(tree, 'notes.md'), 'ignored');
    const base = await engineCodeDigest(tree);
    expect(await engineCodeDigest(tree)).toBe(base);
    await writeFile(join(tree, 'a.js.map'), '{"changed":true}');
    await writeFile(join(tree, 'notes.md'), 'still ignored');
    expect(await engineCodeDigest(tree)).toBe(base);
    await writeFile(join(tree, 'a.ts'), 'export const a = 2;');
    const edited = await engineCodeDigest(tree);
    expect(edited).not.toBe(base);
    await writeFile(join(tree, 'nested', 'b.js'), 'export const b = 2;');
    const editedJs = await engineCodeDigest(tree);
    expect(editedJs).not.toBe(edited);
    await writeFile(join(tree, 'c.d.ts'), 'export declare const c: number;');
    const added = await engineCodeDigest(tree);
    expect(added).not.toBe(editedJs);
    await rename(join(tree, 'c.d.ts'), join(tree, 'd.d.ts'));
    expect(await engineCodeDigest(tree)).not.toBe(added);
  });

  it('keeps scanning past a leaf package.json to fingerprint a workspace root lockfile', async () => {
    const root = await project();
    await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3}');
    const leaf = join(root, 'packages', 'leaf');
    await mkdir(leaf, { recursive: true });
    await writeFile(join(leaf, 'package.json'), '{"type":"module"}');
    const marker = join(root, 'imported');
    await writeFile(
      join(leaf, 'cached.workflow.ts'),
      `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(marker)},'x'); ${source('cached')}`,
    );
    const engine = executor();
    const plan = { kind: 'workflow.list-defs' as const, directories: [leaf] };
    expect(await engine.execute(plan)).toMatchObject({ ok: true });
    expect(await readFile(marker, 'utf8')).toBe('x');
    expect(await engine.execute(plan)).toMatchObject({ ok: true });
    expect(await readFile(marker, 'utf8')).toBe('x');
    await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}');
    expect(await engine.execute(plan)).toMatchObject({ ok: true });
    expect(await readFile(marker, 'utf8')).toBe('xx');
  });

  it('invalidates the cache when an extended tsconfig base changes', async () => {
    const root = await project();
    const marker = join(root, 'imported');
    const baseConfig = (strict: boolean) =>
      JSON.stringify({
        compilerOptions: {
          module: 'nodenext',
          moduleResolution: 'nodenext',
          target: 'es2023',
          lib: ['es2023'],
          skipLibCheck: true,
          types: ['node'],
          strict,
        },
      });
    await writeFile(join(root, 'base.tsconfig.json'), baseConfig(false));
    await writeFile(
      join(root, 'tsconfig.json'),
      JSON.stringify({ extends: './base.tsconfig.json' }),
    );
    await writeFile(
      join(root, 'extends.workflow.ts'),
      `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(marker)},'x'); ${source('extends')}`,
    );
    const engine = executor();
    const plan = { kind: 'workflow.list-defs' as const, directories: [root] };
    expect(await engine.execute(plan)).toMatchObject({ ok: true });
    expect(await readFile(marker, 'utf8')).toBe('x');
    expect(await engine.execute(plan)).toMatchObject({ ok: true });
    expect(await readFile(marker, 'utf8')).toBe('x');
    await writeFile(join(root, 'base.tsconfig.json'), baseConfig(true));
    expect(await engine.execute(plan)).toMatchObject({ ok: true });
    expect(await readFile(marker, 'utf8')).toBe('xx');
  });

  it('reports duplicate names and compiler failures without invoking workflow bodies', async () => {
    const root = await project();
    await writeFile(
      join(root, 'a.workflow.ts'),
      source('duplicate', "throw new Error('body must not run');"),
    );
    await writeFile(join(root, 'b.workflow.ts'), source('duplicate'));
    const engine = executor();
    expect(await engine.execute({ kind: 'workflow.list-defs', directories: [root] })).toMatchObject(
      {
        ok: false,
        code: 'load.definition',
        message: expect.stringContaining('Duplicate workflow name') as unknown,
      },
    );
    await writeFile(
      join(root, 'a.workflow.ts'),
      'const wrong: number = "bad"; export default wrong;',
    );
    expect(await engine.execute({ kind: 'workflow.list-defs', directories: [root] })).toMatchObject(
      { ok: false, code: 'load.typecheck' },
    );
  });
});

const engineIndex = JSON.stringify(join(repository, 'src/index.js'));

interface PackageFixture {
  /** Package name; the directory is `<dir ?? name>.quiet-choir`. */
  readonly name: string;
  readonly dir?: string;
  /** Workflow names, in declaration order; the first is the entry unless `entry` is false. */
  readonly workflows?: readonly string[];
  readonly entry?: boolean;
  /** Appended to on every evaluation of the manifest. */
  readonly marker?: string;
}

/** Write `<name>.quiet-choir/` under `root` with one `workflows/<name>.ts` per workflow. */
async function writePackage(root: string, options: PackageFixture): Promise<string> {
  const dir = join(root, `${options.dir ?? options.name}.quiet-choir`);
  const workflows = options.workflows ?? ['main', 'other'];
  await mkdir(join(dir, 'workflows'), { recursive: true });
  await mkdir(join(dir, 'resources'), { recursive: true });
  await writeFile(join(dir, 'resources', 'notes.txt'), 'notes\n');
  for (const workflow of workflows)
    await writeFile(
      join(dir, 'workflows', `${workflow}.ts`),
      `import { defineWorkflow, z } from ${engineIndex};\nexport default defineWorkflow({ name: ${JSON.stringify(workflow)}, version: '1', description: ${JSON.stringify(`Workflow ${workflow}.`)}, input: z.null(), output: z.null(), run: async () => null });\n`,
    );
  await writeFile(
    join(dir, 'package.ts'),
    `${options.marker === undefined ? '' : `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(options.marker)}, 'x');\n`}import { definePackage } from ${engineIndex};
${workflows.map((workflow, index) => `import w${String(index)} from './workflows/${workflow}.js';`).join('\n')}
export default definePackage({
  root: import.meta.dirname,
  name: ${JSON.stringify(options.name)},
  version: '1',
  description: 'The ${options.name} package.',
  whenToUse: 'When testing.',
  workflows: [${workflows.map((_, index) => `w${String(index)}`).join(', ')}],
${options.entry === false ? '' : '  entry: w0,\n'}});
`,
  );
  return realpath(dir);
}

/** The listing names of a list-defs result. */
function listed(result: Awaited<ReturnType<WorkflowExecutor['execute']>>): string[] {
  if (result.kind !== 'workflow.list-defs.result')
    throw new Error(`Expected a listing: ${JSON.stringify(result).slice(0, 2000)}`);
  return result.definitions.map(listingName);
}

// measured: the cache case (eight list-defs validations) takes 8.6 s and the by-name case 5.7 s
// in a two-file local run without coverage, the others under 1 s (dominated by tsImport compiles on
// the shared program cache); coverage slows these compiles about 2.5x, hence 60 s.
describe('package discovery in the registry (#585)', { timeout: 60_000 }, () => {
  it('discovers packages beside loose files without descending into them', async () => {
    const root = await project();
    await writeFile(join(root, 'a.workflow.ts'), source('a'));
    const dir = await writePackage(root, { name: 'demo' });
    await writeFile(join(dir, 'inside.workflow.ts'), source('inside'));
    // The bare state directory is not a package.
    await mkdir(join(root, '.quiet-choir', 'runs'), { recursive: true });
    expect(await discoverDefinitions([root])).toEqual({
      files: [await realpath(join(root, 'a.workflow.ts'))],
      packages: [dir],
    });
    expect(await discoverDefinitions([dir])).toEqual({ files: [], packages: [dir] });
    expect(await definitionFiles([root])).toEqual([await realpath(join(root, 'a.workflow.ts'))]);
  });

  it('lists a package beside a loose definition and caches the package entry', async () => {
    const root = await project();
    const marker = join(root, 'imported');
    await writeFile(join(root, 'a.workflow.ts'), source('a'));
    const dir = await writePackage(root, { name: 'demo', marker });
    const engine = executor();
    const plan = { kind: 'workflow.list-defs' as const, directories: [root] };
    const first = await engine.execute(plan);
    expect(listed(first)).toEqual(['a', 'demo/main', 'demo/other']);
    if (first.kind !== 'workflow.list-defs.result') throw new Error('Expected a listing.');
    const summary = {
      root: dir,
      name: 'demo',
      version: '1',
      description: 'The demo package.',
      whenToUse: 'When testing.',
    };
    expect(first.definitions[0]).not.toHaveProperty('package');
    expect(first.definitions[1]).toMatchObject({
      entrypoint: join(dir, 'workflows', 'main.ts'),
      package: summary,
      workflow: { name: 'main', description: 'Workflow main.' },
    });
    expect(first.definitions[2]).toMatchObject({
      entrypoint: join(dir, 'workflows', 'other.ts'),
      package: summary,
    });
    // One validation of the package lists both workflows, and both hash the walked resource.
    expect(await readFile(marker, 'utf8')).toBe('x');
    expect(Object.keys(first.definitions[2]?.workflow.identity?.files ?? {})).toContain(
      `${basename(dir)}/resources/notes.txt`,
    );
    expect(await engine.execute(plan)).toEqual(first);
    expect(await readFile(marker, 'utf8')).toBe('x');
    const cache = join(root, 'cache', 'quiet-choir', 'definitions');
    const entries = async () =>
      Promise.all(
        (await readdir(cache)).map(
          async (file) =>
            [file, JSON.parse(await readFile(join(cache, file), 'utf8'))] as [
              string,
              Record<string, unknown>,
            ],
        ),
      );
    expect((await entries()).map(([, entry]) => entry['version'])).toEqual([8, 8]);
    // Older envelopes are revalidated and rewritten.
    for (const [index, stale] of [7, 6].entries()) {
      for (const [file, entry] of await entries())
        await writeFile(join(cache, file), JSON.stringify({ ...entry, version: stale }));
      expect(await engine.execute(plan)).toEqual(first);
      expect(await readFile(marker, 'utf8')).toBe('x'.repeat(2 + index));
      expect((await entries()).map(([, entry]) => entry['version'])).toEqual([8, 8]);
    }
    // An edited, an added and a removed package file each revalidate the package.
    await writeFile(join(dir, 'resources', 'notes.txt'), 'edited\n');
    expect(listed(await engine.execute(plan))).toEqual(['a', 'demo/main', 'demo/other']);
    expect(await readFile(marker, 'utf8')).toBe('xxxx');
    await writeFile(join(dir, 'resources', 'added.txt'), 'added\n');
    await engine.execute(plan);
    expect(await readFile(marker, 'utf8')).toBe('xxxxx');
    await engine.execute(plan);
    expect(await readFile(marker, 'utf8')).toBe('xxxxx');
    await rm(join(dir, 'resources', 'added.txt'));
    await engine.execute(plan);
    expect(await readFile(marker, 'utf8')).toBe('xxxxxx');
  });

  it('lists a package without entry and the same workflow name in two packages', async () => {
    const root = await project();
    await writePackage(root, { name: 'demo', workflows: ['review'], entry: false });
    await writePackage(root, { name: 'other', workflows: ['review', 'main'] });
    expect(
      listed(await executor().execute({ kind: 'workflow.list-defs', directories: [root] })),
    ).toEqual(['demo/review', 'other/review', 'other/main']);
  });

  it('refuses two packages with one name and package directories without package.ts', async () => {
    const root = await project();
    await writePackage(root, { name: 'demo' });
    await writePackage(root, { name: 'demo', dir: 'copy' });
    expect(
      await executor().execute({ kind: 'workflow.list-defs', directories: [root] }),
    ).toMatchObject({
      ok: false,
      code: 'load.definition',
      message: expect.stringContaining('Duplicate workflow name demo/main') as unknown,
    });
    const empty = await project();
    await mkdir(join(empty, 'empty.quiet-choir'));
    expect(
      await executor().execute({ kind: 'workflow.list-defs', directories: [empty] }),
    ).toMatchObject({
      ok: false,
      code: 'load.definition',
      message: expect.stringContaining('No package.ts manifest found in package') as unknown,
    });
    await rm(join(empty, 'empty.quiet-choir'), { recursive: true });
    await mkdir(join(empty, 'js.quiet-choir'));
    await writeFile(join(empty, 'js.quiet-choir', 'package.mjs'), 'export default {};\n');
    expect(
      await executor().execute({ kind: 'workflow.list-defs', directories: [empty] }),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining('rename package.mjs to package.ts') as unknown,
    });
  });

  it('selects an exact listing name first, then a unique bare package workflow name', () => {
    const entry = (name: string, pkg?: string) =>
      ({
        kind: 'workflow.validate.result',
        ok: true,
        entrypoint: `/defs/${pkg ?? 'loose'}/${name}.ts`,
        ...(pkg === undefined
          ? {}
          : {
              package: {
                root: `/defs/${pkg}.quiet-choir`,
                name: pkg,
                version: '1',
                description: null,
                whenToUse: null,
              },
            }),
        workflow: { name },
      }) as unknown as ValidatedWorkflow;
    const loose = entry('main');
    const demoMain = entry('main', 'demo');
    const demoReview = entry('review', 'demo');
    const otherReview = entry('review', 'other');
    const definitions = [loose, demoMain, demoReview, otherReview];
    expect(selectDefinition(definitions, 'main')).toBe(loose);
    expect(selectDefinition(definitions, 'demo/main')).toBe(demoMain);
    expect(selectDefinition([demoMain], 'main')).toBe(demoMain);
    expect(selectDefinition(definitions, 'other/review')).toBe(otherReview);
    expect(() => selectDefinition(definitions, 'review')).toThrow(
      'Workflow name review is ambiguous: demo/review, other/review; use <package>/<workflow>',
    );
    expect(() => selectDefinition(definitions, 'missing')).toThrow('Unknown workflow name missing');
    // A bare name never matches a loose workflow through its package-qualified form.
    expect(() => selectDefinition([loose], 'demo/main')).toThrow('Unknown workflow name demo/main');
  });

  it('executes package workflows by qualified and bare name, recording the package', async () => {
    const root = await project();
    const dir = await writePackage(root, { name: 'demo' });
    await writeFile(join(root, 'main.workflow.ts'), source('main', 'return null;'));
    const stateDir = await mkdtemp(join(tmpdir(), 'choir-registry-state-'));
    roots.push(stateDir);
    const run = (name: string, runId: string) =>
      executor().execute({
        kind: 'workflow.execute-name',
        name,
        directories: [root],
        runId,
        stateDir,
        cwd: root,
        resume: false,
        input: null,
      });
    for (const [name, runId] of [
      ['demo/other', 'qualified'],
      ['other', 'bare'],
    ] as const) {
      expect(await run(name, runId)).toMatchObject({ ok: true, run: { status: 'completed' } });
      const record = await readRun({ stateDir, runId });
      expect(record.launch?.package).toEqual({ root: dir, name: 'demo', version: '1' });
      expect(record.launch?.entrypoint).toBe(join(dir, 'workflows', 'other.ts'));
    }
    // A loose main beside demo/main: the exact listing name wins.
    expect(await run('main', 'loose')).toMatchObject({ ok: true });
    const loose = await readRun({ stateDir, runId: 'loose' });
    expect(loose.launch?.package).toBeUndefined();
    expect(loose.launch?.entrypoint).toBe(await realpath(join(root, 'main.workflow.ts')));
    expect(await run('demo/main', 'demo-main')).toMatchObject({ ok: true });
    expect((await readRun({ stateDir, runId: 'demo-main' })).launch?.package?.name).toBe('demo');
    await writePackage(root, { name: 'more', workflows: ['other'] });
    expect(await run('other', 'ambiguous')).toMatchObject({
      ok: false,
      code: 'load.definition',
      message: expect.stringContaining(
        'Workflow name other is ambiguous: demo/other, more/other',
      ) as unknown,
    });
  });
});
