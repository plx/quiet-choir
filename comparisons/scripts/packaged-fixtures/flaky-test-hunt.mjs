// flaky-test-hunt: tests/cache.test.mjs fails on every third stress run (keyed on the run's step
// ID, so a retry or a replay keeps the same rate), tests/clock.test.mjs always passes and
// tests/net.test.mjs always fails. A "Retry flaky cache test" commit and a CI file give the
// history and CI sweepers code-owned facts, and the CI sweeper also names a file that does not
// exist and a tracked migration script that must never run. The cache flake is diagnosed,
// approved, fixed in the fixer's worktree, re-stressed by code and only then published.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commitAll, git, leaf, writeFiles } from './_support.mjs';

const only = (name) =>
  `if (process.argv[2] !== ${JSON.stringify(name)}) {\n  console.error('no test matched');\n  process.exit(2);\n}\n`;
const run =
  "const run = Number(/(\\d+)$/u.exec(process.env.QUIET_CHOIR_STEP_ID ?? '')?.[1] ?? 0);\n";
const tests = {
  cache: { test: 'reads a fresh cache', file: 'tests/cache.test.mjs' },
  clock: { test: 'formats today', file: 'tests/clock.test.mjs' },
  net: { test: 'fetches the fixture server', file: 'tests/net.test.mjs' },
  ghost: { test: 'quarantined', file: 'tests/ghost.test.mjs' },
  migrate: { test: 'migrates', file: 'scripts/migrate.mjs' },
};
const flaky = (every) =>
  `${only(tests.cache.test)}${run}if (run % ${every} === 1) {\n  console.error('expected 2, got 3: stale cache');\n  process.exit(1);\n}\n`;
const fixed = `${only(tests.cache.test)}// The cache is reset before every read, so the order of runs no longer matters.\n`;
// The same fix, but every re-stress run leaves an untracked restress.log in its tree.
const littering = `${fixed}if ((process.env.QUIET_CHOIR_STEP_ID ?? '').startsWith('restress/'))\n  (await import('node:fs')).appendFileSync('restress.log', 'run\\n');\n`;
const files = {
  [tests.cache.file]: flaky(3),
  [tests.clock.file]: only(tests.clock.test),
  [tests.net.file]:
    `${only(tests.net.test)}console.error('connect ECONNREFUSED 127.0.0.1:9');\nprocess.exit(1);\n`,
  // Not a test: running it as a suspect would migrate, leaving migrated.txt behind.
  [tests.migrate.file]:
    "import { writeFileSync } from 'node:fs';\nwriteFileSync('migrated.txt', 'yes\\n');\n",
};

export async function setup(env) {
  await writeFiles(env.cwd, files);
  commitAll(env.cwd, 'Add cache, clock and net tests');
  await writeFiles(env.cwd, {
    [tests.cache.file]: `// Retried twice in CI.\n${files[tests.cache.file]}`,
  });
  commitAll(env.cwd, 'Retry flaky cache test');
  await writeFiles(env.cwd, {
    '.github/workflows/ci.yml':
      'jobs:\n  test:\n    retries: 2\n  migrate:\n    retries: 2\n    run: node scripts/migrate.mjs\n',
  });
  env.base = commitAll(env.cwd, 'Configure CI retries');
  env.cache = await readFile(join(env.cwd, tests.cache.file), 'utf8');
}

const command = [process.execPath, '{file}', '{test}'];
export const input = () => ({
  testCommand: command,
  fix: true,
  verifyCommands: [[process.execPath, tests.clock.file, tests.clock.test]],
});
const reportOnly = () => ({ testCommand: command });
// Runs the test file like `command`, after appending to an untracked stress.log in the checkout.
const stressLog = [
  process.execPath,
  '-e',
  "require('node:fs').appendFileSync('stress.log', 'run\\n'); import(require('node:path').resolve(process.argv[1]));",
  '{file}',
  '{test}',
];

