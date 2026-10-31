// release-gate: the fixture's README commit is the release since tag v1.0.0. Code runs a passing
// test command (it checks the checkout is the gated tree) and a security evidence command; the
// breaking-changes assessor reports a blocker the Codex confirmer confirms and performance a
// concern, so the code-owned rule allows conditional-go or no-go and the gatekeeper picks the
// first. Assessors and confirmers read their own unchanged checkouts of the pinned commit. The
// gate is read-only: the checkout must end exactly as it started.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commitAll, enumOf, git, leaf } from './_support.mjs';

const pristine = 'export const value = 1;\n';
const gatedTree = `if(require('node:fs').readFileSync('target.mjs','utf8')!==${JSON.stringify(pristine)})process.exit(4)`;
const auditLine = 'audit: 0 vulnerabilities in 3 packages';
const audit = `console.log(${JSON.stringify(auditLine)})`;
const red = "process.stderr.write('1 failing: value is two');process.exit(3)";
const rewrite = "require('node:fs').writeFileSync('target.mjs','export const value = 2;\\n')";
const hang = 'setTimeout(() => {}, 60000)';
// A test that passes with an untracked artifact (coverage output) left in the checkout.
const artifact =
  "const fs=require('node:fs');fs.mkdirSync('coverage',{recursive:true});fs.writeFileSync('coverage/summary.txt','100%')";
// A test that passes only with an untracked helper file beside it.
const helper = "await import('./helper.mjs')";
// Fails with long output on its first run, then hangs past the deadline on its rerun.
const failThenHang = (marker) =>
  `const fs=require('node:fs');if(fs.existsSync(${JSON.stringify(marker)}))setTimeout(()=>{},60000);else{fs.writeFileSync(${JSON.stringify(marker)},'');process.stderr.write('z'.repeat(3000)+' first run: value is two');process.exit(1)}`;
// An audit whose output is longer than the excerpt an assessor receives: only its end is shown.
const longAudit = `console.log('x'.repeat(20000) + ${JSON.stringify(` ${auditLine}`)})`;
// Fails on its first run and passes on its rerun: a marker outside the checkout remembers.
const flaky = (marker) =>
  `const fs=require('node:fs');if(!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},'');process.exit(1)}`;
// Crashes by a signal on every run: a red test, not one that could not start.
const crash = "process.kill(process.pid,'SIGKILL')";
// Test commands that move HEAD: a commit on the current branch, and a switch to a new branch.
const ident = [
  '-c',
  'user.name=Fixture',
  '-c',
  'user.email=fixture@localhost',
  '-c',
  'commit.gpgsign=false',
];
const commits = ['git', ...ident, 'commit', '--allow-empty', '-qm', 'Moved by a test'];
const switches = ['git', 'checkout', '-q', '-b', 'side'];

const pass = (evidence) => ({ status: 'pass', evidence, findings: [] });
const blocker = (evidence, finding) => ({ status: 'blocker', evidence, findings: [finding] });
const assessments = {
  'coverage-on-diff': pass('Only README.md changed; no logic was added'),
  'breaking-changes': blocker(
    'README.md drops the documented --legacy flag; CHANGELOG.md has no entry',
    'Undocumented removal of --legacy',
  ),
  security: pass('audit: 0 vulnerabilities; no code changed'),
  'migrations-rollback': {
    status: 'not-applicable',
    evidence: 'No migrations in the range',
    findings: [],
  },
  performance: {
    status: 'concern',
    evidence: 'No benchmark ran for this release',
    findings: ['No performance numbers'],
  },
};
// Per-mode replacements of the default assessments.
const quiet = {
  'breaking-changes': pass('Nothing public changed'),
  performance: pass('Nothing on a hot path changed'),
};
const token = {
  'breaking-changes': pass('Nothing public changed'),
  security: blocker('README.md shows a token', 'Token committed in README.md'),
};
// Three reported blockers whose confirmers disagree: alignment is why confirmation is a keyed map.
const several = {
  security: blocker('README.md shows a live token', 'Token committed in README.md'),
  'migrations-rollback': blocker(
    'drop.sql drops the users table with no down migration',
    'Irreversible drop of users',
  ),
};
const verdicts = {
  'breaking-changes': { verdict: 'not-a-problem', reasoning: 'The flag was never public' },
  security: { verdict: 'confirmed', reasoning: 'The token is live' },
  'migrations-rollback': { verdict: 'confirmed', reasoning: 'No backup covers the drop' },
};
const overrides = {
  'no-test-commands': quiet,
  'tests-not-run': quiet,
  'flaky-tests': quiet,
  'refuted-blocker': token,
  'failed-confirmer': token,
  'several-blockers': several,
  'failed-nonhard-assessor': quiet,
};
const testedLine = "Code ran the operator's test commands on this same commit";
const housePolicy = 'House rule QC-7: every release needs a signed-off CHANGELOG.md entry.';
const condition = 'Add a CHANGELOG.md entry for the --legacy removal';

export function setup(env) {
  git(env.cwd, 'tag', 'v1.0.0', env.since);
}

export const input = () => ({
  testCommands: [[process.execPath, '-e', gatedTree]],
  evidenceCommands: [{ dimension: 'security', argv: [process.execPath, '-e', audit] }],
});

/** A reader works in its own clean checkout of the gated commit, not in the source checkout. */
function pinnedReader(request, env) {
  assert.notEqual(request.cwd, env.cwd);
  assert.equal(git(request.cwd, 'rev-parse', 'HEAD'), git(env.cwd, 'rev-parse', 'HEAD'));
  assert.equal(git(request.cwd, 'status', '--porcelain=v1', '--untracked-files=all'), '');
}

