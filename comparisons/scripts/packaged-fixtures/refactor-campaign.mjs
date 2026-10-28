// refactor-campaign: pricing.mjs computes the same price-times-quantity loop twice and
// clock.mjs reads the wall clock. The survey finds both and target.mjs, the ranker defers
// target.mjs, the net writer pins pricing.mjs in its worktree with a test file and a cases file
// (code runs the net green on the current code) and cannot pin the clock, a human approves the
// goal and plan, the refactorer extracts a subtotal helper behind the net, code runs the net and
// the verify command again, the reviewer judges the diff structural, and code publishes the net
// and the refactor after final verification onto the unmoved checkout.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commitAll, git, leaf, writeFiles } from './_support.mjs';

const pricing = [
  'export function total(items) {',
  '  let sum = 0;',
  '  for (const item of items) sum += item.price * item.qty;',
  '  return sum;',
  '}',
  '',
  'export function totalWithTax(items, rate) {',
  '  let sum = 0;',
  '  for (const item of items) sum += item.price * item.qty;',
  '  return sum * (1 + rate);',
  '}',
  '',
].join('\n');
const refactored = (tax) =>
  [
    'const subtotal = (items) => {',
    '  let sum = 0;',
    '  for (const item of items) sum += item.price * item.qty;',
    '  return sum;',
    '};',
    '',
    'export function total(items) {',
    '  return subtotal(items);',
    '}',
    '',
    'export function totalWithTax(items, rate) {',
    `  return ${tax};`,
    '}',
    '',
  ].join('\n');
const structural = 'subtotal(items) * (1 + rate)';
const behavioral = 'subtotal(items) * rate';
const netFile = 'pricing.net.test.mjs';
const casesFile = 'pricing.cases.json';
const net = [
  "import assert from 'node:assert/strict';",
  "import { readFileSync } from 'node:fs';",
  "import { total, totalWithTax } from './pricing.mjs';",
  `const cases = JSON.parse(readFileSync(new URL('./${casesFile}', import.meta.url), 'utf8'));`,
  'assert.equal(total([{ price: 2, qty: 3 }, { price: 1, qty: 1 }]), 7);',
  'assert.equal(total([]), 0);',
  'assert.equal(totalWithTax(cases.items, cases.rate), cases.taxed);',
  '',
].join('\n');
const cases = (taxed) =>
  `${JSON.stringify({ items: [{ price: 10, qty: 1 }], rate: 0.5, taxed })}\n`;
const behaviorsPinned = ['total sums price times quantity', 'totalWithTax scales it by 1 + rate'];
const targets = [
  {
    location: 'pricing.mjs:totalWithTax',
    pressure: 'duplication',
    evidence: 'The price-times-quantity loop appears at 2 sites',
    testability: 'untested',
  },
  {
    location: 'clock.mjs:stamp',
    pressure: 'coupling',
    evidence: 'Reads the wall clock directly; fan-in 3',
    testability: 'untested',
  },
  {
    location: 'target.mjs',
    pressure: 'primitive-obsession',
    evidence: 'A bare numeric constant',
    testability: 'well-tested',
  },
];
const ranked = [
  {
    location: 'pricing.mjs:totalWithTax',
    refactoring: 'Extract function subtotal',
    payoff: 'high',
    risk: 'low',
  },
  {
    location: 'clock.mjs:stamp',
    refactoring: 'Inject the clock',
    payoff: 'medium',
    risk: 'medium',
  },
  { location: 'target.mjs', refactoring: 'Introduce a named constant', payoff: 'low', risk: 'low' },
];
const exists = (file) => `require('node:fs').accessSync(${JSON.stringify(file)})`;
/** A verify command that fails only on a tree holding the subtotal refactor. */
const noSubtotal =
  "if (require('node:fs').readFileSync('pricing.mjs', 'utf8').includes('subtotal')) process.exit(3)";
const writer = /^(?:nets\/\d+\/write\/\d+|refactor\/\d+\/write)$/u;
const netWrite = /^nets\/\d+\/write\/\d+$/u;
const refactorWrite = /^refactor\/\d+\/write$/u;

export async function setup(env) {
  await writeFiles(env.cwd, {
    'pricing.mjs': pricing,
    'clock.mjs': 'export const stamp = () => new Date().toISOString();\n',
  });
  env.base = commitAll(env.cwd, 'add pricing and clock');
}

