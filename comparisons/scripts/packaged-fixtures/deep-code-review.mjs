// deep-code-review: a commit adds src/window.mjs (three helpers, two with real defects), a
// generated file under src/ and a guide outside the reviewed paths. Correctness and performance
// report the same lastN defect a line apart, which code merges; a skeptic refutes the average
// claim and upholds the other two, raising one's severity. Every reviewer and skeptic reads a
// snapshot of the head, and the checkout, HEAD and refs stay untouched.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitAll, git, writeFiles } from './_support.mjs';

const window = [
  '/** Sliding-window helpers. */',
  '',
  '/** The last n items. */',
  'export function lastN(items, n) {',
  '  return items.slice(items.length - n - 1);',
  '}',
  '',
  '/** The mean of values. */',
  'export function average(values) {',
  '  return values.reduce((sum, value) => sum + value) / values.length;',
  '}',
  '',
  '/** Items in groups of size. */',
  'export function chunk(items, size) {',
  '  const out = [];',
  '  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));',
  '  return out;',
  '}',
];
const generated = Array.from(
  { length: 40 },
  (_, i) => `export const k${String(i)} = ${String(i)};`,
);

const finding = (title, line, severity) => ({
  title,
  file: 'src/window.mjs',
  line,
  severity,
  evidence: `Fixture evidence for ${title}`,
  failureScenario: `Fixture scenario for ${title}`,
});
const lastN = finding('lastN returns n + 1 items', 5, 'high');
const copies = finding('lastN copies the whole array', 6, 'low');
const average = finding('average throws on an empty list', 10, 'medium');
const chunk = finding('chunk never terminates when size is 0', 16, 'medium');
const found = {
  correctness: [lastN, average],
  security: [],
  performance: [copies],
  tests: [chunk],
  'api-design': [],
};
const report = '## Review\n\nTwo confirmed findings.';

export async function setup(env) {
  await writeFiles(env.cwd, {
    'src/window.mjs': `${window.join('\n')}\n`,
    'src/generated.mjs': `${generated.join('\n')}\n`,
    'docs/guide.md': 'How to use the helpers.\n',
  });
  env.head = commitAll(env.cwd, 'add window helpers');
}

export const input = (env) => ({ base: env.until, paths: ['src'] });

/** A reviewer or skeptic must run in a snapshot of the head, never in the checkout. */
function snapshotOf(request, env) {
  assert.notEqual(request.cwd, env.cwd);
  assert.equal(readFileSync(join(request.cwd, 'src/window.mjs'), 'utf8'), `${window.join('\n')}\n`);
}

export function reply(request, env, mode) {
  const id = request.call.stepId;
  const prompt = request.options.prompt;
  if (id === 'scope') return { summary: 'Adds sliding-window helpers.', riskNotes: null };
  const review = /^reviews\/([a-z-]+)\/review$/u.exec(id);
  if (review) {
    snapshotOf(request, env);
    return { findings: mode === 'no-findings' ? [] : found[review[1]] };
  }
  if (/^verify\/\d+\/refute$/u.test(id)) {
    snapshotOf(request, env);
    const claim = (title) => prompt.includes(`Claim: ${title}`);
    if (mode !== 'all-refuted' && claim(lastN.title))
      return { refuted: false, reasoning: 'No guard on n', adjustedSeverity: null };
    if (mode !== 'all-refuted' && claim(chunk.title))
      return { refuted: false, reasoning: 'size 0 is reachable', adjustedSeverity: 'high' };
    return { refuted: true, reasoning: 'Callers never pass an empty list', adjustedSeverity: null };
  }
  if (id === 'report') return report;
  throw new Error(`Unhandled deep-code-review step ${id} (${mode})`);
}

export function fail(request, mode) {
  const id = request.call.stepId;
  return (
    (mode === 'failed-reviewer' && id === 'reviews/correctness/review') ||
    (mode === 'failed-skeptic' && id === 'verify/0/refute')
  );
}

const titles = (list) => list.map((item) => item.title);
/**
 * The checkout is exactly the fixture's HEAD and clean. Each snapshot call pins its base, so the
 * run's refs are one per call, every one at the head: no snapshot captured a change.
 */
function untouched(env, snapshots) {
  assert.equal(git(env.cwd, 'rev-parse', 'HEAD'), env.head);
  assert.equal(git(env.cwd, 'status', '--porcelain', '--untracked-files=all'), '');
  const pins = git(env.cwd, 'for-each-ref', '--format=%(objectname)', 'refs/quiet-choir');
  assert.deepEqual(pins.split('\n').filter(Boolean), Array(snapshots).fill(env.head));
}