const sweepOf = (id) => /^sweeps\/(history|smells|ci)\/suspects$/u.exec(id)?.[1];
export async function reply(request, env, mode) {
  const id = request.call.stepId;
  const sweep = sweepOf(id);
  if (sweep) {
    if (mode === 'empty') return { suspects: [] };
    const found = (key, evidence) => ({ ...tests[key], evidence });
    return {
      suspects: {
        history: [found('cache', 'Commit "Retry flaky cache test" wrapped it in retries')],
        smells: [
          found('cache', 'Reads a module-level cache another test warms'),
          found('clock', 'Compares against Date.now()'),
          found('net', 'Connects to a real port'),
        ],
        ci: [
          found('cache', 'ci.yml retries the suite twice'),
          found('ghost', 'Named in a quarantine list'),
          found('migrate', 'ci.yml retries the migrate step twice'),
        ],
      }[sweep],
    };
  }
  if (/^diagnose\/\d+\/diagnosis$/u.test(id))
    return {
      mechanism: 'shared-state',
      explanation: 'An earlier run warms the module cache the test reads, so the order decides it',
      proposedFix: `${mode === 'declined' ? 'DECLINE ' : ''}Reset the module cache before each read`,
      confidence: 'high',
      files: [tests.cache.file],
    };
  if (leaf(id) === 'fix') {
    const content = { 'not-held': flaky(2), 'restress-residue': littering }[mode] ?? fixed;
    if (mode !== 'no-op') await writeFile(join(request.cwd, tests.cache.file), content);
    if (mode === 'overreach')
      await writeFile(join(request.cwd, 'target.mjs'), 'export const value = 2;\n');
    return { summary: 'Reset the cache before each read' };
  }
  throw new Error(`Unhandled flaky-test-hunt step ${id} (${mode})`);
}

export function fail(request, mode) {
  const id = request.call.stepId;
  return (
    (mode === 'diagnosis-fails' && /^diagnose\/\d+\/diagnosis$/u.test(id)) ||
    (mode === 'sweep-fails' && id === 'sweeps/smells/suspects') ||
    (mode === 'sweeps-fail' && Boolean(sweepOf(id)))
  );
}

/** The declined mode's diagnosis marks its plan, since answer() does not receive the mode. */
export const answer = (question) =>
  question.subject?.plan?.some((item) => item.proposedFix.startsWith('DECLINE '))
    ? { approved: false }
    : undefined;

const promptOf = (calls, pattern) =>
  calls.find((call) => pattern.test(call.call.stepId))?.options.prompt ?? '';
const fixerCalls = (calls) => calls.filter((call) => leaf(call.call.stepId) === 'fix');
const pick = (rows) => rows.map((row) => [row.file, row.stress.runs, row.stress.failures]);
/** The checkout is exactly the measured commit: no fix published, nothing left behind. */
async function untouched(env) {
  assert.equal(git(env.cwd, 'rev-parse', 'HEAD'), env.base);
  assert.equal(git(env.cwd, 'status', '--porcelain', '--untracked-files=all'), '');
  assert.equal(await readFile(join(env.cwd, tests.cache.file), 'utf8'), env.cache);
}
/** No stress run ever executed the migration script, while the clock test was stressed. */
const neverMigrated = (env, record) => {
  assert.equal(existsSync(join(env.cwd, 'migrated.txt')), false);
  const argvs = Object.entries(record.steps).flatMap(([id, step]) =>
    id.startsWith('stress/') ? [JSON.stringify(step.exec ?? step.request ?? null)] : [],
  );
  assert.ok(argvs.some((text) => text.includes(tests.clock.file)));
  assert.equal(
    argvs.some((text) => text.includes(tests.migrate.file)),
    false,
  );
};