export const input = () => ({
  testCommand: [process.execPath],
  apply: true,
  verifyCommands: [[process.execPath, '-e', exists(netFile)]],
});

const pinned = (file, supportFiles = []) => ({
  status: 'pinned',
  netFile: file,
  supportFiles,
  behaviorsPinned,
  notes: '',
});

async function writeNet(request, env, mode) {
  const { cwd, options } = request;
  const round = Number(leaf(request.call.stepId));
  if (options.prompt.includes('of target.mjs with')) {
    // no-nets: a net that pins the wrong value in every round.
    await writeFile(
      join(cwd, 'target.net.test.mjs'),
      "import assert from 'node:assert/strict';\nimport { value } from './target.mjs';\nassert.equal(value, 2);\n",
    );
    return pinned('target.net.test.mjs');
  }
  if (options.prompt.includes('of clock.mjs:stamp with')) {
    if (mode !== 'no-nets')
      return {
        status: 'cannot-pin',
        netFile: null,
        supportFiles: [],
        behaviorsPinned: [],
        notes: 'Reads the wall clock',
      };
    // no-nets: a net that leaves a file it does not declare.
    await writeFiles(cwd, {
      'clock.net.test.mjs': "import { stamp } from './clock.mjs';\nstamp();\n",
      'notes.txt': 'scratch\n',
    });
    return pinned('clock.net.test.mjs');
  }
  // net-repair: the first round writes a red net under another name; the repair round starts
  // from a fresh checkout and writes the real one, so the first file is never published.
  if (mode === 'net-repair' && round === 0) {
    assert.equal(existsSync(join(cwd, netFile)), false);
    await writeFile(
      join(cwd, 'pricing.first.test.mjs'),
      "import assert from 'node:assert/strict';\nimport { totalWithTax } from './pricing.mjs';\nassert.equal(totalWithTax([{ price: 10, qty: 1 }], 0.5), 16);\n",
    );
    return pinned('pricing.first.test.mjs');
  }
  if (mode === 'net-repair') assert.equal(existsSync(join(cwd, 'pricing.first.test.mjs')), false);
  await writeFiles(cwd, { [netFile]: net, [casesFile]: cases(15) });
  return pinned(netFile, [casesFile]);
}

async function refactor(request, env, mode) {
  const { cwd } = request;
  await writeFile(
    join(cwd, 'pricing.mjs'),
    refactored(['behavior-change', 'net-support-file'].includes(mode) ? behavioral : structural),
  );
  // net-support-file: the behavior change rewrites the cases file, so every net stays green.
  if (mode === 'net-support-file') await writeFile(join(cwd, casesFile), cases(5));
  if (mode === 'net-touched') await rename(join(cwd, netFile), join(cwd, 'pricing.moved.test.mjs'));
  // checkout-moved: someone commits to the source checkout while the refactor runs.
  if (mode === 'checkout-moved') {
    await writeFile(join(env.cwd, 'README.md'), 'Edited during the run\n');
    env.userCommit = commitAll(env.cwd, 'commit while the campaign runs');
  }
  return { status: 'refactored', summary: 'Extracted subtotal from total and totalWithTax' };
}

export async function reply(request, env, mode) {
  const id = request.call.stepId;
  if (id === 'survey') return { targets: mode === 'no-targets' ? [] : targets };
  if (id === 'rank') return { ranked: ranked.slice(0, mode === 'no-nets' ? 3 : 2) };
  if (netWrite.test(id)) return writeNet(request, env, mode);
  if (refactorWrite.test(id)) return refactor(request, env, mode);
  if (/^refactor\/\d+\/review$/u.test(id))
    return mode === 'reviewer-veto'
      ? { structural: false, reasoning: 'Changes the rounding of the taxed total' }
      : {
          structural: true,
          reasoning: 'Extract function only; the same arithmetic in the same order',
        };
  throw new Error(`Unhandled refactor-campaign step ${id} (${mode})`);
}

export function fail(request, mode) {
  const id = request.call.stepId;
  return (
    (mode === 'refactor-fails' && refactorWrite.test(id)) ||
    (mode === 'no-nets' && id === 'nets/0/write/0')
  );
}

