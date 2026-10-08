// Emitted commands must run exactly as printed: answerCommand, resumeCommand and next entries are
// executed with execFile from an unrelated directory, with no quiet-choir on PATH (#135).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatArgv } from '../dist/workflow/runtime/commands.js';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(repository, 'bin/run.js');
const api = join(repository, 'dist/index.js');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'quiet-choir-emitted-')));
const project = join(root, 'proj'),
  sub = join(project, 'sub'),
  elsewhere = join(root, 'elsewhere'),
  stateDir = join(root, 'state');
const env = {
  ...process.env,
  XDG_STATE_HOME: join(root, 'xdg'),
  QUIET_CHOIR_STATE_DIR: undefined,
  PATH: '/usr/bin:/bin',
};
const timeout = 60_000;

/** Launch the repository-local CLI the documented no-install way. */
function launch(cwd, args) {
  const result = spawnSync(process.execPath, [cli, 'workflow', ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout,
  });
  assert.equal(result.error, undefined);
  return result;
}

/** Run an emitted argument vector exactly as given, without a shell. */
function emitted(argv, cwd = elsewhere) {
  const result = spawnSync(argv[0], argv.slice(1), { cwd, env, encoding: 'utf8', timeout });
  assert.equal(result.error, undefined);
  return result;
}

