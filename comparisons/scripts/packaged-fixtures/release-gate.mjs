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
const overrides = {
  'no-test-commands': quiet,
  'tests-not-run': quiet,
  'flaky-tests': quiet,
  'refuted-blocker': token,
  'failed-confirmer': token,
};
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
  if (/^confirmations\/[a-z-]+\/confirm$/u.test(id)) {
    pinnedReader(request, env);
    assert.equal(request.harness, 'codex');
    assert.equal(request.options.sandbox, 'read-only');
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
    (mode === 'failed-confirmer' && id === 'confirmations/security/confirm') ||
    (mode === 'gatekeeper-fails' && id === 'gatekeeper')
  );
}

const ids = (calls) => calls.map((call) => call.call.stepId).sort();
const rows = (output) =>
  output.dimensions.map((row) => [row.dimension, row.reported, row.status, row.confirmation]);
const gatekeeperEnum = (calls) =>
  enumOf(calls.find((call) => call.call.stepId === 'gatekeeper').outputSchema, 'decision');

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
    assert.equal(
      call.options.prompt.includes(auditLine),
      call.call.stepId === 'dimensions/security/assess',
    );
  }
  const gatekeeper = calls.find((call) => call.call.stepId === 'gatekeeper');
  assert.deepEqual(gatekeeper.options.tools, []);
  assert.deepEqual(gatekeeperEnum(calls), ['conditional-go', 'no-go']);
  await untouched(env, calls);
}

export const readOnly =
  "Read-only gate: agents only read and code runs the operator's commands; no prescribed write effect to kill";

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
      assert.deepEqual(output.allowed, ['no-go']);
      assert.equal(output.decision, 'no-go');
      await untouched(env, calls);
    },
  },
  {
    // The upstream's fallback: when the gatekeeper fails, code takes the first allowed decision.
    mode: 'gatekeeper-fails',
    async check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.equal(output.decidedBy, 'code');
      assert.equal(output.decision, 'conditional-go');
      assert.deepEqual(output.conditions, ['Resolve the breaking-changes blocker.']);
      assert.match(output.rationale, /decided by code because the gatekeeper failed/u);
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
    input: (env) => {
      git(env.cwd, 'tag', 'v1.1.0', env.until);
      return input();
    },
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
    input: (env) => {
      writeFileSync(join(env.cwd, 'helper.mjs'), 'export {};\n');
      return { testCommands: [[process.execPath, '--input-type=module', '-e', helper]] };
    },
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
    // A range longer than maxPatchChars: every reader sees the first part of its log and its
    // patch, told so, and the gate says limited.
    mode: 'clipped-range',
    input: (env) => {
      writeFileSync(join(env.cwd, 'big.txt'), `${'y'.repeat(60)}\n`.repeat(50));
      commitAll(env.cwd, `Add big.txt\n\n${'Long release note. '.repeat(80)}`);
      return { ...input(), maxPatchChars: 1000 };
    },
    async check({ result, env, calls }) {
      const { output } = result;
      const end = git(env.cwd, 'rev-parse', 'HEAD');
      assert.equal(output.status, 'limited');
      assert.deepEqual([output.end, output.manifest], [end, [env.until, end]]);
      assert.deepEqual([output.log.clipped, output.patch.clipped], [true, true]);
      assert.ok(output.log.chars > 1000 && output.patch.chars > 3000);
      const prompt = calls.find((call) => call.call.stepId === 'dimensions/security/assess').options
        .prompt;
      for (const [name, excerpt] of [
        ['log', output.log],
        ['patch', output.patch],
      ]) {
        assert.ok(
          prompt.includes(
            `The ${name} is clipped to its first 1000 of ${String(excerpt.chars)} characters.`,
          ),
        );
        const block = new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`, 'u').exec(prompt);
        assert.equal(block?.[1].length, 1000);
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
];

/** A clipped excerpt means an assessor saw only part of the range or of a command's output. */
export const degraded = (output) => output.status === 'limited';
