import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'choir-values-cli-'));
// Default run state goes under the temp root, never the developer's real XDG state.
const env = { ...process.env, XDG_STATE_HOME: join(root, 'xdg') };
delete env.QUIET_CHOIR_STATE_DIR;
const cli = (...args) =>
  spawnSync(process.execPath, [join(project, 'bin/run.js'), 'workflow', ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
const header = `import { defineWorkflow,z } from ${JSON.stringify(join(project, 'dist/index.js'))};\n`;
try {
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  const marker = join(root, 'imported');
  const negative = {
    widen: `defineWorkflow({name:'widen',version:'1',input:z.object({n:z.number().optional()}),output:z.object({n:z.number()}),async run(ctx,input){await ctx.sleep('wait',0);return {n:input.n};}})`,
    step: `defineWorkflow({name:'step',version:'1',input:z.object({}),output:z.number(),async run(ctx){return ctx.step('bad',{input:null,schema:z.number(),run:()=>Math.random()>0.5?1:undefined});}})`,
    unchecked: `defineWorkflow({name:'index',version:'1',input:z.object({files:z.array(z.string())}),output:z.string(),async run(ctx,input){await ctx.sleep('wait',0);return input.files[0].split('.')[0];}})`,
  };
  for (const [name, source] of Object.entries(negative)) {
    const path = join(root, `${name}.ts`);
    writeFileSync(
      path,
      `${header}import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)},'imported');\nexport default ${source};`,
    );
    const checked = cli('typecheck', path, '--json');
    assert.equal(checked.status, 4, checked.stderr);
    const failure = JSON.parse(checked.stdout).error;
    assert.equal(failure.code, 'load.typecheck');
    assert.equal(failure.details.compilerOptions.noUncheckedIndexedAccess, true);
    assert.equal(failure.details.compilerOptions.exactOptionalPropertyTypes, undefined);
    assert.ok(
      JSON.parse(checked.stdout).diagnostics.some(
        (item) => item.code === (name === 'step' ? 2769 : name === 'unchecked' ? 2532 : 2322),
      ),
      checked.stdout,
    );
    assert.match(checked.stderr, /Compiler flags:.*--noUncheckedIndexedAccess true/u);
    const executed = cli('execute', path, '--input', '{}', '--json');
    assert.equal(executed.status, 4, executed.stderr);
    assert.equal(JSON.parse(executed.stdout).error.code, 'load.typecheck');
    assert.equal(existsSync(marker), false, 'Type failures must prevent import and execution');
  }
  const optional = join(root, 'optional.ts');
  writeFileSync(
    optional,
    `${header}
export default defineWorkflow({name:'optional',version:'1',input:z.object({note:z.string().optional()}),output:z.object({done:z.boolean(),note:z.string().optional(),verdict:z.enum(['pass','fail'])}),async run(ctx,input){
  if(Object.hasOwn(input,'note')) throw new Error('Input member was not omitted');
  const local = await ctx.step('local',{input:{note:input.note},schema:z.object({done:z.boolean(),note:z.string().optional()}),run:()=>({done:true,note:input.note})});
  if(Object.hasOwn(local,'note')) throw new Error('Step member was not omitted');
  const agent = await ctx.claude.value('agent',{prompt:'p',model:input.note,schema:z.object({verdict:z.enum(['pass','fail']),note:z.string().optional()})});
  const text = await ctx.codex.value('text',{prompt:'p'});
  if(text!=='ok') throw new Error('Expected text');
  return {done:local.done,note:input.note,verdict:agent.verdict};
}});`,
  );
  const checked = cli('typecheck', optional, '--json');
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).compilerOptions.noUncheckedIndexedAccess, true);
  const human = cli('typecheck', optional);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /Compiler flags:.*--strict true/u);
  const fixtures = join(root, 'fixtures.json');
  writeFileSync(
    fixtures,
    JSON.stringify({
      version: 1,
      calls: [
        { step: 'agent', output: { verdict: 'pass' }, usage: { costUsd: 0.01 } },
        { step: 'text', text: 'ok' },
      ],
    }),
  );
  const args = [
    'execute',
    optional,
    '--run-id',
    'optional',
    '--harness',
    `fixture:${fixtures}`,
    '--json',
  ];
  const executed = cli(...args, '--input', '{}');
  assert.equal(executed.status, 0, executed.stderr);
  const result = JSON.parse(executed.stdout);
  assert.deepEqual(result.output, { done: true, verdict: 'pass' });
  assert.deepEqual(result.steps.agent.output.output, { verdict: 'pass' });
  assert.equal(result.steps.agent.output.usage.costUsd, 0.01);
  const resumed = cli(...args, '--resume');
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.deepEqual(JSON.parse(resumed.stdout).steps, result.steps);
} finally {
  rmSync(root, { recursive: true, force: true });
}
