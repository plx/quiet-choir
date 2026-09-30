import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Failure documents must reach a piped consumer whole. Before the fix, the CLI exited before
// stdout drained, so a document larger than the pipe buffer (64 KiB on macOS) was cut off.
const project = fileURLToPath(new URL('..', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'choir-json-pipe-cli-'));
const stateDir = join(root, 'state');
const file = join(root, 'pipe.mts');
const minimum = 1024 * 1024;

/** Spawn the built CLI with stdout as a pipe and collect every byte until the pipe closes. */
const cli = (...args) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(project, 'bin/run.js'), ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 60_000);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({
        status,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
const workflow = (...args) => cli('workflow', ...args, '--state-dir', stateDir);

const describe = (label, result) => {
  const bytes = Buffer.byteLength(result.stdout);
  const tail = result.stdout.slice(-200);
  return `${label}: exit ${String(result.status)}, got ${String(bytes)} bytes on stdout, ending ${JSON.stringify(tail)}; stderr ${result.stderr.slice(-500)}`;
};

const parsed = (label, result) => {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    assert.fail(`${describe(label, result)}; JSON.parse: ${String(error)}`);
  }
};

const assertFailureDocument = (label, result) => {
  assert.equal(result.status, 1, describe(label, result));
  // Precondition: the document must exceed the pipe buffer by far, or the check proves nothing.
  assert.ok(Buffer.byteLength(result.stdout) >= minimum, describe(label, result));
  const document = parsed(label, result);
  assert.equal(document.kind, 'workflow.error', describe(label, result));
  assert.equal(document.exitCode, 1);
  assert.equal(document.exitCode, result.status);
  assert.equal(document.error.code, 'workflow.failed');
};

const source = `import { defineWorkflow, z } from ${JSON.stringify(join(project, 'dist/index.js'))};
export default defineWorkflow({name:'json-pipe',version:'1',input:z.object({}),output:z.null(),async run(ctx){
  await ctx.step('big',{input:null,schema:z.string(),run:()=>'x'.repeat(1_300_000)});
  await ctx.approve('gate',{prompt:'Fail next?',subject:null,audience:'human'});
  throw new Error('deliberate failure');
}});`;

try {
  writeFileSync(file, source);

  // (1) A suspension is a success path; its large document must parse as well.
  const executed = await workflow('execute', file, '--run-id', 'pipe', '--json');
  assert.equal(executed.status, 75, describe('execute', executed));
  assert.ok(Buffer.byteLength(executed.stdout) >= minimum, describe('execute', executed));
  const suspended = parsed('execute', executed);
  assert.equal(suspended.kind, 'workflow.run.suspended');
  assert.equal(suspended.pending[0].stepId, 'gate');

  // (2) answer --resume delivers the approval and fails the run.
  const answered = await workflow(
    'answer',
    'pipe',
    'gate',
    '--json',
    '{"approved":true}',
    '--by',
    'human:Pat',
    '--resume',
  );
  assertFailureDocument('answer --resume --json', answered);

  // (3) resume of the failed run reports the same failure.
  assertFailureDocument('resume --json', await workflow('resume', 'pipe', '--json'));

  // (4) execute --resume of the failed run reports it too.
  assertFailureDocument(
    'execute --resume --json',
    await workflow('execute', file, '--resume', '--run-id', 'pipe', '--json'),
  );

  // (5) configuration doctor exits 1 on a failing check and its document survives the pipe.
  const doctor = await cli(
    'configuration',
    'doctor',
    '--json',
    '--harness',
    'claude',
    '--claude-binary',
    join(root, 'missing-claude'),
  );
  assert.equal(doctor.status, 1, describe('configuration doctor --json', doctor));
  assert.equal(parsed('configuration doctor --json', doctor).ok, false);
} finally {
  rmSync(root, { recursive: true, force: true });
}
