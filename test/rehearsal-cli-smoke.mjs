import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), 'choir-rehearsal-cli-'));
const file = join(root, 'workflow.ts');
const state = join(root, 'state');
const marker = join(root, 'local-ran');
const forbidden = join(root, 'agent-spawned');
const bomb = join(root, 'must-not-run');
const routes = join(root, 'routes.json');
const calls = join(root, 'calls.jsonl');
const cliConfig = {
  claudeBinary: join(project, 'test/bin/fake-claude.mjs'),
  codexBinary: join(project, 'test/bin/fake-codex.mjs'),
  maxOutputBytes: 33554432,
};
function run(args, store = state, json = true) {
  const result = spawnSync(
    process.execPath,
    [
      join(project, 'bin/run.js'),
      'workflow',
      ...args,
      ...(store === null ? [] : ['--state-dir', store]),
      ...(json ? ['--json'] : []),
    ],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        XDG_STATE_HOME: join(root, 'xdg'),
        QUIET_CHOIR_FAKE_ROUTES: routes,
        QUIET_CHOIR_FAKE_LOG: calls,
      },
    },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stderr);
  if (json) assert.equal(result.stdout.trim().split('\n').length, 1, result.stdout);
  return { ...result, value: json ? JSON.parse(result.stdout) : null };
}
const execute = (id, mode) => [
  'execute',
  file,
  '--run-id',
  id,
  '--input',
  JSON.stringify({ mode }),
];
try {
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  symlinkSync(join(project, 'node_modules'), join(root, 'node_modules'));
  writeFileSync(
    bomb,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(forbidden)},'bad'); process.exit(99);`,
  );
  chmodSync(bomb, 0o700);
  writeFileSync(
    file,
    `import { writeFileSync } from 'node:fs';
