import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = mkdtempSync(join(tmpdir(), 'choir-isolation-cli-'));
const state = join(directory, 'state');
const file = join(directory, 'workflow.ts');
const binary = join(directory, 'agent.mjs');
const cli = (...args) => {
  const result = spawnSync(process.execPath, [join(root, 'bin/run.js'), 'workflow', ...args], {
    cwd: directory,
    env: { ...process.env, CLAUDECODE: 'outer', QC_CUSTOM_HOST: 'custom', QC_UNSET: 'remove' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(!`${result.stdout}${result.stderr}`.includes('explicit-private-value'));
  return result.stdout;
};
try {
  mkdirSync(join(directory, 'node_modules'));
  symlinkSync(root, join(directory, 'node_modules/quiet-choir'));
  symlinkSync(join(root, 'node_modules/@types'), join(directory, 'node_modules/@types'));
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
  writeFileSync(
    binary,
    `#!${process.execPath}
import fs from 'node:fs';
if(process.argv.includes('--version')){console.log('fixture 1.0.0');process.exit(0);}
let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{
fs.writeFileSync('capture.json',JSON.stringify({args:process.argv.slice(2),host:process.env.CLAUDECODE??null,custom:process.env.QC_CUSTOM_HOST??null,removed:process.env.QC_UNSET??null,explicit:process.env.QC_EXPLICIT}));
console.log(JSON.stringify({type:'result',subtype:'success',result:'ok'}));
});`,
    { mode: 0o700 },
  );
  writeFileSync(
    file,
    `import {defineWorkflow,z} from 'quiet-choir';
export default defineWorkflow({name:'isolation-cli',version:'1',input:z.object({}),output:z.string(),
defaults:{claude:{env:{set:{QC_EXPLICIT:'explicit-private-value'},unset:['QC_UNSET']}}},
async run(ctx){return await ctx.claude.value('call',{prompt:'hello'});}});`,
  );
  const validation = JSON.parse(cli('validate', file, '--json'));
  const manifest = validation.workflow.capabilities;
  assert.equal(manifest.defaults, undefined, 'validate --json names the default profile once');
  const defaultRole = manifest.profiles[manifest.defaultProfile];
  assert.equal(defaultRole.claude.isolation, 'restricted');
  assert.equal(defaultRole.claude.env, undefined);
  assert.equal(defaultRole.environment, undefined, 'the default profile uses the shared summary');
  assert.deepEqual(manifest.environment.claude.set, ['QC_EXPLICIT']);
  const complete = JSON.parse(cli('validate', file, '--json', '--harness-schemas'));
  assert.deepEqual(
    complete.workflow.capabilities.defaults.environment.claude.set,
    ['QC_EXPLICIT'],
    '--harness-schemas keeps the complete manifest',
  );
  for (const [runId, scrubEnv, expectedHost, expectedCustom] of [
    ['scrub', ['QC_CUSTOM_HOST'], null, null],
    ['retain', false, 'outer', 'custom'],
  ]) {
    cli(
      'execute',
      file,
      '--run-id',
      runId,
      '--state-dir',
      state,
      '--grant',
      'all',
      '--harness-config',
      JSON.stringify({ claudeBinary: binary, scrubEnv }),
      '--json',
    );
    const capture = JSON.parse(readFileSync(join(directory, 'capture.json'), 'utf8'));
    assert.ok(capture.args.includes('--restricted'));
    assert.ok(capture.args.includes('--strict-mcp-config'));
    assert.equal(capture.host, expectedHost);
    assert.equal(capture.custom, expectedCustom);
    assert.equal(capture.removed, null);
    assert.equal(capture.explicit, 'explicit-private-value');
    const saved = readFileSync(join(state, runId, 'run.json'), 'utf8');
    assert.ok(!saved.includes('explicit-private-value'));
    const record = JSON.parse(saved);
    assert.equal(record.steps.call.request.isolation, 'restricted');
    assert.deepEqual(record.steps.call.request.environment.unset, ['QC_UNSET']);
    const inspected = cli('inspect', runId, '--state-dir', state, '--verbose');
    assert.match(inspected, /Host variables:/);
    const inspection = JSON.parse(cli('inspect', runId, '--state-dir', state, '--json'));
    assert.equal(inspection.steps.call.request.isolation, 'restricted');
  }
  console.log(
    'PASS CLI restricted defaults, private environment manifests, scrub configuration, and inspection',
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
