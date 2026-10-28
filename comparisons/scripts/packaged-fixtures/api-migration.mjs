// api-migration: a.mjs and b.mjs call legacyFormat from fmt.mjs, which also exports format, and a
// changelog names the old function. Code's search finds all four files; discovery groups a.mjs
// and b.mjs and excuses the definition and the changelog; a human approves the plan; each migrator
// rewrites its own file in its own worktree; code integrates both, runs the verification command
// (red while either file mentions legacyFormat, and it leaves an artifact behind) and publishes the
// migrators' changes alone.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commitAll, git, leaf, writeFiles } from './_support.mjs';

const fmt = [
  'export const legacyFormat = (x) => String(x);',
  'export const format = (x) => String(x);',
  '',
].join('\n');
const changelog = '# Changelog\n\n- 1.0: added legacyFormat.\n';
const values = { a: 1, b: 2 };
const caller = (name, api) =>
  `import { ${api} } from './fmt.mjs';\n\nexport const ${name} = ${api}(${String(values[name])});\n`;
// The repair mode's b.mjs calls the new API but keeps the old import, so its search still hits.
const halfDone = `import { legacyFormat } from './fmt.mjs';\nimport { format } from './fmt.mjs';\n\nexport const b = format(2);\n`;
const clusters = [
  { description: 'b.mjs still imports legacyFormat', files: ['b.mjs'] },
  { description: 'b.mjs carries a dead legacy import', files: ['b.mjs'] },
];
const collides = halfDone.replace(/^.*\n/u, '// legacy import removed\n');
const groups = [
  { files: ['a.mjs'], siteCount: 1, notes: null },
  { files: ['b.mjs'], siteCount: 1, notes: null },
];
const unchanged = [
  { file: 'fmt.mjs', why: 'Defines the old API, kept for compatibility' },
  { file: 'CHANGELOG.md', why: 'Records history' },
];
/** A check that exits 4 while a named file mentions legacyFormat and 5 when its value is wrong. */
const verify = (names) => [
  process.execPath,
  '-e',
  [
    "const fs=require('node:fs');",
    `const names=${JSON.stringify(names)};`,
    "if(names.some((f)=>fs.readFileSync(f+'.mjs','utf8').includes('legacyFormat')))process.exit(4);",
    "fs.writeFileSync('verified.txt','ok\\n');",
    `Promise.all(names.map((f)=>import('./'+f+'.mjs'))).then((ms)=>{if(ms.some((m,i)=>m[names[i]]!==String(${JSON.stringify(values)}[names[i]])))process.exit(5)});`,
  ].join(''),
];
/** A command that commits OPERATOR.md to the source checkout at `cwd`, as an operator might. */
const operatorCommit = (cwd) =>
  [
    "const {execFileSync}=require('node:child_process');",
    `const cwd=${JSON.stringify(cwd)};`,
    "require('node:fs').writeFileSync(cwd+'/OPERATOR.md','operator\\n');",
    "const git=(...a)=>execFileSync('git',['-C',cwd,'-c','user.name=Operator','-c','user.email=op@localhost','-c','commit.gpgsign=false',...a]);",
    "git('add','OPERATOR.md');git('commit','-qm','operator');",
  ].join('');
const writer = /^(?:wave\/\d+\/\d+\/migrate|repairs\/\d+\/repair)$/u;
const migrator = /^wave\/\d+\/\d+\/migrate$/u;
/** The migrator's own file, from its prompt's file list (the plan JSON names every group). */
const own = (prompt) => /Your files:\n- ([ab])\.mjs\n/u.exec(prompt)?.[1];

export async function setup(env) {
  await writeFiles(env.cwd, {
    'fmt.mjs': fmt,
    'a.mjs': caller('a', 'legacyFormat'),
    'b.mjs': caller('b', 'legacyFormat'),
    'CHANGELOG.md': changelog,
  });
  env.base = commitAll(env.cwd, 'add the legacyFormat callers');
}

export const input = () => ({
  from: 'legacyFormat(x) from ./fmt.mjs',
  to: 'format(x) from ./fmt.mjs',
  searchTerms: ['legacyFormat'],
  verifyCommands: [verify(['a', 'b'])],
});

