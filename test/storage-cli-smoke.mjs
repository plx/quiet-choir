import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(repository, 'bin/run.js');
const root = mkdtempSync(join(tmpdir(), 'quiet-choir-storage-cli-'));
const project = join(root, 'project'),
  other = join(root, 'other'),
  xdg = join(root, 'xdg');
const api = join(repository, 'dist/index.js');
const env = { ...process.env, XDG_STATE_HOME: xdg, QUIET_CHOIR_STATE_DIR: undefined };
const workflow = `import { defineWorkflow, z } from ${JSON.stringify(api)};
export default defineWorkflow({name:'storage',version:'1',input:z.object({}),output:z.number(),run:ctx=>ctx.step('value',{input:null,schema:z.number(),run:()=>7})});`;
function command(cwd, args, overrides = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    env: { ...env, ...overrides },
    encoding: 'utf8',
  });
  assert.equal(result.error, undefined);
  return result;
}
function success(cwd, args, overrides) {
  const result = command(cwd, [...args, '--json'], overrides);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return { document: JSON.parse(result.stdout), ...result };
}
function git(...args) {
  const result = spawnSync(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Storage test',
      '-c',
      'user.email=storage@example.invalid',
      ...args,
    ],
    { cwd: project, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
try {
  for (const cwd of [project, other]) {
    mkdirSync(cwd);
    writeFileSync(join(cwd, 'package.json'), '{"type":"module"}');
    writeFileSync(join(cwd, 'workflow.ts'), workflow);
  }
  git('init');
  git('add', 'package.json', 'workflow.ts');
  git('commit', '-m', 'fixture');
  const first = success(project, ['workflow', 'execute', 'workflow.ts', '--run-id', 'default']);
  const state = first.document.stateDir;
  assert.ok(state.startsWith(xdg + '/quiet-choir/'));
  assert.equal(state.startsWith(realpathSync(project) + '/'), false);
  assert.ok(first.stderr.includes(`State directory: ${state}`));
  assert.equal(git('status', '--porcelain'), '');
  const header = JSON.parse(readFileSync(join(state, 'default', 'run.json'), 'utf8'));
  assert.equal(header.formatVersion, 7);
  assert.equal(header.engine.node, process.version);
  assert.equal(header.engine.quietChoir, '0.0.0');
  assert.equal(header.launch.entrypoint, realpathSync(join(project, 'workflow.ts')));
  assert.equal(header.launch.tsconfig, null);
  assert.equal(
    JSON.parse(readFileSync(join(dirname(state), 'project.json'), 'utf8')).cwd,
    realpathSync(project),
  );
  assert.equal(
    success(project, ['workflow', 'execute', '--resume', '--run-id', 'default']).document.output,
    7,
  );
  assert.equal(
    success(other, [
      'workflow',
      'execute',
      '--resume',
      '--run-id',
      'default',
      '--state-dir',
      state,
      '--full',
    ]).document.cwd,
    realpathSync(project),
  );

  const imported = join(root, 'wrong-imported');
  writeFileSync(
    join(project, 'wrong.ts'),
    `import { writeFileSync } from 'node:fs';writeFileSync(${JSON.stringify(imported)},'bad');\n${workflow}`,
  );
  const wrong = command(project, [
    'workflow',
    'execute',
    'wrong.ts',
    '--resume',
    '--run-id',
    'default',
    '--json',
  ]);
  assert.equal(wrong.status, 3, wrong.stderr);
  assert.equal(JSON.parse(wrong.stdout).error.code, 'run.incompatible');
  assert.ok(wrong.stdout.includes('workflow.ts') && wrong.stdout.includes('wrong.ts'));
  assert.equal(existsSync(imported), false);
  rmSync(join(project, 'wrong.ts'));

  const overridden = join(root, 'env-state');
  assert.equal(
    success(project, ['workflow', 'execute', 'workflow.ts', '--run-id', 'env'], {
      QUIET_CHOIR_STATE_DIR: overridden,
    }).document.stateDir,
    overridden,
  );
  const explicit = join(root, 'explicit-state');
  assert.equal(
    success(
      project,
      ['workflow', 'execute', 'workflow.ts', '--run-id', 'explicit', '--state-dir', explicit],
      { QUIET_CHOIR_STATE_DIR: overridden },
    ).document.stateDir,
    explicit,
  );
  const second = success(other, ['workflow', 'execute', 'workflow.ts', '--run-id', 'other']);
  const all = success(project, ['workflow', 'list', '--all']).document;
  assert.ok(all.runs.some((run) => run.id === 'default' && run.stateDir === state));
  assert.ok(
    all.runs.some((run) => run.id === 'other' && run.stateDir === second.document.stateDir),
  );

  const legacy = join(project, '.quiet-choir', 'runs');
  mkdirSync(legacy, { recursive: true });
  const old = { ...header, id: 'legacy', formatVersion: 6 };
  delete old.seq;
  delete old.engine;
  const bytes = JSON.stringify(old);
  writeFileSync(join(legacy, 'legacy.json'), bytes);
  const resumed = success(project, ['workflow', 'execute', '--resume', '--run-id', 'legacy']);
  assert.equal(resumed.document.stateDir, realpathSync(legacy));
  assert.match(resumed.stderr, /legacy state directory/);
  assert.equal(readFileSync(join(legacy, 'legacy.json.v6'), 'utf8'), bytes);
  assert.equal(JSON.parse(readFileSync(join(legacy, 'legacy.json'), 'utf8')).formatVersion, 7);

  const inTree = join(project, '.state');
  success(project, [
    'workflow',
    'execute',
    'workflow.ts',
    '--run-id',
    'protected',
    '--state-dir',
    inTree,
  ]);
  assert.equal(readFileSync(join(inTree, '.gitignore'), 'utf8'), '*\n');
  assert.equal(git('status', '--porcelain'), '');
  git('add', '-A');
  assert.equal(git('diff', '--cached', '--name-only'), '');
  writeFileSync(join(project, 'untracked.txt'), 'clean me');
  git('clean', '-fd');
  assert.equal(existsSync(join(project, 'untracked.txt')), false);
  assert.equal(existsSync(join(inTree, 'protected', 'run.json')), true);
  writeFileSync(join(project, 'untracked.txt'), 'stash me');
  git('stash', 'push', '-u', '-m', 'storage hygiene');
  assert.equal(existsSync(join(project, 'untracked.txt')), false);
  assert.equal(existsSync(join(inTree, 'protected', 'run.json')), true);
  assert.equal(existsSync(join(legacy, 'legacy', 'run.json')), true);

  const vanished = join(root, 'vanished');
  const deleting = `import { rm } from 'node:fs/promises';import { defineWorkflow,z } from ${JSON.stringify(api)};
export default defineWorkflow({name:'vanish',version:'1',input:z.object({}),output:z.null(),run:ctx=>ctx.step('remove',{input:null,schema:z.null(),run:async()=>{await rm(${JSON.stringify(vanished)},{recursive:true});return null;}})});`;
  writeFileSync(join(project, 'delete.ts'), deleting);
  const removed = command(project, [
    'workflow',
    'execute',
    'delete.ts',
    '--run-id',
    'gone',
    '--state-dir',
    vanished,
    '--json',
  ]);
  assert.equal(removed.status, 74, removed.stderr || removed.stdout);
  assert.ok(
    JSON.parse(removed.stdout).error.message.includes(`State directory ${vanished} was removed`),
  );
  console.log(
    'Storage CLI: XDG/defaults, header, stored resume, path guard, discovery, migration, Git hygiene, and removed-directory diagnostics passed.',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