export function check({ result, env, calls }) {
  const { output } = result;
  assert.equal(output.status, 'complete');
  assert.equal(output.base, env.until);
  assert.equal(output.head, env.head);
  assert.deepEqual(
    output.files.map((file) => [file.path, file.added, file.deleted]),
    [
      ['src/generated.mjs', 40, 0],
      ['src/window.mjs', 18, 0],
    ],
  );
  assert.deepEqual(output.unreviewedFiles, []);
  assert.deepEqual(output.dimensions, [
    'correctness',
    'security',
    'performance',
    'tests',
    'api-design',
  ]);
  assert.deepEqual(output.unreviewedDimensions, []);
  assert.equal(output.rawFindings, 4);
  assert.deepEqual(
    output.confirmed.map((c) => [
      c.title,
      c.severity,
      c.reportedSeverity,
      c.dimensions,
      c.absorbed,
    ]),
    [
      [lastN.title, 'high', 'high', ['correctness', 'performance'], [copies.title]],
      [chunk.title, 'high', 'medium', ['tests'], []],
    ],
  );
  assert.deepEqual(titles(output.rejected), [average.title]);
  assert.equal(output.rejected[0].why, 'Callers never pass an empty list');
  assert.deepEqual([output.unverified, output.unchecked], [[], []]);
  assert.equal(output.report, report);
  // Map items run concurrently, so compare the calls as a set.
  assert.deepEqual(
    calls.map((call) => call.call.stepId).sort(),
    [
      'report',
      ...output.dimensions.map((dimension) => `reviews/${dimension}/review`),
      'scope',
      'verify/0/refute',
      'verify/1/refute',
      'verify/2/refute',
    ].sort(),
  );
  // Code cut the patch: the reviewers read the defect, never the guide outside the paths.
  for (const call of calls.filter((c) => c.call.stepId.startsWith('reviews/'))) {
    assert.match(call.options.prompt, /<patch>[^]*items\.length - n - 1[^]*<\/patch>/u);
    assert.doesNotMatch(call.options.prompt, /docs\/guide\.md/u);
  }
  // Nobody may edit; the Scoper and Reporter have no tools at all.
  assert.ok(
    calls.every((call) => !call.options.tools.some((tool) => /Write|Edit|Bash/u.test(tool))),
  );
  for (const id of ['scope', 'report'])
    assert.deepEqual(calls.find((call) => call.call.stepId === id).options.tools, []);
  untouched(env, 8);
}

export const readOnly =
  'Read-only review: reviewers and skeptics read unchanged per-call snapshots of the pinned head';

export const modes = [
  {
    mode: 'failed-reviewer',
    check({ result, env }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(output.unreviewedDimensions, ['correctness']);
      assert.equal(output.rawFindings, 2);
      // Without the correctness copy, the performance finding stands alone and is refuted.
      assert.deepEqual(titles(output.confirmed), [chunk.title]);
      assert.deepEqual(titles(output.rejected), [copies.title]);
      untouched(env, 7);
    },
  },
  {
    mode: 'failed-skeptic',
    check({ result, calls }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(titles(output.unverified), [lastN.title]);
      assert.match(output.unverified[0].why, /^Skeptic failed \(process\); not confirmed$/u);
      assert.deepEqual(titles(output.confirmed), [chunk.title]);
      assert.deepEqual(titles(output.rejected), [average.title]);
      const reporter = calls.find((call) => call.call.stepId === 'report');
      assert.match(
        reporter.options.prompt,
        /Findings whose skeptic failed, so never verified: 1\./u,
      );
      assert.doesNotMatch(reporter.options.prompt, new RegExp(lastN.title, 'u'));
    },
  },
  {
    mode: 'capped',
    input: (env) => ({ base: env.until, paths: ['src'], maxChangedLines: 30, maxFindings: 1 }),
    check({ result, calls }) {
      const { output } = result;
      assert.equal(output.status, 'limited');
      assert.deepEqual(
        output.unreviewedFiles.map((file) => file.path),
        ['src/generated.mjs'],
      );
      assert.deepEqual(titles(output.confirmed), [lastN.title]);
      assert.deepEqual(titles(output.unchecked), [average.title, chunk.title]);
      assert.equal(calls.filter((call) => call.call.stepId.startsWith('verify/')).length, 1);
      const reviewer = calls.find((call) => call.call.stepId.startsWith('reviews/'));
      assert.doesNotMatch(reviewer.options.prompt, /export const k0/u);
      assert.match(reviewer.options.prompt, /left out by the review's line budget[^]*generated/u);
    },
  },
  {
    mode: 'all-refuted',
    check({ result, calls }) {
      const { output } = result;
      assert.equal(output.status, 'complete');
      assert.deepEqual(output.confirmed, []);
      assert.equal(output.rejected.length, 3);
      assert.equal(
        output.report,
        'Reviewed 2 files across 5 dimensions. No finding was confirmed: 3 refuted under adversarial verification.',
      );
      assert.equal(
        calls.some((call) => call.call.stepId === 'report'),
        false,
      );
    },
  },
  {
    mode: 'no-findings',
    check({ result, calls }) {
      const { output } = result;
      assert.equal(output.status, 'complete');
      assert.equal(output.rawFindings, 0);
      assert.equal(output.report, 'Reviewed 2 files across 5 dimensions. No findings.');
      assert.deepEqual(
        calls.map((call) => call.call.stepId).filter((id) => !id.startsWith('reviews/')),
        ['scope'],
      );
    },
  },
  {
    mode: 'nothing-in-scope',
    input: (env) => ({ base: env.until, paths: ['lib'] }),
    check({ result, calls, env }) {
      assert.equal(result.output.status, 'nothing-to-review');
      assert.deepEqual(result.output.files, []);
      assert.equal(calls.length, 0);
      untouched(env, 0);
    },
  },
  {
    mode: 'unknown-base',
    input: () => ({ base: 'no-such-revision' }),
    rejects:
      /Cannot resolve the base revision "no-such-revision" to a commit: fatal: Needed a single revision/u,
    check({ record, calls }) {
      assert.equal(record.status, 'failed');
      assert.equal(calls.length, 0);
    },
  },
];

/** A failed reviewer or skeptic hides behind 'limited' when a cap also applied. */
export const degraded = (output) =>
  output.status === 'limited' &&
  (output.unreviewedDimensions.length > 0 || output.unverified.length > 0);