export async function reply(request, env, mode) {
  const id = request.call.stepId;
  if (id === 'discover') {
    if (mode === 'missed-sites') return { groups: [], unchanged };
    // A second group naming b.mjs again, and a file that does not exist: code coalesces the
    // first and reports the second as stray.
    const overlapping = { files: ['b.mjs', 'missing.mjs'], siteCount: 1, notes: 'Re-exported' };
    return { groups: mode === 'out-of-bounds' ? [...groups, overlapping] : groups, unchanged };
  }
  if (migrator.test(id)) {
    const name = own(request.options.prompt);
    assert.ok(name, `No own file in ${id}`);
    if (mode === 'early-abort' && name === 'a')
      return {
        status: 'blocked',
        summary: 'legacyFormat is reached through a string-keyed registry',
        blockers: ['a.mjs:3: dynamic call'],
      };
    const migrated = mode === 'repair' && name === 'b' ? halfDone : caller(name, 'format');
    await writeFile(join(request.cwd, `${name}.mjs`), migrated);
    if (mode === 'out-of-bounds' && name === 'a')
      await writeFile(join(request.cwd, 'CHANGELOG.md'), `${changelog}- 2.0: format.\n`);
    return { status: 'migrated', summary: `Replaced legacyFormat in ${name}.mjs`, blockers: [] };
  }
  if (id === 'triage') return { clusters: mode === 'repair' ? clusters : clusters.slice(0, 1) };
  if (/^repairs\/\d+\/repair$/u.test(id)) {
    if (mode === 'red-verify') return { summary: 'Nothing in the approved files explains exit 3' };
    // The second repairer rewrites the line the first deletes, so integration drops it.
    const second = request.options.prompt.includes(clusters[1].description);
    await writeFile(join(request.cwd, 'b.mjs'), second ? collides : caller('b', 'format'));
    return { summary: 'Dropped the legacyFormat import from b.mjs' };
  }
  throw new Error(`Unhandled api-migration step ${id} (${mode})`);
}

export function fail(request, mode) {
  return (
    mode === 'migrator-fails' &&
    migrator.test(request.call.stepId) &&
    own(request.options.prompt) === 'a'
  );
}

/** The declined mode's API asks the fixture human to decline; it is in the subject. */
export const answer = (question) =>
  leaf(question.stepId) === 'approve-migration' && question.subject?.from?.includes('(decline)')
    ? { approved: false, comment: 'Fixture human declined' }
    : undefined;

const read = (env, file) => readFileSync(join(env.cwd, file), 'utf8');
/** The checkout is the setup commit, clean. */
function untouched(env) {
  assert.equal(git(env.cwd, 'rev-parse', 'HEAD'), env.base);
  assert.equal(read(env, 'a.mjs'), caller('a', 'legacyFormat'));
  assert.equal(read(env, 'b.mjs'), caller('b', 'legacyFormat'));
  assert.equal(git(env.cwd, 'status', '--porcelain'), '');
}
/** Published: one fast-forward of the clean checkout holding exactly `files`, no artifact. */
function published(env, output, files) {
  assert.equal(git(env.cwd, 'rev-parse', 'HEAD'), output.commit);
  assert.equal(git(env.cwd, 'status', '--porcelain'), '');
  assert.deepEqual(git(env.cwd, 'diff', '--name-only', env.base, 'HEAD').split('\n'), files);
  assert.equal(read(env, 'fmt.mjs'), fmt);
  assert.equal(read(env, 'CHANGELOG.md'), changelog);
  assert.equal(existsSync(join(env.cwd, 'verified.txt')), false);
}
const partialInput = () => ({ ...input(), verifyCommands: [verify(['b'])] });
const outcomes = (list) => list.map((group) => [group.files.join(','), group.status]);

