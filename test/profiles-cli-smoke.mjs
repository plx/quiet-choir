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
 const at=args.indexOf('--settings');
 const settings=at<0?null:fs.readFileSync(args[at+1],'utf8');
 fs.appendFileSync('calls.jsonl',JSON.stringify({prompt,args,settings})+'\\n');
 const fail=prompt==='pending'&&turns<60;
 console.log(JSON.stringify({type:'result',subtype:fail?'error_max_turns':'success',is_error:fail,result:fail?'turn cap':'ok',num_turns:turns,total_cost_usd:0.31,permission_denials:fail?[{tool_name:'Read'}]:[]}));process.exitCode=fail?1:0;
});`,
    { mode: 0o700 },
  );
  const source = `import {defineWorkflow,z} from 'quiet-choir';
import {writeFileSync} from 'node:fs';
export default defineWorkflow({name:'profiles-cli',version:'1',input:z.object({}),output:z.string(),
defaults:{claude:{model:'fixture'}},profiles:{scout:{extends:'readonly',maxTurns:30,description:'Reads code',claude:{addDirRoots:['runs']}},fixer:{extends:'edit'}},
async run(ctx){
// quiet-choir-ignore QC002 marker file proving whether the body ran
writeFileSync('body-started','yes');await ctx.claude.text('saved',{prompt:'saved',profile:'scout'});return (await ctx.claude.text('pending',{prompt:'pending',profile:'scout'})).output;}});`;
  writeFileSync(file, source);
  const validation = cli('validate', file, '--json');
  assert.equal(validation.status, 0, validation.stderr);
  const manifest = JSON.parse(validation.stdout).workflow.capabilities;
  assert.equal(manifest.profiles.scout.description, 'Reads code');
  assert.equal(manifest.profiles.scout.claude.model, 'fixture');
  assert.deepEqual(manifest.profiles.scout.claude.addDirRoots, ['runs']);
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

  // Free-form controls reach the harness but never a printed manifest or checkpoint (#103).
  const markers = [
    'marker-env-value',
    'marker-settings-theme',
    'marker-mcp-command',
    'marker-mcp-token',
    'marker-agent-prompt',
    'marker-append-prompt',
    'marker-codex-config',
  ];
  const clean = (label, text) => {
    for (const marker of markers) assert.ok(!text.includes(marker), `${label} leaked ${marker}`);
  };
  const secretFile = join(fixture, 'secret.ts');
  const secretSource = (tail) => `import {defineWorkflow,z} from 'quiet-choir';
export default defineWorkflow({name:'secret-cli',version:'1',input:z.object({}),output:z.string(),
profiles:{vault:{claude:{isolation:'inherit',env:{set:{PRIVATE:'marker-env-value'}},settings:{theme:'marker-settings-theme'},
mcpServers:{tracker:{command:'marker-mcp-command',env:{TOKEN:'marker-mcp-token'}}},agents:{reviewer:{description:'Reviews',prompt:'marker-agent-prompt'}},
appendSystemPrompt:'marker-append-prompt'},codex:{isolation:'inherit',config:{'model_providers.x.base_url':'marker-codex-config'}}}},
async run(ctx){return (await ctx.claude.text('only',{prompt:'secret',profile:'vault'})).output${tail};}});`;
  writeFileSync(secretFile, secretSource(''));
  const secretValidation = cli('validate', secretFile, '--json');
  assert.equal(secretValidation.status, 0, secretValidation.stderr);
  clean('validate --json', secretValidation.stdout);
  const secretProfile = JSON.parse(secretValidation.stdout).workflow.capabilities.profiles.vault;
  assert.deepEqual(secretProfile.environment.claude.set, ['PRIVATE']);
  assert.match(secretProfile.environment.claude.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(secretProfile.redacted.claude.settings.keys, ['theme']);
  assert.deepEqual(secretProfile.redacted.claude.mcpServers.keys, ['tracker']);
  assert.deepEqual(secretProfile.redacted.claude.agents.keys, ['reviewer']);
  assert.match(secretProfile.redacted.claude.appendSystemPrompt.sha256, /^[a-f0-9]{64}$/);
  assert.equal(secretProfile.redacted.claude.appendSystemPrompt.keys, undefined);
  assert.deepEqual(secretProfile.redacted.codex.config.keys, ['model_providers.x.base_url']);
  for (const field of ['settings', 'mcpServers', 'agents', 'appendSystemPrompt', 'env'])
    assert.ok(!(field in secretProfile.claude), field);
  const secretArgs = ['--run-id', 'redaction', '--state-dir', state];
  const callsBefore = readFileSync(join(fixture, 'calls.jsonl'), 'utf8').trim().split('\n').length;
  const secretRun = cli('execute', secretFile, ...secretArgs, '--grant', 'vault');
  assert.equal(secretRun.status, 0, secretRun.stderr);
  clean('execute output', secretRun.stdout + secretRun.stderr);
  clean('checkpoint', readFileSync(join(state, 'redaction', 'run.json'), 'utf8'));
  const secretCall = JSON.parse(
    readFileSync(join(fixture, 'calls.jsonl'), 'utf8').trim().split('\n')[callsBefore],
  );
  assert.ok(secretCall.args.includes('--settings'));
  assert.deepEqual(JSON.parse(secretCall.settings), { theme: 'marker-settings-theme' });
  const compatible = cli('check-resume', secretFile, ...secretArgs, '--json');
  clean('check-resume --json', compatible.stdout + compatible.stderr);
  assert.equal(compatible.status, 0, compatible.stderr);
  writeFileSync(secretFile, secretSource('+"!"'));
  const incompatible = cli('check-resume', secretFile, ...secretArgs, '--json');
  assert.equal(incompatible.status, 3, incompatible.stderr);
  assert.equal(JSON.parse(incompatible.stdout).error.code, 'run.incompatible');
  clean('check-resume --json (incompatible)', incompatible.stdout + incompatible.stderr);
  console.log(
    'PASS CLI capability manifest, grant preflight, limit diagnostics, sticky profile recovery, typed names and redacted free-form controls',
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
