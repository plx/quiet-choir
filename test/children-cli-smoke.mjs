import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRunSync } from '../dist/workflow/runtime/store.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = mkdtempSync(join(tmpdir(), 'choir-children-cli-'));
const definitions = join(directory, 'definitions');
const other = join(directory, 'other');
const state = join(directory, 'state');
const imported = join(directory, 'imports.txt');
const calls = join(directory, 'calls.txt');
const file = join(definitions, 'parent.workflow.ts');
const leaf = join(definitions, 'leaf.ts');
const cli = (args) =>
  spawnSync(process.execPath, [join(root, 'bin/run.js'), 'workflow', ...args], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, XDG_CACHE_HOME: join(directory, 'cache') },
  });
function ok(args) {
  const result = cli(args);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return JSON.parse(result.stdout);
}
function count(path) {
  return readFileSync(path, 'utf8').trim().split('\n').length;
}

try {
  mkdirSync(definitions);
  mkdirSync(other);
  mkdirSync(join(directory, 'node_modules'));
  symlinkSync(root, join(directory, 'node_modules/quiet-choir'));
  symlinkSync(join(root, 'node_modules/@types'), join(directory, 'node_modules/@types'));
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
  writeFileSync(
    leaf,
    `import {appendFileSync} from 'node:fs';
import {defineWorkflow,z} from 'quiet-choir';
export const leaf=defineWorkflow({name:'design-tournament',version:'1',input:z.object({topic:z.string()}),output:z.string(),
async run(ctx,input){ctx.phase('Design');return ctx.step('choose',{input:input.topic,schema:z.string(),run:()=>{appendFileSync(${JSON.stringify(calls)},'call\\n');return input.topic;}});}});`,
  );
  writeFileSync(
    file,
    `import {appendFileSync} from 'node:fs';
import {defineWorkflow,z} from 'quiet-choir';
import {leaf} from './leaf.js';
appendFileSync(${JSON.stringify(imported)},'import\\n');
const spec=defineWorkflow({name:'prd-to-spec',version:'1',input:z.object({topic:z.string()}),output:z.string(),children:[leaf],async run(ctx,input){return ctx.workflow('design','design-tournament',input) as Promise<string>;}});
export default defineWorkflow({name:'sdlc',version:'1',description:'Build from a topic',whenToUse:'Planning a feature',phases:[{title:'Plan',detail:'Prepare a spec'}],children:[spec],input:z.object({topic:z.string().describe('Required topic')}),output:z.string(),async run(ctx,input){return ctx.workflow('spec',spec,input);}});`,
  );
  const listing = ok(['list-defs', definitions, '--json']);
  assert.equal(listing.kind, 'workflow.list-defs.result');
  assert.equal(listing.definitions.length, 1);
  const metadata = listing.definitions[0].workflow;
  assert.deepEqual(metadata.inputSchema.required, ['topic']);
  assert.equal(metadata.children[0].children[0].name, 'design-tournament');
  assert.equal(metadata.description, 'Build from a topic');
  assert.equal(count(imported), 1);
  ok(['list-defs', definitions, '--json']);
  assert.equal(count(imported), 1, 'Matching source metadata must avoid a second import');
  ok(['list-defs', definitions, '--refresh', '--json']);
  assert.equal(count(imported), 2);
  const executed = ok([
    'execute',
    'sdlc',
    '--registry-dir',
    definitions,
    '--run-id',
    'tree',
    '--state-dir',
    state,
    '--input',
    '{"topic":"chosen"}',
    '--json',
  ]);
  assert.equal(executed.output, 'chosen');
  assert.equal(count(calls), 1);
  assert.equal(Object.keys(executed.children).length, 2);
  const inspected = ok(['inspect', 'tree', '--state-dir', state, '--json']);
  assert.equal(inspected.children['spec/design'].workflow.name, 'design-tournament');
  const text = cli(['inspect', 'tree', '--state-dir', state]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Workflow tree/u);
  assert.match(text.stdout, / {2}sdlc@1/u);
  assert.match(text.stdout, / {4}spec: prd-to-spec@1/u);
  assert.match(text.stdout, / {6}design: design-tournament@1/u);
  ok(['resume', 'tree', '--state-dir', state, '--json']);
  assert.equal(count(calls), 1);
  const missing = cli([
    'execute',
    'sdlc',
    '--registry-dir',
    definitions,
    '--run-id',
    'missing',
    '--state-dir',
    state,
    '--input',
    '{}',
    '--json',
  ]);
  assert.equal(missing.status, 2, missing.stderr);
  assert.throws(() => readRunSync({ stateDir: state, runId: 'missing' }), { code: 'ENOENT' });
  const shallow = cli([
    'execute',
    'sdlc',
    '--registry-dir',
    definitions,
    '--run-id',
    'shallow',
    '--state-dir',
    state,
    '--input',
    '{"topic":"deep"}',
    '--max-child-depth',
    '1',
    '--json',
  ]);
  assert.equal(shallow.status, 1, shallow.stderr);
  assert.match(shallow.stderr, /sdlc > prd-to-spec > design-tournament/u);
  ok(['resume', 'shallow', '--state-dir', state, '--max-child-depth', '2', '--json']);
  assert.equal(readRunSync({ stateDir: state, runId: 'shallow' }).maxChildDepth, 2);
  writeFileSync(leaf, readFileSync(leaf, 'utf8').replace("version:'1'", "version:'2'"));
  const refreshed = ok(['list-defs', definitions, '--json']);
  assert.notEqual(
    refreshed.definitions[0].workflow.fingerprint,
    metadata.fingerprint,
    'Transitive source changes invalidate cached metadata',
  );
  assert.equal(refreshed.definitions[0].workflow.children[0].children[0].version, '2');
  const changed = cli(['resume', 'tree', '--state-dir', state, '--accept-code-change', '--json']);
  assert.equal(changed.status, 3, changed.stderr);
  assert.equal(JSON.parse(changed.stdout).error.code, 'run.incompatible');
  assert.match(
    changed.stderr,
    /Child frame spec\/design changed: design-tournament@1 -> design-tournament@2/u,
  );
  writeFileSync(
    join(other, 'duplicate.workflow.ts'),
    `import {defineWorkflow,z} from 'quiet-choir';export default defineWorkflow({name:'sdlc',version:'1',input:z.null(),output:z.null(),run:async()=>null});`,
  );
  const duplicate = cli(['list-defs', definitions, other, '--json']);
  assert.equal(duplicate.status, 4, duplicate.stderr);
  assert.match(duplicate.stderr, /Duplicate workflow name sdlc/u);
  console.log(
    'PASS CLI child trees, schemas, required input, registry cache/dependency invalidation, named execute, depth resume, identity refusal and duplicate names',
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
