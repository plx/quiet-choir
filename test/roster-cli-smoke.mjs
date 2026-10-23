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
const fixture = mkdtempSync(join(tmpdir(), 'quiet-choir-roster-cli-'));
const state = join(fixture, 'state');
const bin = join(fixture, 'bin');
const cli = (...args) =>
  spawnSync(process.execPath, [join(root, 'bin/run.js'), 'workflow', ...args], {
    cwd: fixture,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    encoding: 'utf8',
    timeout: 30_000,
  });
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

  // Roster entries are the declared roles, each pinned to one harness (#579, #726): validate lists
  // them with their harness and access, and `--profile Name.limit=` recovers a roster call.
  const rosterFile = join(fixture, 'roster.ts');
  const rosterSource = (
    extra = '',
    entry = 'Reviewer',
  ) => `import {defineRoster,defineWorkflow,z} from 'quiet-choir';
import {writeFileSync} from 'node:fs';
const roster=defineRoster({Reviewer:{harness:'claude',model:'opus',tools:['Read','Grep'],maxTurns:40,appendSystemPrompt:'marker-roster-prompt',description:'Reviews'},
Mechanic:{harness:'codex',sandbox:'workspace-write'},Clerk:{harness:'claude'}});
export default defineWorkflow({name:'roster-cli',version:'1',input:z.object({}),output:z.string(),roster,defaults:{maxBudgetUsd:1},${extra}
async run(ctx){
// quiet-choir-ignore QC002 marker file proving whether the body ran
writeFileSync('roster-body-started','yes');return (await ctx.roster.${entry}.text('pending',{prompt:'pending'})).output;}});`;
  writeFileSync(rosterFile, rosterSource());
  const rosterValidation = cli('validate', rosterFile, '--json');
  assert.equal(rosterValidation.status, 0, rosterValidation.stderr);
  assert.ok(!rosterValidation.stdout.includes('marker-roster-prompt'), 'validate leaked a prompt');
  const rosterWorkflow = JSON.parse(rosterValidation.stdout).workflow;
  const entries = rosterWorkflow.capabilities.profiles;
  // The manifest lists the text role and the entries only, never the removed presets.
  assert.deepEqual(Object.keys(entries).sort(), ['Clerk', 'Mechanic', 'Reviewer', 'text']);
  assert.equal(rosterWorkflow.capabilities.defaultProfile, 'text');
  assert.equal(entries.Reviewer.harness, 'claude');
  assert.equal(entries.Reviewer.access, 'read');
  assert.equal(entries.Reviewer.description, 'Reviews');
  assert.equal(entries.Reviewer.claude.model, 'opus');
  assert.deepEqual(entries.Reviewer.claude.tools, ['Read', 'Grep']);
  assert.equal(entries.Reviewer.maxTurns, 40);
  assert.equal(entries.Reviewer.maxBudgetUsd, 1);
  assert.ok(!('appendSystemPrompt' in entries.Reviewer.claude));
  assert.match(entries.Reviewer.redacted.claude.appendSystemPrompt.sha256, /^[a-f0-9]{64}$/);
  assert.equal(entries.Mechanic.harness, 'codex');
  assert.equal(entries.Mechanic.access, 'write');
  assert.equal(entries.Mechanic.codex.sandbox, 'workspace-write');
  assert.equal(entries.Clerk.harness, 'claude');
  assert.equal(entries.Clerk.access, 'none');
  // Access classes stay as labels; required grants are listed only under requireGrants (#577).
  assert.equal(rosterWorkflow.capabilities.strictProfiles, false);
  assert.deepEqual(rosterWorkflow.capabilities.requiredGrants, []);
  // The removed workflow.profiles list (#726) is not printed.
  assert.equal(rosterWorkflow.profiles, undefined);
  const optedFile = join(fixture, 'opted.ts');
  writeFileSync(optedFile, rosterSource('requireGrants:true,'));
  const opted = cli('validate', optedFile, '--json');
  assert.equal(opted.status, 0, opted.stderr);
  assert.deepEqual(JSON.parse(opted.stdout).workflow.capabilities.requiredGrants, ['Mechanic']);
  assert.equal(existsSync(join(fixture, 'roster-body-started')), false);
  const rosterArgs = ['execute', rosterFile, '--run-id', 'roster', '--state-dir', state];
  const rosterRecord = () => JSON.parse(readFileSync(join(state, 'roster', 'run.json'), 'utf8'));
  // The codex workspace-write entry Mechanic is a declared write role, so --require-grants refuses
  // the launch before the body runs and before any record exists.
  const rosterDenied = cli(...rosterArgs, '--require-grants');
  assert.equal(rosterDenied.status, 2, rosterDenied.stderr);
  assert.match(rosterDenied.stderr, /Role Mechanic requires write access/);
  assert.match(rosterDenied.stderr, /--grant[\s›]*Mechanic,/);
  assert.equal(existsSync(join(fixture, 'roster-body-started')), false);
  assert.equal(existsSync(join(state, 'roster', 'run.json')), false);
  // The turn cap names the entry's limit, the reported turns and spend, and the recovery flag.
  const rosterFirst = cli(...rosterArgs, '--require-grants', '--grant', 'Mechanic');
  assert.equal(rosterFirst.status, 1, rosterFirst.stderr);
  assert.match(rosterFirst.stderr, /--resume[\s›]*--profile Reviewer.maxTurns=80/);
  assert.match(rosterFirst.stderr, /turns=40;[\s›]*costUsd=0.31/);
  assert.equal(existsSync(join(fixture, 'roster-body-started')), true);
  assert.deepEqual(rosterRecord().steps.pending.warnings, [
    'Profile Reviewer: 1 permission denials reported.',
  ]);
  const rosterResumed = cli(
    ...rosterArgs,
    '--resume',
    '--profile',
    'Reviewer.maxTurns=60',
    '--profile',
    '*.timeoutMs=1800000',
  );
  assert.equal(rosterResumed.status, 0, rosterResumed.stderr);
  const record = rosterRecord();
  assert.equal(record.status, 'completed');
  assert.deepEqual(record.grants, ['Mechanic']);
  assert.equal(record.requireGrants, true);
  const rosterAttempt = record.steps.pending.attemptHistory[1];
  assert.equal(rosterAttempt.profile, 'Reviewer');
  assert.equal(rosterAttempt.policy.maxTurns, 60);
  assert.equal(rosterAttempt.sources.maxTurns, 'profile-override:0');
  assert.equal(rosterAttempt.policy.timeoutMs, 1_800_000);
  assert.equal(rosterAttempt.sources.timeoutMs, 'profile-override:1');
  assert.ok(!readFileSync(join(state, 'roster', 'run.json'), 'utf8').includes('marker-roster'));
  // The saved rules are sticky: a bare resume of the completed run makes no new call.
  const rosterCalls = readFileSync(join(fixture, 'calls.jsonl'), 'utf8');
  assert.equal(rosterCalls.trim().split('\n').length, 2);
  const rosterBare = cli(...rosterArgs, '--resume');
  assert.equal(rosterBare.status, 0, rosterBare.stderr);
  assert.equal(readFileSync(join(fixture, 'calls.jsonl'), 'utf8'), rosterCalls);
  const rosterInspected = cli('inspect', 'roster', '--state-dir', state, '--json');
  assert.equal(rosterInspected.status, 0, rosterInspected.stderr);
  assert.equal(JSON.parse(rosterInspected.stdout).profileOverrides.length, 2);
  const rosterInvalid = cli(...rosterArgs, '--resume', '--profile', 'Reviewer.model=other');
  assert.equal(rosterInvalid.status, 2, rosterInvalid.stderr);
  assert.match(rosterInvalid.stderr, /Invalid --profile/);
  // A misspelled entry name fails typecheck before any call.
  writeFileSync(rosterFile, rosterSource('', 'Reviewr'));
  const typo = cli('validate', rosterFile, '--json');
  assert.equal(typo.status, 4, typo.stderr);
  assert.match(typo.stdout + typo.stderr, /Reviewr/);
  assert.equal(readFileSync(join(fixture, 'calls.jsonl'), 'utf8'), rosterCalls);
  // The removed profiles field (#726) fails typecheck as an excess property, and a definition
  // that suppresses the type error is refused at runtime with a pointer to defineRoster.
  writeFileSync(rosterFile, rosterSource("profiles:{scout:{claude:{tools:['Read']}}},"));
  const declared = cli('validate', rosterFile, '--json');
  assert.notEqual(declared.status, 0, declared.stdout);
  assert.match(declared.stdout + declared.stderr, /profiles/);
  writeFileSync(
    rosterFile,
    rosterSource(
      "\n// @ts-expect-error -- removed in #726\nprofiles:{scout:{claude:{tools:['Read']}}},",
    ),
  );
  const refused = cli('validate', rosterFile, '--json');
  assert.notEqual(refused.status, 0, refused.stdout);
  assert.match(refused.stdout + refused.stderr, /declares profiles, which were removed/);
  assert.match(refused.stdout + refused.stderr, /defineRoster/);
  assert.equal(readFileSync(join(fixture, 'calls.jsonl'), 'utf8'), rosterCalls);

  // Free-form controls of entries reach the harness but never a printed manifest or checkpoint
  // (#103). An entry pins one harness, so the Claude controls sit on a Claude entry and the Codex
  // config on a Codex entry.
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
  // defineRoster's option types recurse through these JSON controls (TS2589), so the entries hide
  // the free-form keys from their static types, as capability-manifest.test.ts does.
  const secretSource = (tail) => `import {defineRoster,defineWorkflow,z} from 'quiet-choir';
const Vault={harness:'claude',isolation:'inherit',env:{set:{PRIVATE:'marker-env-value'}},settings:{theme:'marker-settings-theme'},
mcpServers:{tracker:{command:'marker-mcp-command',env:{TOKEN:'marker-mcp-token'}}},agents:{reviewer:{description:'Reviews',prompt:'marker-agent-prompt'}},
appendSystemPrompt:'marker-append-prompt'} as {readonly harness:'claude';readonly isolation:'inherit'};
const Configured={harness:'codex',isolation:'inherit',config:{'model_providers.x.base_url':'marker-codex-config'}} as {readonly harness:'codex';readonly isolation:'inherit'};
const roster=defineRoster({Vault,Configured});
export default defineWorkflow({name:'secret-cli',version:'1',input:z.object({}),output:z.string(),roster,
async run(ctx){return (await ctx.roster.Vault.text('only',{prompt:'secret'})).output${tail};}});`;
  writeFileSync(secretFile, secretSource(''));
  const secretValidation = cli('validate', secretFile, '--json');
  assert.equal(secretValidation.status, 0, secretValidation.stderr);
  clean('validate --json', secretValidation.stdout);
  const secretRoles = JSON.parse(secretValidation.stdout).workflow.capabilities.profiles;
  const vault = secretRoles.Vault;
  assert.deepEqual(vault.environment.claude.set, ['PRIVATE']);
  assert.match(vault.environment.claude.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(vault.redacted.claude.settings.keys, ['theme']);
  assert.deepEqual(vault.redacted.claude.mcpServers.keys, ['tracker']);
  assert.deepEqual(vault.redacted.claude.agents.keys, ['reviewer']);
  assert.match(vault.redacted.claude.appendSystemPrompt.sha256, /^[a-f0-9]{64}$/);
  assert.equal(vault.redacted.claude.appendSystemPrompt.keys, undefined);
  for (const field of ['settings', 'mcpServers', 'agents', 'appendSystemPrompt', 'env'])
    assert.ok(!(field in vault.claude), field);
  assert.deepEqual(secretRoles.Configured.redacted.codex.config.keys, [
    'model_providers.x.base_url',
  ]);
  assert.ok(!('config' in secretRoles.Configured.codex));
  const secretArgs = ['--run-id', 'redaction', '--state-dir', state];
  const callsBefore = readFileSync(join(fixture, 'calls.jsonl'), 'utf8').trim().split('\n').length;
  const secretRun = cli('execute', secretFile, ...secretArgs, '--grant', 'Vault');
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

  // Registered harness sensitiveOptions of an entry reach the adapter but never a printed manifest
  // or checkpoint (#247); headers is also a capability key, region is not sensitive.
  const optionMarkers = ['marker-harness-token', 'marker-harness-header'];
  const scrubbed = (label, text) => {
    for (const marker of optionMarkers)
      assert.ok(!text.includes(marker), `${label} leaked ${marker}`);
  };
  const keeperFile = join(fixture, 'keeper.ts');
  const keeperCalls = join(fixture, 'keeper-calls.jsonl');
  const keeperSource = (tail) => `import {appendFileSync} from 'node:fs';
import {defineRoster,defineWorkflow,z} from 'quiet-choir';
import {defineHarness} from 'quiet-choir/harness-kit';
const keeper=defineHarness({name:'keeper',revision:1,options:z.object({prompt:z.string(),token:z.string().optional(),headers:z.record(z.string(),z.string()).optional(),region:z.string().optional()}),
capabilities:{structuredOutput:'none'},capabilityKeys:['headers'],sensitiveOptions:['token','headers'],access:()=>'none',
createAdapter:()=>({invoke(request){appendFileSync(${JSON.stringify(keeperCalls)},JSON.stringify(request.options)+'\\n');return Promise.resolve({text:'kept',sessionId:null});}})});
const roster=defineRoster({Locked:{harness:'keeper',token:'marker-harness-token',headers:{Authorization:'marker-harness-header','X-Trace':'trace'},region:'eu'}},{harnesses:[keeper]});
export default defineWorkflow({name:'keeper-cli',version:'1',input:z.object({}),output:z.string(),harnesses:[keeper],roster,
async run(ctx){return (await ctx.roster.Locked.text('only',{prompt:'secret'})).output${tail};}});`;
  writeFileSync(keeperFile, keeperSource(''));
  const keeperValidation = cli('validate', keeperFile, '--json');
  assert.equal(keeperValidation.status, 0, keeperValidation.stderr);
  scrubbed('validate --json', keeperValidation.stdout);
  const locked = JSON.parse(keeperValidation.stdout).workflow.capabilities.profiles.Locked;
  assert.equal(locked.harness, 'keeper');
  assert.match(locked.redacted.harnesses.keeper.token.sha256, /^[a-f0-9]{64}$/);
  assert.equal(locked.redacted.harnesses.keeper.token.keys, undefined);
  assert.match(locked.redacted.harnesses.keeper.headers.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(locked.redacted.harnesses.keeper.headers.keys, ['Authorization', 'X-Trace']);
  assert.deepEqual(locked.harnesses.keeper, { region: 'eu' });
  assert.deepEqual(locked.harnessCapabilities.keeper, {});
  const keeperArgs = ['--run-id', 'keeper', '--state-dir', state];
  const keeperRun = cli('execute', keeperFile, ...keeperArgs);
  assert.equal(keeperRun.status, 0, keeperRun.stderr);
  scrubbed('execute output', keeperRun.stdout + keeperRun.stderr);
  const keeperCheckpoint = readFileSync(join(state, 'keeper', 'run.json'), 'utf8');
  scrubbed('checkpoint', keeperCheckpoint);
  assert.deepEqual(
    JSON.parse(keeperCheckpoint).capabilities.profiles.Locked.redacted.harnesses.keeper.headers,
    locked.redacted.harnesses.keeper.headers,
  );
  const keeperCall = JSON.parse(readFileSync(keeperCalls, 'utf8').trim());
  assert.equal(keeperCall.token, 'marker-harness-token');
  assert.deepEqual(keeperCall.headers, {
    Authorization: 'marker-harness-header',
    'X-Trace': 'trace',
  });
  const keeperCompatible = cli('check-resume', keeperFile, ...keeperArgs, '--json');
  assert.equal(keeperCompatible.status, 0, keeperCompatible.stderr);
  scrubbed('check-resume --json', keeperCompatible.stdout + keeperCompatible.stderr);
  writeFileSync(keeperFile, keeperSource('+"!"'));
  const keeperIncompatible = cli('check-resume', keeperFile, ...keeperArgs, '--json');
  assert.equal(keeperIncompatible.status, 3, keeperIncompatible.stderr);
  assert.equal(JSON.parse(keeperIncompatible.stdout).error.code, 'run.incompatible');
  scrubbed(
    'check-resume --json (incompatible)',
    keeperIncompatible.stdout + keeperIncompatible.stderr,
  );
  console.log(
    'PASS CLI roster entries: manifest, grant preflight, limit diagnostics, sticky launch overrides, typed names, refused profiles, redacted free-form controls and redacted registered harness options',
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
