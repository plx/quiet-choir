import {
  appendFile,
  mkdir,
  readdir,
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
import { TypecheckProgramCache } from '../src/workflow/typecheck/program-cache.js';
import { analyzeTypecheckEntrypoint } from '../src/workflow/typecheck/plan.js';
import { readRun } from '../src/index.js';
import { lockRun } from '../src/workflow/runtime/store.js';
import { workflowExitCodes } from '../src/cli/workflow-errors.js';
import { harnessConfigDigest } from '../src/workflow/loader/harness-selection.js';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
let root: string;
let stateDir: string;
let file: string;
// One program cache for the suite: the first compile checks the whole engine, later ones reuse it.
const typecheckCache = new TypecheckProgramCache();
const executor = () =>
  new WorkflowExecutor({ logger: new ThresholdLogger('silent', () => undefined), typecheckCache });
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
/** Every checkpoint file of a run, by name, so a refusal can prove it wrote nothing. */
async function runFiles(runId: string): Promise<Record<string, string>> {
  const directory = join(stateDir, runId);
  const names = (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name): Promise<[string, string]> => [
        name.slice(directory.length + 1),
        await readFile(name, 'utf8'),
      ]),
    ),
  );
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

// Each case type-checks fixtures that import the whole engine source up to four times. The suite's
// shared program cache makes only the first compile a full engine check; that compile, tsImport and
// the run itself dominate. measured: the heaviest case (symlink spellings) takes 2.8 s alone,
// 7.5-8.8 s in local full coverage runs (28.2-34.0 s for the slowest case before the cache), and
// 15.0 s on the Node 22.13 and 24.4 s on the Node 24 CI legs; before the cache it took 30.0 s on Node
// 22.13 and 60.6 s on Node 24. This is a correctness suite, not a benchmark.
describe('source-aware loader recovery', { timeout: 50_000 }, () => {
  it('normalizes symlink spellings, excludes engine sources, and validates the exact stored fingerprint', async () => {
    const alias = join(root, 'alias');
    await symlink(root, alias);
    const original = await validate();
    const viaAlias = await validate(join(alias, 'workflow.ts'));
    expect(viaAlias.workflow.fingerprint).toBe(original.workflow.fingerprint);
    expect(Object.keys(original.workflow.identity?.files ?? {})).toEqual(['workflow.ts']);
    expect(original.workflow.identity?.engine).toEqual({ version: '0.0.0', formatVersion: 6 });
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
    const bytes = await readFile(join(stateDir, 'source', 'run.json'), 'utf8');
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
        kind: 'workflow.error',
        code: 'run.incompatible',
        details: { compatible: false, files: ['helper.ts'], canAcceptCodeChange: true },
        run: JSON.parse(bytes) as unknown,
      });
      expect(await readFile(join(stateDir, 'source', 'run.json'), 'utf8')).toBe(bytes);
    } finally {
      await release();
    }
  });

  it('hashes transpiled callback logic but ignores comment/formatting edits, and honors explicit versions', async () => {
    await execute('source');
    const before = await readFile(join(stateDir, 'source', 'run.json'), 'utf8');
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
    expect(await readFile(join(stateDir, 'source', 'run.json'), 'utf8')).toBe(before);
  });

  it('repairs an unfinished callback without a live preflight call, and refuses an edited completed callback without changes', async () => {
    const counter = join(root, 'counter');
    const prefix = "import { appendFileSync } from 'node:fs';\n";
    const counted = (body: string) =>
      `() => { appendFileSync(new URL('./counter', import.meta.url), 'run\\n'); ${body} }`;
    await writeFile(file, prefix + source(counted('throw new Error("bug");')));
    expect(await execute('source')).toMatchObject({ ok: false });
    expect(await readFile(counter, 'utf8')).toBe('run\n');
    await writeFile(file, prefix + source(counted('return "fixed";')));
    expect(await execute('source', { resume: true })).toMatchObject({
      ok: false,
      message: expect.stringContaining('workflow.ts') as unknown,
    });
    expect(await execute('source', { resume: true, acceptCodeChange: true })).toMatchObject({
      ok: true,
      run: { output: 'fixed' },
    });
    // The preflight stubs the unfinished callback; only the real resume runs it.
    expect(await readFile(counter, 'utf8')).toBe('run\nrun\n');
    const fixed = await readRun({ stateDir, runId: 'source' });
    expect(fixed.codeChanges?.[0]?.files).toEqual(['workflow.ts']);
    expect(fixed.steps['effect']?.redefinitions).toHaveLength(1);

    await writeFile(file, prefix + source(counted('return "other";')));
    const plain = await execute('source', { resume: true });
    expect(plain).toMatchObject({ ok: false, code: 'run.incompatible' });
    const plainMessage = plain.ok ? '' : plain.message;
    expect(plainMessage.indexOf('--fork-from source')).toBeGreaterThanOrEqual(0);
    expect(plainMessage.indexOf('--fork-from source')).toBeLessThan(
      plainMessage.indexOf('--accept-code-change'),
    );
    expect(plainMessage).toContain('--dry-run --resume --accept-code-change');
    const bytes = await runFiles('source');
    const refused = await execute('source', { resume: true, acceptCodeChange: true });
    expect(refused).toMatchObject({
      ok: false,
      code: 'run.incompatible',
      message: expect.stringContaining('callback changed on a completed step') as unknown,
      details: { divergent: [{ stepId: 'effect', components: ['callback'] }] },
    });
    if (refused.ok) throw new Error('expected a refusal');
    expect(workflowExitCodes[refused.code]).toBe(3);
    expect(refused.message).not.toContain('re-finalize');
    expect(await runFiles('source')).toEqual(bytes);
    const kept = await readRun({ stateDir, runId: 'source' });
    expect(kept).toMatchObject({ status: 'completed', output: 'fixed' });
    expect(kept.workflow.fingerprint).toBe(fixed.workflow.fingerprint);
    expect(kept.codeChanges).toHaveLength(1);
    expect(await readFile(counter, 'utf8')).toBe('run\nrun\n');
  });

  it.for([
    {
      kind: 'step',
      id: 'early',
      recorded: "await ctx.step('early', { input: null, schema: z.string(), run: () => 'e' });",
      noun: 'recorded steps (early)',
    },
    {
      kind: 'map',
      id: 'reviews',
      recorded:
        "await ctx.map('reviews', [0, 1], { concurrency: 2, onError: 'return' }, (item) => Promise.resolve(item * 2));",
      noun: 'settled maps (reviews)',
    },
  ] as const)(
    'refuses an accepted resume whose edit skips a completed $kind, without changes and alike in a dry run',
    async ({ kind, id, recorded, noun }) => {
      await writeFile(file, source(undefined, undefined, `${recorded}\nreturn value;`));
      expect(await execute('source')).toMatchObject({ ok: true, run: { status: 'completed' } });
      const saved = await readRun({ stateDir, runId: 'source' });
      // The edit drops the recorded call, so the body would finish without revisiting it.
      await writeFile(file, source());
      const bytes = await runFiles('source');
      const refused = await execute('source', { resume: true, acceptCodeChange: true });
      if (refused.ok) throw new Error(JSON.stringify(refused));
      expect(refused.code).toBe('run.incompatible');
      expect(workflowExitCodes[refused.code]).toBe(3);
      const details = refused.details as {
        divergent: { stepId: string; skipped: string }[];
        next: string[][];
      };
      expect(details.divergent).toEqual([{ stepId: id, skipped: kind }]);
      expect(details.next).toHaveLength(1);
      const next = details.next[0] ?? [];
      const at = next.indexOf('--fork-from');
      expect(next.slice(at, at + 6)).toEqual([
        '--fork-from',
        'source',
        '--reuse',
        'matching',
        '--invalidate',
        id,
      ]);
      expect(next.slice(0, 4)).toEqual([
        'quiet-choir',
        'workflow',
        'execute',
        await realpath(file),
      ]);
      expect(next.slice(-4)).toEqual(['--run-id', '<NEW_RUN_ID>', '--state-dir', stateDir]);
      expect(refused.message).toContain(`The changed workflow skipped ${noun}.`);
      expect(refused.message).toContain('nothing was changed');
      expect(refused.message).toContain(`--fork-from source --reuse matching --invalidate ${id}`);
      expect(refused.message).not.toContain('re-finalize');
      expect(await runFiles('source')).toEqual(bytes);
      const kept = await readRun({ stateDir, runId: 'source' });
      expect(kept.status).toBe('completed');
      expect(kept.workflow.fingerprint).toBe(saved.workflow.fingerprint);
      expect(kept.output).toBe(saved.output);
      expect(kept.codeChanges).toEqual(saved.codeChanges);

      const preview = await execute('source', {
        resume: true,
        acceptCodeChange: true,
        dryRun: true,
      });
      expect(preview).toMatchObject({ ok: false, code: refused.code, message: refused.message });
      expect(preview.ok ? null : preview.details).toEqual(refused.details);
      expect(await runFiles('source')).toEqual(bytes);
    },
  );

  it('refuses an accepted resume whose completed agent step changed, leaving the suspended run intact', async () => {
    const ops = join(root, 'ops.workflow.ts');
    const opsSource = (
      prompt: string,
    ) => `import { defineWorkflow, z } from ${JSON.stringify(join(repository, 'src/index.js'))};
export default defineWorkflow({ name: 'ops', version: '1', input: z.null(), output: z.string(), async run(ctx) {
const scan = await ctx.claude.text('scan', { prompt: ${JSON.stringify(prompt)} });
const approved = await ctx.ask('approve', { prompt: 'Approve?', schema: z.boolean() });
return approved ? scan.output : 'rejected';
}});`;
    const harness = {
      kind: 'fixture' as const,
      config: {},
      fixtures: { version: 1 as const, calls: [], unmatched: 'synthesize' as const },
    };
    await writeFile(ops, opsSource('scan the repository'));
    const first = await executor().execute({
      kind: 'workflow.execute',
      typecheck: plan(ops),
      runId: 'ops2',
      stateDir,
      cwd: root,
      input: null,
      resume: false,
      harness,
    });
    expect(first).toMatchObject({ ok: true, run: { status: 'suspended' } });
    const saved = await readRun({ stateDir, runId: 'ops2' });
    await writeFile(ops, opsSource('scan the repository carefully'));
    const bytes = await runFiles('ops2');
    const resume = (extra: object = {}) =>
      executor().execute({
        kind: 'workflow.resume',
        runId: 'ops2',
        stateDir,
        harness,
        acceptCodeChange: true,
        ...extra,
      });
    const refused = await resume();
    if (refused.ok) throw new Error(JSON.stringify(refused));
    expect(refused.code).toBe('run.incompatible');
    expect(workflowExitCodes[refused.code]).toBe(3);
    const details = refused.details as {
      divergent: { stepId: string; components: string[] }[];
      next: string[][];
    };
    expect(details.divergent[0]?.stepId).toBe('scan');
    expect(details.divergent[0]?.components).toContain('prompt');
    const next = details.next[0] ?? [];
    const flags = next.slice(next.indexOf('--fork-from'), next.indexOf('--fork-from') + 6);
    expect(flags).toEqual(['--fork-from', 'ops2', '--reuse', 'matching', '--invalidate', 'scan']);
    expect(next.slice(0, 4)).toEqual(['quiet-choir', 'workflow', 'execute', await realpath(ops)]);
    expect(next.slice(-4)).toEqual(['--run-id', '<NEW_RUN_ID>', '--state-dir', stateDir]);
    expect(refused.message).toContain('--fork-from ops2 --reuse matching --invalidate scan');
    expect(refused.message).not.toContain('re-finalize');
    expect(await runFiles('ops2')).toEqual(bytes);
    const kept = await readRun({ stateDir, runId: 'ops2' });
    expect(kept.status).toBe('suspended');
    expect(kept.workflow.fingerprint).toBe(saved.workflow.fingerprint);
    expect(kept.codeChanges?.length ?? 0).toBe(saved.codeChanges?.length ?? 0);
    expect(kept.steps['approve']?.status).toBe('waiting');

    const preview = await resume({ dryRun: true });
    expect(preview).toMatchObject({ ok: false, code: refused.code, message: refused.message });
    expect(preview.ok ? null : preview.details).toEqual(refused.details);
    expect(await runFiles('ops2')).toEqual(bytes);

    const check = await executor().execute({
      kind: 'workflow.check-resume',
      typecheck: plan(ops),
      runId: 'ops2',
      stateDir,
      cwd: root,
      acceptCodeChange: true,
    });
    expect(check).toMatchObject({
      ok: true,
      check: {
        canAcceptCodeChange: true,
        message: expect.stringContaining('--dry-run --resume --accept-code-change') as unknown,
      },
    });

    const forked = await executor().execute({
      kind: 'workflow.execute',
      typecheck: plan(ops),
      runId: 'ops4',
      stateDir,
      cwd: root,
      resume: false,
      harness,
      forkFrom: { runId: 'ops2', reuse: 'matching', invalidate: ['scan'] },
    });
    expect(forked).toMatchObject({ ok: true, run: { status: 'suspended' } });
    expect((await readRun({ stateDir, runId: 'ops4' })).steps['scan']?.reusedFrom).toBeUndefined();
    expect(await runFiles('ops2')).toEqual(bytes);
  });

  it('preflights an accepted resume exactly once, and reports a change it could not reach as a failure', async () => {
    const bodies = join(root, 'bodies');
    const counted = (callback: string, tail: string, gap = '') =>
      `import { appendFileSync } from 'node:fs';
import { defineWorkflow, z } from ${JSON.stringify(join(repository, 'src/index.js'))};
export default defineWorkflow({ name: 'loader-replay', version: '1', input: z.null(), output: z.string(), async run(ctx) {
appendFileSync(new URL('./bodies', import.meta.url), 'body\\n');
${gap}
const value = await ctx.step('effect', { input: null, schema: z.string(), run: ${callback} });
${tail}
}});`;
    const lines = async () => (await readFile(bodies, 'utf8')).split('\n').length - 1;
    await writeFile(file, counted('() => "one"', 'throw new Error("tail");'));
    expect(await execute('source')).toMatchObject({ ok: false });
    expect(await lines()).toBe(1);
    await writeFile(file, counted('() => "one"', 'return value;'));
    expect(await execute('source', { resume: true, acceptCodeChange: true })).toMatchObject({
      ok: true,
      run: { output: 'one' },
    });
    // Once on runWorkflow's disposable copy and once for real; a second preflight would make three.
    expect(await lines()).toBe(3);

    // A pattern the preflight cannot synthesize stops its copy before the changed step, so it finds
    // nothing and the real run changes the record before it fails: that is no refusal.
    await writeFile(
      file,
      counted(
        '() => "two"',
        'return value;',
        "await ctx.step('gap', { input: null, schema: z.string().regex(/^x$/u), run: () => 'x' });",
      ),
    );
    const failed = await execute('source', { resume: true, acceptCodeChange: true });
    expect(failed).toMatchObject({
      ok: false,
      code: 'workflow.failed',
      message: expect.stringContaining('callback changed on a completed step') as unknown,
    });
    expect(await lines()).toBe(5);
    const saved = await readRun({ stateDir, runId: 'source' });
    expect(saved.status).toBe('failed');
    expect(saved.codeChanges).toHaveLength(2);
  });

  it('re-finalizes a tail validation failure and surfaces the recovery hint', async () => {
    const effectPath = join(root, 'effects');
    const prefix = "import { appendFileSync } from 'node:fs';\n";
    const callback = `() => { appendFileSync(new URL('./effects', import.meta.url), 'effect\\n'); return 'done'; }`;
    await writeFile(file, prefix + source(callback, '1', 'return undefined as unknown as string;'));
    const failed = await execute('source');
    expect(failed).toMatchObject({
      ok: false,
      message: expect.stringContaining('All recorded work has terminal outcomes') as unknown,
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

  it('gives no resume advice for a dry-run failure or a refusal, and appends only a saved failure hint', async () => {
    await writeFile(file, source(undefined, '1', 'return undefined as unknown as string;'));
    const dry = await execute('rehearsed', { dryRun: true });
    if (dry.ok) throw new Error(JSON.stringify(dry));
    expect(dry.message).not.toContain('--resume');
    expect(dry.message).not.toContain('accept-code-change');
    expect(dry.next ?? []).toEqual([]);
    expect(dry.run?.recoveryHint).toBeUndefined();

    const failed = await execute('source');
    if (failed.ok) throw new Error(JSON.stringify(failed));
    expect(failed.message).toContain('re-finalize');
    expect((await readRun({ stateDir, runId: 'source' })).recoveryHint).toContain('re-finalize');

    // An effect failure appends a plain resume; a later refusal carries its own advice instead.
    const plain = 'Resume with --resume once the cause is fixed or has passed';
    await writeFile(file, source('() => { throw new Error("down"); }'));
    const down = await execute('effect');
    if (down.ok) throw new Error(JSON.stringify(down));
    expect(down.message).toContain(plain);
    expect(down.message).not.toContain('accept-code-change');
    const effect = await readRun({ stateDir, runId: 'effect' });
    expect(effect.recoveryHint).toContain(plain);
    expect(effect.recoveryCause).toEqual({ kind: 'effect' });
    await writeFile(file, source('() => { throw new Error("down"); }', '2'));
    const refused = await execute('effect', { resume: true });
    if (refused.ok) throw new Error(JSON.stringify(refused));
    expect(refused.code).toBe('run.incompatible');
    expect(refused.message).not.toContain(plain);
  });

  it('advises --grant, not --accept-code-change, for a grant failure', async () => {
    await writeFile(
      file,
      `import { defineWorkflow, z } from ${JSON.stringify(join(repository, 'src/index.js'))};
export default defineWorkflow({ name: 'loader-grant', version: '1', input: z.null(), output: z.string(), async run(ctx) {
await ctx.step('prepare', { input: null, schema: z.string(), run: () => 'ready' });
return (await ctx.claude.text('edit', { prompt: 'x', profile: 'edit' })).output;
}});`,
    );
    const fixtures = { version: 1 as const, calls: [], unmatched: 'synthesize' as const };
    const failed = await execute('grant', {
      harness: { kind: 'fixture' as const, config: {}, fixtures },
    });
    if (failed.ok) throw new Error(JSON.stringify(failed));
    expect(failed.code).toBe('workflow.failed');
    expect(failed.message).toMatch(/^Step edit \(claude\) failed:/u);
    expect(failed.message).toContain('--resume --grant edit');
    expect(failed.message).not.toContain('accept-code-change');
  });

  it('reports source changes on a completed run instead of silently returning stale final output', async () => {
    const prefix = "import { appendFileSync } from 'node:fs';\n";
    const callback = `() => { appendFileSync(new URL('./effects', import.meta.url), 'effect\\n'); return 'one'; }`;
    await writeFile(file, prefix + source(callback));
    await execute('source');
    await writeFile(file, prefix + source(callback, '1', 'return `${value}-new`;'));
    expect(await execute('source', { resume: true })).toMatchObject({ ok: false });
    expect(await execute('source', { resume: true, acceptCodeChange: true })).toMatchObject({
      ok: true,
      run: { output: 'one-new' },
    });
    // A tail-only fix re-finalizes with zero repeated effects.
    expect(await readFile(join(root, 'effects'), 'utf8')).toBe('effect\n');
    expect((await readRun({ stateDir, runId: 'source' })).codeChanges).toHaveLength(1);
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

  it('refuses a resume or answer --resume under a changed harness configuration unless allowed', async () => {
    const ops = join(root, 'ops.ts');
    await writeFile(
      ops,
      `import { defineWorkflow, z } from ${JSON.stringify(join(repository, 'src/index.js'))};
export default defineWorkflow({ name: 'ops', version: '1', input: z.null(), output: z.string(), async run(ctx) {
const scan = await ctx.claude.text('scan', { prompt: 'scan' });
const approved = await ctx.ask('approve', { prompt: 'Approve?', schema: z.boolean() });
return approved ? scan.output : 'rejected';
}});`,
    );
    const fixtures = { version: 1 as const, calls: [], unmatched: 'synthesize' as const };
    const started = { kind: 'fixture' as const, config: { maxOutputBytes: 4096 }, fixtures };
    const changed = { kind: 'fixture' as const, config: {}, fixtures };
    const start = async (runId: string) => {
      expect(
        await executor().execute({
          kind: 'workflow.execute',
          typecheck: plan(ops),
          runId,
          stateDir,
          cwd: root,
          input: null,
          resume: false,
          harness: started,
        }),
      ).toMatchObject({ ok: true, run: { status: 'suspended' } });
      expect((await readRun({ stateDir, runId })).harness?.configDigest).toBe(
        harnessConfigDigest(started),
      );
    };
    const answer = (runId: string, extra: object = {}) =>
      executor().execute({
        kind: 'workflow.answer',
        runId,
        stateDir,
        stepId: 'approve',
        value: true,
        resume: true,
        harness: changed,
        ...extra,
      });

    await start('config');
    const bytes = await runFiles('config');
    const refused = await executor().execute({
      kind: 'workflow.resume',
      runId: 'config',
      stateDir,
      harness: changed,
    });
    if (refused.ok) throw new Error(JSON.stringify(refused));
    expect(refused.code).toBe('run.incompatible');
    expect(workflowExitCodes[refused.code]).toBe(3);
    expect(refused.details).toEqual({
      previousConfigDigest: harnessConfigDigest(started),
      requestedConfigDigest: harnessConfigDigest(changed),
    });
    expect(await runFiles('config')).toEqual(bytes);
    // The same configuration, in any key order, resumes normally (and parks on the question).
    expect(
      await executor().execute({
        kind: 'workflow.resume',
        runId: 'config',
        stateDir,
        harness: { ...started, config: { maxOutputBytes: 4096 } },
      }),
    ).toMatchObject({ ok: true, run: { status: 'suspended' } });
    // answer --resume delivers the answer, then the resume is refused like any other.
    expect(await answer('config')).toMatchObject({ ok: false, code: 'run.incompatible' });
    expect((await readRun({ stateDir, runId: 'config' })).status).toBe('suspended');
    expect(
      await executor().execute({
        kind: 'workflow.resume',
        runId: 'config',
        stateDir,
        harness: changed,
        allowHarnessConfigChange: true,
      }),
    ).toMatchObject({ ok: true, run: { status: 'completed' } });
    expect((await readRun({ stateDir, runId: 'config' })).harness?.configDigest).toBe(
      harnessConfigDigest(changed),
    );

    await start('answered');
    expect(await answer('answered', { allowHarnessConfigChange: true })).toMatchObject({
      ok: true,
      run: { status: 'completed' },
    });
    expect((await readRun({ stateDir, runId: 'answered' })).harness?.configDigest).toBe(
      harnessConfigDigest(changed),
    );
  });
});