/** The declined mode's goal asks the fixture human to decline; the goal is in the subject. */
export const answer = (question) =>
  /^approve-refactors$/u.test(leaf(question.stepId)) && question.subject?.goal?.includes('decline')
    ? { approved: false, comment: 'Fixture human declined' }
    : undefined;

/** The checkout holds neither the net nor a refactor, and its tree is clean. */
function untouched(env) {
  assert.equal(readFileSync(join(env.cwd, 'pricing.mjs'), 'utf8'), pricing);
  assert.equal(existsSync(join(env.cwd, netFile)), false);
  assert.equal(existsSync(join(env.cwd, casesFile)), false);
  assert.equal(git(env.cwd, 'status', '--porcelain'), '');
}
/** The checkout holds the published net, unchanged, and the original pricing code. */
function netsOnlyPublished(env, output) {
  assert.equal(output.status, 'nets-only');
  assert.deepEqual(output.refactored, []);
  assert.equal(git(env.cwd, 'rev-parse', 'HEAD'), output.commit);
  assert.equal(readFileSync(join(env.cwd, 'pricing.mjs'), 'utf8'), pricing);
  assert.equal(readFileSync(join(env.cwd, netFile), 'utf8'), net);
  assert.equal(readFileSync(join(env.cwd, casesFile), 'utf8'), cases(15));
  assert.equal(git(env.cwd, 'status', '--porcelain'), '');
}
/** The run-owned nets commit holds exactly the green net's two files, on the setup commit. */
function netsCommitHoldsNet(env, output) {
  assert.match(output.netsCommit, /^[a-f0-9]{40}$/u);
  assert.equal(git(env.cwd, 'show', `${output.netsCommit}:${netFile}`), net.trimEnd());
  assert.equal(git(env.cwd, 'show', `${output.netsCommit}:${casesFile}`), cases(15).trimEnd());
  assert.equal(
    git(env.cwd, 'diff', '--name-only', env.base, output.netsCommit),
    `${casesFile}\n${netFile}`,
  );
}
const stepIds = (calls) => calls.map((call) => call.call.stepId);
const noReview = (calls) => assert.ok(!stepIds(calls).includes('refactor/0/review'));