export function reply(request, env, mode) {
  const id = request.call.stepId;
  const assess = /^dimensions\/([a-z-]+)\/assess$/u.exec(id);
  if (assess) {
    pinnedReader(request, env);
    if (mode === 'writing-assessor' && assess[1] === 'security')
      writeFileSync(join(request.cwd, 'notes.txt'), 'scratch\n');
    return { ...assessments, ...overrides[mode] }[assess[1]];
  }
  const confirm = /^confirmations\/([a-z-]+)\/confirm$/u.exec(id);
  if (confirm) {
    pinnedReader(request, env);
    assert.equal(request.harness, 'codex');
    assert.equal(request.options.sandbox, 'read-only');
    if (mode === 'writing-confirmer') writeFileSync(join(request.cwd, 'notes.txt'), 'scratch\n');
    if (mode === 'several-blockers') return verdicts[confirm[1]];
    return mode === 'refuted-blocker'
      ? { verdict: 'not-a-problem', reasoning: 'The token is a documented placeholder' }
      : mode === 'downgraded-concern'
        ? { verdict: 'concern', reasoning: 'Documented in the README; worth a changelog line' }
        : { verdict: 'confirmed', reasoning: 'Shipping this is wrong' };
  }
  if (id === 'gatekeeper') {
    const allowed = enumOf(request.outputSchema, 'decision');
    const decision =
      mode === 'refuted-blocker' && allowed.includes('go')
        ? 'go'
        : allowed.includes('conditional-go')
          ? 'conditional-go'
          : allowed[0];
    return {
      decision,
      conditions: decision === 'go' ? [] : [condition],
      rationale: `${decision} from the fixture evidence`,
    };
  }
  throw new Error(`Unhandled release-gate step ${id} (${mode})`);
}

export function fail(request, mode) {
  const id = request.call.stepId;
  return (
    (mode === 'failed-assessor' && id === 'dimensions/security/assess') ||
    (mode === 'failed-nonhard-assessor' && id === 'dimensions/performance/assess') ||
    (mode === 'failed-confirmer' && id === 'confirmations/security/confirm') ||
    (mode.startsWith('gatekeeper-fails') && id === 'gatekeeper')
  );
}

const ids = (calls) => calls.map((call) => call.call.stepId).sort();
const promptOf = (calls, stepId) =>
  calls.find((call) => call.call.stepId === stepId).options.prompt;
const rows = (output) =>
  output.dimensions.map((row) => [row.dimension, row.reported, row.status, row.confirmation]);
const gatekeeperEnum = (calls) =>
  enumOf(calls.find((call) => call.call.stepId === 'gatekeeper').outputSchema, 'decision');
/** What the Decide prompt says the gate rule allows, and its hard-block line. */
const ruleOf = (calls) =>
  /^The workflow's gate rule allows ([^:]+):/mu.exec(promptOf(calls, 'gatekeeper'))?.[1];
const hardOf = (calls) =>
  /^Hard-block dimensions: (.*)$/mu.exec(promptOf(calls, 'gatekeeper'))?.[1];

/** Read-only throughout: no write tool anywhere, and the checkout ends as it started. */
async function untouched(env, calls) {
  assert.ok(
    calls.every(
      (call) =>
        !(call.options.tools ?? []).some((tool) => /^(?:Write|Edit|Bash)/u.test(tool)) &&
        (call.options.sandbox ?? 'read-only') === 'read-only',
    ),
  );
  assert.equal(git(env.cwd, 'status', '--porcelain=v1', '--untracked-files=all'), '');
  assert.equal(await readFile(join(env.cwd, 'target.mjs'), 'utf8'), pristine);
  noNewRefs(env);
}

