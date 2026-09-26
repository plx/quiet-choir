import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ThresholdLogger } from '../src/application/execution.js';
import { WorkflowExecutor } from '../src/workflow/loader/executor.js';
import { analyzeTypecheckEntrypoint } from '../src/workflow/typecheck/plan.js';
import { readRun } from '../src/index.js';
import { lockRun } from '../src/workflow/runtime/store.js';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
let root: string;
let stateDir: string;
let file: string;
const executor = () =>
  new WorkflowExecutor({ logger: new ThresholdLogger('silent', () => undefined) });
function plan(entrypoint = file) {
  const analysis = analyzeTypecheckEntrypoint(entrypoint, root);
  if (!analysis.ok) throw new Error('invalid fixture');
  return analysis.plan;
}
function source(
  callback = '() => { /* original */ return "one"; }',
  version = '1',
  tail = 'return value;',
) {
  return `import { defineWorkflow, z } from ${JSON.stringify(join(repository, 'src/index.js'))};
export default defineWorkflow({ name: 'loader-replay', version: '1', input: z.null(), output: z.string(), async run(ctx) {
const value = await ctx.step('effect', { input: null, schema: z.string(), version: ${JSON.stringify(version)}, run: ${callback} });
${tail}
}});`;
}
async function execute(runId: string, extra: object = {}) {
  return executor().execute({
    kind: 'workflow.execute',
    typecheck: plan(),
    runId,
    stateDir,
    cwd: root,
    input: null,
    resume: false,
    ...extra,
  });
}
async function validate(entrypoint = file) {
  const result = await executor().execute({
    kind: 'workflow.validate',
    typecheck: plan(entrypoint),
  });
  if (result.kind !== 'workflow.validate.result') throw new Error(JSON.stringify(result));
  return result;
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'choir-loader-replay-'));
  stateDir = join(root, 'state');
  file = join(root, 'workflow.ts');
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await symlink(join(repository, 'node_modules'), join(root, 'node_modules'));
  await writeFile(file, source());
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('source-aware loader recovery', { timeout: 30_000 }, () => {
  it('normalizes symlink spellings, excludes engine sources, and validates the exact stored fingerprint', async () => {
    const alias = join(root, 'alias');
    await symlink(root, alias);
    const original = await validate();
    const viaAlias = await validate(join(alias, 'workflow.ts'));
    expect(viaAlias.workflow.fingerprint).toBe(original.workflow.fingerprint);
    expect(Object.keys(original.workflow.identity?.files ?? {})).toEqual(['workflow.ts']);
    expect(original.workflow.identity?.engine).toEqual({ version: '0.0.0', formatVersion: 3 });
    const result = await execute('source');
    expect(result).toMatchObject({
      ok: true,
      run: { workflow: { fingerprint: original.workflow.fingerprint }, cwd: await realpath(root) },
    });
    const resumed = await executor().execute({
      kind: 'workflow.execute',
      typecheck: plan(join(alias, 'workflow.ts')),
      runId: 'source',
      stateDir,
      cwd: alias,
      resume: true,
    });
    expect(resumed).toMatchObject({ ok: true });
  });

  it('normalizes relative file names under a selected tsconfig and reports file/schema drift', async () => {
    await writeFile(join(root, 'helper.ts'), 'export const value = "one";');
    await writeFile(
      file,
      `import { value as helper } from './helper.js';\n${source('() => helper')}`,
    );
    await writeFile(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'NodeNext',
          target: 'ES2023',
          strict: true,
          skipLibCheck: true,
          types: ['node'],
        },
      }),
    );
    const initial = await validate();
    expect(Object.keys(initial.workflow.identity?.files ?? {}).sort()).toEqual([
      'helper.ts',
      'tsconfig.json',
      'workflow.ts',
    ]);
    await execute('source');
    const bytes = await readFile(join(stateDir, 'source.json'), 'utf8');
    const release = await lockRun(stateDir, 'source');
    try {
      await appendFile(join(root, 'helper.ts'), '\n// changed helper\n');
      const report = await executor().execute({
        kind: 'workflow.check-resume',
        typecheck: plan(),
        runId: 'source',
        stateDir,
        cwd: root,
      });
      expect(report).toMatchObject({
        kind: 'workflow.check-resume.result',
        check: { compatible: false, files: ['helper.ts'], canAcceptCodeChange: true },
      });
      expect(await readFile(join(stateDir, 'source.json'), 'utf8')).toBe(bytes);
    } finally {
      await release();
    }
  });

  it('hashes transpiled callback logic but ignores comment/formatting edits, and honors explicit versions', async () => {
    await execute('source');
    const before = await readFile(join(stateDir, 'source.json'), 'utf8');
    await writeFile(file, source('()=>{return "one";}'));
    const commentFork = await execute('comments', { forkFrom: { runId: 'source' } });
    expect(commentFork).toMatchObject({
      ok: true,
      run: { steps: { effect: { reusedFrom: { runId: 'source' } } } },
    });
    await writeFile(file, source('() => { return "two"; }'));
    const logicFork = await execute('logic', { forkFrom: { runId: 'source' } });
    expect(logicFork).toMatchObject({ ok: true, run: { output: 'two' } });
    expect(
      (await readRun({ stateDir, runId: 'logic' })).steps['effect']?.reusedFrom,
    ).toBeUndefined();
    await writeFile(file, source('()=>{return "one";}', '2'));
    await execute('version', { forkFrom: { runId: 'source' } });
    expect(
      (await readRun({ stateDir, runId: 'version' })).steps['effect']?.reusedFrom,
    ).toBeUndefined();
    expect(await readFile(join(stateDir, 'source.json'), 'utf8')).toBe(before);
  });

  it('repairs an unfinished callback, and does not let accepted code changes bypass completed-step checks', async () => {
    await writeFile(file, source('() => { throw new Error("bug"); }'));
    expect(await execute('source')).toMatchObject({ ok: false });
    await writeFile(file, source('() => { return "fixed"; }'));
    expect(await execute('source', { resume: true })).toMatchObject({
      ok: false,
      message: expect.stringContaining('workflow.ts') as unknown,
    });
    expect(await execute('source', { resume: true, acceptCodeChange: true })).toMatchObject({
      ok: true,
      run: { output: 'fixed' },
    });
    const fixed = await readRun({ stateDir, runId: 'source' });
    expect(fixed.codeChanges?.[0]?.files).toEqual(['workflow.ts']);
    expect(fixed.steps['effect']?.redefinitions).toHaveLength(1);
    await writeFile(file, source('() => { return "other"; }'));
    expect(await execute('source', { resume: true, acceptCodeChange: true })).toMatchObject({
      ok: false,
      message: expect.stringContaining('callback changed on a completed step') as unknown,
    });
  });

  it('re-finalizes a tail validation failure and surfaces the recovery hint', async () => {
    const effectPath = join(root, 'effects');
    const prefix = "import { appendFileSync } from 'node:fs';\n";
    const callback = `() => { appendFileSync(${JSON.stringify(effectPath)}, 'effect\\n'); return 'done'; }`;
    await writeFile(file, prefix + source(callback, '1', 'return undefined as unknown as string;'));
    const failed = await execute('source');
    expect(failed).toMatchObject({
      ok: false,
      message: expect.stringContaining('All recorded effects completed') as unknown,
    });
    await writeFile(file, prefix + source(callback));
    const preview = await executor().execute({
      kind: 'workflow.check-resume',
      typecheck: plan(),
      runId: 'source',
      stateDir,
      cwd: root,
      acceptCodeChange: true,
    });
    expect(preview).toMatchObject({ check: { compatible: true, refinalizable: true } });
    expect(await execute('source', { resume: true, acceptCodeChange: true })).toMatchObject({
      ok: true,
      run: { output: 'done' },
    });
    expect(await readFile(effectPath, 'utf8')).toBe('effect\n');
  });

  it('reports source changes on a completed run instead of silently returning stale final output', async () => {
    await execute('source');
    await writeFile(file, source(undefined, '1', 'return `${value}-new`;'));
    expect(await execute('source', { resume: true })).toMatchObject({ ok: false });
    expect(await execute('source', { resume: true, acceptCodeChange: true })).toMatchObject({
      ok: true,
      run: { output: 'one-new' },
    });
  });

  it('hashes external workflow sources independently of where the checkout was copied', async () => {
    const other = join(root, 'copy');
    await mkdir(other);
    await writeFile(join(other, 'package.json'), '{"type":"module"}');
    await writeFile(join(other, 'workflow.ts'), source());
    expect((await validate(join(other, 'workflow.ts'))).workflow.fingerprint).toBe(
      (await validate()).workflow.fingerprint,
    );
  });
});
