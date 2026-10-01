import { readRunSync } from '../dist/workflow/runtime/store.js';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), 'choir-json-cli-'));
const state = join(root, 'state');
const file = join(root, 'workflow.ts');
const marker = join(root, 'imported');
const bin = join(project, 'bin/run.js');
const children = new Set();
function run(args, input) {
  const result = spawnSync(process.execPath, [bin, 'workflow', ...args, '--json'], {
    cwd: project,
    encoding: 'utf8',
    input,
    timeout: 30_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.stdout.trim().split('\n').length, 1, result.stdout);
  return { ...result, document: JSON.parse(result.stdout) };
}
function failure(args, code, exit, input) {
  const result = run(args, input);
  assert.equal(result.status, exit, result.stderr);
  assert.equal(result.document.exitCode, exit);
  assert.equal(result.document.error.code, code, result.stdout);
  assert.equal(result.document.kind, 'workflow.error');
  assert.equal(result.document.ok, false);
  return result;
}
const execute = (...args) => ['execute', file, '--state-dir', state, ...args];
const saved = (id) => readRunSync({ stateDir: state, runId: id });
async function until(action, explanation) {
  for (let attempt = 0; attempt < 1500; attempt++) {
    if (action()) return;
    await delay(20);
  }
  throw new Error(explanation);
}
try {
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  symlinkSync(join(project, 'node_modules'), join(root, 'node_modules'));
  writeFileSync(
    file,
    `
import { appendFileSync, rmSync } from 'node:fs';
import { defineWorkflow, z } from ${JSON.stringify(join(project, 'dist/index.js'))};
appendFileSync(${JSON.stringify(marker)}, 'imported\\n');
console.log('import stdout'); process.stdout.write('import write\\n');
export default defineWorkflow({ name:'json', version:'1',
  input:z.object({ value:z.number().default(7), mode:z.enum(['pass','fail','sleep','stuck','storage']).default('pass') }),
  output:z.number(),
  async run(ctx, input) {
    console.log('body stdout');
    if (input.mode === 'sleep') await ctx.sleep('wait', 60_000);
    if (input.mode === 'stuck') await ctx.step('wait', { input:null, schema:z.null(), run:()=>{ process.stderr.write('stuck started\\n'); return new Promise<null>(()=>{ setInterval(()=>{},1000); }); } });
    return ctx.step('result', { input:input.value, schema:z.number(), run:()=>{
      if (input.mode === 'fail') throw new Error('original failure');
      if (input.mode === 'storage') rmSync(${JSON.stringify(state)}, { recursive:true });
      return input.value;
    }});
  }
});`,
  );

  // Invalid IDs and parsing errors must never execute a module's top-level code.
  for (const command of ['validate', 'execute', 'inspect', 'typecheck', 'check-resume']) {
    failure([command, '--unknown'], 'usage.flag', 2);
    failure([command], 'usage.flag', 2);
  }
  failure(['misspelled'], 'usage.flag', 2);
  failure(execute('--run-id', '../unsafe'), 'usage.run_id', 2);
  failure(execute('--fork-from', '../unsafe'), 'usage.run_id', 2);
  failure(['check-resume', file, '--run-id', 'bad id'], 'usage.run_id', 2);
  failure(['inspect', 'bad id'], 'usage.run_id', 2);
  failure(execute('--resume'), 'usage.resume_requires_run_id', 2);
  failure(['execute', join(root, 'missing.ts')], 'usage.file_not_found', 2);
  failure(['--json', 'inspect', 'missing'], 'usage.flag', 2);
  failure(execute('--input', '@' + join(root, 'missing.json')), 'usage.input_file', 2);
  const malformed = join(root, 'bad.json');
  writeFileSync(malformed, '{"value":');
  const badJson = failure(execute('--input', '@' + malformed), 'usage.input_json', 2).document;
  assert.equal(badJson.error.details.source, malformed);
  assert.equal(badJson.error.details.position, 9);
  assert.equal(existsSync(marker), false, 'No early failure may import the module');

  for (const command of ['validate', 'typecheck']) {
    const result = run([command, file, '--log-level', 'debug']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.document.kind,
      command === 'validate' ? 'workflow.validate.result' : 'workflow.typecheck.result',
    );
  }
  const inputFile = join(root, 'input.json');
  writeFileSync(inputFile, '{"value":13}');
  const completed = run(
    execute('--run-id', 'file', '--input', '@' + inputFile, '--log-level', 'debug'),
  );
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(completed.document.output, 13);
  assert.match(completed.stderr, /import stdout/);
  assert.match(completed.stderr, /import write/);
  assert.match(completed.stderr, /body stdout/);
  assert.match(completed.stderr, /\[debug\]/);
  const stdin = run(execute('--run-id', 'stdin', '--input', '-'), '{"value":19}');
  assert.equal(stdin.status, 0, stdin.stderr);
  assert.equal(stdin.document.output, 19);

  const failed = failure(
    [...execute('--input', '{"mode":"fail"}'), '--full'],
    'workflow.failed',
    1,
  ).document;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.stepId, 'result');
  assert.equal(failed.runId, failed.run.id);
  assert.deepEqual(failed.run, saved(failed.runId));
  assert.deepEqual(failed.failedSteps, [
    { id: 'result', kind: 'step', attempts: 1, error: 'original failure' },
  ]);
  const demo = failure(
    [
      'execute',
      join(project, 'examples/local.workflow.ts'),
      '--state-dir',
      state,
      '--input',
      '{"failOnce":true}',
    ],
    'workflow.failed',
    1,
  ).document;
  assert.equal(demo.error.stepId, 'summarize');
  assert.equal(demo.status, 'failed');
  assert.ok(demo.runId);
  assert.equal(run(['inspect', failed.runId, '--state-dir', state]).status, 0);
  failure(
    execute('--run-id', 'bad-input', '--input', '{"value":"wrong"}'),
    'usage.input_schema',
    2,
  );
  assert.equal(existsSync(join(state, 'bad-input', 'run.json')), false);
  failure(
    execute('--resume', '--run-id', 'file', '--input', '{"value":"wrong"}'),
    'usage.input_schema',
    2,
  );
  failure(execute('--run-id', 'file'), 'run.exists', 3);
  failure(execute('--resume', '--run-id', 'unknown'), 'run.not_found', 3);
  failure(
    execute('--resume', '--run-id', 'file', '--input', '{"value":99}'),
    'run.input_changed',
    3,
  );
  const before = readFileSync(join(state, 'file', 'run.json'), 'utf8');
  writeFileSync(file, readFileSync(file, 'utf8').replace("version:'1'", "version:'2'"));
  const incompatible = failure(
    execute('--resume', '--run-id', 'file'),
    'run.incompatible',
    3,
  ).document;
  assert.ok(incompatible.error.details.changed.includes('version'));
  assert.equal(readFileSync(join(state, 'file', 'run.json'), 'utf8'), before);
  const lock = join(state, 'locked', 'lock');
  mkdirSync(lock, { recursive: true });
  writeFileSync(
    join(lock, 'owner.json'),
    JSON.stringify({ pid: process.pid, host: hostname(), token: 'fixture' }),
  );
  const locked = failure(execute('--run-id', 'locked'), 'run.locked', 3).document;
  assert.equal(locked.error.details.pid, process.pid);
  assert.equal(locked.error.details.host, hostname());
  writeFileSync(join(state, 'corrupt.json'), '{broken');
  failure(['inspect', 'corrupt', '--state-dir', state], 'run.unreadable', 3);
  for (let index = 0; index < 25; index++)
    writeFileSync(join(state, `available-${index}.json`), '{}');
  const missing = failure(['inspect', 'absent', '--state-dir', state], 'run.not_found', 3).document;
  assert.equal(missing.stateDir, resolve(state));
  assert.equal(missing.error.details.available.length, 20);
  assert.equal(missing.error.details.count, 30);
  assert.equal(missing.status, null);

  const brokenResume = join(root, 'broken-resume.ts');
  writeFileSync(brokenResume, 'const wrong: number = "wrong"; export default {};');
  const differentFile = failure(
    ['execute', brokenResume, '--resume', '--run-id', 'file', '--state-dir', state],
    'run.incompatible',
    3,
  ).document;
  assert.ok(differentFile.error.message.includes('broken-resume.ts'));
  assert.ok(differentFile.error.message.includes('workflow.ts'));
  const originalSource = readFileSync(file, 'utf8');
  writeFileSync(file, readFileSync(brokenResume, 'utf8'));
  const loadFailure = failure(
    ['execute', file, '--resume', '--run-id', 'file', '--state-dir', state, '--full'],
    'load.typecheck',
    4,
  ).document;
  writeFileSync(file, originalSource);
  assert.equal(loadFailure.status, 'completed');
  assert.deepEqual(loadFailure.run, JSON.parse(before));
  for (const [name, source, code] of [
    ['type', 'const wrong: number = "wrong"; export default {};', 'load.typecheck'],
    [
      'import',
      'console.log("throwing import"); throw new Error("import failed"); export default {};',
      'load.import',
    ],
    ['definition', 'export default {};', 'load.definition'],
  ]) {
    const bad = join(root, `${name}.ts`);
    writeFileSync(bad, source);
    const result = failure(['validate', bad], code, 4);
    if (name === 'type') assert.ok(result.document.diagnostics.length);
  }
  // Both cooperative and forced interrupts produce one document with actual saved state.
  for (const [mode, signal] of [
    ['sleep', 'SIGINT'],
    ['sleep', 'SIGTERM'],
    ['sleep', 'SIGHUP'],
    ['stuck', 'SIGINT'],
  ]) {
    const id = mode + '-' + signal;
    const child = spawn(
      process.execPath,
      [
        bin,
        'workflow',
        ...execute('--run-id', id, '--input', JSON.stringify({ mode })),
        '--wait-mode',
        'block',
        '--json',
        '--full',
      ],
      { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    children.add(child);
    let stdout = '',
      stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    const closed = once(child, 'close');
    // A signal between the attempt save and the callback start cancels before the stuck callback.
    await until(
      () =>
        existsSync(join(state, id, 'run.json')) &&
        saved(id).steps.wait?.status === (mode === 'stuck' ? 'running' : 'waiting') &&
        (mode !== 'stuck' || stderr.includes('stuck started')),
      `No active wait: ${stderr}`,
    );
    child.kill(signal);
    if (mode === 'stuck') {
      await until(() => stderr.includes('Send again to force'), 'First signal did not drain');
      child.kill('SIGHUP');
    }
    const [code] = await closed;
    children.delete(child);
    assert.equal(code, 130, stderr);
    assert.equal(stdout.trim().split('\n').length, 1, stdout);
    const document = JSON.parse(stdout);
    assert.equal(document.error.code, 'workflow.interrupted');
    // A drained first signal saves a resumable suspension; a forced exit leaves 'running'.
    assert.equal(document.status, mode === 'stuck' ? 'running' : 'suspended');
    if (mode !== 'stuck') assert.match(document.run.interruptedBy.reason, /^Workflow interrupted/);
    assert.deepEqual(document.run, saved(id));
    if (mode === 'stuck') assert.equal(document.error.details.forced, true);
  }
  const storage = failure(
    execute('--run-id', 'storage', '--input', '{"mode":"storage"}'),
    'workflow.storage',
    74,
  ).document;
  assert.equal(storage.status, null);
  assert.strictEqual(
    storage.summary,
    null,
    'Do not invent a failed checkpoint after its directory was removed',
  );
  console.log('Scriptable CLI contract verified.');
} finally {
  for (const child of children) child.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
}