export function check({ result, env, calls, suspended }) {
  const { output } = result;
  assert.equal(output.status, 'migrated');
  assert.equal(suspended, 1);
  assert.equal(output.totalSites, 2);
  assert.deepEqual([output.coalesced, output.stray, output.deferred], [0, [], []]);
  assert.deepEqual(output.unassigned, []);
  assert.deepEqual(
    output.excused.map((entry) => entry.file),
    ['fmt.mjs', 'CHANGELOG.md'],
  );
  assert.deepEqual(outcomes(output.migrated), [
    ['a.mjs', 'migrated'],
    ['b.mjs', 'migrated'],
  ]);
  assert.deepEqual([output.failed, output.unattempted, output.clusters], [[], [], []]);
  // The discoverer saw the code-owned search hits.
  const discover = calls.find((call) => call.call.stepId === 'discover');
  assert.match(discover.options.prompt, /tracked files:\n- CHANGELOG\.md\n- a\.mjs\n- b\.mjs\n/u);
  // Each migrator got its own worktree and the approved plan verbatim; the digest is of that text.
  const migrators = calls.filter((call) => migrator.test(call.call.stepId));
  assert.equal(migrators.length, 2);
  assert.equal(new Set(migrators.map((call) => call.cwd)).size, 2);
  for (const call of migrators) {
    const text = call.options.prompt.split('Approved plan:\n')[1];
    assert.equal(output.approvedDigest, createHash('sha256').update(text).digest('hex'));
    assert.deepEqual(JSON.parse(text).groups, groups);
  }
  // One verification pass, green, with no leftover reference in the migrated files.
  assert.equal(output.verification.length, 1);
  const [round] = output.verification;
  assert.deepEqual([round.passed, round.leftovers, round.checks[0].code], [true, [], 0]);
  assert.notEqual(round.commit, env.base);
  published(env, output, ['a.mjs', 'b.mjs']);
  assert.equal(read(env, 'a.mjs'), caller('a', 'format'));
  assert.equal(read(env, 'b.mjs'), caller('b', 'format'));
  for (const call of calls)
    if (writer.test(call.call.stepId)) assert.notEqual(call.cwd, env.cwd);
    else assert.ok(!call.options.tools.includes('Write'), call.call.stepId);
}

// Any first-wave migrator: the first one invoked holds the fixture's single agent slot when it
// dies, so no sibling has an unsaved completion and the repaid count is the same on every run.
export const kill = {
  step: '^wave/0/\\d+/migrate$',
  boundary: 'response',
  writeLocation: 'isolated-checkout',
};

