import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'choir-worktree-cli-'));
const repo = join(root, 'repo');
const stateDir = join(root, 'state');
const workflow = join(root, 'worktree.mts');
const header = `import { defineWorkflow,z } from ${JSON.stringify(join(project, 'dist/index.js'))};\n`;
function git(...args) {
  const result = spawnSync(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args],
    { cwd: repo, encoding: 'utf8', timeout: 30000 },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function cli(status, ...args) {
  const result = spawnSync(
    process.execPath,
    [join(project, 'bin/run.js'), 'workflow', ...args, '--state-dir', stateDir],
    {
      cwd: repo,
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, XDG_STATE_HOME: join(root, 'xdg') },
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, status, result.stderr || result.stdout);
  return result;
}
function json(status, ...args) {
  return JSON.parse(cli(status, ...args, '--json').stdout);
}
try {
  mkdirSync(repo);
  git('init', '-q');
  writeFileSync(join(repo, 'file.txt'), 'base\n');
  git('add', '.');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', 'commit', '-qm', 'baseline');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(
    workflow,
    `${header}export default defineWorkflow({name:'worktree-cli',version:'1',input:z.object({}),output:z.string(),async run(ctx){
 const tree=await ctx.worktree('cache');
 await ctx.exec('edit',[${JSON.stringify(process.execPath)},'-e',"require('node:fs').writeFileSync('file.txt','captured')"],{worktree:tree});
 const merged=await ctx.merge('integrate',[tree]);
 await ctx.step('tail',{input:null,schema:z.null(),run:({attempt})=>{if(attempt===1)throw new Error('tail');return null;}});
 return merged.commit;
}});`,
  );
  const failed = json(1, 'execute', workflow, '--run-id', 'worktree');
  assert.equal(failed.run.steps.integrate.status, 'completed');
  assert.equal(failed.run.steps.edit.worktree.files[0].path, 'file.txt');
  const resumed = json(0, 'resume', 'worktree');
  assert.equal(git('show', `${resumed.output}:file.txt`), 'captured');
  assert.equal(git('rev-parse', 'HEAD'), base);
  assert.equal(readFileSync(join(repo, 'file.txt'), 'utf8'), 'base\n');
  assert.match(cli(0, 'inspect', 'worktree').stdout, /Worktree edit: base/u);
  const inspected = json(0, 'inspect', 'worktree', '--summary');
  assert.equal(
    inspected.steps.find((step) => step.id === 'edit').worktree.directoryState,
    'removed',
  );
  rmSync(workflow);
  const cleaned = json(0, 'clean', 'worktree', '--refs');
  assert(cleaned.refs.length > 0);
  assert.equal(cleaned.directories.length, 0);
  assert.equal(git('for-each-ref', '--format=%(refname)', 'refs/quiet-choir'), '');
  assert.deepEqual(json(0, 'clean', 'worktree', '--refs').refs, []);
  writeFileSync(
    workflow,
    `${header}export default defineWorkflow({name:'failed-cache',version:'1',input:z.object({}),output:z.null(),async run(ctx){const tree=await ctx.worktree('cache');await ctx.exec('fail',[${JSON.stringify(process.execPath)},'-e',"require('node:fs').writeFileSync('partial','unfinished');process.exit(1)"],{worktree:tree});return null;}});`,
  );
  const abandoned = json(1, 'execute', workflow, '--run-id', 'failed-cache');
  const cache = abandoned.run.steps.fail.worktree.path;
  assert.equal(existsSync(join(cache, 'partial')), true);
  rmSync(workflow);
  const removed = json(0, 'clean', 'failed-cache');
  assert.deepEqual(removed.directories, [cache]);
  assert.equal(removed.refs.length, 0);
  assert.equal(existsSync(cache), false);
  assert.equal(git('worktree', 'list', '--porcelain').match(/^worktree /gmu).length, 1);
  console.log(
    'Worktree isolation, integration, inspection, and source-free cleanup CLI checks passed.',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