function documentOf(result, status) {
  assert.equal(result.status, status, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

const approval = `import { defineWorkflow, z } from ${JSON.stringify(api)};
import { appendFileSync } from 'node:fs';
export default defineWorkflow({name:'emitted',version:'1',input:z.object({}),output:z.object({approved:z.boolean()}),async run(ctx){
  const answer = await ctx.approve('approve',{prompt:'Apply?',subject:{revision:'A'}});
  if (answer.approved) await ctx.step('apply',{input:null,schema:z.null(),run:()=>{appendFileSync(${JSON.stringify(join(root, 'applied'))},'apply\\n');return null;}});
  return {approved:answer.approved};
}});`;

try {
  for (const directory of [sub, elsewhere]) mkdirSync(directory, { recursive: true });
  const which = spawnSync('/bin/sh', ['-c', 'command -v quiet-choir'], { env, encoding: 'utf8' });
  assert.notEqual(which.status, 0, `quiet-choir must not be on PATH: ${which.stdout}`);
  const file = join(project, 'emitted.workflow.mts');
  writeFileSync(file, approval);

  // A suspension's answerCommand and resumeCommand start with node and this checkout's bin/run.js.
  const suspended = documentOf(
    launch(project, ['execute', file, '--run-id', 'gate', '--state-dir', stateDir, '--json']),
    75,
  );
  const [pending] = suspended.pending;
  assert.equal(pending.answerCommand[0], process.execPath);
  assert.equal(pending.answerCommand[1], realpathSync(cli));
  assert.deepEqual(suspended.resumeCommand.slice(0, 2), [process.execPath, realpathSync(cli)]);
  const answer = pending.answerCommand.map((word) =>
    word === '<ANSWER_JSON>' ? '{"approved":true}' : word,
  );
  assert.equal(documentOf(emitted(answer), 0).kind, 'workflow.answer.result');
  // Exactly as emitted: no --json, so the human completion line.
  const resumed = emitted(suspended.resumeCommand);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /^Run gate completed\./u);
  assert.equal(readFileSync(join(root, 'applied'), 'utf8'), 'apply\n');

  // From a subdirectory, run.not_found names the registered project root, and its next entry
  // inspects the run there.
  const registered = documentOf(
    launch(project, ['execute', file, '--run-id', 'nested', '--json']),
    75,
  );
  assert.ok(registered.stateDir.startsWith(join(root, 'xdg')), registered.stateDir);
  const missing = documentOf(launch(sub, ['inspect', 'nested', '--json']), 3);
  assert.equal(missing.error.code, 'run.not_found');
  assert.deepEqual(missing.error.details.candidates, [
    { stateDir: registered.stateDir, cwd: project },
  ]);
  assert.ok(missing.error.message.includes(`--state-dir ${registered.stateDir}`));
  assert.deepEqual(missing.next[0].argv.slice(-4), [
    'inspect',
    'nested',
    '--state-dir',
    registered.stateDir,
  ]);
  const inspected = documentOf(emitted([...missing.next[0].argv, '--json', '--summary']), 0);
  assert.equal(inspected.status, 'suspended');
  // The summary's own next entries answer the question, then resume.
  assert.deepEqual(
    inspected.next.map((entry) => entry.argv[3]),
    ['answer', 'resume'],
  );

  // A foreign-host lock refuses resume as run.locked (exit 3). Its details.next, mirrored at the
  // top level, is the unlock command behind this checkout's launcher with --force-remote, and it
  // clears the lock when run exactly as printed.
  const foreignHost = `${hostname()}-gone`;
  documentOf(
    launch(project, ['execute', file, '--run-id', 'locked', '--state-dir', stateDir, '--json']),
    75,
  );
  const plantLocks = () => {
    for (const lock of [join(stateDir, 'locked', 'lock'), join(stateDir, 'locked.json.lock')]) {
      mkdirSync(lock, { recursive: true });
      writeFileSync(
        join(lock, 'owner.json'),
        JSON.stringify({ pid: 2_000_000_000, host: foreignHost, token: 'far' }),
      );
    }
  };
  plantLocks();
  const locked = documentOf(
    launch(elsewhere, ['resume', 'locked', '--state-dir', stateDir, '--json']),
    3,
  );
  assert.equal(locked.error.code, 'run.locked');
  assert.equal(locked.error.details.next.length, 1);
  assert.deepEqual(locked.next, locked.error.details.next);
  const [unlock] = locked.next;
  assert.deepEqual(unlock.argv.slice(0, 2), [process.execPath, realpathSync(cli)]);
  assert.deepEqual(unlock.argv.slice(2), [
    'workflow',
    'unlock',
    'locked',
    '--state-dir',
    stateDir,
    '--force-remote',
  ]);
  assert.ok(
    locked.error.message.includes(
      formatArgv([process.execPath, realpathSync(cli), 'workflow', 'unlock']),
    ),
  );
  const unlocked = emitted(unlock.argv);
  assert.equal(unlocked.status, 0, unlocked.stderr);
  assert.match(unlocked.stdout, /locked/u);
  assert.equal(existsSync(join(stateDir, 'locked', 'lock')), false);
  assert.equal(existsSync(join(stateDir, 'locked.json.lock')), false);

  // Behind an installed quiet-choir on PATH (a symlink to this checkout's bin/run.js), the same
  // refusal names the bare program word.
  const installed = join(root, 'installed-bin');
  mkdirSync(installed);
  symlinkSync(cli, join(installed, 'quiet-choir'));
  plantLocks();
  // Node is started on the symlink itself, the way a shebang or an npm shim would.
  const viaPath = spawnSync(
    process.execPath,
    [
      join(installed, 'quiet-choir'),
      'workflow',
      'resume',
      'locked',
      '--state-dir',
      stateDir,
      '--json',
    ],
    {
      cwd: elsewhere,
      env: { ...env, PATH: `${installed}:${env.PATH}` },
      encoding: 'utf8',
      timeout,
    },
  );
  const installedLocked = documentOf(viaPath, 3);
  assert.equal(installedLocked.error.code, 'run.locked');
  assert.deepEqual(installedLocked.next, installedLocked.error.details.next);
  assert.deepEqual(installedLocked.next[0].argv, [
    'quiet-choir',
    'workflow',
    'unlock',
    'locked',
    '--state-dir',
    stateDir,
    '--force-remote',
  ]);
  assert.ok(
    installedLocked.error.message.includes('quiet-choir workflow unlock locked --state-dir'),
  );

  // The early usage.flag refusal also spells its example behind the launcher in use.
  const usage = spawnSync(process.execPath, [cli, 'workflow', '--json', 'inspect', 'x'], {
    cwd: elsewhere,
    env,
    encoding: 'utf8',
    timeout,
  });
  const usageDocument = documentOf(usage, 2);
  assert.equal(usageDocument.error.code, 'usage.flag');
  assert.ok(
    usageDocument.error.message.includes(
      formatArgv([process.execPath, realpathSync(cli), 'workflow', 'inspect', 'ID', '--json']),
    ),
    usageDocument.error.message,
  );

  // A grant failure's next entry carries --grant and the recorded fixture selection (#284); run as
  // emitted, it completes the run, reusing the recorded step.
  const grantFixture = join(project, 'grant.fixture.json');
  writeFileSync(
    grantFixture,
    JSON.stringify({ version: 1, calls: [{ step: 'edit', text: 'edited' }] }),
  );
  const grantFile = join(project, 'grant.workflow.mts');
  writeFileSync(
    grantFile,
    `import { defineWorkflow, z } from ${JSON.stringify(api)};
import { appendFileSync } from 'node:fs';
export default defineWorkflow({name:'grant',version:'1',input:z.object({}),output:z.string(),async run(ctx){
  await ctx.step('prepare',{input:null,schema:z.null(),run:()=>{appendFileSync(${JSON.stringify(join(root, 'prepared'))},'prepare\\n');return null;}});
  return (await ctx.claude.text('edit',{prompt:'x',profile:'edit'})).output;
}});`,
  );
  const denied = documentOf(
    launch(project, [
      'execute',
      grantFile,
      '--run-id',
      'grant',
      '--state-dir',
      stateDir,
      '--harness',
      `fixture:${grantFixture}`,
      '--json',
    ]),
    1,
  );
  assert.equal(denied.error.code, 'workflow.failed');
  assert.deepEqual(denied.next.length, 1);
  assert.deepEqual(denied.next[0].argv.slice(2), [
    'workflow',
    'execute',
    '--resume',
    '--run-id',
    'grant',
    '--state-dir',
    stateDir,
    '--grant',
    'edit',
    '--harness',
    `fixture:${grantFixture}`,
  ]);
  const granted = documentOf(emitted([...denied.next[0].argv, '--json']), 0);
  assert.equal(granted.status, 'completed');
  assert.equal(granted.output, 'edited');
  assert.equal(readFileSync(join(root, 'prepared'), 'utf8'), 'prepare\n');

  // A moved stored entrypoint is run.incompatible (exit 3), with a runnable fork entry.
  const moved = join(project, 'moved.workflow.mts');
  renameSync(file, moved);
  const refused = documentOf(
    launch(elsewhere, ['resume', 'gate', '--state-dir', stateDir, '--json']),
    3,
  );
  assert.equal(refused.error.code, 'run.incompatible');
  assert.equal(refused.error.details.reason, 'entrypoint_missing');
  const fork = refused.next[0].argv.map((word) =>
    word === '<ENTRYPOINT>' ? moved : word === '<NEW_RUN_ID>' ? 'gate-fork' : word,
  );
  // The fork is a new run from the new location; it asks its own question again.
  const forked = documentOf(emitted([...fork, '--json']), 75);
  assert.equal(forked.runId, 'gate-fork');
  assert.equal(existsSync(join(stateDir, 'gate-fork', 'run.json')), true);
} finally {
  rmSync(root, { recursive: true, force: true });
}