/** The run adds no branch or tag; the reader pins it leaves are all under refs/quiet-choir/. */
function noNewRefs(env) {
  const refs = git(env.cwd, 'for-each-ref', '--format=%(refname)').split('\n');
  assert.deepEqual(
    refs.filter((ref) => ref.startsWith('refs/heads/')),
    [git(env.cwd, 'symbolic-ref', 'HEAD')],
  );
  assert.ok(
    refs.every((ref) => /^refs\/(?:heads|tags|quiet-choir)\//u.test(ref)),
    refs.join(' '),
  );
}

export async function check({ result, env, calls }) {
  const { output } = result;
  assert.equal(output.status, 'complete');
  assert.equal(output.decision, 'conditional-go');
  assert.equal(output.decidedBy, 'gatekeeper');
  assert.deepEqual(output.allowed, ['conditional-go', 'no-go']);
  assert.deepEqual(output.conditions, [condition]);
  assert.deepEqual(
    [output.since, output.start, output.end, output.manifest],
    ['v1.0.0', env.since, env.until, [env.until]],
  );
  assert.deepEqual(rows(output), [
    ['tests', 'pass', 'pass', null],
    ['coverage-on-diff', 'pass', 'pass', null],
    ['breaking-changes', 'blocker', 'blocker', 'confirmed'],
    ['security', 'pass', 'pass', null],
    ['migrations-rollback', 'not-applicable', 'not-applicable', null],
    ['performance', 'concern', 'concern', null],
  ]);
  assert.deepEqual(
    output.blockers.map((row) => [row.dimension, row.hard, row.confirmation]),
    [['breaking-changes', false, 'confirmed']],
  );
  assert.deepEqual(
    output.warnings.map((row) => [row.dimension, row.downgraded]),
    [['performance', false]],
  );
  assert.deepEqual(output.unverified, []);
  assert.deepEqual(
    output.tests.map((row) => [row.code, row.verdict, row.rerun]),
    [[0, 'pass', null]],
  );
  assert.deepEqual(
    output.evidence.map((row) => [row.dimension, row.code, row.failure, row.error, row.clipped]),
    [['security', 0, null, null, false]],
  );
  assert.deepEqual([output.log.clipped, output.patch.clipped], [false, false]);
  // Five assessors, one confirmer for the one reported blocker, one gatekeeper.
  assert.deepEqual(ids(calls), [
    'confirmations/breaking-changes/confirm',
    'dimensions/breaking-changes/assess',
    'dimensions/coverage-on-diff/assess',
    'dimensions/migrations-rollback/assess',
    'dimensions/performance/assess',
    'dimensions/security/assess',
    'gatekeeper',
  ]);
  // Code hands each assessor and confirmer the pinned patch, and only the security dimension's
  // assessor (or confirmer) its command output; each reads its own checkout, not the source.
  for (const call of calls.filter((call) => /^(?:assess|confirm)$/u.test(leaf(call.call.stepId)))) {
    assert.notEqual(call.cwd, env.cwd);
    assert.match(call.options.prompt, /\+Fixture project/u);
    assert.ok(call.options.prompt.includes('The range v1.0.0..HEAD: 1 commit(s), oldest first.'));
    assert.ok(call.options.prompt.includes(testedLine));
    assert.equal(
      call.options.prompt.includes(auditLine),
      call.call.stepId === 'dimensions/security/assess',
    );
  }
  const gatekeeper = calls.find((call) => call.call.stepId === 'gatekeeper');
  assert.deepEqual(gatekeeper.options.tools, []);
  assert.deepEqual(gatekeeperEnum(calls), ['conditional-go', 'no-go']);
  assert.ok(gatekeeper.options.prompt.startsWith('Render the release decision for v1.0.0..HEAD '));
  assert.deepEqual([ruleOf(calls), hardOf(calls)], ['conditional-go or no-go', 'tests, security']);
  await untouched(env, calls);
  // What a run leaves behind: one run-owned pin of the gated commit per reader call.
  const pins = git(env.cwd, 'for-each-ref', '--format=%(objectname)', 'refs/quiet-choir/');
  assert.deepEqual(pins.split('\n'), Array(6).fill(env.until));
}

export const readOnly =
  "Read-only gate: agents only read and code runs the operator's commands; no prescribed write effect to kill";

/**
 * Every agent call is settled and retried on a process failure, so the faults name one assessor
 * of the concurrent dimension map: F1 is retried away, and F2 leaves security unassessed.
 */
export const faults = { F1: '^dimensions/security/assess$', F2: '^dimensions/security/assess$' };

export const modes = [
  {
    // Code's own red test is a hard block with no confirmer: only no-go is offered.
    mode: 'red-tests',
    input: () => ({ testCommands: [[process.execPath, '-e', red]] }),
    async check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'complete');
      assert.equal(output.decision, 'no-go');
      assert.deepEqual(output.allowed, ['no-go']);
      assert.deepEqual(gatekeeperEnum(calls), ['no-go']);
      assert.equal(ruleOf(calls), 'only no-go');
      assert.deepEqual(
        output.tests.map((row) => [row.code, row.rerun?.code, row.verdict]),
        [[3, 3, 'failed']],
      );
      assert.deepEqual(
        output.blockers.map((row) => [row.dimension, row.hard, row.confirmation]),
        [
          ['tests', true, null],
          ['breaking-changes', false, 'confirmed'],
        ],
      );
      assert.match(output.blockers[0].findings[0], /1 failing: value is two/u);
      assert.deepEqual(
        ids(calls).filter((id) => id.startsWith('confirmations/')),
        ['confirmations/breaking-changes/confirm'],
      );
      await untouched(env, calls);
    },
  },
  {
    // A failure that passes on its one rerun is a flaky concern, not a blocker.
    mode: 'flaky-tests',
    input: (env) => ({ testCommands: [[process.execPath, '-e', flaky(join(env.root, 'flaky'))]] }),
    async check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'complete');
      assert.deepEqual(
        output.tests.map((row) => [row.code, row.rerun?.code, row.verdict]),
        [[1, 0, 'flaky']],
      );
      assert.deepEqual(output.blockers, []);
      assert.deepEqual(
        output.warnings.map((row) => [row.dimension, row.downgraded]),
        [['tests', false]],
      );
      assert.deepEqual(output.allowed, ['go', 'conditional-go']);
      assert.equal(ruleOf(calls), 'go or conditional-go');
      assert.equal(output.decision, 'conditional-go');
      assert.equal(
        calls.some((call) => call.call.stepId.startsWith('confirmations/')),
        false,
      );
      await untouched(env, calls);
    },
  },
  {
    // The Codex confirmer clears a hard-block blocker, so the gate does not cry wolf.
    mode: 'refuted-blocker',
    async check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'complete');
      assert.equal(output.decision, 'go');
      assert.deepEqual(output.conditions, []);
      assert.deepEqual(output.allowed, ['go', 'conditional-go']);
      assert.deepEqual(output.blockers, []);
      const security = output.dimensions.find((row) => row.dimension === 'security');
      assert.deepEqual(
        [security.reported, security.status, security.confirmation],
        ['blocker', 'pass', 'not-a-problem'],
      );
      assert.equal(security.reasoning, 'The token is a documented placeholder');
      // The confirmer sees the audit output its assessor judged.
      const confirmer = calls.find((call) => leaf(call.call.stepId) === 'confirm');
      assert.equal(confirmer.call.stepId, 'confirmations/security/confirm');
      assert.ok(confirmer.options.prompt.includes(auditLine));
      await untouched(env, calls);
    },
  },
  {
    // A failed assessor on a hard-block dimension leaves it unverified: go is ruled out.
    mode: 'failed-assessor',
    async check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      // One retry, then the failure settles and replays on resume.
      assert.equal(ids(calls).filter((id) => id === 'dimensions/security/assess').length, 2);
      assert.deepEqual(output.unverified, ['security']);
      assert.equal(
        output.dimensions.find((row) => row.dimension === 'security').reported,
        'unassessed',
      );
      assert.deepEqual(output.allowed, ['conditional-go', 'no-go']);
      assert.equal(output.decision, 'conditional-go');
      await untouched(env, calls);
    },
  },
  {
    // A confirmer that fails keeps its blocker standing, unconfirmed: the gate fails closed.
    mode: 'failed-confirmer',
    async check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(
        output.blockers.map((row) => [row.dimension, row.hard, row.confirmation]),
        [['security', true, 'unconfirmed']],
      );
      // One retry, then the failure settles; its cause is the row's reasoning.
      assert.equal(ids(calls).filter((id) => id === 'confirmations/security/confirm').length, 2);
      assert.match(
        output.dimensions.find((row) => row.dimension === 'security').reasoning,
        /^The confirmer failed \(process: [^)]+\), so the blocker stands\.$/u,
      );
      assert.deepEqual(output.allowed, ['no-go']);
      assert.equal(output.decision, 'no-go');
      await untouched(env, calls);
    },
  },
  {
    // The upstream's fallback: when the gatekeeper fails its retry too, code takes the first
    // allowed decision, with a condition per blocker and per unverified hard-block dimension.
    mode: 'gatekeeper-fails',
    input: () => ({ evidenceCommands: input().evidenceCommands }),
    async check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.equal(ids(calls).filter((id) => id === 'gatekeeper').length, 2);
      assert.equal(output.decidedBy, 'code');
      assert.deepEqual(output.allowed, ['conditional-go', 'no-go']);
      assert.equal(output.decision, 'conditional-go');
      assert.deepEqual(output.unverified, ['tests']);
      assert.deepEqual(output.conditions, [
        'Resolve the breaking-changes blocker.',
        'Verify tests; the gate could not.',
      ]);
      assert.equal(
        output.rationale,
        'conditional-go, decided by code because the gatekeeper failed: 1 blocker(s), 1 concern(s), 1 unverified hard-block dimension(s).',
      );
      await untouched(env, calls);
    },
  },
  {
    // A command that rewrites a tracked file is caught by code before any assessor reads the tree.
    mode: 'dirtying-command',
    input: () => ({ testCommands: [[process.execPath, '-e', rewrite]] }),
    async check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'refused');
      assert.equal(output.decision, 'no-go');
      assert.equal(
        output.reason,
        'A test or evidence command changed tracked files (M target.mjs).',
      );
      assert.deepEqual([output.start, output.end], [env.since, env.until]);
      assert.deepEqual(
        output.tests.map((row) => [row.code, row.verdict]),
        [[0, 'pass']],
      );
      assert.equal(calls.length, 0);
      // The gate reports the change and does not undo the operator's command.
      assert.equal(git(env.cwd, 'status', '--porcelain=v1'), 'M target.mjs');
    },
  },
  {
    // No release tag matches: the gate refuses before any agent runs, and fails closed.
    mode: 'no-tag',
    input: () => ({ tagPattern: 'release-*' }),
    async check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'refused');
      assert.equal(output.decision, 'no-go');
      assert.match(
        output.reason,
        /^No tag matching release-\* other than HEAD's own is reachable from HEAD/u,
      );
      assert.deepEqual(output.dimensions, []);
      assert.equal(calls.length, 0);
      await untouched(env, calls);
    },
  },
  {
    // A since that names no commit is refused like a missing tag, not a crash.
    mode: 'bad-since',
    input: () => ({ ...input(), since: 'no-such-revision' }),
    async check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'refused');
      assert.equal(output.decision, 'no-go');
      assert.match(output.reason, /^since no-such-revision does not name a commit/u);
      assert.deepEqual([output.since, output.start, output.tests], [null, null, []]);
      assert.equal(calls.length, 0);
      await untouched(env, calls);
    },
  },
  {
    // A tagged release candidate is gated against the previous tag, not its own.
    mode: 'tagged-head',
    setup: (env) => git(env.cwd, 'tag', 'v1.1.0', env.until),
    async check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'complete');
      assert.deepEqual(
        [output.since, output.start, output.end, output.manifest],
        ['v1.0.0', env.since, env.until, [env.until]],
      );
      assert.equal(output.decision, 'conditional-go');
      await untouched(env, calls);
    },
  },
  {
    // Without a test command the tests dimension is cannot-check: unverified on a hard block, so
    // go is ruled out even though no assessor reports a blocker.
    mode: 'no-test-commands',
    input: () => ({ evidenceCommands: input().evidenceCommands }),
    async check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(output.tests, []);
      assert.deepEqual(rows(output)[0], ['tests', 'cannot-check', 'cannot-check', null]);
      assert.deepEqual(output.unverified, ['tests']);
      assert.deepEqual(output.blockers, []);
      assert.deepEqual(output.allowed, ['conditional-go', 'no-go']);
      assert.deepEqual(gatekeeperEnum(calls), ['conditional-go', 'no-go']);
      assert.match(
        calls.find((call) => call.call.stepId === 'gatekeeper').options.prompt,
        /Nobody could verify these hard-block dimensions: tests\./u,
      );
      // No test ran, so no reader is told that one did.
      assert.ok(!calls.some((call) => call.options.prompt.includes(testedLine)));
      await untouched(env, calls);
    },
  },
  {
    // A test command that cannot start, and one that times out twice, are not red tests: the suite
    // is unverified (cannot-check) and the gate degraded, rather than a complete no-go.
    mode: 'tests-not-run',
    input: () => ({
      ...input(),
      testCommands: [
        ['definitely-not-a-test-binary', 'test'],
        [process.execPath, '-e', hang],
      ],
      commandTimeoutMs: 1000,
    }),
    async check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(
        output.tests.map((row) => [row.verdict, row.failure, row.code, row.rerun?.failure ?? null]),
        [
          ['not-run', 'process', null, null],
          ['unfinished', 'timeout', null, 'timeout'],
        ],
      );
      assert.match(output.tests[0].error, /^Cannot start definitely-not-a-test-binary/u);
      const tests = output.dimensions[0];
      assert.deepEqual([tests.reported, tests.status], ['cannot-check', 'cannot-check']);
      assert.match(tests.findings[0], /could not start, so it was not run: Cannot start/u);
      assert.match(tests.findings[1], /did not finish within 1000 ms on either run \(timed out/u);
      assert.deepEqual(output.unverified, ['tests']);
      assert.deepEqual(output.blockers, []);
      assert.deepEqual(output.allowed, ['conditional-go', 'no-go']);
      await untouched(env, calls);
    },
  },
  {
    // blockOn is honored exactly: a confirmed breaking-changes blocker becomes the hard block.
    mode: 'block-on',
    input: () => ({ ...input(), blockOn: ['breaking-changes'] }),
    async check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'complete');
      assert.deepEqual(output.blockOn, ['breaking-changes']);
      assert.deepEqual(
        output.blockers.map((row) => [row.dimension, row.hard, row.confirmation]),
        [['breaking-changes', true, 'confirmed']],
      );
      assert.deepEqual(output.allowed, ['no-go']);
      assert.deepEqual(gatekeeperEnum(calls), ['no-go']);
      assert.deepEqual([ruleOf(calls), hardOf(calls)], ['only no-go', 'breaking-changes']);
      assert.equal(output.decision, 'no-go');
      await untouched(env, calls);
    },
  },
  {
    // A confirmer's concern downgrades the blocker to a warning instead of clearing it.
    mode: 'downgraded-concern',
    async check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'complete');
      assert.deepEqual(rows(output)[2], ['breaking-changes', 'blocker', 'concern', 'concern']);
      assert.deepEqual(output.blockers, []);
      assert.deepEqual(
        output.warnings.map((row) => [row.dimension, row.downgraded]),
        [
          ['breaking-changes', true],
          ['performance', false],
        ],
      );
      assert.deepEqual(output.allowed, ['go', 'conditional-go']);
      assert.match(
        calls.find((call) => call.call.stepId === 'gatekeeper').options.prompt,
        /a blocker its confirmer downgraded: Documented in the README/u,
      );
      await untouched(env, calls);
    },
  },
  {
    // An evidence command longer than the excerpt: its assessor sees only the end, marked clipped,
    // and the gate says limited.
    mode: 'limited',
    input: () => ({
      ...input(),
      evidenceCommands: [{ dimension: 'security', argv: [process.execPath, '-e', longAudit] }],
    }),
    async check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'limited');
      assert.deepEqual(
        output.evidence.map((row) => [row.dimension, row.code, row.truncated, row.clipped]),
        [['security', 0, false, true]],
      );
      const prompt = calls.find((call) => call.call.stepId === 'dimensions/security/assess').options
        .prompt;
      assert.match(prompt, /<command outcome="exit 0" clipped="true">\n<argv>[^\n]+<\/argv>/u);
      assert.ok(prompt.includes(auditLine));
      assert.ok(!prompt.includes('x'.repeat(16001)));
      await untouched(env, calls);
    },
  },
  {
    // A reader that changes its pinned checkout broke its contract: code drops its answer, so the
    // dimension is unassessed, and nothing reaches the source checkout.
    mode: 'writing-assessor',
    async check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      const security = output.dimensions.find((row) => row.dimension === 'security');
      assert.equal(security.reported, 'unassessed');
      assert.match(security.evidence, /A read-only role changed its checkout: added notes\.txt/u);
      assert.deepEqual(output.unverified, ['security']);
      assert.deepEqual(output.allowed, ['conditional-go', 'no-go']);
      // The settled failure is the assessor's answer; it is not asked again.
      assert.equal(ids(calls).filter((id) => id === 'dimensions/security/assess').length, 1);
      await untouched(env, calls);
    },
  },
  {
    // An untracked file the tests could read is not HEAD: refused before any command runs.
    mode: 'untracked-start',
    setup: (env) => writeFileSync(join(env.cwd, 'helper.mjs'), 'export {};\n'),
    input: () => ({ testCommands: [[process.execPath, '--input-type=module', '-e', helper]] }),
    async check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'refused');
      assert.equal(output.decision, 'no-go');
      assert.match(output.reason, /^The checkout differs from HEAD \(\?\? helper\.mjs\);/u);
      assert.deepEqual([output.start, output.tests, output.dimensions], [null, [], []]);
      assert.equal(calls.length, 0);
      // The gate reports the file and leaves it alone.
      assert.equal(git(env.cwd, 'status', '--porcelain=v1'), '?? helper.mjs');
    },
  },
  {
    // An untracked artifact a test leaves behind does not refuse the gate, and never reaches the
    // readers, which work in their own checkouts of the pinned commit.
    mode: 'test-artifacts',
    input: () => ({ ...input(), testCommands: [[process.execPath, '-e', artifact]] }),
    async check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'complete');
      assert.equal(output.reason, null);
      assert.deepEqual(
        output.tests.map((row) => [row.code, row.verdict]),
        [[0, 'pass']],
      );
      assert.equal(output.decision, 'conditional-go');
      assert.equal(calls.filter((call) => leaf(call.call.stepId) === 'assess').length, 5);
      assert.equal(git(env.cwd, 'status', '--porcelain=v1'), '?? coverage/');
    },
  },
  {
    // A range longer than maxRangeChars: every reader sees the first part of its log (at most a
    // quarter of the budget) and of its patch (the rest), told so, and the gate says limited.
    mode: 'clipped-range',
    setup: (env) => {
      writeFileSync(join(env.cwd, 'big.txt'), `${'y'.repeat(60)}\n`.repeat(50));
      commitAll(env.cwd, `Add big.txt\n\n${'Long release note. '.repeat(80)}`);
    },
    input: () => ({ ...input(), maxRangeChars: 1000 }),
    async check({ result, env, calls }) {
      const { output } = result;
      const end = git(env.cwd, 'rev-parse', 'HEAD');
      assert.equal(output.status, 'limited');
      assert.deepEqual([output.end, output.manifest], [end, [env.until, end]]);
      assert.deepEqual([output.log.clipped, output.patch.clipped], [true, true]);
      assert.ok(output.log.chars > 1000 && output.patch.chars > 3000);
      const prompt = calls.find((call) => call.call.stepId === 'dimensions/security/assess').options
        .prompt;
      for (const [name, excerpt, size] of [
        ['log', output.log, 250],
        ['patch', output.patch, 750],
      ]) {
        assert.ok(
          prompt.includes(
            `The ${name} is clipped to its first ${String(size)} of ${String(excerpt.chars)} characters.`,
          ),
        );
        const block = new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`, 'u').exec(prompt);
        assert.equal(block?.[1].length, size);
        // The excerpt is the head: the log's oldest commit, the patch's stat summary.
        assert.match(
          block[1],
          name === 'log'
            ? new RegExp(`^commit ${env.until}\\n`, 'u')
            : /^ README\.md +\| +1 \+\n big\.txt +\| +50 \++\n 2 files changed/u,
        );
      }
      await untouched(env, calls);
    },
  },
  {
    // Evidence commands that cannot start or time out are recorded failures: their assessors are
    // told so, and the gate is degraded rather than complete.
    mode: 'evidence-failures',
    input: () => ({
      ...input(),
      evidenceCommands: [
        { dimension: 'security', argv: ['definitely-not-an-audit-binary'] },
        { dimension: 'performance', argv: [process.execPath, '-e', hang] },
      ],
      commandTimeoutMs: 1000,
    }),
    async check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(
        output.evidence.map((row) => [row.dimension, row.failure, row.code]),
        [
          ['security', 'process', null],
          ['performance', 'timeout', null],
        ],
      );
      const prompt = (dimension) =>
        calls.find((call) => call.call.stepId === `dimensions/${dimension}/assess`).options.prompt;
      assert.match(prompt('security'), /<command outcome="could not start">\n<argv>definitely/u);
      assert.match(prompt('performance'), /<command outcome="timed out">/u);
      assert.equal(output.decision, 'conditional-go');
      await untouched(env, calls);
    },
  },
  {
    // A test that fails, then times out on its rerun, failed and never passed: a red test.
    mode: 'fail-then-timeout',
    input: (env) => ({
      ...input(),
      testCommands: [[process.execPath, '-e', failThenHang(join(env.root, 'failed-once'))]],
      commandTimeoutMs: 1000,
    }),
    async check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'complete');
      assert.deepEqual(
        output.tests.map((row) => [row.code, row.rerun?.failure, row.verdict]),
        [[1, 'timeout', 'failed']],
      );
      assert.deepEqual(output.allowed, ['no-go']);
      assert.equal(output.decision, 'no-go');
      // The finding quotes the failed run's output, marked as its end.
      assert.match(
        output.blockers[0].findings[0],
        /failed on a run and never passed \(exit 1, then timed out\)\. Output ends \(last 2000 of 3024 characters\): z+ first run: value is two$/u,
      );
      await untouched(env, calls);
    },
  },
  {
    // Three reported blockers whose confirmers disagree, under a house policy of the operator's:
    // each verdict lands on its own blocker, each confirmer sees only its own assessor's case,
    // and the gatekeeper sees every standing blocker's evidence and findings.
    mode: 'several-blockers',
    input: () => ({ ...input(), policy: housePolicy }),
    async check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'complete');
      const byDimension = Object.fromEntries(output.dimensions.map((row) => [row.dimension, row]));
      for (const [dimension, { verdict, reasoning }] of Object.entries(verdicts)) {
        const row = byDimension[dimension];
        assert.deepEqual(
          [row.reported, row.status, row.confirmation, row.reasoning],
          ['blocker', verdict === 'confirmed' ? 'blocker' : 'pass', verdict, reasoning],
        );
      }
      assert.deepEqual(
        output.blockers.map((row) => [row.dimension, row.hard, row.confirmation, row.findings]),
        [
          ['security', true, 'confirmed', ['Token committed in README.md']],
          ['migrations-rollback', false, 'confirmed', ['Irreversible drop of users']],
        ],
      );
      assert.deepEqual(
        output.warnings.map((row) => row.dimension),
        ['performance'],
      );
      assert.deepEqual(output.allowed, ['no-go']);
      assert.equal(output.decision, 'no-go');
      const cases = { ...assessments, ...several };
      for (const dimension of Object.keys(verdicts)) {
        const prompt = promptOf(calls, `confirmations/${dimension}/confirm`);
        for (const [other, { evidence, findings }] of Object.entries(cases))
          if (other in verdicts)
            for (const text of [evidence, ...findings])
              assert.equal(prompt.includes(text), other === dimension, `${dimension}: ${text}`);
      }
      const decide = promptOf(calls, 'gatekeeper');
      assert.ok(
        decide.includes(
          '- security, a hard block: README.md shows a live token\n  - Token committed in README.md',
        ),
      );
      assert.ok(
        decide.includes(
          '- migrations-rollback: drop.sql drops the users table with no down migration\n  - Irreversible drop of users',
        ),
      );
      assert.ok(decide.includes('(a blocker its confirmer cleared: The flag was never public)'));
      // The operator's policy, not the default, reaches every role.
      const judged = calls.filter((call) => /^(?:assess|confirm)$/u.test(leaf(call.call.stepId)));
      assert.equal(judged.length, 8);
      for (const call of [...judged, calls.find((call) => call.call.stepId === 'gatekeeper')]) {
        assert.ok(call.options.prompt.includes(`House policy: ${housePolicy}`), call.call.stepId);
        assert.ok(!call.options.prompt.includes('Tests must pass;'), call.call.stepId);
      }
      await untouched(env, calls);
    },
  },
  {
    // A failed assessor on a dimension that is not a hard block degrades the gate but leaves
    // nothing unverified, so go stays allowed.
    mode: 'failed-nonhard-assessor',
    async check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.equal(ids(calls).filter((id) => id === 'dimensions/performance/assess').length, 2);
      const performance = output.dimensions.find((row) => row.dimension === 'performance');
      assert.deepEqual([performance.reported, performance.status], ['unassessed', 'unassessed']);
      assert.deepEqual(output.unverified, []);
      assert.deepEqual(output.blockers, []);
      assert.deepEqual(output.allowed, ['go', 'conditional-go']);
      assert.match(
        promptOf(calls, 'gatekeeper'),
        /\n- performance: unassessed\. The assessor failed/u,
      );
      await untouched(env, calls);
    },
  },
  {
    // An explicit since that is an ancestor of HEAD bounds the range, its log and its patch.
    mode: 'explicit-since',
    setup: (env) => {
      writeFileSync(join(env.cwd, 'notes.md'), 'Release notes\n');
      commitAll(env.cwd, 'Add release notes');
    },
    input: (env) => ({ ...input(), since: env.until }),
    async check({ result, env, calls }) {
      const { output } = result;
      const end = git(env.cwd, 'rev-parse', 'HEAD');
      assert.equal(output.status, 'complete');
      assert.deepEqual(
        [output.since, output.start, output.end, output.manifest],
        [env.until, env.until, end, [end]],
      );
      for (const call of calls.filter((call) => leaf(call.call.stepId) === 'assess')) {
        assert.ok(call.options.prompt.includes(`The range ${env.until}..HEAD: 1 commit(s)`));
        assert.ok(call.options.prompt.includes('+Release notes'));
        assert.ok(!call.options.prompt.includes('+Fixture project'));
      }
      await untouched(env, calls);
    },
  },
  {
    // A since off HEAD's history is refused: its log and its tree diff would disagree.
    mode: 'non-ancestor-since',
    setup: (env) => {
      env.side = git(
        env.cwd,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@localhost',
        'commit-tree',
        `${env.since}^{tree}`,
        '-p',
        env.since,
        '-m',
        'Side',
      );
    },
    input: (env) => ({ ...input(), since: env.side }),
    async check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'refused');
      assert.equal(output.decision, 'no-go');
      assert.match(
        output.reason,
        /^since ([a-f0-9]{40}) \(\1\) is not an ancestor of HEAD, so its log and its patch would disagree;/u,
      );
      assert.deepEqual([output.start, output.tests, output.dimensions], [null, [], []]);
      assert.equal(calls.length, 0);
      await untouched(env, calls);
    },
  },
  {
    // since HEAD: nothing ships, so the gate refuses before any command or agent runs.
    mode: 'empty-range',
    input: () => ({ ...input(), since: 'HEAD' }),
    async check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'refused');
      assert.equal(output.decision, 'no-go');
      assert.deepEqual(output.allowed, ['no-go']);
      assert.equal(output.reason, 'Nothing ships: HEAD..HEAD has no commits.');
      assert.deepEqual(
        [output.since, output.start, output.end, output.manifest, output.tests],
        ['HEAD', env.until, env.until, [], []],
      );
      assert.equal(calls.length, 0);
      await untouched(env, calls);
    },
  },
  {
    // A test killed by a signal on both runs crashed: a red test, not one that could not start.
    mode: 'crashed-tests',
    input: () => ({ ...input(), testCommands: [[process.execPath, '-e', crash]] }),
    async check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'complete');
      assert.deepEqual(
        output.tests.map((row) => [
          row.verdict,
          row.failure,
          row.code,
          row.signal,
          row.rerun?.signal,
        ]),
        [['failed', 'process', null, 'SIGKILL', 'SIGKILL']],
      );
      assert.deepEqual(
        output.blockers.map((row) => [row.dimension, row.hard, row.confirmation]),
        [
          ['tests', true, null],
          ['breaking-changes', false, 'confirmed'],
        ],
      );
      assert.match(
        output.blockers[0].findings[0],
        /failed on a run and never passed \(killed by SIGKILL, then killed by SIGKILL\)\.$/u,
      );
      assert.deepEqual([output.allowed, output.unverified], [['no-go'], []]);
      assert.equal(output.decision, 'no-go');
      await untouched(env, calls);
    },
  },
  {
    // A red test beside one that cannot start: the red one blocks, and the unrunnable one still
    // degrades the gate.
    mode: 'failed-and-unstartable',
    input: () => ({
      ...input(),
      testCommands: [
        [process.execPath, '-e', red],
        ['definitely-not-a-test-binary', 'test'],
      ],
    }),
    async check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(
        output.tests.map((row) => [row.verdict, row.code]),
        [
          ['failed', 3],
          ['not-run', null],
        ],
      );
      const tests = output.dimensions[0];
      assert.deepEqual([tests.reported, tests.status], ['blocker', 'blocker']);
      assert.match(
        tests.findings[0],
        /failed on a run and never passed .*1 failing: value is two$/u,
      );
      assert.match(tests.findings[1], /could not start, so it was not run: Cannot start/u);
      assert.deepEqual([output.allowed, output.unverified], [['no-go'], []]);
      assert.equal(ruleOf(calls), 'only no-go');
      assert.equal(output.decision, 'no-go');
      await untouched(env, calls);
    },
  },
  {
    // The fallback alone degrades the gate: the tests passed and every hard block was verified.
    mode: 'gatekeeper-fails-tested',
    async check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.equal(ids(calls).filter((id) => id === 'gatekeeper').length, 2);
      assert.equal(output.decidedBy, 'code');
      assert.deepEqual(
        output.tests.map((row) => [row.code, row.verdict]),
        [[0, 'pass']],
      );
      assert.deepEqual([output.allowed, output.unverified], [['conditional-go', 'no-go'], []]);
      assert.equal(output.decision, 'conditional-go');
      assert.deepEqual(output.conditions, ['Resolve the breaking-changes blocker.']);
      assert.equal(
        output.rationale,
        'conditional-go, decided by code because the gatekeeper failed: 1 blocker(s), 1 concern(s), 0 unverified hard-block dimension(s).',
      );
      await untouched(env, calls);
    },
  },
  {
    // A confirmer that changes its pinned checkout broke its contract: code drops its verdict, so
    // the blocker stands unconfirmed, and nothing reaches the source checkout.
    mode: 'writing-confirmer',
    async check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(rows(output)[2], ['breaking-changes', 'blocker', 'blocker', 'unconfirmed']);
      assert.match(
        output.dimensions[2].reasoning,
        /^The confirmer failed \(\w+: A read-only role changed its checkout: added notes\.txt\), so the blocker stands\.$/u,
      );
      assert.deepEqual(
        output.blockers.map((row) => [row.dimension, row.hard, row.confirmation]),
        [['breaking-changes', false, 'unconfirmed']],
      );
      assert.equal(ids(calls).filter((id) => id.startsWith('confirmations/')).length, 1);
      assert.deepEqual(output.allowed, ['conditional-go', 'no-go']);
      await untouched(env, calls);
    },
  },
  {
    // A test that commits moves HEAD: its verdict, and every command after it, describe another
    // commit, so the gate refuses before any agent runs and leaves the commit to the operator.
    mode: 'committing-command',
    input: () => ({ ...input(), testCommands: [commits] }),
    async check({ result, env, calls }) {
      const { output } = result;
      const branch = git(env.cwd, 'symbolic-ref', 'HEAD');
      const now = git(env.cwd, 'rev-parse', 'HEAD');
      assert.equal(git(env.cwd, 'rev-parse', 'HEAD^'), env.until);
      assert.equal(output.status, 'refused');
      assert.equal(output.decision, 'no-go');
      assert.equal(
        output.reason,
        `A test or evidence command moved HEAD from ${branch} at ${env.until} to ${branch} at ${now}; the gate runs the operator's commands on the gated commit only.`,
      );
      assert.deepEqual(
        [
          output.end,
          output.tests.map((row) => row.verdict),
          output.evidence.map((row) => row.code),
        ],
        [env.until, ['pass'], [0]],
      );
      assert.equal(calls.length, 0);
    },
  },
  {
    // A test that switches branch moves HEAD too, even on the same commit.
    mode: 'switching-command',
    input: () => ({ ...input(), testCommands: [switches] }),
    async check({ result, env, calls }) {
      const { output } = result;
      const [branch] = git(env.cwd, 'for-each-ref', '--format=%(refname)', 'refs/heads/')
        .split('\n')
        .filter((ref) => ref !== 'refs/heads/side');
      assert.equal(git(env.cwd, 'symbolic-ref', 'HEAD'), 'refs/heads/side');
      assert.equal(output.status, 'refused');
      assert.equal(
        output.reason,
        `A test or evidence command moved HEAD from ${branch} at ${env.until} to refs/heads/side at ${env.until}; the gate runs the operator's commands on the gated commit only.`,
      );
      assert.equal(calls.length, 0);
    },
  },
];

/** A clipped excerpt means an assessor saw only part of the range or of a command's output. */
export const degraded = (output) => output.status === 'limited';
