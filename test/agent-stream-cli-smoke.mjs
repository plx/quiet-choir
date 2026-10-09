import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { deriveAgentSessionId } from '../dist/index.js';
import { readRunSync } from '../dist/workflow/runtime/store.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = mkdtempSync(join(tmpdir(), 'choir-stream-cli-'));
const state = join(directory, 'state');
const file = join(directory, 'workflow.ts');
const bin = join(directory, 'bin');
const runners = new Set();
const argsFor = (id, provider = 'codex') => [
  join(root, 'bin/run.js'),
  'workflow',
  'execute',
  file,
  '--run-id',
  id,
  '--state-dir',
  state,
  '--json',
  '--input',
  JSON.stringify({ provider }),
  '--kill-grace-ms',
  '30',
];
const environment = (mode) => ({
  ...process.env,
  QC_STREAM_MODE: mode,
  PATH: `${bin}${delimiter}${process.env.PATH}`,
});
const cli = (id, mode, extra = [], provider = 'codex') =>
  spawnSync(process.execPath, [...argsFor(id, provider), ...extra], {
    cwd: directory,
    env: environment(mode),
    encoding: 'utf8',
    timeout: 30_000,
  });
const saved = (runId) => readRunSync({ stateDir: state, runId });
async function waitFor(fn) {
  const deadline = performance.now() + 25_000;
  while (performance.now() < deadline) {
    if (fn()) return;
    await delay(25);
  }
  throw new Error('Timed out waiting for early streaming evidence.');
}
try {
  mkdirSync(bin);
  mkdirSync(join(directory, 'node_modules'));
  symlinkSync(root, join(directory, 'node_modules/quiet-choir'));
  symlinkSync(join(root, 'node_modules/@types'), join(directory, 'node_modules/@types'));
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
  writeFileSync(
    file,
    `import {defineWorkflow,z} from 'quiet-choir';
export default defineWorkflow({name:'stream-cli',version:'1',input:z.object({provider:z.enum(['claude','codex'])}),output:z.string(),
async run(ctx,input){return input.provider==='claude'?ctx.claude.value('scope/../../answer',{prompt:'fixture'}):ctx.codex.value('scope/../../answer',{prompt:'fixture'});}});`,
  );
  const script = `#!${process.execPath}
if(process.argv.includes('--version')){console.log('fixture 1.2.3');process.exit();}
const claude=!process.argv.includes('exec');
const mode=process.env.QC_STREAM_MODE;
const send=value=>console.log(JSON.stringify(value));
process.stdin.resume();process.stdin.on('end',()=>{
const id=claude?process.argv[process.argv.indexOf('--session-id')+1]:'early-thread';
send(claude?{type:'system',subtype:'init',session_id:id,model:'fixture-model',claude_code_version:'1.2.3'}:{type:'thread.started',thread_id:id});
if(mode==='hang'){setInterval(()=>{},1000);return;}
if(claude){send({type:'result',subtype:'success',result:'ok',session_id:id,permission_denials:[{tool_name:'Read'}]});return;}
send({type:'item.completed',item:{id:'command',type:'command_execution',aggregated_output:'x'.repeat(9*1024*1024)}});
send({type:'item.completed',item:{type:'agent_message',text:'ok'}});
send({type:'turn.completed',usage:{input_tokens:2,output_tokens:1}});
});`;
  for (const provider of ['claude', 'codex'])
    writeFileSync(join(bin, provider), script, { mode: 0o700 });

  const large = cli('large', 'large', [
    '--progress',
    '--max-retained-bytes',
    '1024',
    '--max-transcript-bytes',
    '2048',
  ]);
  assert.equal(large.status, 0, large.stderr || large.stdout);
  const largeRun = JSON.parse(large.stdout);
  assert.equal(largeRun.output, 'ok');
  assert.match(large.stderr, /agent\.started/);
  assert.match(large.stderr, /agent\.progress/);
  assert.match(large.stderr, /agent\.finished/);
  const largeAttempt = saved('large').steps['scope/../../answer'].attemptHistory[0];
  assert.equal(largeAttempt.policy.maxRetainedBytes, 1024);
  assert.equal(largeAttempt.diagnostics.skippedLines, 1);
  assert.ok(statSync(largeAttempt.transcript.path).size <= 2048);
  assert.equal(statSync(largeAttempt.transcript.path).mode & 0o777, 0o600);

  const limited = cli('limited', 'large', ['--max-stream-bytes', '1000', '--transcripts', 'off']);
  assert.equal(limited.status, 1, limited.stdout + limited.stderr);
  assert.match(JSON.stringify(JSON.parse(limited.stdout)), /maxStreamBytes/);
  const resumed = cli('limited', 'large', [
    '--resume',
    '--max-stream-bytes',
    String(20 * 1024 * 1024),
  ]);
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  const resumedRun = saved('limited');
  assert.equal(resumedRun.steps['scope/../../answer'].attemptHistory.length, 2);
  assert.equal(resumedRun.steps['scope/../../answer'].attemptHistory[1].policy.transcripts, 'off');
  assert.equal(resumedRun.steps['scope/../../answer'].attemptHistory[1].transcript, undefined);

  const denied = cli('denied', 'denied', [], 'claude');
  assert.equal(denied.status, 0, denied.stderr);
  assert.match(denied.stderr, /1 permission denials \(Read\)/);
  assert.equal(JSON.parse(denied.stdout).output, 'ok');

  const transcript = (...extra) =>
    spawnSync(
      process.execPath,
      [join(root, 'bin/run.js'), 'workflow', 'transcript', ...extra, '--state-dir', state],
      { cwd: directory, encoding: 'utf8', timeout: 30_000 },
    );
  const decoded = transcript('denied', 'scope/../../answer');
  assert.equal(decoded.status, 0, decoded.stderr);
  const nativeLines = decoded.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    nativeLines.map((line) => line.type),
    ['system', 'result'],
  );
  assert.equal(nativeLines[1].permission_denials[0].tool_name, 'Read');
  assert.doesNotMatch(decoded.stderr, /maxTranscriptBytes/);
  const cut = transcript('large', 'scope/../../answer', '--attempt', '1');
  assert.equal(cut.status, 0, cut.stderr);
  assert.match(cut.stdout, /^\{"type":"thread\.started"/);
  assert.match(cut.stderr, /cut at its maxTranscriptBytes cap/);
  const unknownStep = transcript('denied', 'answer', '--json');
  assert.equal(unknownStep.status, 2, unknownStep.stderr);
  const unknownStepError = JSON.parse(unknownStep.stdout).error;
  assert.equal(unknownStepError.code, 'usage.flag');
  assert.equal(unknownStepError.details.reason, 'unknown-step');
  assert.deepEqual(unknownStepError.details.agentSteps, ['scope/../../answer']);
  const unknownRun = transcript('missing-run', 'scope/../../answer');
  assert.equal(unknownRun.status, 3, unknownRun.stderr);
  assert.equal(unknownRun.stdout, '');
  assert.match(unknownRun.stderr, /missing-run/);

  // Rewritten transcripts of the settled `denied` attempt drive the output-channel cases.
  const entry = (text) =>
    `${JSON.stringify({ stream: 'stdout', base64: Buffer.from(text).toString('base64') })}\n`;
  const deniedPath = saved('denied').steps['scope/../../answer'].attemptHistory[0].transcript.path;
  // A reader that closes the pipe early (`| head`) is a success, even past the pipe buffer. A shell
  // pipeline gives the command a real pipe, as at a terminal.
  writeFileSync(deniedPath, entry(`${'x'.repeat(1023)}\n`).repeat(2048));
  const closedPipe = spawnSync(
    '/bin/sh',
    [
      '-c',
      '{ "$0" "$@"; echo "exit=$?" >&2; } | head -c 100',
      process.execPath,
      join(root, 'bin/run.js'),
      'workflow',
      'transcript',
      'denied',
      'scope/../../answer',
      '--state-dir',
      state,
    ],
    { cwd: directory, encoding: 'utf8', timeout: 30_000 },
  );
  assert.equal(closedPipe.status, 0, closedPipe.stderr);
  assert.match(closedPipe.stderr, /^exit=0$/m, closedPipe.stderr);
  assert.equal(closedPipe.stdout.length, 100);
  assert.doesNotMatch(closedPipe.stdout, /workflow\.error/);
  assert.doesNotMatch(closedPipe.stderr, /unsettled top-level await/);
  // Once transcript bytes are on stdout, a --json failure goes to stderr with its exit code.
  writeFileSync(deniedPath, `${entry('first\n')}not json\n`);
  const partial = transcript('denied', 'scope/../../answer', '--json');
  assert.equal(partial.status, 3, partial.stderr);
  assert.equal(partial.stdout, 'first\n');
  assert.match(partial.stderr, /Transcript line 2 .* is not valid JSON/);

  for (const provider of ['claude', 'codex']) {
    const id = `hang-${provider}`;
    let stdout = '',
      stderr = '';
    const child = spawn(process.execPath, [...argsFor(id, provider), '--progress'], {
      cwd: directory,
      env: environment('hang'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    runners.add(child);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => {
        runners.delete(child);
        resolve(code);
      });
    });
    await waitFor(() => stderr.includes('agent.progress'));
    assert.equal(stdout, '', 'JSON stdout must remain empty while the call is running.');
    const checkpoint = saved(id);
    const attempt = checkpoint.steps['scope/../../answer'].attemptHistory[0];
    assert.equal(attempt.status, 'running');
    assert.ok(attempt.sessionId);
    assert.ok(!relative(join(state, id), attempt.transcript.path).startsWith('..'));
    if (provider === 'claude')
      assert.equal(
        attempt.sessionId,
        deriveAgentSessionId(checkpoint.sessionSalt, 'scope/../../answer', attempt.attempt),
      );
    // A running attempt decodes what is written so far, with a warning that it may end early.
    const live = transcript(id, 'scope/../../answer');
    assert.equal(live.status, 0, live.stderr);
    assert.match(live.stdout, provider === 'claude' ? /"subtype":"init"/ : /"thread\.started"/);
    assert.match(
      live.stderr,
      /attempt 1 of scope\/\.\.\/\.\.\/answer is still running or was interrupted/,
    );
    child.kill('SIGINT');
    assert.equal(await done, 130, stderr);
    assert.equal(JSON.parse(stdout).error.code, 'workflow.interrupted');
    assert.equal(
      saved(id).steps['scope/../../answer'].attemptHistory[0].sessionId,
      attempt.sessionId,
    );
  }
  console.log(
    'PASS CLI live streaming, early checkpoint IDs, SIGINT evidence, capped private transcripts, transcript decoding (closed pipes, partial output, live attempts), sticky caps, and clean JSON stdout',
  );
} finally {
  for (const child of runners) child.kill('SIGINT');
  await waitFor(() => runners.size === 0);
  rmSync(directory, { recursive: true, force: true });
}
