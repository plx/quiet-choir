// refactor-campaign: pricing.mjs computes the same price-times-quantity loop twice and
// clock.mjs reads the wall clock. The survey finds both and target.mjs, the ranker defers
// target.mjs, the net writer pins pricing.mjs in its worktree with a test file and a cases file
// (code runs the net green on the current code) and cannot pin the clock, code runs the verify
// command on the nets commit, a human approves the goal and plan, the refactorer extracts a
// subtotal helper behind the net, code runs the net and the verify command again, the reviewer
// judges the diff structural, and code verifies the integration and publishes it onto the
// unmoved checkout. The two-targets, chain-break and declines modes also pin and refactor the
// clock; the moved and conflict modes commit to the source checkout while the run works.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
/** net-repair: a first-round support file larger than the 20,000 bytes a repair round is shown. */
const golden = 'pricing.first.golden.txt';
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
/** net-refusals: two more targets, whose writers refuse in other ways. */
const extra = [
  ['README.md', 'Pins nothing'],
  ['notes.mjs', 'Declares a file it never adds'],
].map(([location, refactoring]) => ({
  target: {
    location,
    pressure: 'long-method',
    evidence: 'One long block',
    testability: 'untested',
  },
  rank: { location, refactoring, payoff: 'low', risk: 'low' },
}));
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
/** A verify command that fails only at the final gate, as a flaky one might. */
const redAtGate =
  "if ((process.env.QUIET_CHOIR_STEP_ID ?? '').startsWith('verification/')) process.exit(3)";
const clock = 'export const stamp = () => new Date().toISOString();\n';
const injected = 'export const stamp = (now = () => new Date()) => now().toISOString();\n';
const clockNet = [
  "import assert from 'node:assert/strict';",
  "import { stamp } from './clock.mjs';",
  'assert.match(stamp(), /^\\d{4}-\\d{2}-\\d{2}T/u);',
  '',
].join('\n');
/** baseline-red: a clock net that is green alone and red beside the pricing net's cases file. */
const clockNetInterferes = [
  ...clockNet.split('\n').slice(0, 2),
  "import { existsSync } from 'node:fs';",
  ...clockNet.split('\n').slice(2, -1),
  `assert.equal(existsSync(new URL('./${casesFile}', import.meta.url)), false);`,
  '',
].join('\n');
/** Modes in which the clock writer pins a deterministic net, so two targets reach refactoring. */
const clockPinned = ['two-targets', 'chain-break', 'net-refusals', 'declines', 'baseline-red'];
/** conflict-move: the user's own rewrite of pricing.mjs, committed while the refactor runs. */
const pricingRewrite = [
  'export function total(items) {',
  '  return items.reduce((sum, item) => sum + item.price * item.qty, 0);',
  '}',
  '',
  'export function totalWithTax(items, rate) {',
  '  return total(items) * (1 + rate);',
  '}',
  '',
].join('\n');
/** large: a long pinned behavior, so the approved plan outgrows the approval's 15000-byte preview. */
const longBehavior = `totalWithTax matches ${'every listed price, quantity and rate; '.repeat(400)}`;
/** large: a comment block that makes the refactor's diff outgrow the reviewer's 100000 bytes. */
const notes = Array.from({ length: 3000 }, (_, n) => `// note ${String(n)}: ${'.'.repeat(90)}`);
const large = `${refactored(structural)}${notes.join('\n')}\n`;
const writer = /^(?:nets\/\d+\/write\/\d+|refactor\/\d+\/write)$/u;
const netWrite = /^nets\/\d+\/write\/\d+$/u;
const refactorWrite = /^refactor\/\d+\/write$/u;