import { defineWorkflow,z } from ${JSON.stringify(join(project, 'dist/index.js'))};
export default defineWorkflow({name:'rehearsal-cli',version:'1',input:z.object({mode:z.string()}),output:z.string(),async run(ctx,input){
  if (input.mode === 'text' || input.mode === 'partial') {
    const a = await ctx.claude.text('one',{prompt:'first'});
    const b = await ctx.codex.text('two',{prompt:'second'});
    return a.output+' / '+b.output;
  }
  if (input.mode !== 'mixed') {
    for (const id of ['s/a','two','three','four','five']) await ctx.claude.text(id,{prompt:'first'});
    if(input.mode==='date') await ctx.claude.object('late',{prompt:'late',schema:z.object({date:z.date()})});
    if(input.mode==='transform') await ctx.codex.object('late',{prompt:'late',schema:z.string().transform(value=>value.length)});
    if(input.mode==='id') await ctx.claude.text('bad id',{prompt:'late'});
    if(input.mode==='duplicate') await ctx.claude.text('s/a',{prompt:'first'});
    if(input.mode==='lossless') await ctx.step('late',{input:{missing:[undefined]} as unknown as null,schema:z.null(),run:()=>null});
    if(input.mode==='class') await ctx.step('late',{input:new Date() as unknown as null,schema:z.null(),run:()=>null});
    return 'unreachable';
  }
  await ctx.step('read',{input:null,schema:z.string(),run:()=>{writeFileSync(${JSON.stringify(marker)},'read');return 'files';}});
  const items=(await ctx.claude.object('triage',{prompt:'Find items',schema:z.object({items:z.array(z.string())})})).output.items;
  const answers=await ctx.map('review',items,{concurrency:2},async item=>(await ctx.codex.text('ask',{prompt:item,skipGitRepoCheck:true})).output);
  await ctx.sleep('pause',3600000);
  const published=await ctx.step('publish/report',{input:null,schema:z.string(),run:()=>{throw new Error('must be stubbed');}});
  return JSON.stringify({items,answers,published});
}});`,
  );
  const dry = run(
    [
      ...execute('mixed', 'mixed'),
      '--dry-run',
      '--stub-steps',
      'publish/**',
      '--harness-config',
      JSON.stringify({ claudeBinary: bomb, codexBinary: bomb }),
    ],
    null,
  );
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(dry.value.kind, 'workflow.rehearsal');
  assert.deepEqual(dry.value.harnessCounts, { claude: 1, codex: 1 });
  assert.equal(dry.value.nominalClaudeCeilingUsd, 0.5);
  assert.deepEqual(dry.value.skippedSleeps, ['pause']);
  assert.equal(dry.value.run.harness.kind, 'dry-run');
  assert(existsSync(marker), 'ordinary local callback did not run');
  assert(!existsSync(forbidden), 'dry-run spawned the configured CLI, including its version probe');
  assert(!existsSync(join(root, '.quiet-choir')), 'dry-run wrote default state');
  assert(!existsSync(join(root, 'xdg')), 'dry-run wrote external default state');
  assert.equal(dry.value.calls[1].prompt, 'dry-run:triage/items/0');
  assert(dry.value.calls[0].plan.argv.includes('--json-schema'));
  assert.match(dry.stderr, /Local callbacks.*run for real/u);
  for (const [mode, id, pattern] of [
    ['date', 'late', /Date cannot/u],
    ['transform', 'late', /Transforms cannot/u],
    ['id', 'bad id', /Invalid step ID/u],
    ['duplicate', 's/a', /Duplicate step ID/u],
    ['lossless', 'late', /undefined array element/u],
    ['class', 'late', /plain JSON objects/u],
  ]) {
    const failed = run([...execute(`late-${mode}`, mode), '--dry-run'], null);
    assert.equal(failed.status, 1, failed.stderr);
    assert.equal(failed.value.error.code, 'workflow.failed');
    assert.equal(failed.value.error.stepId, id);
    assert.match(failed.value.error.message, pattern);
    assert.match(failed.value.error.stack, /\n\s+at /u);
    assert.match(failed.value.run.errorStack, /\n\s+at /u);
    assert.equal(failed.value.rehearsal.calls.length, 5);
    assert(!existsSync(failed.value.stateDir), 'failed rehearsal did not remove temporary state');
  }
  assert(!existsSync(join(root, '.quiet-choir')));
  const fixturePath = join(root, 'fixtures.json');
  writeFileSync(
    fixturePath,
    JSON.stringify({
      version: 1,
      calls: [
        { step: 'one', text: 'first answer' },
        { step: 'two', output: 'second answer' },
      ],
    }),
  );
  const fixture = run([
    ...execute('fixture', 'text'),
    '--full',
    '--harness',
    `fixture:${fixturePath}`,
  ]);
  assert.equal(fixture.status, 0, fixture.stderr);
  assert.equal(fixture.value.output, 'first answer / second answer');
  assert.equal(fixture.value.harness.kind, 'fixture');
  const bytes = readFileSync(join(state, 'fixture', 'run.json'), 'utf8');
  const exported = run(['fixtures', 'fixture']);
  assert.equal(exported.status, 0, exported.stderr);
  assert.deepEqual(
    exported.value.calls.map((call) => call.step),
    ['one', 'two'],
  );
  assert.equal(readFileSync(join(state, 'fixture', 'run.json'), 'utf8'), bytes);
  writeFileSync(join(root, 'export.json'), JSON.stringify(exported.value));
  assert.equal(
    run([...execute('export', 'text'), '--harness', 'fixture:export.json']).value.output,
    fixture.value.output,
  );
  const refused = run(['execute', file, '--run-id', 'fixture', '--resume']);
  assert.equal(refused.status, 3);
  assert.match(refused.value.error.message, /--allow-harness-change/u);
  assert.equal(
    run(['execute', file, '--run-id', 'fixture', '--resume', '--allow-harness-change']).status,
    0,
  );
  const completePreview = run(['execute', file, '--run-id', 'fixture', '--resume', '--dry-run']);
  assert.equal(completePreview.status, 0, completePreview.stderr);
  assert.equal(completePreview.value.calls.length, 0);
  assert.equal(completePreview.value.replays.length, 2);
  assert.equal(completePreview.value.nominalClaudeCeilingUsd, 0);
  assert.equal(readFileSync(join(state, 'fixture', 'run.json'), 'utf8'), bytes);

  writeFileSync(
    routes,
    JSON.stringify({ version: 1, calls: [{ step: 'two', scenario: 'codex-invalid-schema' }] }),
  );
  writeFileSync(join(root, 'harness.json'), JSON.stringify(cliConfig));
  const partial = run([
    ...execute('partial', 'partial'),
    '--full',
    '--harness-config',
    '@harness.json',
  ]);
  assert.equal(partial.status, 1, partial.stderr);
  assert.equal(partial.value.error.stepId, 'two');
  assert.equal(partial.value.run.harness.kind, 'cli');
  assert.match(partial.value.error.message, /invalid_json_schema|Invalid schema/u);
  const partialBytes = readFileSync(join(state, 'partial', 'run.json'), 'utf8');
  const lock = join(state, 'partial', 'lock');
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner.json'), 'source lock must not be inspected or removed');
  const count = readFileSync(calls, 'utf8').trim().split('\n').length;
  const preview = run([
    'execute',
    file,
    '--run-id',
    'partial',
    '--resume',
    '--dry-run',
    '--harness-config',
    JSON.stringify({ claudeBinary: bomb, codexBinary: bomb }),
  ]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.deepEqual(preview.value.replays, [{ stepId: 'one', kind: 'agent' }]);
  assert.deepEqual(preview.value.harnessCounts, { codex: 1 });
  assert.deepEqual(preview.value.providerCounts, { claude: 0, codex: 1 });
  assert.equal(preview.value.calls[0].attempt, 2);
  assert.match(preview.value.run.output, /hello from captured claude \/ \[dry-run codex two\]/u);
  assert.equal(readFileSync(join(state, 'partial', 'run.json'), 'utf8'), partialBytes);
  assert.equal(
    readFileSync(join(lock, 'owner.json'), 'utf8'),
    'source lock must not be inspected or removed',
  );
  assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, count);
  assert(!existsSync(forbidden));
  assert.equal(run(['fixtures', 'partial']).status, 3);
  const missing = run(['execute', file, '--run-id', 'missing', '--resume', '--dry-run']);
  assert.equal(missing.status, 3, missing.stderr);

  const malformed = run([...execute('malformed', 'text'), '--harness-config', '{"unknown":true}']);
  assert.equal(malformed.status, 2);
  assert(!existsSync(join(state, 'malformed', 'run.json')));
  const noMatch = join(root, 'no-match.json');
  writeFileSync(noMatch, '{"version":1,"calls":[]}');
  const unmatched = run([...execute('unmatched', 'text'), '--harness', `fixture:${noMatch}`]);
  assert.equal(unmatched.status, 1);
  assert.equal(unmatched.value.error.stepId, 'one');
  assert.match(unmatched.value.error.message, /No fixture matches step one/u);
  const overridden = run([
    ...execute('overridden', 'text'),
    '--dry-run',
    '--harness',
    'fixture:export.json',
  ]);
  assert.equal(overridden.status, 0, overridden.stderr);
  assert.equal(overridden.value.run.output, 'first answer / second answer');
  assert(overridden.value.calls.every((call) => call.outputSource === 'fixture'));
  assert(!existsSync(join(state, 'overridden', 'run.json')));
  writeFileSync(
    file,
    readFileSync(file, 'utf8') + '\n// explicit source change for preview compatibility\n',
  );
  const incompatible = run(['execute', file, '--run-id', 'partial', '--resume', '--dry-run']);
  assert.equal(incompatible.status, 3, incompatible.stderr);
  assert.equal(incompatible.value.error.code, 'run.incompatible');
  const accepted = run([
    'execute',
    file,
    '--run-id',
    'partial',
    '--resume',
    '--dry-run',
    '--accept-code-change',
  ]);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.value.calls.length, 1);
  assert.equal(readFileSync(join(state, 'partial', 'run.json'), 'utf8'), partialBytes);
  console.log(
    'Rehearsal CLI: dry-run, fixtures/config/export, named late failures, process-free preview, and harness guards passed.',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
