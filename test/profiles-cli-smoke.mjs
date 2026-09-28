import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = mkdtempSync(join(tmpdir(), 'quiet-choir-profiles-cli-'));
const state = join(fixture, 'state');
const bin = join(fixture, 'bin');
const file = join(fixture, 'profiles.ts');
const cli = (...args) =>
  spawnSync(process.execPath, [join(root, 'bin/run.js'), 'workflow', ...args], {
    cwd: fixture,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    encoding: 'utf8',
    timeout: 30_000,
  });
const checkpoint = () => JSON.parse(readFileSync(join(state, 'profiles', 'run.json'), 'utf8'));
try {
  mkdirSync(bin);
  mkdirSync(join(fixture, 'node_modules'));
  symlinkSync(root, join(fixture, 'node_modules/quiet-choir'));
  symlinkSync(join(root, 'node_modules/@types'), join(fixture, 'node_modules/@types'));
  writeFileSync(join(fixture, 'package.json'), '{"type":"module"}');
  writeFileSync(
    join(bin, 'claude'),
    `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("2.1.283"); process.exit(0); }
import fs from 'node:fs';
let prompt='';process.stdin.on('data',chunk=>prompt+=chunk);process.stdin.on('end',()=>{
 const args=process.argv.slice(2);const turns=Number(args[args.indexOf('--max-turns')+1]);
 fs.appendFileSync('calls.jsonl',JSON.stringify({prompt,args})+'\\n');
 const fail=prompt==='pending'&&turns<60;
 console.log(JSON.stringify({type:'result',subtype:fail?'error_max_turns':'success',is_error:fail,result:fail?'turn cap':'ok',num_turns:turns,total_cost_usd:0.31,permission_denials:fail?[{tool_name:'Read'}]:[]}));process.exitCode=fail?1:0;
});`,
    { mode: 0o700 },
  );
  const source = `import {defineWorkflow,z} from 'quiet-choir';
import {writeFileSync} from 'node:fs';
export default defineWorkflow({name:'profiles-cli',version:'1',input:z.object({}),output:z.string(),
defaults:{claude:{model:'fixture'}},profiles:{scout:{extends:'readonly',maxTurns:30,description:'Reads code'},fixer:{extends:'edit'}},
async run(ctx){writeFileSync('body-started','yes');await ctx.claude.text('saved',{prompt:'saved',profile:'scout'});return (await ctx.claude.text('pending',{prompt:'pending',profile:'scout'})).output;}});`;
  writeFileSync(file, source);
  const validation = cli('validate', file, '--json');
  assert.equal(validation.status, 0, validation.stderr);
  const manifest = JSON.parse(validation.stdout).workflow.capabilities;
  assert.equal(manifest.profiles.scout.description, 'Reads code');
  assert.equal(manifest.profiles.scout.claude.model, 'fixture');
  assert.deepEqual(manifest.requiredGrants, ['fixer']);
  assert.equal(existsSync(join(fixture, 'body-started')), false);
  const args = ['execute', file, '--run-id', 'profiles', '--state-dir', state];
  const denied = cli(...args);
  assert.equal(denied.status, 2, denied.stderr);
  assert.match(denied.stderr, /--grant fixer/);
  assert.equal(existsSync(join(fixture, 'body-started')), false);
  assert.equal(existsSync(join(state, 'profiles', 'run.json')), false);
  const first = cli(...args, '--grant', 'fixer');
  assert.equal(first.status, 1, first.stderr);
  assert.match(first.stderr, /--resume[\s›]*--profile scout.maxTurns=60/);
  assert.match(first.stderr, /turns=30;[\s›]*costUsd=0.31/);
  assert.deepEqual(checkpoint().steps.pending.warnings, [
    'Profile scout: 1 permission denials reported.',
  ]);
  const resumed = cli(
    ...args,
    '--resume',
    '--profile',
    'scout.maxTurns=60',
    '--profile',
    '*.timeoutMs=1800000',
  );
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(checkpoint().status, 'completed');
  assert.deepEqual(checkpoint().grants, ['fixer']);
  assert.equal(checkpoint().steps.pending.attemptHistory[1].policy.maxTurns, 60);
  const calls = readFileSync(join(fixture, 'calls.jsonl'), 'utf8');
  assert.equal(calls.trim().split('\n').length, 3);
  const bare = cli(...args, '--resume');
  assert.equal(bare.status, 0, bare.stderr);
  assert.equal(readFileSync(join(fixture, 'calls.jsonl'), 'utf8'), calls);
  const inspected = cli('inspect', 'profiles', '--state-dir', state, '--json');
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.equal(JSON.parse(inspected.stdout).profileOverrides.length, 2);
  const invalid = cli(...args, '--resume', '--profile', 'scout.model=other');
  assert.equal(invalid.status, 2, invalid.stderr);
  assert.match(invalid.stderr, /Invalid --profile/);
  writeFileSync(file, source.replace("profile:'scout'", "profile:'scuot'"));
  const typo = cli('validate', file, '--json');
  assert.equal(typo.status, 4, typo.stderr);
  assert.match(typo.stderr, /scuot/);
  assert.equal(readFileSync(join(fixture, 'calls.jsonl'), 'utf8'), calls);
  console.log(
    'PASS CLI capability manifest, grant preflight, limit diagnostics, sticky profile recovery and typed names',
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