export async function setup(env) {
  await writeFiles(env.cwd, {
    'pricing.mjs': pricing,
    'clock.mjs': clock,
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
  if (options.prompt.includes('of README.md with')) {
    // net-refusals: a green net that names no behavior.
    await writeFile(join(cwd, 'readme.net.test.mjs'), '\n');
    return { ...pinned('readme.net.test.mjs'), behaviorsPinned: [] };
  }
  if (options.prompt.includes('of notes.mjs with')) {
    // net-refusals: a net that declares a support file it never adds.
    await writeFile(join(cwd, 'notes.net.test.mjs'), '\n');
    return pinned('notes.net.test.mjs', ['notes.cases.json']);
  }
  if (options.prompt.includes('of target.mjs with')) {
    if (mode === 'net-refusals') {
      // A green net that also edits an existing file, declared as a support file.
      await writeFiles(cwd, {
        'target.net.test.mjs':
          "import assert from 'node:assert/strict';\nimport { value } from './target.mjs';\nassert.equal(value, 1);\n",
        'clock.mjs': injected,
      });
      return pinned('target.net.test.mjs', ['clock.mjs']);
    }
    // no-nets: a net that pins the wrong value in every round.
    await writeFile(
      join(cwd, 'target.net.test.mjs'),
      "import assert from 'node:assert/strict';\nimport { value } from './target.mjs';\nassert.equal(value, 2);\n",
    );
    return pinned('target.net.test.mjs');
  }
  if (options.prompt.includes('of clock.mjs:stamp with')) {
    if (clockPinned.includes(mode)) {
      // net-refusals: the clock net also claims the pricing net's cases file.
      const collide = mode === 'net-refusals';
      await writeFiles(cwd, {
        'clock.net.test.mjs': mode === 'baseline-red' ? clockNetInterferes : clockNet,
        ...(collide ? { [casesFile]: cases(0) } : {}),
      });
      return pinned('clock.net.test.mjs', collide ? [casesFile] : []);
    }
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
  // net-repair: the first round writes a red net under another name, with a golden file too large
  // to show whole; the repair round starts from a fresh checkout and writes the real one, so
  // neither first-round file is ever published.
  if (mode === 'net-repair' && round === 0) {
    assert.equal(existsSync(join(cwd, netFile)), false);
    await writeFiles(cwd, {
      'pricing.first.test.mjs':
        "import assert from 'node:assert/strict';\nimport { totalWithTax } from './pricing.mjs';\nassert.equal(totalWithTax([{ price: 10, qty: 1 }], 0.5), 16);\n",
      [golden]: '7\n'.repeat(15_000),
    });
    return pinned('pricing.first.test.mjs', [golden]);
  }
  if (mode === 'net-repair')
    for (const file of ['pricing.first.test.mjs', golden])
      assert.equal(existsSync(join(cwd, file)), false, file);
  // moved-early and nets-conflict: someone commits to the source checkout while the net is written,
  // a README edit or a file of the same name as the net.
  if (mode === 'moved-early')
    await writeFile(join(env.cwd, 'README.md'), 'Edited during the run\n');
  if (mode === 'nets-conflict') await writeFile(join(env.cwd, netFile), '// the user test\n');
  if (['moved-early', 'nets-conflict'].includes(mode))
    env.userCommit = commitAll(env.cwd, 'commit while the nets are written');
  await writeFiles(cwd, { [netFile]: net, [casesFile]: cases(15) });
  const claim = pinned(netFile, [casesFile]);
  return mode === 'large'
    ? { ...claim, behaviorsPinned: [...behaviorsPinned, longBehavior] }
    : claim;
}

async function refactor(request, env, mode) {
  const { cwd } = request;
  if (request.options.prompt.startsWith('Apply this approved refactoring to clock.mjs:stamp')) {
    // Serial: this checkout starts from the last kept refactor, so it holds the subtotal helper.
    env.clockSawSubtotal = readFileSync(join(cwd, 'pricing.mjs'), 'utf8').includes('subtotal');
    // declines: a refactorer that claims success but changes nothing.
    if (mode === 'declines') return { status: 'refactored', summary: 'Injected the clock' };
    await writeFile(join(cwd, 'clock.mjs'), injected);
    // chain-break: a pricing change only the earlier target's net pins.
    if (mode === 'chain-break') await writeFile(join(cwd, 'pricing.mjs'), refactored(behavioral));
    return { status: 'refactored', summary: 'Injected the clock' };
  }
  await writeFile(
    join(cwd, 'pricing.mjs'),
    mode === 'large'
      ? large
      : refactored(
          ['behavior-change', 'net-support-file', 'declines'].includes(mode)
            ? behavioral
            : structural,
        ),
  );
  // declines: the refactorer edits, finds it cannot keep the rounding, and declines.
  if (mode === 'declines')
    return { status: 'declined', summary: 'Cannot extract without changing the rounding' };
  // net-support-file: the behavior change rewrites the cases file, so every net stays green.
  if (mode === 'net-support-file') await writeFile(join(cwd, casesFile), cases(5));
  if (mode === 'net-touched') await rename(join(cwd, netFile), join(cwd, 'pricing.moved.test.mjs'));
  // checkout-moved and conflict-move: someone commits to the source checkout while the refactor
  // runs, a README edit or a rewrite of the same code.
  if (mode === 'checkout-moved')
    await writeFile(join(env.cwd, 'README.md'), 'Edited during the run\n');
  if (mode === 'conflict-move') await writeFile(join(env.cwd, 'pricing.mjs'), pricingRewrite);
  if (['checkout-moved', 'conflict-move'].includes(mode))
    env.userCommit = commitAll(env.cwd, 'commit while the campaign runs');
  // checkout-dirty: someone leaves an uncommitted file in the source checkout instead.
  if (mode === 'checkout-dirty')
    await writeFile(join(env.cwd, 'scratch.txt'), 'work in progress\n');
  return { status: 'refactored', summary: 'Extracted subtotal from total and totalWithTax' };
}

export async function reply(request, env, mode) {
  const id = request.call.stepId;
  if (id === 'survey') {
    if (mode === 'no-targets') return { targets: [] };
    if (mode === 'net-refusals')
      return { targets: [...targets, ...extra.map((entry) => entry.target)] };
    // report-only: a later duplicate of the first location, which code drops and counts.
    if (mode === 'report-only')
      return { targets: [...targets, { ...targets[0], evidence: 'A later duplicate' }] };
    return { targets };
  }
  if (id === 'rank') {
    if (mode === 'net-refusals')
      return { ranked: [...ranked, ...extra.map((entry) => entry.rank)] };
    return { ranked: ranked.slice(0, mode === 'no-nets' ? 3 : 2) };
  }
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
    (mode === 'review-fails' && id === 'refactor/0/review') ||
    (mode === 'no-nets' && id === 'nets/0/write/0')
  );
}

/** The declined mode's human declines the goal and plan. */
export const answer = (question, env, mode) =>
  mode === 'declined' && leaf(question.stepId) === 'approve-refactors'
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
const promptOf = (calls, id) => calls.find((call) => call.call.stepId === id).options.prompt;
const rows = (checks) => checks.map((row) => [row.argv.at(-1), row.code]);
const treeOf = (env, commit) => git(env.cwd, 'rev-parse', `${commit}^{tree}`);
/** The commit the final verification ran on. */
const gated = (record) => record.steps['verification/0'].worktree.base;
/** The checkout holds both nets, the pricing refactor and `clockText`, clean, as `output.commit`. */
function bothNetsPublished(env, output, record, clockText) {
  assert.equal(git(env.cwd, 'rev-parse', 'HEAD'), output.commit);
  assert.equal(treeOf(env, gated(record)), treeOf(env, 'HEAD'));
  assert.equal(
    git(env.cwd, 'diff', '--name-only', env.base, 'HEAD'),
    [
      ...(clockText === clock ? [] : ['clock.mjs']),
      'clock.net.test.mjs',
      casesFile,
      'pricing.mjs',
      netFile,
    ].join('\n'),
  );
  assert.equal(readFileSync(join(env.cwd, 'pricing.mjs'), 'utf8'), refactored(structural));
  assert.equal(readFileSync(join(env.cwd, 'clock.mjs'), 'utf8'), clockText);
  assert.equal(readFileSync(join(env.cwd, 'clock.net.test.mjs'), 'utf8'), clockNet);
  assert.equal(git(env.cwd, 'status', '--porcelain'), '');
  for (const file of [netFile, 'clock.net.test.mjs'])
    assert.equal(spawnSync(process.execPath, [file], { cwd: env.cwd }).status, 0, file);
}

export function check({ result, env, calls, record, suspended }) {
  const { output } = result;
  assert.equal(output.status, 'applied');
  assert.equal(suspended, 1);
  assert.equal(output.truncatedRepairFiles, 0);
  assert.equal(output.duplicateTargets, 0);
  assert.equal(output.refusal, null);
  // The net and the verify command passed on the nets commit before the approval, which shows them.
  assert.deepEqual(rows(output.baseline), [
    [netFile, 0],
    [exists(netFile), 0],
  ]);
  const { subject } = record.steps['approve-refactors'].question.request;
  assert.deepEqual(subject.baseline, output.baseline);
  assert.equal(subject.digest, output.approvedDigest);
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
  const review = promptOf(calls, 'refactor/0/review');
  assert.match(review, /<diff>\n[^]*\+const subtotal = \(items\) => \{[^]*<\/diff>/u);
  // The reviewer sees every touched path, and is told how to treat a changed test.
  assert.match(review, /no net file is among them:\n- pricing\.mjs\n\n/u);
  assert.match(review, /Treat a change to an\nexisting test/u);
  assert.deepEqual(rows(output.verification), [
    [netFile, 0],
    [exists(netFile), 0],
  ]);
  // Published: the net and the refactor, as one fast-forward of the clean, unmoved checkout, with
  // exactly the tree the final verification ran on.
  assert.equal(git(env.cwd, 'rev-parse', 'HEAD'), output.commit);
  assert.equal(treeOf(env, gated(record)), treeOf(env, 'HEAD'));
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
      // The later duplicate is dropped and counted; the ranker saw the first one's evidence.
      assert.equal(output.duplicateTargets, 1);
      assert.match(output.summary, / 1 surveyed duplicates dropped\.$/u);
      assert.ok(!promptOf(calls, 'rank').includes('A later duplicate'));
      // Report-only has no verify commands, so the baseline runs the net alone, on the nets commit.
      assert.deepEqual(rows(output.baseline), [[netFile, 0]]);
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
      const repair = promptOf(calls, 'nets/0/write/1');
      assert.match(repair, /Your previous net, pricing\.first\.test\.mjs, failed/u);
      // The whole assertion error, from a completed nonzero exit rather than a 1 KiB failure tail.
      assert.match(repair, /The command exited with code 1\./u);
      assert.match(repair, /<stderr>\n[^]*AssertionError[^]*16[^]*<\/stderr>/u);
      assert.match(repair, /<file path="pricing\.first\.test\.mjs">\n[^]*, 16\);\n<\/file>/u);
      // The golden file is shown in part, said so after a blank line, and counted.
      assert.match(
        repair,
        /<file path="pricing\.first\.golden\.txt">\n(?:7\n){9999}7\n<\/file>\n\n\(Only the first 20000 bytes of pricing\.first\.golden\.txt are shown\.\)\n\n/u,
      );
      assert.equal(result.output.truncatedRepairFiles, 1);
      // The superseded red files never reach the nets commit or the checkout.
      netsCommitHoldsNet(env, result.output);
      for (const file of ['pricing.first.test.mjs', golden])
        assert.equal(existsSync(join(env.cwd, file)), false, file);
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
    mode: 'review-fails',
    check({ result, env }) {
      const { output } = result;
      // A failed review call keeps only the net, and is counted, so the output admits degradation.
      assert.equal(output.failedCalls, 1);
      assert.match(output.netOnly[0].why, /^review failed/u);
      assert.equal(degraded(output), true);
      netsOnlyPublished(env, output);
    },
  },
  {
    mode: 'declined',
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
    input: () => ({ ...input(), verifyCommands: [[process.execPath, '-e', redAtGate]] }),
    check({ result, env, record }) {
      const { output } = result;
      // Green on the nets commit and on the refactor, red only at the gate: nothing is published.
      assert.equal(output.status, 'verification-failed');
      assert.deepEqual(rows(output.baseline), [
        [netFile, 0],
        [redAtGate, 0],
      ]);
      assert.equal(output.refactored.length, 1);
      assert.deepEqual(rows(output.verification), [
        [netFile, 0],
        [redAtGate, 3],
      ]);
      // The unpublished commit is the integration of the net and the kept refactor, as verified.
      assert.equal(gated(record), output.commit);
      assert.equal(treeOf(env, output.commit), treeOf(env, output.refactored[0].commit));
      assert.ok(output.summary.includes(output.commit), output.summary);
      untouched(env);
    },
  },
  {
    mode: 'baseline-red',
    input: () => ({ ...input(), verifyCommands: [[process.execPath, '-e', 'process.exit(4)']] }),
    check({ result, env, calls, suspended }) {
      const { output } = result;
      // Red before any refactor: the clock net was green alone but fails beside the pricing net's
      // cases file, and the verify command fails too. No approval is asked, no refactor paid for.
      assert.equal(output.status, 'baseline-red');
      assert.equal(suspended, 0);
      assert.deepEqual(rows(output.baseline), [
        [netFile, 0],
        ['clock.net.test.mjs', 1],
        ['process.exit(4)', 4],
      ]);
      assert.deepEqual(
        output.netOnly.map((entry) => [entry.location, entry.why]),
        [
          ['pricing.mjs:totalWithTax', 'a net or verify command fails on the nets commit'],
          ['clock.mjs:stamp', 'a net or verify command fails on the nets commit'],
        ],
      );
      assert.equal(output.approvedDigest, null);
      assert.deepEqual(output.verification, []);
      assert.ok(stepIds(calls).every((id) => !id.startsWith('refactor/')));
      assert.ok(output.summary.includes(output.netsCommit), output.summary);
      untouched(env);
    },
  },
  {
    mode: 'checkout-moved',
    check({ result, env, record }) {
      const { output } = result;
      assert.equal(output.status, 'checkout-moved');
      assert.equal(output.refusal, null);
      assert.equal(output.refactored.length, 1);
      assert.ok(output.verification.every((row) => row.code === 0));
      // ctx.merge integrates onto the checkout's HEAD of the moment, so the verified, unpublished
      // integration sits on the user's commit and the summary says how to keep it.
      assert.equal(
        git(env.cwd, 'diff', '--name-only', env.userCommit, output.commit),
        `${casesFile}\npricing.mjs\n${netFile}`,
      );
      assert.equal(git(env.cwd, 'merge-base', env.userCommit, output.commit), env.userCommit);
      assert.equal(gated(record), output.commit);
      assert.ok(output.summary.includes(`${output.commit}`), output.summary);
      assert.ok(output.summary.includes('git merge that commit'), output.summary);
      // The user's commit stays HEAD; the verified tree was not rebased onto it.
      assert.equal(git(env.cwd, 'rev-parse', 'HEAD'), env.userCommit);
      untouched(env);
    },
  },
  {
    mode: 'checkout-dirty',
    check({ result, env, record }) {
      const { output } = result;
      // HEAD did not move, so the recorded check passes; the publish itself refuses the dirty
      // checkout, and the refusal is a result, so there is no failed run to resume onto a moved HEAD.
      assert.equal(output.status, 'merge-refused');
      assert.equal(output.refusal.step, 'publish');
      assert.match(output.refusal.message, /dirty/u);
      assert.equal(output.refactored.length, 1);
      assert.ok(output.verification.every((row) => row.code === 0));
      assert.equal(gated(record), output.commit);
      assert.equal(git(env.cwd, 'merge-base', env.base, output.commit), env.base);
      assert.ok(output.summary.includes(output.commit), output.summary);
      assert.ok(output.summary.includes('git merge that commit'), output.summary);
      assert.equal(record.steps.publish.status, 'settled-failed');
      assert.equal(git(env.cwd, 'rev-parse', 'HEAD'), env.base);
      assert.equal(git(env.cwd, 'status', '--porcelain'), '?? scratch.txt');
      assert.equal(readFileSync(join(env.cwd, 'pricing.mjs'), 'utf8'), pricing);
      assert.equal(existsSync(join(env.cwd, netFile)), false);
    },
  },
  {
    mode: 'conflict-move',
    check({ result, env, calls }) {
      const { output } = result;
      // The user's commit conflicts with the refactor, so the integration refuses: the status says
      // the checkout moved, and the last kept result (green behind every net) is left to merge.
      assert.equal(output.status, 'checkout-moved');
      assert.equal(output.refusal.step, 'integrate');
      assert.match(output.refusal.message, /conflicts: pricing\.mjs$/u);
      assert.equal(output.refactored.length, 1);
      assert.equal(output.commit, output.refactored[0].commit);
      assert.deepEqual(output.verification, []);
      assert.ok(stepIds(calls).includes('refactor/0/review'));
      assert.equal(
        git(env.cwd, 'show', `${output.commit}:pricing.mjs`),
        refactored(structural).trimEnd(),
      );
      assert.ok(output.summary.includes(`${output.commit}`), output.summary);
      assert.ok(output.summary.includes('git merge that commit'), output.summary);
      assert.equal(git(env.cwd, 'rev-parse', 'HEAD'), env.userCommit);
      assert.equal(readFileSync(join(env.cwd, 'pricing.mjs'), 'utf8'), pricingRewrite);
      assert.equal(existsSync(join(env.cwd, netFile)), false);
      assert.equal(git(env.cwd, 'status', '--porcelain'), '');
    },
  },
  {
    mode: 'moved-early',
    check({ result, env, calls, suspended }) {
      const { output } = result;
      // HEAD moved while the nets were written, so the run stops before the approval and before
      // any refactor is paid for; the nets commit (green on the moved HEAD) is left to merge.
      assert.equal(output.status, 'checkout-moved');
      assert.equal(suspended, 0);
      assert.equal(output.refusal, null);
      assert.ok(stepIds(calls).every((id) => !id.startsWith('refactor/')));
      assert.equal(output.commit, output.netsCommit);
      assert.equal(git(env.cwd, 'merge-base', env.userCommit, output.netsCommit), env.userCommit);
      assert.deepEqual(rows(output.baseline), [
        [netFile, 0],
        [exists(netFile), 0],
      ]);
      assert.deepEqual(
        output.netOnly.map((entry) => entry.why),
        ['the checkout moved before the approval'],
      );
      assert.equal(output.approvedDigest, null);
      assert.ok(output.summary.includes('git merge that commit'), output.summary);
      assert.equal(git(env.cwd, 'rev-parse', 'HEAD'), env.userCommit);
      assert.equal(existsSync(join(env.cwd, casesFile)), false);
      assert.equal(git(env.cwd, 'status', '--porcelain'), '');
    },
  },
  {
    mode: 'nets-conflict',
    check({ result, env, calls, suspended }) {
      const { output } = result;
      // The user committed a file of the net's name, so the nets cannot integrate at all.
      assert.equal(output.status, 'checkout-moved');
      assert.equal(suspended, 0);
      assert.equal(output.refusal.step, 'integrate-nets');
      assert.match(output.refusal.message, /conflicts: pricing\.net\.test\.mjs$/u);
      assert.equal(output.netsCommit, null);
      assert.equal(output.commit, null);
      assert.deepEqual(output.baseline, []);
      assert.deepEqual(
        output.netOnly.map((entry) => entry.why),
        ['the nets did not integrate'],
      );
      assert.ok(stepIds(calls).every((id) => !id.startsWith('refactor/')));
      assert.ok(output.summary.includes('nothing was integrated'), output.summary);
      assert.equal(git(env.cwd, 'rev-parse', 'HEAD'), env.userCommit);
      assert.equal(readFileSync(join(env.cwd, netFile), 'utf8'), '// the user test\n');
      assert.equal(git(env.cwd, 'status', '--porcelain'), '');
    },
  },
  {
    mode: 'dirty-start',
    // An uncommitted file in the checkout before the run starts.
    input: (env) => {
      writeFileSync(join(env.cwd, 'scratch.txt'), 'work in progress\n');
      return input();
    },
    check({ result, env, calls, suspended }) {
      const { output } = result;
      // Refused before any agent call, as a result: a resume after a cleanup cannot help.
      assert.equal(output.status, 'dirty-checkout');
      assert.equal(suspended, 0);
      assert.deepEqual(calls, []);
      assert.deepEqual(output.refusal, {
        step: 'clean',
        message: 'uncommitted changes: ?? scratch.txt',
      });
      assert.ok(output.summary.includes('?? scratch.txt'), output.summary);
      assert.ok(output.summary.includes('start a new run'), output.summary);
      assert.equal(git(env.cwd, 'rev-parse', 'HEAD'), env.base);
      assert.equal(git(env.cwd, 'status', '--porcelain'), '?? scratch.txt');
    },
  },
  {
    mode: 'declines',
    check({ result, env, calls, record }) {
      const { output } = result;
      // The pricing refactorer edits and then declines; the clock refactorer claims success but
      // changes nothing. Code keeps neither change, asks no reviewer, and publishes both nets.
      assert.equal(output.status, 'nets-only');
      assert.deepEqual(output.refactored, []);
      assert.deepEqual(
        output.netOnly.map((entry) => [entry.location, entry.why]),
        [
          [
            'pricing.mjs:totalWithTax',
            'refactorer declined: Cannot extract without changing the rounding',
          ],
          ['clock.mjs:stamp', 'refactorer made no change'],
        ],
      );
      assert.equal(output.failedCalls, 0);
      assert.ok(stepIds(calls).every((id) => !id.endsWith('/review')));
      assert.equal(record.steps['refactor/0/touched'], undefined);
      assert.equal(git(env.cwd, 'rev-parse', 'HEAD'), output.commit);
      assert.equal(
        git(env.cwd, 'diff', '--name-only', env.base, 'HEAD'),
        ['clock.net.test.mjs', casesFile, netFile].join('\n'),
      );
      assert.equal(readFileSync(join(env.cwd, 'pricing.mjs'), 'utf8'), pricing);
      assert.equal(readFileSync(join(env.cwd, 'clock.mjs'), 'utf8'), clock);
      assert.equal(git(env.cwd, 'status', '--porcelain'), '');
    },
  },
  {
    mode: 'large',
    check({ result, env, calls, record }) {
      const { output } = result;
      // A diff past what the reviewer is shown (and past its capture) and a plan past the approval
      // preview: both are cut, said so and counted, and the run still completes.
      assert.equal(output.status, 'applied');
      assert.equal(output.refactored[0].reviewedWhole, false);
      assert.equal(degraded(output), true);
      const review = promptOf(calls, 'refactor/0/review');
      assert.match(review, /The diff below is truncated to its first 100000 bytes\./u);
      const shown = review.split('<diff>\n')[1].split('\n</diff>')[0];
      assert.ok(shown.startsWith('diff --git a/pricing.mjs b/pricing.mjs'));
      assert.ok(Buffer.byteLength(shown) <= 100_000 && Buffer.byteLength(shown) > 99_000);
      const { details, subject } = record.steps['approve-refactors'].question.request;
      assert.match(
        details,
        /\n\n\(Only the first 15000 bytes are shown; the question's subject holds the whole plan\.\)$/u,
      );
      assert.ok(subject.targets[0].behaviorsPinned.includes(longBehavior));
      assert.equal(readFileSync(join(env.cwd, 'pricing.mjs'), 'utf8'), large);
      assert.equal(git(env.cwd, 'rev-parse', 'HEAD'), output.commit);
      assert.equal(git(env.cwd, 'status', '--porcelain'), '');
    },
  },
  {
    mode: 'two-targets',
    check({ result, env, calls, record }) {
      const { output } = result;
      assert.equal(output.status, 'applied');
      assert.deepEqual(
        output.refactored.map((entry) => [entry.location, entry.files]),
        [
          ['pricing.mjs:totalWithTax', ['pricing.mjs']],
          ['clock.mjs:stamp', ['clock.mjs']],
        ],
      );
      // The second refactor started from the first one's result, behind both nets.
      assert.equal(env.clockSawSubtotal, true);
      assert.equal(record.steps['refactor/1/write'].worktree.base, output.refactored[0].commit);
      assert.match(
        promptOf(calls, 'refactor/1/write'),
        /any of them:\n- pricing\.net\.test\.mjs\n- pricing\.cases\.json\n- clock\.net\.test\.mjs\n/u,
      );
      assert.doesNotMatch(promptOf(calls, 'refactor/1/review'), /subtotal/u);
      assert.deepEqual(rows(output.verification), [
        [netFile, 0],
        ['clock.net.test.mjs', 0],
        [exists(netFile), 0],
      ]);
      bothNetsPublished(env, output, record, injected);
    },
  },
  {
    mode: 'chain-break',
    check({ result, env, record }) {
      const { output } = result;
      // The clock refactor also changed pricing; only the earlier target's net catches it.
      assert.equal(output.status, 'applied');
      assert.equal(env.clockSawSubtotal, true);
      assert.deepEqual(
        output.refactored.map((entry) => entry.location),
        ['pricing.mjs:totalWithTax'],
      );
      assert.deepEqual(
        output.netOnly.map((entry) => [entry.location, entry.why]),
        [['clock.mjs:stamp', `net ${netFile} went red after the refactor (exit 1); discarded`]],
      );
      assert.equal(record.steps['refactor/1/net/0'].exec.command.at(-1), netFile);
      bothNetsPublished(env, output, record, clock);
    },
  },
  {
    mode: 'net-refusals',
    input: () => ({ ...input(), maxTargets: 5 }),
    check({ result, env }) {
      const { output } = result;
      // Refused: a net claiming another net's file, one that edits existing code, one that pins
      // no behavior and one missing a declared file. The pricing net still goes ahead.
      assert.equal(output.status, 'applied');
      assert.deepEqual(output.skipped, [
        {
          location: 'clock.mjs:stamp',
          refactoring: 'Inject the clock',
          why: `net file ${casesFile} collides with the net of pricing.mjs:totalWithTax`,
          failed: false,
        },
        {
          location: 'target.mjs',
          refactoring: 'Introduce a named constant',
          why: 'net writer changed existing files: [{"path":"clock.mjs","status":"modified"}]',
          failed: false,
        },
        {
          location: 'README.md',
          refactoring: 'Pins nothing',
          why: 'pinned net names no behavior',
          failed: false,
        },
        {
          location: 'notes.mjs',
          refactoring: 'Declares a file it never adds',
          why: 'declared net files were not added: notes.cases.json',
          failed: false,
        },
      ]);
      assert.equal(output.refactored.length, 1);
      assert.equal(
        git(env.cwd, 'diff', '--name-only', env.base, 'HEAD'),
        `${casesFile}\npricing.mjs\n${netFile}`,
      );
      assert.equal(readFileSync(join(env.cwd, casesFile), 'utf8'), cases(15));
      assert.equal(readFileSync(join(env.cwd, 'clock.mjs'), 'utf8'), clock);
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
