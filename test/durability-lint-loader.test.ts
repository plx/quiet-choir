import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ThresholdLogger } from '../src/application/execution.js';
import { WorkflowExecutor } from '../src/workflow/loader/executor.js';
import { analyzeTypecheckEntrypoint } from '../src/workflow/typecheck/plan.js';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtures = join(projectRoot, 'test', 'fixtures', 'durability-lint');
const fixture = (name: string): string => join(fixtures, `${name}.workflow.ts`);
const roots: string[] = [];

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'quiet-choir-durability-'));
  roots.push(root);
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await symlink(join(projectRoot, 'node_modules'), join(root, 'node_modules'));
  return root;
}

function typecheck(file: string) {
  const analysis = analyzeTypecheckEntrypoint(file, projectRoot);
  if (!analysis.ok) throw new Error(analysis.error.message);
  return analysis.plan;
}

function executor(log: (level: string, message: string) => void = () => undefined) {
  return new WorkflowExecutor({
    logger: { log },
    signal: new AbortController().signal,
    harness: { invoke: vi.fn() },
  });
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Each case compiles one fixture against the root tsconfig (src/ included); a failing validate
// stops before import.
// measured: 0.9-1.2 s per case alone, up to 5.1 s in a full coverage run (compile-dominated).
describe('durability lint in the loader', { timeout: 20_000 }, () => {
  it.each([
    ['m01-void', 'QC001', 10],
    ['m02-reused-id', 'QC005', 11],
    ['m03-loop-id', 'QC005', 13],
    ['m05-exists-sync', 'QC002', 12],
    ['m06-date-now', 'QC002', 10],
    ['m07-process-env', 'QC002', 10],
    ['m08-nested-step', 'QC003', 13],
    ['m08b-nested-exec', 'QC003', 14],
    ['m20-race', 'QC004', 10],
  ])('fails validate of %s with %s at its line', async (name, rule, line) => {
    const result = await executor().execute({
      kind: 'workflow.validate',
      typecheck: typecheck(fixture(name)),
    });
    expect(result).toMatchObject({
      kind: 'workflow.error',
      ok: false,
      code: 'load.typecheck',
      message: expect.stringMatching(
        /^Workflow durability lint failed: \d+ finding\(s\); fix them or add `\/\/ quiet-choir-ignore QCnnn <reason>` on the line before\.$/,
      ) as unknown,
      diagnostics: expect.arrayContaining([
        {
          rule,
          category: 'error',
          file: fixture(name),
          line,
          column: expect.any(Number) as unknown,
          message: expect.any(String) as unknown,
        },
      ]) as unknown,
    });
  });

  it.each(['m11b-named-map', 'exclusive-branch', 'legitimate-apis'])(
    'validates the clean %s fixture with no diagnostics',
    async (name) => {
      const result = await executor().execute({
        kind: 'workflow.validate',
        typecheck: typecheck(fixture(name)),
      });
      expect(result).toMatchObject({ kind: 'workflow.validate.result', ok: true, diagnostics: [] });
    },
  );

  it('keeps compiler diagnostics for a type error and does not lint', async () => {
    const root = await temporary();
    const file = join(root, 'broken.workflow.ts');
    await writeFile(
      file,
      `import { z } from 'zod';
import { defineWorkflow } from ${JSON.stringify(join(projectRoot, 'src/workflow/runtime/model.js'))};
export default defineWorkflow({
  name: 'broken', version: '1', input: z.null(), output: z.null(),
  async run(ctx) { void ctx.now('lost'); const wrong: number = Date(); return null; },
});`,
    );
    const result = await executor().execute({
      kind: 'workflow.validate',
      typecheck: typecheck(file),
    });
    expect(result).toMatchObject({
      ok: false,
      code: 'load.typecheck',
      message: 'Workflow type check failed.',
    });
    if (result.ok || !('diagnostics' in result)) throw new Error('Expected a failure.');
    expect(result.diagnostics.length).toBeGreaterThan(0);
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic).toHaveProperty('code');
      expect(diagnostic).not.toHaveProperty('rule');
    }
  });

  it('warns about a QC002 finding on execute and runs the workflow', async () => {
    const root = await temporary();
    const log = vi.fn<(level: string, message: string) => void>();
    const result = await executor(log).execute({
      kind: 'workflow.execute',
      runId: 'durability-warning',
      stateDir: join(root, 'state'),
      cwd: root,
      resume: false,
      input: {},
      typecheck: typecheck(fixture('m06-date-now')),
    });
    expect(result).toMatchObject({ ok: true, run: { status: 'completed' } });
    expect(log).toHaveBeenCalledWith(
      'warn',
      expect.stringMatching(
        /test\/fixtures\/durability-lint\/m06-date-now\.workflow\.ts:10:21 - warning QC002: Date\.now\(\)/,
      ),
    );
  });

  it('lists and runs definitions with findings, logging them only when it validates', async () => {
    const root = await temporary();
    vi.stubEnv('XDG_CACHE_HOME', join(root, 'cache'));
    await writeFile(
      join(root, 'clock.workflow.ts'),
      `import { z } from 'zod';
import { defineWorkflow } from ${JSON.stringify(join(projectRoot, 'src/workflow/runtime/model.js'))};
export default defineWorkflow({
  name: 'clock', version: '1', input: z.null(), output: z.number(),
  async run(ctx) { return ctx.step('read', { input: { at: Date.now() }, schema: z.number(), run: () => 1 }); },
});`,
    );
    const lines: string[] = [];
    const engine = new WorkflowExecutor({
      logger: new ThresholdLogger('warn', (line) => lines.push(line)),
    });
    const plan = { kind: 'workflow.list-defs' as const, directories: [root] };
    const fresh = await engine.execute(plan);
    expect(fresh).toMatchObject({
      kind: 'workflow.list-defs.result',
      ok: true,
      definitions: [{ workflow: { name: 'clock' } }],
    });
    if (fresh.kind !== 'workflow.list-defs.result') throw new Error('Expected definitions.');
    expect(fresh.definitions[0]).not.toHaveProperty('diagnostics');
    expect(lines).toEqual([
      expect.stringMatching(/^\[warn\] .*clock\.workflow\.ts:5:\d+ - warning QC002: Date\.now\(\)/),
    ]);
    lines.length = 0;
    expect(await engine.execute(plan)).toEqual(fresh);
    expect(lines).toEqual([]);
  });
});