export function check({ result, env, calls, suspended }) {
  const { output } = result;
  assert.equal(output.status, 'applied');
  assert.equal(suspended, 1);
  assert.deepEqual(
    output.deferred.map((target) => target.location),
    ['target.mjs'],
  );
  assert.deepEqual(output.skipped, [
    {
      location: 'clock.mjs:stamp',
      refactoring: 'Inject the clock',
      why: 'cannot pin: Reads the wall clock',
      failed: false,
    },
  ]);
  assert.deepEqual(output.netOnly, []);
  assert.equal(output.failedNets + output.failedCalls, 0);
  const [done] = output.refactored;
  assert.equal(output.refactored.length, 1);
  assert.equal(done.location, 'pricing.mjs:totalWithTax');
  assert.equal(done.netFile, netFile);
  assert.deepEqual(done.supportFiles, [casesFile]);
  assert.deepEqual(done.files, ['pricing.mjs']);
  assert.equal(done.reviewedWhole, true);
  netsCommitHoldsNet(env, output);
  // The refactorer received the approved goal and plan verbatim, and the digest is of that text.
  const refactorer = calls.find((call) => call.call.stepId === 'refactor/0/write');
  const text = refactorer.options.prompt.split('Approved goal and plan:\n')[1];
  assert.equal(output.approvedDigest, createHash('sha256').update(text).digest('hex'));
  assert.deepEqual(JSON.parse(text), {
    goal: 'reduce complexity and duplication without changing behavior',
    targets: [
      {
        location: done.location,
        refactoring: done.refactoring,
        netFile,
        supportFiles: [casesFile],
        behaviorsPinned,
      },
    ],
  });
  // Both of the net's files are off limits to the refactorer.
  assert.match(
    refactorer.options.prompt,
    /any of them:\n- pricing\.net\.test\.mjs\n- pricing\.cases\.json\n/u,
  );
  // Code ran the net and the verify command on the refactored tree before the reviewer saw it.
  const review = calls.find((call) => call.call.stepId === 'refactor/0/review');
  assert.match(
    review.options.prompt,
    /<diff>\n[^]*\+const subtotal = \(items\) => \{[^]*<\/diff>/u,
  );
  assert.deepEqual(
    output.verification.map((row) => [row.argv.at(-1), row.code]),
    [
      [netFile, 0],
      [exists(netFile), 0],
    ],
  );
  // Published: the net and the refactor, as one fast-forward of the clean, unmoved checkout.
  assert.equal(git(env.cwd, 'rev-parse', 'HEAD'), output.commit);
  assert.equal(git(env.cwd, 'merge-base', env.base, 'HEAD'), env.base);
  assert.equal(
    git(env.cwd, 'diff', '--name-only', env.base, 'HEAD'),
    `${casesFile}\npricing.mjs\n${netFile}`,
  );
  assert.equal(git(env.cwd, 'status', '--porcelain'), '');
  assert.equal(readFileSync(join(env.cwd, 'pricing.mjs'), 'utf8'), refactored(structural));
  assert.equal(readFileSync(join(env.cwd, netFile), 'utf8'), net);
  assert.equal(readFileSync(join(env.cwd, casesFile), 'utf8'), cases(15));
  assert.equal(spawnSync(process.execPath, [netFile], { cwd: env.cwd }).status, 0);
  for (const call of calls)
    if (writer.test(call.call.stepId)) assert.notEqual(call.cwd, env.cwd);
    else assert.ok(!call.options.tools.includes('Write'), call.call.stepId);
}

export const kill = {
  step: '^refactor/0/write$',
  boundary: 'response',
  writeLocation: 'isolated-checkout',
};

export const modes = [
  {
    mode: 'report-only',
    input: () => ({ testCommand: [process.execPath] }),
    check({ result, env, calls, suspended }) {
      const { output } = result;
      assert.equal(output.status, 'report');
      assert.equal(suspended, 0);
      assert.deepEqual(
        output.netOnly.map((entry) => [entry.location, entry.why]),
        [['pricing.mjs:totalWithTax', 'apply is false; refactor not performed']],
      );
      assert.equal(output.approvedDigest, null);
      netsCommitHoldsNet(env, output);
      // The summary says where the nets are, since the checkout does not hold them.
      assert.ok(output.summary.includes(`run-owned commit ${output.netsCommit}`), output.summary);
      assert.ok(stepIds(calls).every((id) => !id.startsWith('refactor/')));
      untouched(env);
    },
  },
  {
    mode: 'net-repair',
    check({ result, env, calls }) {
      assert.equal(result.output.status, 'applied');
      const repair = calls.find((call) => call.call.stepId === 'nets/0/write/1');
      assert.match(repair.options.prompt, /Your previous net, pricing\.first\.test\.mjs, failed/u);
      assert.match(repair.options.prompt, /<output>\n[^]*16[^]*<\/output>/u);
      assert.match(
        repair.options.prompt,
        /<file path="pricing\.first\.test\.mjs">\n[^]*, 16\);\n<\/file>/u,
      );
      // The superseded red file never reaches the nets commit or the checkout.
      netsCommitHoldsNet(env, result.output);
      assert.equal(existsSync(join(env.cwd, 'pricing.first.test.mjs')), false);
      assert.equal(readFileSync(join(env.cwd, netFile), 'utf8'), net);
    },
  },
  {
    mode: 'behavior-change',
    check({ result, env, calls }) {
      const { output } = result;
      assert.match(
        output.netOnly[0].why,
        /^net pricing\.net\.test\.mjs went red after the refactor \(exit 1\); discarded$/u,
      );
      noReview(calls);
      netsOnlyPublished(env, output);
    },
  },
  {
    mode: 'net-support-file',
    check({ result, env, calls }) {
      const { output } = result;
      // The rewritten cases file kept the net green, so only the ownership rule catches it.
      assert.equal(output.netOnly[0].why, `refactor touched a net: ${casesFile}`);
      noReview(calls);
      netsOnlyPublished(env, output);
    },
  },
  {
    mode: 'net-touched',
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.netOnly[0].why, `refactor touched a net: ${netFile}`);
      noReview(calls);
      netsOnlyPublished(env, output);
      assert.equal(existsSync(join(env.cwd, 'pricing.moved.test.mjs')), false);
    },
  },
  {
    mode: 'reviewer-veto',
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.netOnly[0].why, 'reviewer: Changes the rounding of the taxed total');
      assert.equal(output.failedCalls, 0);
      assert.ok(stepIds(calls).includes('refactor/0/review'));
      netsOnlyPublished(env, output);
    },
  },
  {
    mode: 'refactor-fails',
    check({ result, env }) {
      const { output } = result;
      assert.equal(output.failedCalls, 1);
      assert.match(output.netOnly[0].why, /^refactor call failed/u);
      netsOnlyPublished(env, output);
    },
  },
  {
    mode: 'declined',
    input: () => ({ ...input(), goal: 'fixture: decline this plan' }),
    check({ result, env, calls, suspended }) {
      const { output } = result;
      assert.equal(output.status, 'declined');
      assert.equal(suspended, 1);
      assert.match(output.approvedDigest, /^[a-f0-9]{64}$/u);
      assert.ok(stepIds(calls).every((id) => !id.startsWith('refactor/')));
      netsCommitHoldsNet(env, output);
      untouched(env);
    },
  },
  {
    mode: 'red-verify',
    input: () => ({ ...input(), verifyCommands: [[process.execPath, '-e', noSubtotal]] }),
    check({ result, env, calls }) {
      const { output } = result;
      // Every net stays green; the verify command alone discards the refactor, and the nets ship.
      assert.match(
        output.netOnly[0].why,
        /^verify command \[.*\] failed after the refactor \(exit 3\); discarded$/u,
      );
      noReview(calls);
      assert.deepEqual(
        output.verification.map((row) => row.code),
        [0, 0],
      );
      netsOnlyPublished(env, output);
    },
  },
  {
    mode: 'red-final',
    input: () => ({ ...input(), verifyCommands: [[process.execPath, '-e', 'process.exit(3)']] }),
    check({ result, env }) {
      const { output } = result;
      assert.equal(output.status, 'verification-failed');
      assert.deepEqual(output.refactored, []);
      assert.match(output.netOnly[0].why, /^verify command /u);
      assert.equal(output.verification.at(-1).code, 3);
      assert.equal(output.commit, output.netsCommit);
      untouched(env);
    },
  },
  {
    mode: 'checkout-moved',
    check({ result, env }) {
      const { output } = result;
      assert.equal(output.status, 'checkout-moved');
      assert.equal(output.refactored.length, 1);
      assert.equal(output.commit, output.refactored[0].commit);
      assert.ok(output.verification.every((row) => row.code === 0));
      // The user's commit stays HEAD; the verified tree was not rebased onto it.
      assert.equal(git(env.cwd, 'rev-parse', 'HEAD'), env.userCommit);
      untouched(env);
    },
  },
  {
    mode: 'no-nets',
    check({ result, env, calls, suspended }) {
      const { output } = result;
      assert.equal(output.status, 'no-nets');
      assert.equal(suspended, 0);
      assert.equal(output.failedNets, 1);
      assert.deepEqual(
        output.skipped.map((entry) => [entry.location, entry.failed]),
        [
          ['pricing.mjs:totalWithTax', true],
          ['clock.mjs:stamp', false],
          ['target.mjs', false],
        ],
      );
      assert.match(output.skipped[0].why, /^net writer failed/u);
      assert.equal(output.skipped[1].why, 'net writer added undeclared files: notes.txt');
      assert.equal(output.skipped[2].why, 'net red on the current code after 2 rounds');
      assert.deepEqual(output.deferred, []);
      assert.equal(output.netsCommit, null);
      assert.ok(stepIds(calls).includes('nets/2/write/1'));
      assert.ok(stepIds(calls).every((id) => !id.startsWith('refactor/')));
      untouched(env);
    },
  },
  {
    mode: 'no-targets',
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'no-targets');
      assert.deepEqual(stepIds(calls), ['survey']);
      assert.deepEqual(output.deferred, []);
      untouched(env);
    },
  },
];

/** A failed writer or call, or a reviewer who saw a truncated diff or net, is degraded. */
export const degraded = (output) =>
  output.failedNets > 0 ||
  output.failedCalls > 0 ||
  output.skipped.some((entry) => entry.failed) ||
  output.refactored.some((entry) => !entry.reviewedWhole);
