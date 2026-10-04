import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThresholdLogger } from '../src/application/execution.js';
import { WorkflowExecutor } from '../src/workflow/loader/executor.js';
import { TypecheckProgramCache } from '../src/workflow/typecheck/program-cache.js';
import { definitionFiles } from '../src/workflow/loader/registry.js';

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

// measured: the slowest case (cache refresh) takes 1.3 s alone and 3.3-3.6 s in local full coverage
// runs; before the shared program cache it took 10.1-13.1 s locally and up to 13.1 s on the Node 22.13
// and 28.3 s on the Node 24 CI legs (dominated by the suite's first full engine compile and tsImport).
describe('trusted definition registry', { timeout: 20_000 }, () => {
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
    for (const file of await readdir(cache)) await writeFile(join(cache, file), 'invalid JSON');
    expect(await engine.execute(plan)).toMatchObject({ ok: true });
    expect(await readFile(marker, 'utf8')).toBe('xxx');
    expect(await engine.execute({ ...plan, refresh: true })).toMatchObject({ ok: true });
    expect(await readFile(marker, 'utf8')).toBe('xxxx');
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
