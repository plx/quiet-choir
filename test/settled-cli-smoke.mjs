import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = mkdtempSync(join(tmpdir(), 'quiet-choir-settled-cli-'));
const state = join(fixture, 'state');
const file = join(fixture, 'fallback.ts');
const calls = join(fixture, 'calls.jsonl');
const healed = join(fixture, 'healed');
function cli(...args) {
  return spawnSync(process.execPath, [join(root, 'bin/run.js'), 'workflow', ...args], {
    cwd: fixture,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${join(fixture, 'bin')}:${process.env.PATH}`,
      QC_SETTLED_CALLS: calls,
      QC_SETTLED_HEALED: healed,
    },
  });
}
try {
  mkdirSync(join(fixture, 'bin'));
  mkdirSync(join(fixture, 'node_modules'));
  symlinkSync(root, join(fixture, 'node_modules/quiet-choir'));
  symlinkSync(join(root, 'node_modules/@types'), join(fixture, 'node_modules/@types'));
  writeFileSync(join(fixture, 'package.json'), '{"type":"module"}');
  writeFileSync(
    join(fixture, 'bin/claude'),
    `#!/usr/bin/env node
import fs from 'node:fs';
let prompt = '';
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.QC_SETTLED_CALLS, JSON.stringify(prompt) + '\\n');
  const broken = !fs.existsSync(process.env.QC_SETTLED_HEALED);
  console.log(JSON.stringify(broken
    ? {type:'result',subtype:'error_max_turns',terminal_reason:'max_turns',is_error:true,errors:['limit'],num_turns:2}
    : {type:'result',subtype:'success',is_error:false,result:prompt}));
  process.exitCode = broken ? 1 : 0;
});
`,
    { mode: 0o700 },
  );
  writeFileSync(
    file,
    `import { appendFileSync } from 'node:fs';
import { defineWorkflow, z, type Settled, type AgentResult } from 'quiet-choir';
export default defineWorkflow({name:'fallback-cli',version:'1',input:z.object({}),output:z.string(),async run(ctx) {
  const primary: Settled<AgentResult<string>> = await ctx.claude.text('primary', {prompt:'primary',onError:'return',retry:{maxAttempts:2,delayMs:0,on:['rate-limit']}});
  const draft = primary.ok ? primary.value.output : await ctx.step('fallback', {input:primary.error.kind,schema:z.string(),run() {appendFileSync('writes.txt','fallback\\n');return 'fallback';}});
  return draft + (await ctx.claude.text('final', {prompt:'final'})).output;
}});
`,
  );
  const args = ['execute', file, '--run-id', 'recovery', '--state-dir', state];
  const first = cli(...args, '--json');
  assert.equal(first.status, 1, first.stderr);
  assert.equal(first.stdout, '');
  const inspected = cli('inspect', 'recovery', '--state-dir', state, '--json');
  assert.equal(inspected.status, 0, inspected.stderr);
  const initial = JSON.parse(inspected.stdout);
  assert.equal(initial.formatVersion, 4);
  assert.equal(initial.steps.primary.status, 'settled-failed');
  assert.equal(initial.steps.primary.settledError.kind, 'turn-limit');
  assert.equal(initial.steps.primary.attemptHistory[0].errorKind, 'turn-limit');
  writeFileSync(healed, 'yes');
  const resume = cli(...args, '--resume', '--json');
  assert.equal(resume.status, 0, resume.stderr);
  assert.equal(JSON.parse(resume.stdout).output, 'fallbackfinal');
  assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse), [
    'primary',
    'final',
    'final',
  ]);
  assert.equal(readFileSync(join(fixture, 'writes.txt'), 'utf8'), 'fallback\n');
  const source = readFileSync(join(state, 'recovery.json'), 'utf8');
  const fork = cli(
    'execute',
    file,
    '--run-id',
    'reconsidered',
    '--state-dir',
    state,
    '--fork-from',
    'recovery',
    '--invalidate',
    'primary',
    '--json',
  );
  assert.equal(fork.status, 0, fork.stderr);
  assert.equal(JSON.parse(fork.stdout).output, 'primaryfinal');
  assert.equal(readFileSync(join(state, 'recovery.json'), 'utf8'), source);
  console.log(
    'PASS CLI settled failure replay, attempt categories, immutable source, and explicit retry through fork invalidation',
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
