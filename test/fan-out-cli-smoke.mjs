import { readRunSync } from '../dist/workflow/runtime/store.js';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
import { setTimeout as delay } from 'node:timers/promises';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = mkdtempSync(join(tmpdir(), 'quiet-choir-fanout-cli-'));
const state = join(fixture, 'state');
const file = join(fixture, 'fanout.ts');
const binaryDirectory = join(fixture, 'bin');
const entry = join(root, 'bin/run.js');
const env = { ...process.env, PATH: `${binaryDirectory}:${process.env.PATH}` };
// A writer that should be cancelled holds for HOLD_LINES lines (one per 60 ms, about 15 s), half the
// 30 s CLI bound below, so it cannot finish on its own before any plausible cancellation arrives.
// A writer that is never cancelled completes at the cap and fails the 'cancelled' status assertion.
const HOLD_LINES = 250;
// This fixture makes CI wait for two sibling writers; it explicitly needs three live agents.
const cli = (...args) =>
  spawnSync(
    process.execPath,
    [entry, 'workflow', ...args, ...(args[0] === 'execute' ? ['--max-agents', '3'] : [])],
    {
      cwd: fixture,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
const checkpoint = (id) => readRunSync({ stateDir: state, runId: id });
const lines = (prefix, name) =>
  readFileSync(join(fixture, `${prefix}-${name}.txt`), 'utf8')
    .trim()
    .split('\n').length;
async function interrupt(id, sleep) {
  // The agent case holds both writers until the SIGINT, and the healed marker makes ci succeed at
  // once, so neither lint completing nor ci failing can race the interrupt.
  if (!sleep) writeFileSync(join(fixture, `${id}-healed`), 'yes');
  const child = spawn(
    process.execPath,
    [
      entry,
      'workflow',
      'execute',
      file,
      '--run-id',
      id,
      '--max-agents',
      '3',
      '--state-dir',
      state,
      '--input',
      JSON.stringify(sleep ? { prefix: id, sleep } : { prefix: id, hold: true }),
      '--wait-mode',
      'block',
    ],
    { cwd: fixture, env },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdout.resume();
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const deadline = Date.now() + 20_000;
  try {
    for (;;) {
      const path = join(state, id, 'run.json');
      if (existsSync(path)) {
        const record = checkpoint(id);
        if (
          sleep
            ? record.steps.nap?.status === 'waiting'
            : record.steps['checks/lint/run']?.status === 'running' &&
              existsSync(join(fixture, `${id}-lint.txt`))
        )
          break;
      }
      if (child.exitCode !== null) throw new Error(`CLI exited before interruption: ${stderr}`);
      if (Date.now() > deadline) throw new Error('CLI did not start its interrupt target');
      await delay(20);
    }
    assert.equal(existsSync(join(state, id, 'lock')), true);
    child.kill('SIGINT');
    const result = await Promise.race([
      exited,
      delay(10_000, undefined, { ref: false }).then(() => {
        throw new Error('CLI did not exit after SIGINT');
      }),
    ]);
    assert.equal(result.code, 130, stderr);
    assert.match(stderr, /Workflow interrupted/);
    const record = checkpoint(id);
    // A first signal saves a resumable suspension that is due now, not a failure.
    assert.equal(record.status, 'suspended');
    assert.equal(record.rootCause, null);
    assert.match(record.interruptedBy.reason, /Workflow interrupted/);
    assert.ok(record.nextWakeAt <= Date.now());
    const target = record.steps[sleep ? 'nap' : 'checks/lint/run'];
    assert.equal(target.status, sleep ? 'waiting' : 'cancelled');
    assert.equal(target.cancelledBy ?? null, null);
    if (!sleep)
      assert.ok(lines(id, 'lint') < HOLD_LINES, 'SIGINT stopped lint before it completed');
    assert.equal(existsSync(join(state, id, 'lock')), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await exited;
    }
  }
}
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
let prompt = '';
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  const {prefix,name,lines} = JSON.parse(prompt);
  fs.appendFileSync(prefix + '-calls.txt', name + '\\n');
  const ok = () => { console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:name})); };
  process.on('SIGTERM', () => { fs.appendFileSync(prefix+'-signals.txt', name+'\\n'); process.exit(143); });
  if (name === 'ci') {
    if (fs.existsSync(prefix+'-healed')) return ok();
    const timer = setInterval(() => {
      if (['lint','tests'].every(writer => fs.existsSync(prefix+'-'+writer+'.txt') && fs.readFileSync(prefix+'-'+writer+'.txt','utf8').split('\\n').length > 2)) {
        clearInterval(timer);
        console.log(JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true,errors:['CI failed']}));
        process.exitCode=1;
      }
    },5);
  } else {
    let count = 0;
    const timer = setInterval(() => {
      fs.appendFileSync(prefix+'-'+name+'.txt', 'line\\n');
      if (++count === lines) { clearInterval(timer); ok(); }
    },60);
  }
});
`,
    { mode: 0o700 },
  );
  writeFileSync(
    file,
    `import { defineWorkflow, z } from 'quiet-choir';
