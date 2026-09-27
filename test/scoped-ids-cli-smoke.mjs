import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stepId } from '../dist/index.js';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = mkdtempSync(join(tmpdir(), 'quiet-choir-scoped-cli-'));
const state = join(fixture, 'state');
const binaryDirectory = join(fixture, 'bin');
const file = join(fixture, 'scopes.ts');
const entry = join(root, 'bin/run.js');
const env = { ...process.env, PATH: `${binaryDirectory}:${process.env.PATH}` };
const cli = (...args) =>
  spawnSync(process.execPath, [entry, 'workflow', ...args], {
    cwd: fixture,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
const checkpoint = (id) => JSON.parse(readFileSync(join(state, `${id}.json`), 'utf8'));
try {
  mkdirSync(binaryDirectory);
  mkdirSync(join(fixture, 'node_modules'));
  symlinkSync(root, join(fixture, 'node_modules/quiet-choir'));
  symlinkSync(join(root, 'node_modules/@types'), join(fixture, 'node_modules/@types'));
  writeFileSync(join(fixture, 'package.json'), '{"type":"module"}');
  writeFileSync(
    join(binaryDirectory, 'claude'),
    `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("2.1.283"); process.exit(0); }
import fs from 'node:fs';
let prompt=''; process.stdin.on('data',chunk=>prompt+=chunk);
process.stdin.on('end',()=>{fs.appendFileSync('calls.txt',prompt+'\\n');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:prompt}));});
`,
    { mode: 0o700 },
  );
  writeFileSync(
    file,
    `import {defineWorkflow,z} from 'quiet-choir';
export default defineWorkflow({name:'scoped-cli',version:'1',input:z.object({invalid:z.boolean().default(false)}),output:z.array(z.array(z.string())),async run(ctx,input) {
 const panel=ctx.within('round');
 const reviews=await panel.map('files',['src/My Component.tsx','café.md'],{concurrency:2,key:(file)=>input.invalid?'duplicate':panel.id(file)},(file)=>panel.map('votes',[0,1],{concurrency:2},async(index)=>(await panel.claude.text('verdict',{prompt:file+':'+index})).output));
 return ctx.step('tail',{input:reviews,schema:z.array(z.array(z.string())),run:({attempt})=>{if(attempt===1)throw new Error('tail failed');return reviews;}});
}});`,
  );
  const first = cli('execute', file, '--run-id', 'scoped', '--state-dir', state, '--input', '{}');
  assert.equal(first.status, 1, first.stderr);
  assert.match(first.stderr, /tail failed/);
  const before = checkpoint('scoped');
  const ids = ['src/My Component.tsx', 'café.md'].flatMap((file) =>
    [0, 1].map((index) => `round/files/${stepId(file)}/votes/${index}/verdict`),
  );
  assert.deepEqual(
    Object.keys(before.steps)
      .filter((id) => id !== 'tail')
      .sort(),
    ids.sort(),
  );
  assert.equal(before.formatVersion, 6);
  const calls = readFileSync(join(fixture, 'calls.txt'), 'utf8');
  assert.equal(calls.trim().split('\n').length, 4);
  const resumed = cli('execute', file, '--run-id', 'scoped', '--state-dir', state, '--resume');
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(checkpoint('scoped').status, 'completed');
  assert.equal(readFileSync(join(fixture, 'calls.txt'), 'utf8'), calls);
  const inspected = cli('inspect', 'scoped', '--state-dir', state, '--json');
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.deepEqual(
    Object.keys(JSON.parse(inspected.stdout).steps)
      .filter((id) => id !== 'tail')
      .sort(),
    ids,
  );
  const invalid = cli(
    'execute',
    file,
    '--run-id',
    'invalid',
    '--state-dir',
    state,
    '--input',
    '{"invalid":true}',
  );
  assert.equal(invalid.status, 1, invalid.stderr);
  assert.match(invalid.stderr, /Duplicate map key "duplicate".*round\/files/);
  assert.deepEqual(checkpoint('invalid').steps, {});
  assert.equal(readFileSync(join(fixture, 'calls.txt'), 'utf8'), calls);
  console.log(
    'PASS CLI scoped IDs, hashed item keys, nested lexical maps, zero-call resume and key preflight',
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
