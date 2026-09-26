import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ThresholdLogger } from '../src/application/execution.js';
import { WorkflowExecutor } from '../src/workflow/loader/executor.js';
import type { ExecuteWorkflowPlan } from '../src/workflow/loader/model.js';
import { analyzeTypecheckEntrypoint } from '../src/workflow/typecheck/plan.js';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const roots: string[] = [];
const imports = `import { z } from 'zod';
import { defineWorkflow } from ${JSON.stringify(join(projectRoot, 'src/workflow/runtime/model.js'))};`;

async function fixture(source: string, extension = 'ts'): Promise<{ file: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'quiet-choir-loader-'));
  roots.push(root);
  const file = join(root, `workflow.${extension}`);
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await symlink(join(projectRoot, 'node_modules'), join(root, 'node_modules'));
  await writeFile(file, source);
  return { file, root };
}

function plan(file: string) {
  const analysis = analyzeTypecheckEntrypoint(file, projectRoot);
  if (!analysis.ok) throw new Error(analysis.error.message);
  return { kind: 'workflow.validate' as const, typecheck: analysis.plan };
}

function executor(): WorkflowExecutor {
  return new WorkflowExecutor({ logger: new ThresholdLogger('silent', () => undefined) });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const validSource = `${imports}
export default defineWorkflow({
  name: 'fixture', version: '1', input: z.object({ value: z.number() }), output: z.number(),
  async run(ctx, input) {
    return ctx.step('double', { input: input.value, schema: z.number(), run: () => input.value * 2 });
  },
});`;

// Real compiler passes can exceed five seconds under coverage on shared CI runners.
describe('trusted TypeScript workflow loader', { timeout: 20_000 }, () => {
  it('type-checks and validates metadata without invoking the body', async () => {
    const { file } = await fixture(
      validSource.replace(
        'return ctx.step(',
        "throw new Error('body was called'); return ctx.step(",
      ),
    );
    const result = await executor().execute(plan(file));
    expect(result).toMatchObject({
      kind: 'workflow.validate.result',
      ok: true,
      workflow: {
        name: 'fixture',
        version: '1',
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) as unknown,
      },
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('rejects type errors before importing module top-level code', async () => {
    const { file, root } = await fixture(`import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./imported', import.meta.url), 'bad');
export const invalid: number = 'wrong';`);
    const result = await executor().execute(plan(file));
    expect(result).toMatchObject({
      ok: false,
      message: 'Workflow type check failed.',
      diagnostics: [expect.objectContaining({ code: 2322 })],
    });
    await expect(readFile(join(root, 'imported'))).rejects.toThrow();
  });

  it.each([
    ['export const named = {};', 'default-export'],
    ['export default null;', 'default-export'],
    ['export default {name:"",version:"1",run(){}};', '"name" must be a nonempty string'],
    ['export default {name:"test",version:1,run(){}};', '"version" must be a nonempty string'],
    ['export default {name:"test",version:"1",run:42};', '"run" must be a function'],
    [
      'export default {name:"test",version:"1",run(){},input:{},output:{}};',
      '"input" is not a zod 4 schema',
    ],
    [
      `${imports} export default {name:"test",version:"1",run(){},input:z.string(),output:{}};`,
      '"output" is not a zod 4 schema',
    ],
  ])('identifies the invalid default-export field', async (source, message) => {
    const { file } = await fixture(source);
    const result = await executor().execute(plan(file));
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining(message) as unknown,
    });
  });

  it.each(['zod/v3', 'zod/mini'])('explains unsupported %s schemas', async (library) => {
    const { file } = await fixture(`
      import * as unsupported from '${library}';
      export default { name: 'schema', version: '1', input: unsupported.string(), output: unsupported.string(), async run() { return 'ok'; } };
    `);
    expect(await executor().execute(plan(file))).toMatchObject({
      ok: false,
      message: `Workflow "input" is not a zod 4 schema (zod/v3 and zod/mini are unsupported; import { z } from 'quiet-choir').`,
    });
  });

  it('reports module initialization errors as plain data', async () => {
    const { file } = await fixture('throw "module initialization failed"; export default {};');
    const result = await executor().execute(plan(file));
    expect(result).toEqual({
      kind: 'workflow.error',
      ok: false,
      message: 'module initialization failed',
      diagnostics: [],
    });
  });

  it('supports CommonJS TypeScript default exports', async () => {
    const { file } = await fixture(validSource, 'cts');
    const result = await executor().execute(plan(file));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result).toMatchObject({ ok: true, workflow: { name: 'fixture' } });
  });

  it('loads .ts files and local imports in a CommonJS package', async () => {
    const { file, root } = await fixture(
      `import { factor } from './helper.js';\n${validSource.replace('input.value * 2', 'input.value * factor')}`,
    );
    await writeFile(join(root, 'package.json'), '{"type":"commonjs"}');
    await writeFile(join(root, 'helper.ts'), 'export const factor = 2;');
    const result = await executor().execute(plan(file));
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it('rejects schemas that cannot be represented as JSON before validation succeeds', async () => {
    const { file } = await fixture(
      `${imports} export default defineWorkflow({ name: 'date', version: '1', input: z.date(), output: z.date(), async run(_ctx,input) { return input; } });`,
    );
    const result = await executor().execute(plan(file));
    expect(result).toMatchObject({
      ok: false,
      message: 'Date cannot be represented in JSON Schema',
    });
  });

  it('fingerprints transitive local imports and the selected tsconfig', async () => {
    const { file, root } = await fixture(
      `import { factor } from './helper.js';\n${validSource.replace('input.value * 2', 'input.value * factor')}`,
    );
    const helper = join(root, 'helper.ts');
    await writeFile(helper, 'export const factor = 2;');
    await writeFile(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { module: 'NodeNext', target: 'ES2023', strict: true, skipLibCheck: true },
      }),
    );
    const first = await executor().execute(plan(file));
    await writeFile(helper, 'export const factor = 3;');
    const second = await executor().execute(plan(file));
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(second.ok, JSON.stringify(second)).toBe(true);
    if (first.kind === 'workflow.validate.result' && second.kind === 'workflow.validate.result') {
      expect(first.workflow.fingerprint).not.toBe(second.workflow.fingerprint);
    }
  });

  it('executes, inspects, and resumes a local workflow with validated input', async () => {
    const { file, root } = await fixture(validSource);
    const executionPlan: ExecuteWorkflowPlan = {
      ...plan(file),
      kind: 'workflow.execute',
      runId: 'loader-test',
      stateDir: join(root, 'state'),
      cwd: root,
      resume: false,
      input: { value: 21 },
    };
    const log = vi.fn();
    const runner = new WorkflowExecutor({
      logger: { log },
      signal: new AbortController().signal,
      harness: { invoke: vi.fn() },
    });
    const executed = await runner.execute(executionPlan);
    expect(executed).toMatchObject({
      kind: 'workflow.run.result',
      ok: true,
      run: { status: 'completed', output: 42 },
    });
    const inspected = await runner.execute({
      kind: 'workflow.inspect',
      runId: 'loader-test',
      stateDir: join(root, 'state'),
    });
    expect(inspected).toEqual(executed);
    const resumed = await runner.execute({ ...executionPlan, resume: true });
    expect(resumed).toMatchObject({ ok: true, run: { output: 42 } });
    expect(log).toHaveBeenCalledWith('debug', expect.stringContaining('step.completed double'));
  });

  it('rejects invalid inputs and reports missing run metadata', async () => {
    const { file, root } = await fixture(validSource);
    const executed = await executor().execute({
      ...plan(file),
      kind: 'workflow.execute',
      runId: 'bad-input',
      stateDir: join(root, 'state'),
      cwd: root,
      resume: false,
      input: { value: 'wrong' },
    });
    expect(executed).toMatchObject({ ok: false });
    const inspected = await executor().execute({
      kind: 'workflow.inspect',
      runId: 'missing',
      stateDir: root,
    });
    expect(inspected).toMatchObject({ ok: false });
  });
  it('lists available runs and the absolute directory when inspect cannot find a run', async () => {
    const fixtureInfo = await fixture(validSource);
    const root = join(fixtureInfo.root, 'runs');
    await mkdir(root);
    for (const name of ['beta.json', 'alpha.json', 'notes.txt', 'alpha.json.backup'])
      await writeFile(join(root, name), '{}');
    expect(
      await executor().execute({ kind: 'workflow.inspect', stateDir: root, runId: 'nope' }),
    ).toMatchObject({
      ok: false,
      message: `Run nope not found in ${root} (2 runs present: alpha, beta). --state-dir resolves against the current directory.`,
    });
    const absent = join(root, 'absent');
    expect(
      await executor().execute({ kind: 'workflow.inspect', stateDir: absent, runId: 'nope' }),
    ).toMatchObject({
      ok: false,
      message: `Run nope not found in ${absent} (0 runs present). --state-dir resolves against the current directory.`,
    });
  });
});
