import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'choir-exec-cli-'));
const stateDir = join(root, 'state');
const file = join(root, 'commands.mts');
const header = `import { defineWorkflow,z } from ${JSON.stringify(join(project, 'dist/index.js'))};\n`;
function command(...args) {
  const result = spawnSync(
    process.execPath,
    [join(project, 'bin/run.js'), 'workflow', ...args, '--state-dir', stateDir],
    { cwd: root, encoding: 'utf8', timeout: 30000 },
  );
  assert.equal(result.error, undefined);
  return result;
}
function document(status, ...args) {
  const result = command(...args);
  assert.equal(result.status, status, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
try {
  writeFileSync(
    file,
    `${header}
export default defineWorkflow({name:'commands',version:'1',input:z.object({}),output:z.object({code:z.number().nullable(),n:z.number(),content:z.string()}),async run(ctx){
 const red = await ctx.exec('test',[${JSON.stringify(process.execPath)},'-e',"require('node:fs').appendFileSync('calls','call');process.exitCode=3"],{okExitCodes:'any'});
 const parsed = await ctx.exec.json('json',[${JSON.stringify(process.execPath)},'-e','console.log(JSON.stringify({n:42}))'],{schema:z.object({n:z.number()})});
 await ctx.exec('shell',{shell:'printf shell'});
 await ctx.writeFile('write','out.txt','saved text',{ifMatch:null});
 const snapshot = await ctx.readFile('read','out.txt');
 await ctx.step('tail',{input:null,schema:z.null(),run:({attempt})=>{if(attempt===1)throw new Error('tail');return null;}});
 return {code:red.code,n:parsed.n,content:snapshot.content};
}});`,
  );
  const failed = document(1, 'execute', file, '--run-id', 'commands', '--json', '--full');
  assert.equal(failed.run.steps.test.status, 'completed');
  assert.equal(failed.run.steps.test.output.code, 3);
  writeFileSync(join(root, 'out.txt'), 'external change');
  const resumed = document(0, 'resume', 'commands', '--json');
  assert.deepEqual(resumed.output, { code: 3, n: 42, content: 'saved text' });
  assert.equal(readFileSync(join(root, 'calls'), 'utf8'), 'call');
  assert.equal(readFileSync(join(root, 'out.txt'), 'utf8'), 'external change');
  const inspected = command('inspect', 'commands');
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.match(inspected.stdout, /\[SHELL\]/u);
  const summary = document(0, 'inspect', 'commands', '--summary', '--json');
  assert.equal(summary.usage.attempts, 0);
  const preview = join(root, 'preview.mts');
  writeFileSync(
    preview,
    `${header}export default defineWorkflow({name:'preview',version:'1',input:z.object({}),output:z.object({ok:z.literal(true)}),async run(ctx){return ctx.exec.json('preview',[${JSON.stringify(process.execPath)},'-e',"require('node:fs').writeFileSync('unsafe','bad');console.log(JSON.stringify({ok:true}))"],{schema:z.object({ok:z.literal(true)})});}});`,
  );
  const dry = document(0, 'execute', preview, '--run-id', 'preview', '--dry-run', '--json');
  assert.equal(dry.commands.length, 1);
  assert.deepEqual(dry.run.output, { ok: true });
  assert.equal(existsSync(join(root, 'unsafe')), false);
  assert.equal(existsSync(join(stateDir, 'preview')), false);
  console.log('Durable exec/file CLI smoke checks passed.');
} finally {
  rmSync(root, { recursive: true, force: true });
}
