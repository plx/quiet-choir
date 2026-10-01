import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeBinary } from 'quiet-choir/harness-kit';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = mkdtempSync(join(tmpdir(), 'choir-harness-registry-cli-'));
const state = join(directory, 'state');
const source = join(directory, 'custom.workflow.ts');
const constructed = join(directory, 'constructed');
const binary = await createFakeBinary(
  'third-cli',
  `
 if(process.argv.includes('--version')) {console.log('third-cli 1.0');}
 else {let input=''; for await(const chunk of process.stdin) input+=chunk; const request=JSON.parse(input); console.log(JSON.stringify({answer:request.prompt+':'+request.provider+':'+request.effort}));}
`,
);
const config = JSON.stringify({ harnesses: { third: { binary: 'third-cli' } } });
function cli(args, env = {}) {
  return spawnSync(process.execPath, [join(root, 'bin/run.js'), ...args], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      ...binary.env,
      XDG_CACHE_HOME: join(directory, 'cache'),
      QUIET_CHOIR_HARNESS_CONFIG: config,
      ...env,
    },
  });
}
function ok(args) {
  const result = cli(args);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return JSON.parse(result.stdout);
}
try {
  mkdirSync(join(directory, 'node_modules'));
  symlinkSync(root, join(directory, 'node_modules/quiet-choir'));
  symlinkSync(join(root, 'node_modules/@types'), join(directory, 'node_modules/@types'));
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
  writeFileSync(
    source,
    `import {appendFileSync} from 'node:fs';
import {defineWorkflow,z} from 'quiet-choir';
import {defineHarness,runProcess} from 'quiet-choir/harness-kit';
import {decision} from 'quiet-choir/decision';
const third=defineHarness({name:'third',revision:1,options:z.object({prompt:z.string(),provider:z.string(),effort:z.enum(['brief','deep'])}), capabilities:{structuredOutput:'prompted',effort:['brief','deep']},access:()=> 'none',
 createAdapter(config){const {binary}=z.object({binary:z.string()}).parse(config); appendFileSync(${JSON.stringify(constructed)},'construct\\n');
 return {async invoke(request,signal,invocation){const result=await runProcess({binary,args:[],cwd:request.cwd,input:JSON.stringify(request.options),signal,timeoutMs:invocation?.policy?.timeoutMs??1000,maxOutputBytes:10000,killGraceMs:25,...(invocation?{trackProcess:invocation.trackProcess}: {})});if(result.code!==0)throw new Error(result.stderr);return{text:result.stdout,sessionId:null};}};},
 async probe(config,signal){const {binary}=z.object({binary:z.string()}).parse(config);const result=await runProcess({binary,args:['--version'],cwd:${JSON.stringify(directory)},input:'',signal:signal??new AbortController().signal,timeoutMs:1000,maxOutputBytes:10000,killGraceMs:25});if(result.code!==0)throw new Error(result.stderr);return{version:result.stdout.trim()};}});
export default defineWorkflow({name:'custom-cli',version:'1',harnesses:[third],input:z.object({}),output:z.string(),async run(ctx){
 const route=await decision(ctx,async()=>({output:{answer:'fix',probabilities:{fix:1,skip:0}},usage:{inputTokens:1,outputTokens:1,costUsd:0.01}})).choose('route',{state:null,question:'route?',answers:['fix','skip']});
 const answer=await ctx.agent('third').value('answer',{prompt:route.answer,provider:'openai',effort:'deep',schema:z.object({answer:z.string()})});return answer.answer;}});`,
  );
  const validated = ok(['workflow', 'validate', source, '--json']);
  assert.equal(validated.workflow.harnesses.find((item) => item.name === 'third').revision, 1);
  const doctor = ok(['configuration', 'doctor', '--workflow', source, '--json']);
  assert.equal(doctor.harnesses.third.version, 'third-cli 1.0');
  const selectedDoctor = ok([
    'configuration',
    'doctor',
    '--workflow',
    source,
    '--harness',
    'third',
    '--json',
  ]);
  assert.deepEqual(
    selectedDoctor.checks.map((check) => check.harness),
    ['third'],
  );
  assert.equal(existsSync(constructed), false, 'Validation and doctor must not construct adapters');
  const run = ok([
    'workflow',
    'execute',
    source,
    '--run-id',
    'native',
    '--state-dir',
    state,
    '--json',
    '--full',
  ]);
  assert.equal(run.output, 'fix:openai:deep');
  assert.equal(run.steps.answer.kind, 'agent');
  assert.equal(run.steps.answer.harness, 'third');
  assert.equal(run.steps.route.meta.integration, 'decision');
  ok(['workflow', 'resume', 'native', '--state-dir', state, '--json']);
  assert.equal(
    readFileSync(constructed, 'utf8'),
    'construct\n',
    'Completed replay must not construct an adapter',
  );
  const fixture = join(directory, 'fixture.json');
  writeFileSync(
    fixture,
    JSON.stringify({ version: 1, calls: [{ step: 'answer', output: { answer: 'fixture' } }] }),
  );
  const selected = ok([
    'workflow',
    'execute',
    source,
    '--harness',
    `third=fixture:${fixture}`,
    '--run-id',
    'fixture',
    '--state-dir',
    state,
    '--json',
  ]);
  assert.equal(selected.output, 'fixture');
  assert.equal(readFileSync(constructed, 'utf8'), 'construct\n');
  const rehearsal = ok([
    'workflow',
    'execute',
    source,
    '--dry-run',
    '--harness',
    `third=fixture:${fixture}`,
    '--run-id',
    'preview',
    '--state-dir',
    state,
    '--json',
  ]);
  assert.equal(rehearsal.harnessCounts.third, 1);
  assert.equal(rehearsal.calls[0].outputSource, 'fixture');
  const inspected = ok(['workflow', 'inspect', 'native', '--state-dir', state, '--json']);
  assert.equal(inspected.usageSummary.integrationUsage.attempts, 1);
  const changed = cli(['workflow', 'resume', 'fixture', '--state-dir', state, '--json']);
  assert.notEqual(
    changed.status,
    0,
    'Dropping a named fixture requires explicit harness-mode acceptance',
  );
  console.log('Harness registry CLI smoke passed.');
} finally {
  await binary.dispose();
  rmSync(directory, { recursive: true, force: true });
}
