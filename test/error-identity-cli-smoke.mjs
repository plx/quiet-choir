// Public errors and adapter evidence built by the workflow's own quiet-choir module instance
// (tsImport namespaces the workflow's import graph) must behave as they do embedded.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = mkdtempSync(join(tmpdir(), 'choir-error-identity-cli-'));
const state = join(directory, 'state');
const source = join(directory, 'identity.workflow.ts');
const counter = join(directory, 'flaky-count');
const config = JSON.stringify({ harnesses: { flaky: {} } });

function cli(args) {
  return spawnSync(process.execPath, [join(root, 'bin/run.js'), ...args], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      XDG_CACHE_HOME: join(directory, 'cache'),
      QUIET_CHOIR_HARNESS_CONFIG: config,
    },
  });
}
function execute(runId, scenario) {
  return cli([
    'workflow',
    'execute',
    source,
    '--run-id',
    runId,
    '--input',
    JSON.stringify({ scenario }),
    '--state-dir',
    state,
    '--json',
  ]);
}
function inspect(runId) {
  const result = cli(['workflow', 'inspect', runId, '--state-dir', state, '--json']);
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
    `import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {ConfigurationError as WorkflowConfigurationError,ExecError,defineWorkflow,z} from 'quiet-choir';
import {ConfigurationError,HarnessError,attachHarnessEvidence,defineHarness} from 'quiet-choir/harness-kit';
const counter=${JSON.stringify(counter)};
const flaky=defineHarness({name:'flaky',revision:1,options:z.object({prompt:z.string()}),capabilities:{structuredOutput:'prompted'},access:()=>'none',
 createAdapter(){return {async invoke(request){
  const prompt=request.options.prompt;
  if(prompt==='rate-limit'){
   const count=existsSync(counter)?Number(readFileSync(counter,'utf8')):0;
   writeFileSync(counter,String(count+1));
   if(count===0) throw new HarnessError({harness:'flaky',exit:{code:1,signal:null},failure:{reason:'Rate limit reached (fake)',subtype:null,terminalReason:null,apiStatus:429,sessionId:null,usage:null},reason:'rate limited',stderr:'',stdout:''});
   return {text:JSON.stringify({answer:'recovered'}),sessionId:null};
  }
  if(prompt==='evidence'){
   const error=new Error('adapter failed with evidence');
   attachHarnessEvidence(error,{sessionId:'sess-evidence',rawText:'raw evidence',diagnostics:{marker:'x'},usage:null,responseTruncated:false});
   throw error;
  }
  if(prompt==='frozen-evidence'){
   const error=Object.freeze(new Error('frozen adapter failure'));
   attachHarnessEvidence(error,{sessionId:'sess-frozen',rawText:'raw frozen',diagnostics:{marker:'frozen'},usage:null,responseTruncated:false});
   throw error;
  }
  if(prompt==='config') throw new ConfigurationError('adapter misconfigured');
  return {text:JSON.stringify({answer:prompt}),sessionId:null};
 }};}});
const answer=z.object({answer:z.string()});
export default defineWorkflow({name:'error-identity',version:'1',harnesses:[flaky],input:z.object({scenario:z.enum(['ok','step-config','adapter-config'])}),output:z.unknown(),async run(ctx,input){
 if(input.scenario==='step-config')
  return ctx.step('configure',{input:null,schema:z.string(),onError:'return',retry:{maxAttempts:3,delayMs:1},run:()=>{throw new WorkflowConfigurationError('step misconfigured');}});
 if(input.scenario==='adapter-config')
  return ctx.agent('flaky').value('configure',{prompt:'config',schema:answer,onError:'return',retry:{maxAttempts:3,delayMs:1}});
 const retried=await ctx.agent('flaky').value('retried',{prompt:'rate-limit',schema:answer,onError:'return',retry:{maxAttempts:3,delayMs:1,on:['rate-limit']}});
 const evidence=await ctx.agent('flaky').value('evidence',{prompt:'evidence',schema:answer,onError:'return'});
 const frozenEvidence=await ctx.agent('flaky').value('frozenEvidence',{prompt:'frozen-evidence',schema:answer,onError:'return'});
 let execIsExecError=false;
 try{await ctx.exec('x',['false']);}catch(error){execIsExecError=error instanceof ExecError;}
 return {retried:retried.ok?retried.value.answer:null,evidenceOk:evidence.ok,frozenEvidenceOk:frozenEvidence.ok,execIsExecError};
}});`,
  );

  // Collect every failed check, so a regression reports all of them at once.
  const failures = [];
  const check = (name, assertion) => {
    try {
      assertion();
    } catch (error) {
      failures.push(
        `${name}: got ${JSON.stringify(error.actual)}, expected ${error.operator === 'notStrictEqual' ? 'not ' : ''}${JSON.stringify(error.expected)}`,
      );
    }
  };

  const ok = execute('ok', 'ok');
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  const okOutput = JSON.parse(ok.stdout).output;
  const okRun = inspect('ok');
  const retried = okRun.steps.retried;
  check('429 HarnessError is recorded as rate-limit', () =>
    assert.equal(retried.attemptHistory[0].errorKind, 'rate-limit'),
  );
  check('429 HarnessError is retried under on: rate-limit', () => {
    assert.equal(okOutput.retried, 'recovered');
    assert.equal(retried.status, 'completed');
    assert.equal(retried.attempts, 2);
  });
  const evidence = okRun.steps.evidence.attemptHistory[0];
  check('attachHarnessEvidence reaches the attempt record', () => {
    assert.equal(okOutput.evidenceOk, false);
    assert.equal(evidence.sessionId, 'sess-evidence');
    assert.equal(evidence.response, 'raw evidence');
    assert.equal(evidence.diagnostics?.marker, 'x');
  });
  const frozenAttempt = okRun.steps.frozenEvidence.attemptHistory[0];
  check('attachHarnessEvidence on a frozen error reaches the attempt record', () => {
    assert.equal(okOutput.frozenEvidenceOk, false);
    assert.equal(frozenAttempt.sessionId, 'sess-frozen');
    assert.equal(frozenAttempt.response, 'raw frozen');
    assert.equal(frozenAttempt.diagnostics?.marker, 'frozen');
  });
  check('e instanceof ExecError holds in workflow code', () =>
    assert.equal(okOutput.execIsExecError, true),
  );

  for (const scenario of ['step-config', 'adapter-config']) {
    const result = execute(scenario, scenario);
    const run = inspect(scenario);
    const step = run.steps.configure;
    check(`${scenario}: ConfigurationError rejects the run`, () => {
      assert.notEqual(result.status, 0);
      assert.equal(run.status, 'failed');
    });
    check(`${scenario}: ConfigurationError is never settled`, () =>
      assert.equal(step.status, 'failed'),
    );
    check(`${scenario}: ConfigurationError is never retried`, () => assert.equal(step.attempts, 1));
  }
  assert.deepEqual(failures, [], `Error identity checks failed:\n${failures.join('\n')}`);
  console.log('Error identity CLI smoke passed.');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
