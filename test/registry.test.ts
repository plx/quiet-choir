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
const executor = () =>
  new WorkflowExecutor({ logger: new ThresholdLogger('silent', () => undefined) });
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Cache invalidation and refresh cases compile repeatedly; Node 22 coverage on CI needs headroom.
describe('trusted definition registry', { timeout: 60_000 }, () => {
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