export const modes = [
  {
    mode: 'declined',
    input: () => ({ ...input(), from: 'legacyFormat(x) (decline)' }),
    check({ result, env, calls, suspended }) {
      assert.equal(result.output.status, 'declined');
      assert.equal(suspended, 1);
      assert.match(result.output.approvedDigest, /^[a-f0-9]{64}$/u);
      assert.ok(calls.every((call) => !migrator.test(call.call.stepId)));
      untouched(env);
    },
  },
  {
    mode: 'missed-sites',
    check({ result, env, calls, suspended }) {
      const { output } = result;
      assert.equal(output.status, 'nothing-to-migrate');
      assert.equal(suspended, 0);
      // Code's search names the call sites the discoverer missed.
      assert.deepEqual(output.unassigned, ['a.mjs', 'b.mjs']);
      assert.equal(output.approvedDigest, null);
      assert.equal(calls.length, 1);
      untouched(env);
    },
  },
  {
    mode: 'early-abort',
    input: () => ({ ...input(), batchSize: 1 }),
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'nothing-migrated');
      assert.deepEqual(outcomes(output.failed), [['a.mjs', 'blocked']]);
      assert.deepEqual(output.failed[0].blockers, ['a.mjs:3: dynamic call']);
      assert.deepEqual(output.unattempted, [['b.mjs']]);
      assert.deepEqual(output.verification, []);
      assert.ok(calls.every((call) => !call.call.stepId.startsWith('wave/1/')));
      untouched(env);
    },
  },
  {
    mode: 'migrator-fails',
    input: partialInput,
    check({ result, env }) {
      const { output } = result;
      assert.equal(output.status, 'partial');
      assert.deepEqual(outcomes(output.migrated), [['b.mjs', 'migrated']]);
      assert.deepEqual(outcomes(output.failed), [['a.mjs', 'failed']]);
      assert.match(output.failed[0].summary, /^migrator failed: /u);
      published(env, output, ['b.mjs']);
      assert.equal(read(env, 'a.mjs'), caller('a', 'legacyFormat'));
    },
  },
  {
    mode: 'out-of-bounds',
    input: partialInput,
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'partial');
      assert.deepEqual(
        [output.coalesced, output.stray, output.totalSites],
        [1, ['missing.mjs'], 3],
      );
      const b = calls.find((call) => own(call.options.prompt) === 'b');
      assert.match(b.options.prompt, /Expected sites: about 2\.\nDiscovery noted: Re-exported\n/u);
      assert.deepEqual(outcomes(output.failed), [['a.mjs', 'refused']]);
      assert.match(output.failed[0].summary, /CHANGELOG\.md \(modified\)/u);
      published(env, output, ['b.mjs']);
      assert.equal(read(env, 'a.mjs'), caller('a', 'legacyFormat'));
    },
  },
  {
    mode: 'repair',
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'migrated');
      assert.deepEqual(
        output.verification.map((round) => [round.passed, round.leftovers, round.checks[0].code]),
        [
          [false, ['b.mjs'], 4],
          [true, [], 0],
        ],
      );
      // Both repairers changed the same line; the later one conflicts and is never published.
      assert.deepEqual(
        output.clusters.map((cluster) => cluster.repair),
        ['applied', 'conflict'],
      );
      // The triager saw the code-found leftover and the failing command's result.
      const triage = calls.find((call) => call.call.stepId === 'triage');
      assert.match(triage.options.prompt, /reported fully migrated:\n- b\.mjs\n/u);
      assert.match(triage.options.prompt, /Command 1, exit 4: /u);
      const repairer = calls.find((call) => leaf(call.call.stepId) === 'repair');
      assert.notEqual(repairer.cwd, env.cwd);
      published(env, output, ['a.mjs', 'b.mjs']);
      assert.equal(read(env, 'b.mjs'), caller('b', 'format'));
    },
  },
  {
    // An operator commits to the checkout after the last verification pass (here, from a
    // verification command). ctx.merge rebases the publication onto the moved HEAD and succeeds,
    // so code compares trees and reports the published tree as unverified.
    mode: 'moved-checkout',
    input: (env) => ({
      ...input(),
      verifyCommands: [verify(['a', 'b']), [process.execPath, '-e', operatorCommit(env.cwd)]],
    }),
    check({ result, env }) {
      const { output } = result;
      assert.equal(output.status, 'unverified-publish');
      assert.equal(output.verification.length, 1);
      assert.equal(output.verification[0].passed, true);
      assert.equal(git(env.cwd, 'rev-parse', 'HEAD'), output.commit);
      assert.notEqual(
        git(env.cwd, 'rev-parse', `${output.commit}^{tree}`),
        git(env.cwd, 'rev-parse', `${output.verification[0].commit}^{tree}`),
      );
      assert.equal(read(env, 'OPERATOR.md'), 'operator\n');
      assert.equal(read(env, 'a.mjs'), caller('a', 'format'));
    },
  },
  {
    mode: 'red-verify',
    // A nonzero exit is a recorded result; a command that kills itself settles as a failure.
    input: () => ({
      ...input(),
      verifyCommands: [
        [process.execPath, '-e', 'process.exit(3)'],
        [process.execPath, '-e', "process.kill(process.pid, 'SIGKILL')"],
      ],
    }),
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'verification-failed');
      // The repairer changed nothing, so there is no second pass to run.
      assert.equal(output.verification.length, 1);
      assert.deepEqual(
        output.verification[0].checks.map((row) => [row.code, row.signal, row.failure]),
        [
          [3, null, null],
          [null, 'SIGKILL', 'process'],
        ],
      );
      const triage = calls.find((call) => call.call.stepId === 'triage');
      assert.match(
        triage.options.prompt,
        /Command 1, exit 3: [^]*Command 2, process, signal SIGKILL: /u,
      );
      assert.deepEqual(
        output.clusters.map((cluster) => cluster.repair),
        ['unchanged'],
      );
      assert.equal(output.commit, output.verification[0].commit);
      assert.equal(git(env.cwd, 'show', `${output.commit}:a.mjs`), caller('a', 'format').trimEnd());
      untouched(env);
    },
  },
];

/** A migrator or repairer call that failed is degradation that a partial status does not name. */
export const degraded = (output) =>
  output.failed.some((group) => group.status === 'failed') ||
  output.clusters.some((cluster) => cluster.repair === 'failed');