export default defineWorkflow({name:'fanout-cli',version:'1',input:z.object({prefix:z.string(),policy:z.enum(['drain','abort']).default('drain'),sleep:z.boolean().default(false),hold:z.boolean().default(false)}),output:z.array(z.string()),async run(ctx,input) {
  if(input.sleep) { await ctx.sleep('nap',10000); return []; }
  return ctx.map('checks',['ci','lint','tests'],{concurrency:3,key:(name)=>name,cancelSiblings:input.policy==='abort'},async(name)=>(await ctx.claude.text('run',{prompt:JSON.stringify({prefix:input.prefix,name,lines:input.policy==='abort'||input.hold?${HOLD_LINES}:10})})).output);
}});
`,
  );
  const first = cli(
    'execute',
    file,
    '--run-id',
    'drain',
    '--state-dir',
    state,
    '--input',
    '{"prefix":"drain"}',
  );
  assert.equal(first.status, 1, first.stderr);
  assert.match(first.stderr, /CI failed/);
  const saved = checkpoint('drain');
  assert.equal(saved.rootCause.stepId, 'checks/ci/run');
  assert.match(saved.rootCause.error, /CI failed/);
  assert.equal(saved.steps['checks/ci/run'].status, 'failed');
  for (const name of ['lint', 'tests']) {
    assert.equal(lines('drain', name), 10);
    assert.equal(saved.steps[`checks/${name}/run`].status, 'completed');
  }
  assert.equal(existsSync(join(fixture, 'drain-signals.txt')), false);
  writeFileSync(join(fixture, 'drain-healed'), 'yes');
  const resumed = cli(
    'execute',
    file,
    '--run-id',
    'drain',
    '--state-dir',
    state,
    '--resume',
    '--json',
  );
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.deepEqual(JSON.parse(resumed.stdout).output, ['ci', 'lint', 'tests']);
  for (const name of ['lint', 'tests']) assert.equal(lines('drain', name), 10);
  assert.deepEqual(
    readFileSync(join(fixture, 'drain-calls.txt'), 'utf8').trim().split('\n').sort(),
    ['ci', 'ci', 'lint', 'tests'],
  );

  const aborted = cli(
    'execute',
    file,
    '--run-id',
    'abort',
    '--state-dir',
    state,
    '--input',
    '{"prefix":"abort","policy":"abort"}',
  );
  assert.equal(aborted.status, 1, aborted.stderr);
  const interrupted = checkpoint('abort');
  assert.equal(interrupted.status, 'failed');
  assert.equal(interrupted.rootCause.stepId, 'checks/ci/run');
  for (const name of ['lint', 'tests']) {
    const step = interrupted.steps[`checks/${name}/run`];
    assert.equal(step.status, 'cancelled');
    assert.equal(step.cancelledBy, 'checks/ci/run');
    assert.doesNotMatch(step.error, /CI failed/);
    // Order-independent: cancellation, not completion, stopped the writer.
    assert.ok(
      lines('abort', name) < HOLD_LINES,
      `${name} ran to completion; cancellation must stop it first`,
    );
  }
  const inspected = cli('inspect', 'abort', '--state-dir', state);
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.match(inspected.stdout, /Root cause \(checks\/ci\/run, unknown\):.*CI failed/);
  await interrupt('interrupt-agent', false);
  await interrupt('interrupt-sleep', true);
  console.log(
    'PASS CLI drain preserves 10-line writers across resume; scoped abort and SIGINT persist cancellation/rootCause',
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