export async function check({ result, env, calls, record, suspended }) {
  const { output } = result;
  assert.equal(output.status, 'fixed');
  assert.equal(output.commit, env.base);
  assert.deepEqual([output.noEvidence, output.failedSweeps], [[], []]);
  // An untracked file and a tracked non-test script are rejected before anything runs them.
  assert.deepEqual(
    output.rejected.map((row) => [row.file, row.reason]),
    [
      [tests.ghost.file, 'untracked-file'],
      [tests.migrate.file, 'not-a-test-file'],
    ],
  );
  neverMigrated(env, record);
  assert.deepEqual(output.skipped, []);
  assert.equal(output.confirmed.length, 1);
  const [flake] = output.confirmed;
  assert.deepEqual(
    [flake.test, flake.corroboration, flake.evidence.map((item) => item.modality)],
    [tests.cache.test, 3, ['history', 'smells', 'ci']],
  );
  assert.deepEqual(flake.stress.argv, [process.execPath, tests.cache.file, tests.cache.test]);
  assert.deepEqual(
    [flake.stress.runs, flake.stress.failures, flake.stress.verdict],
    [8, 3, 'flaky'],
  );
  assert.deepEqual(
    flake.stress.outcomes.map((row) => row.outcome),
    ['pass', 'fail', 'pass', 'pass', 'fail', 'pass', 'pass', 'fail'],
  );
  assert.match(flake.stress.sample, /stale cache/u);
  assert.equal(flake.diagnosis.mechanism, 'shared-state');
  assert.deepEqual(pick(output.cleared), [[tests.clock.file, 8, 0]]);
  assert.deepEqual(pick(output.broken), [[tests.net.file, 8, 8]]);
  assert.deepEqual([output.unrunnable, output.undiagnosed, output.residue], [[], 0, []]);
  // Code-owned facts reached the sweepers and the diagnostician.
  const history = promptOf(calls, /^sweeps\/history\//u);
  assert.match(history, /"Retry flaky cache test": tests\/cache/u);
  assert.match(history, /<patch commit="[a-f0-9]{12}">[\s\S]*\+\/\/ Retried twice in CI\./u);
  assert.match(history, /tests\/cache\.test\.mjs: 2 commits/u);
  assert.match(history, /globs \(\*\*\/\*\.test\.\*, /u);
  assert.match(promptOf(calls, /^sweeps\/ci\//u), /- \.github\/workflows\/ci\.yml/u);
  assert.match(promptOf(calls, /^diagnose\//u), /failed 3 of them[\s\S]*stale cache/u);
  // The fixer received exactly the plan the human approved, and wrote only in its worktree.
  assert.equal(suspended, 1);
  const [fixer] = fixerCalls(calls);
  const plan = fixer.options.prompt.split('Approved plan:\n')[1];
  assert.equal(output.approvedDigest, createHash('sha256').update(plan).digest('hex'));
  assert.notEqual(fixer.cwd, env.cwd);
  assert.ok(
    calls.filter((call) => call !== fixer).every((call) => !call.options.tools.includes('Write')),
  );
  assert.deepEqual(pick(output.restress), [[tests.cache.file, 5, 0]]);
  assert.ok(output.verification.length === 1 && output.verification[0].code === 0);
  assert.deepEqual([output.refusedFiles, output.untouched], [[], []]);
  // Published: the checkout holds the fix as one commit on the measured base, and is clean.
  assert.equal(git(env.cwd, 'rev-parse', 'HEAD'), output.fixCommit);
  assert.equal(git(env.cwd, 'rev-parse', 'HEAD^'), env.base);
  assert.equal(await readFile(join(env.cwd, tests.cache.file), 'utf8'), fixed);
  assert.equal(git(env.cwd, 'status', '--porcelain', '--untracked-files=all'), '');
}

export const kill = {
  step: '^fix$',
  boundary: 'response',
  writeLocation: 'isolated-checkout',
};

export const modes = [
  {
    mode: 'report-only',
    input: reportOnly,
    async check({ result, env, calls, suspended }) {
      assert.equal(result.output.status, 'report');
      assert.equal(result.output.confirmed[0].diagnosis.mechanism, 'shared-state');
      assert.deepEqual([result.output.approvedDigest, suspended], [null, 0]);
      assert.equal(fixerCalls(calls).length, 0);
      await untouched(env);
    },
  },
  {
    mode: 'declined',
    async check({ result, env, calls, suspended }) {
      assert.equal(result.output.status, 'declined');
      assert.match(result.output.approvedDigest, /^[a-f0-9]{64}$/u);
      assert.equal(suspended, 1);
      assert.equal(fixerCalls(calls).length, 0);
      await untouched(env);
    },
  },
  {
    mode: 'diagnosis-fails',
    async check({ result, env, calls, suspended }) {
      // A measured flake stays confirmed without a diagnosis; nothing is planned or approved.
      assert.equal(result.output.status, 'report');
      assert.deepEqual(
        result.output.confirmed.map((flake) => [flake.file, flake.diagnosis]),
        [[tests.cache.file, null]],
      );
      assert.deepEqual([result.output.undiagnosed, suspended], [1, 0]);
      assert.equal(fixerCalls(calls).length, 0);
      await untouched(env);
    },
  },
  {
    mode: 'not-held',
    async check({ result, env }) {
      // The fix still flakes under re-stress, so it is integrated on a run ref but not published.
      assert.equal(result.output.status, 'fix-failed');
      assert.deepEqual(pick(result.output.restress), [[tests.cache.file, 5, 2]]);
      assert.match(result.output.fixCommit, /^[a-f0-9]{40}$/u);
      assert.notEqual(result.output.fixCommit, env.base);
      await untouched(env);
    },
  },
  {
    mode: 'overreach',
    async check({ result, env }) {
      assert.equal(result.output.status, 'refused');
      assert.deepEqual(result.output.refusedFiles, ['target.mjs']);
      assert.deepEqual([result.output.fixCommit, result.output.restress], [null, []]);
      await untouched(env);
    },
  },
  {
    mode: 'sweep-fails',
    input: reportOnly,
    async check({ result, env }) {
      // Without the smell sweep, only the corroborated cache suspect is left to stress.
      assert.deepEqual(result.output.failedSweeps, ['smells']);
      assert.equal(result.output.status, 'report');
      assert.deepEqual(
        result.output.confirmed.map((flake) => [flake.file, flake.corroboration]),
        [[tests.cache.file, 2]],
      );
      assert.deepEqual([result.output.cleared, result.output.broken], [[], []]);
      assert.equal(degraded(result.output), true);
      await untouched(env);
    },
  },
  {
    mode: 'empty',
    async check({ result, env, calls, record }) {
      assert.equal(result.output.status, 'no-suspects');
      assert.equal(calls.length, 3);
      assert.equal(
        Object.keys(record.steps).some((id) => id.startsWith('stress/')),
        false,
      );
      await untouched(env);
    },
  },
  {
    mode: 'capped',
    input: () => ({ testCommand: command, maxSuspects: 1 }),
    async check({ result, env }) {
      // The corroborated suspect wins the only stress slot; the rest are reported, not dropped.
      assert.equal(result.output.status, 'report');
      assert.deepEqual(
        result.output.confirmed.map((flake) => flake.file),
        [tests.cache.file],
      );
      assert.deepEqual(
        result.output.skipped.map((suspect) => suspect.file),
        [tests.clock.file, tests.net.file],
      );
      assert.equal(degraded(result.output), true);
      await untouched(env);
    },
  },
  {
    mode: 'dirty',
    options(opts, env) {
      writeFileSync(join(env.cwd, 'stray.txt'), 'uncommitted\n');
      return opts;
    },
    rejects: /The checkout must be clean \(clean\)[\s\S]*stray\.txt/u,
    check({ result, calls }) {
      // Flake rates describe a commit, so a dirty checkout stops the run before any agent call.
      assert.equal(result.status, 'failed');
      assert.equal(calls.length, 0);
    },
  },
  {
    mode: 'residue',
    input: () => ({ testCommand: stressLog, fix: true }),
    rejects: /The checkout must be clean \(clean-for-fix\)[\s\S]*stress\.log/u,
    async check({ result, env, calls }) {
      // Residue reaches the diagnostician as a fact, and stops the fix before its approval, since
      // publication needs the measured checkout.
      assert.equal(result.status, 'failed');
      assert.match(promptOf(calls, /^diagnose\//u), /- \?\? stress\.log/u);
      assert.deepEqual([result.pending ?? [], fixerCalls(calls)], [[], []]);
      assert.equal(git(env.cwd, 'rev-parse', 'HEAD'), env.base);
      assert.equal(await readFile(join(env.cwd, tests.cache.file), 'utf8'), env.cache);
    },
  },
  {
    mode: 'unrunnable',
    input: () => ({ testCommand: [join('/nonexistent', 'flaky-runner'), '{file}', '{test}'] }),
    async check({ result, env, calls }) {
      // A command that cannot start is could-not-run after one attempt, never always-fails.
      assert.equal(result.output.status, 'no-flakes');
      assert.deepEqual(
        result.output.unrunnable.map((row) => [row.file, row.stress.runs, row.stress.verdict]),
        [
          [tests.cache.file, 1, 'could-not-run'],
          [tests.clock.file, 1, 'could-not-run'],
          [tests.net.file, 1, 'could-not-run'],
        ],
      );
      assert.equal(result.output.unrunnable[0].stress.outcomes[0].outcome, 'error');
      assert.equal(
        calls.some((call) => call.call.stepId.startsWith('diagnose/')),
        false,
      );
      await untouched(env);
    },
  },
  {
    mode: 'no-op',
    async check({ result, env, calls, record }) {
      // A fixer that changes nothing could pass a few re-stress runs by chance; it is stopped first.
      assert.equal(result.output.status, 'incomplete');
      assert.deepEqual(result.output.untouched, [
        { test: tests.cache.test, file: tests.cache.file },
      ]);
      assert.deepEqual([result.output.fixCommit, result.output.restress], [null, []]);
      assert.equal(fixerCalls(calls).length, 1);
      assert.equal(
        Object.keys(record.steps).some((id) => id === 'integrate' || id.startsWith('restress/')),
        false,
      );
      await untouched(env);
    },
  },
  {
    mode: 'red-verify',
    input: () => ({
      testCommand: command,
      fix: true,
      verifyCommands: [[process.execPath, '-e', 'process.exit(4)']],
    }),
    async check({ result, env }) {
      // The re-stress holds, but a failing verification command still keeps the fix unpublished.
      assert.equal(result.output.status, 'fix-failed');
      assert.deepEqual(pick(result.output.restress), [[tests.cache.file, 5, 0]]);
      assert.deepEqual(
        result.output.verification.map((row) => [row.code, row.failure]),
        [[4, 'process']],
      );
      await untouched(env);
    },
  },
  {
    mode: 'restress-residue',
    input: () => ({
      testCommand: command,
      fix: true,
      // Fails if the re-stress runs' residue reached the verification tree.
      verifyCommands: [
        [
          process.execPath,
          '-e',
          "process.exit(require('node:fs').existsSync('restress.log') ? 5 : 0)",
        ],
      ],
    }),
    async check({ result, env }) {
      // Re-stress residue stays in its own tree: verification and the publish see only the fix.
      assert.equal(result.output.status, 'fixed');
      assert.deepEqual(pick(result.output.restress), [[tests.cache.file, 5, 0]]);
      assert.equal(result.output.verification[0].code, 0);
      assert.equal(git(env.cwd, 'rev-parse', 'HEAD'), result.output.fixCommit);
      assert.equal(git(env.cwd, 'rev-parse', 'HEAD^'), env.base);
      assert.equal(git(env.cwd, 'show', '--name-only', '--format=', 'HEAD'), tests.cache.file);
      assert.equal(git(env.cwd, 'status', '--porcelain', '--untracked-files=all'), '');
      assert.equal(await readFile(join(env.cwd, tests.cache.file), 'utf8'), littering);
    },
  },
  {
    mode: 'sweeps-fail',
    input: reportOnly,
    async check({ result, env, calls, record }) {
      // No sweep answered, so the run says so instead of claiming there are no suspects.
      assert.equal(result.output.status, 'sweeps-failed');
      assert.deepEqual(result.output.failedSweeps, ['history', 'smells', 'ci']);
      assert.equal(calls.length, 3);
      assert.equal(
        Object.keys(record.steps).some((id) => id.startsWith('stress/')),
        false,
      );
      await untouched(env);
    },
  },
  {
    mode: 'test-files',
    input: () => ({ testCommand: command, testFiles: ['tests/clock.*'] }),
    async check({ result, env, record }) {
      // The operator's globs, not the sweepers, decide which files the test command may run.
      assert.equal(result.output.status, 'no-flakes');
      assert.deepEqual(pick(result.output.cleared), [[tests.clock.file, 8, 0]]);
      assert.deepEqual(
        result.output.rejected.map((row) => [row.file, row.reason]),
        [
          [tests.cache.file, 'not-a-test-file'],
          [tests.net.file, 'not-a-test-file'],
          [tests.ghost.file, 'untracked-file'],
          [tests.migrate.file, 'not-a-test-file'],
        ],
      );
      neverMigrated(env, record);
      await untouched(env);
    },
  },
  {
    mode: 'no-history',
    input: reportOnly,
    options(opts, env) {
      // One innocuous root commit: no flake mention and no churn for the history sweeper to read.
      git(env.cwd, 'checkout', '-q', '--orphan', 'imported');
      env.base = commitAll(env.cwd, 'Import the project');
      return opts;
    },
    async check({ result, env, calls }) {
      assert.deepEqual([result.output.noEvidence, result.output.failedSweeps], [['history'], []]);
      assert.equal(
        calls.some((call) => call.call.stepId.startsWith('sweeps/history/')),
        false,
      );
      assert.equal(result.output.status, 'report');
      assert.deepEqual(
        result.output.confirmed.map((flake) => [flake.file, flake.corroboration]),
        [[tests.cache.file, 2]],
      );
      assert.equal(degraded(result.output), false);
      await untouched(env);
    },
  },
];

/** A failed sweep, a suspect never stressed or a flake left undiagnosed is a partial hunt. */
export const degraded = (output) =>
  output.failedSweeps.length > 0 || output.skipped.length > 0 || output.undiagnosed > 0;
