// dependency-upgrade: the fixture project depends on tinyclock ^1, whose 2.0.0 renames now() to
// tick(). The upgrader bumps the manifest and fixes one of the two callers; code's install command
// refreshes the lockfile in each verification checkout and the verification command fails while
// any caller still uses now(). A triager clusters the red output, one fixer repairs the other
// caller in its own worktree of the integrated commit, the second verification is green, and code
// publishes the manifest, the install's lockfile and both callers. Modes cover the exits: nothing
// attempted, declined, refused writers and installs, a failed fixer, a failed triage, the
// fix-round cap and a checkout that moves before or during the loop.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commitAll, git, leaf, writeFiles } from './_support.mjs';

const manifest = (range) =>
  `${JSON.stringify({ name: 'fixture', dependencies: { tinyclock: range } }, null, 2)}\n`;
const lockfile = (version) =>
  `${JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: { 'node_modules/tinyclock': { version } } }, null, 2)}\n`;
const caller = (api, name) =>
  `import { ${api} } from 'tinyclock';\nexport const ${name} = () => ${api}();\n`;
const files = {
  'package.json': manifest('^1.0.0'),
  'package-lock.json': lockfile('1.4.2'),
  'src/clock.mjs': caller('now', 'stamp'),
  'src/report.mjs': caller('now', 'report'),
  'docs/notes.md': 'We once evaluated tinyclock-legacy and did not adopt it.\n',
};
// A stand-in for `npm install`: resolve the manifest's range and rewrite the lockfile.
const install = [
  "const fs=require('node:fs');",
  "const range=JSON.parse(fs.readFileSync('package.json','utf8')).dependencies.tinyclock;",
  "const version=range.startsWith('^2')?'2.0.0':'1.4.2';",
  "fs.writeFileSync('package-lock.json',JSON.stringify({name:'fixture',lockfileVersion:3,packages:{'node_modules/tinyclock':{version}}},null,2)+'\\n');",
].join('');
// The test suite: the manifest, the lockfile and every caller must be on tinyclock 2.
const verify = [
  "const fs=require('node:fs');const errors=[];",
  "const range=JSON.parse(fs.readFileSync('package.json','utf8')).dependencies.tinyclock;",
  "if(!range.startsWith('^2'))errors.push('package.json still pins tinyclock '+range);",
  "const lock=JSON.parse(fs.readFileSync('package-lock.json','utf8')).packages['node_modules/tinyclock'].version;",
  "if(lock!=='2.0.0')errors.push('the lockfile resolves tinyclock '+lock);",
  "for(const f of fs.readdirSync('src'))if(fs.readFileSync('src/'+f,'utf8').includes('now('))errors.push('src/'+f+' still calls the removed now()');",
  "if(errors.length){console.error(errors.join('\\n'));process.exit(1)}console.log('ok');",
].join('');
const planFiles = ['package.json', 'src/clock.mjs', 'src/report.mjs'];

export async function setup(env) {
  await writeFiles(env.cwd, files);
  env.base = commitAll(env.cwd, 'depend on tinyclock 1');
}

export const input = () => ({
  package: 'tinyclock',
  installCommand: [process.execPath, '-e', install],
  verifyCommands: [[process.execPath, '-e', verify]],
});

const read = (cwd, file) => readFileSync(join(cwd, file), 'utf8');
const writer = (id) => leaf(id) === 'apply' || /^round\/\d+\/fixes\/\d+\/fix$/u.test(id);

export async function reply(request, env, mode) {
  const id = request.call.stepId,
    prompt = request.options.prompt;
  if (id === 'research') {
    // Code read the installed version from the lockfile; the researcher only gets the lines.
    assert.match(prompt, /package-lock\.json-\d+-\s+"version": "1\.4\.2"/u);
    if (mode === 'checkout-moves') moveCheckout(env);
    return {
      currentMajor: '1',
      targetVersion: '2.0.0',
      breakingChanges: [
        {
          change: 'now() was renamed to tick()',
          affects: 'now()',
          migrationHint: 'Call tick()',
        },
      ],
      migrationGuideUrl: 'https://example.invalid/tinyclock/v2',
      notes: null,
    };
  }
  if (id === 'impact') {
    assert.match(prompt, /- docs\/notes\.md\n- src\/clock\.mjs\n- src\/report\.mjs\n/u);
    return {
      currentVersion: '1.4.2',
      usageSites: [
        { file: 'src/clock.mjs', apis: ['now'], heaviness: 'light' },
        { file: 'src/report.mjs', apis: ['now'], heaviness: 'light' },
      ],
      unrelated: [{ file: 'docs/notes.md', why: 'Names tinyclock-legacy, another package' }],
      indirectExposure: null,
    };
  }
  if (id === 'plan')
    return {
      riskLevel: mode === 'reconsider' ? 'reconsider' : 'moderate',
      steps: ['Bump tinyclock to ^2.0.0 in package.json', 'Replace now() with tick() in src/'],
      riskNotes: 'Every caller uses now()',
      testFocus: ['src/report.mjs'],
      files: planFiles,
    };
  if (id === 'apply') {
    // The upgrader bumps the manifest and fixes one caller, leaving the other for the loop.
    await writeFiles(request.cwd, {
      'package.json': manifest('^2.0.0'),
      'src/clock.mjs': caller('tick', 'stamp'),
    });
    if (mode === 'upgrader-strays') await writeFile(join(request.cwd, 'target.mjs'), 'stray\n');
    return { summary: 'Bumped tinyclock and moved src/clock.mjs to tick()' };
  }
  if (/^round\/\d+\/triage$/u.test(id)) return triage(request, env, mode);
  if (/^round\/\d+\/fixes\/\d+\/fix$/u.test(id)) {
    // Each fixer starts from the round's integrated commit, which holds the upgrader's change.
    assert.equal(JSON.parse(read(request.cwd, 'package.json')).dependencies.tinyclock, '^2.0.0');
    assert.equal(read(request.cwd, 'src/clock.mjs'), caller('tick', 'stamp'));
    if (!owns(prompt).includes('src/report.mjs')) return { summary: 'Nothing to change here' };
    // At the round cap the fixer touches the caller but keeps now(), so the loop cannot converge.
    const fixed =
      mode === 'round-cap' ? `${caller('now', 'report')}// tried\n` : caller('tick', 'report');
    await writeFile(join(request.cwd, 'src/report.mjs'), fixed);
    if (mode === 'fix-strays') await writeFile(join(request.cwd, 'target.mjs'), 'stray\n');
    if (mode === 'moves-mid-loop') moveCheckout(env);
    return { summary: 'Moved src/report.mjs to tick()' };
  }
  throw new Error(`Unhandled dependency-upgrade step ${id} (${mode})`);
}

/** The files a fixer's prompt says it owns. */
const owns = (prompt) =>
  [
    ...(prompt.match(/may change only them:\n((?:- .+\n)+)/u)?.[1] ?? '').matchAll(/^- (.+)$/gmu),
  ].map((match) => match[1]);

/** Someone commits unrelated work to the checkout while the run is in flight. */
function moveCheckout(env) {
  writeFileSync(join(env.cwd, 'CHANGELOG.md'), 'Unrelated work\n');
  commitAll(env.cwd, 'unrelated work');
}

const stale = 'src/report.mjs still calls the removed now()';
function triage(request, env, mode) {
  const prompt = request.options.prompt;
  // The triager reads the verification checkout, where the install already ran.
  assert.notEqual(request.cwd, env.cwd);
  assert.equal(
    JSON.parse(read(request.cwd, 'package-lock.json')).packages['node_modules/tinyclock'].version,
    '2.0.0',
  );
  assert.match(prompt, /src\/report\.mjs still calls the removed now\(\)/u);
  assert.match(prompt, /after the workflow ran `\S+ -e const fs=/u);
  // Only the round-cap mode reaches a red round with no fix round left.
  const last = /^This was the last verification/mu.test(prompt);
  assert.equal(last, mode === 'round-cap' && request.call.stepId === 'round/1/triage');
  if (last) return { clusters: [{ description: stale, files: ['src/report.mjs'] }] };
  assert.match(prompt, /Fixers may change only these files/u);
  if (mode === 'round-cap')
    // Four root causes on four allowed files: three get fixers, the fourth is over the cap.
    return {
      clusters: [
        { description: stale, files: ['src/report.mjs'] },
        { description: 'src/clock.mjs may share the cause', files: ['src/clock.mjs'] },
        { description: 'The manifest range may be wrong', files: ['package.json'] },
        { description: 'The lockfile may be stale', files: ['package-lock.json'] },
      ],
    };
  return {
    clusters: [
      { description: stale, files: ['src/report.mjs'] },
      { description: 'The fixture target looks stale', files: ['target.mjs'] },
    ],
  };
}

export function fail(request, mode) {
  const id = request.call.stepId;
  return (
    (mode === 'fixer-fails' && /\/fixes\/\d+\/fix$/u.test(id)) ||
    (mode === 'triage-fails' && /^round\/\d+\/triage$/u.test(id))
  );
}

/** The declined mode's human declines the upgrade plan. */
export const answer = (question, env, mode) =>
  mode === 'declined' && leaf(question.stepId) === 'approve-upgrade'
    ? { approved: false, comment: 'Fixture human declined' }
    : undefined;

/** The checkout is the setup commit, clean, still on tinyclock 1. */
function untouched(env) {
  assert.equal(git(env.cwd, 'rev-parse', 'HEAD'), env.base);
  assert.equal(git(env.cwd, 'status', '--porcelain', '--untracked-files=all'), '');
  for (const [file, content] of Object.entries(files)) assert.equal(read(env.cwd, file), content);
}
const digest = (text) => createHash('sha256').update(text).digest('hex');
const nonWriters = (calls) => calls.filter((call) => !writer(call.call.stepId));

const ids = (calls) => calls.map((call) => call.call.stepId);
const noWriters = (calls) =>
  assert.equal(
    calls.some((call) => writer(call.call.stepId)),
    false,
  );

export async function check({ result, env, calls, record, suspended }) {
  const { output } = result;
  assert.equal(output.status, 'upgraded');
  assert.equal(suspended, 1);
  assert.deepEqual([output.from, output.to, output.rounds], ['1.4.2', '2.0.0', 2]);
  assert.deepEqual([output.remaining, output.refusal], [[], null]);
  assert.deepEqual(output.usage, {
    sites: ['src/clock.mjs', 'src/report.mjs'],
    unclassified: [],
    unmapped: [],
    evidenceOmitted: 0,
  });
  // Round 0: the install refreshed the lockfile and the suite failed on the unfixed caller; one
  // cluster got a fixer, the cluster naming a file outside the plan got none.
  const [red, greenRound] = output.verification;
  assert.equal(red.install.code, 0);
  assert.deepEqual([red.checks[0].code, red.passed, red.triage], [1, false, 'repair']);
  assert.deepEqual(
    red.clusters.map((cluster) => [cluster.fix, cluster.files]),
    [
      ['applied', ['src/report.mjs']],
      ['unowned', ['target.mjs']],
    ],
  );
  assert.deepEqual(
    [greenRound.checks[0].code, greenRound.passed, greenRound.triage, greenRound.clusters],
    [0, true, 'none', []],
  );
  // Code looked for a moved checkout after the approval, before each integration and at publish.
  for (const id of ['head/approved', 'head/applied', 'round/0/head', 'head/publish'])
    assert.equal(record.steps[id]?.status, 'completed', id);
  // The upgrader got the approved plan verbatim, and the digest is its SHA-256.
  const apply = calls.find((call) => call.call.stepId === 'apply');
  const text = apply.options.prompt.split('Approved plan:\n')[1];
  assert.equal(digest(text), output.approvedDigest);
  assert.deepEqual(JSON.parse(text).files, planFiles);
  // The human approved that same text and digest, over the pinned base and the allowed files.
  const { subject, details } = record.steps['approve-upgrade'].question.request;
  assert.equal(details, text);
  assert.deepEqual([subject.digest, subject.base], [output.approvedDigest, env.base]);
  assert.deepEqual(subject.allowed, ['package-lock.json', ...planFiles]);
  // Writers worked in two different isolated checkouts; nobody else could write.
  const writers = calls.filter((call) => writer(call.call.stepId));
  assert.equal(writers.length, 2);
  assert.equal(new Set([env.cwd, ...writers.map((call) => call.cwd)]).size, 3);
  for (const call of nonWriters(calls))
    assert.ok(!(call.options.tools ?? []).some((tool) => ['Write', 'Edit'].includes(tool)));
  const research = calls.find((call) => call.call.stepId === 'research');
  assert.deepEqual(research.options.tools, ['WebSearch', 'WebFetch']);
  assert.deepEqual(calls.find((call) => call.call.stepId === 'plan').options.tools, []);
  // Published: the manifest, the install's lockfile and both callers, on top of the setup commit.
  assert.equal(git(env.cwd, 'rev-parse', 'HEAD'), output.commit);
  assert.equal(git(env.cwd, 'rev-parse', 'HEAD~1'), env.base);
  assert.equal(git(env.cwd, 'log', '-1', '--format=%s'), 'Upgrade tinyclock from 1.4.2 to 2.0.0');
  assert.equal(git(env.cwd, 'status', '--porcelain', '--untracked-files=all'), '');
  assert.equal(read(env.cwd, 'package.json'), manifest('^2.0.0'));
  assert.equal(read(env.cwd, 'package-lock.json'), lockfile('2.0.0'));
  assert.equal(read(env.cwd, 'src/clock.mjs'), caller('tick', 'stamp'));
  assert.equal(read(env.cwd, 'src/report.mjs'), caller('tick', 'report'));
  assert.equal(read(env.cwd, 'docs/notes.md'), files['docs/notes.md']);
  assert.deepEqual(git(env.cwd, 'diff', '--name-only', env.base, 'HEAD').split('\n'), [
    'package-lock.json',
    'package.json',
    'src/clock.mjs',
    'src/report.mjs',
  ]);
}

export const kill = {
  step: '^apply$',
  boundary: 'response',
  writeLocation: 'isolated-checkout',
};

/** The research and the impact analysis run concurrently, so the faults name the research. */
export const faults = { F1: '^research$', F2: '^research$' };

/** The checkout holds the setup commit plus one unrelated commit, and nothing from the run. */
function movedOnly(env) {
  assert.equal(git(env.cwd, 'rev-parse', 'HEAD~1'), env.base);
  assert.equal(git(env.cwd, 'log', '-1', '--format=%s'), 'unrelated work');
  assert.equal(git(env.cwd, 'status', '--porcelain', '--untracked-files=all'), '');
  for (const [file, content] of Object.entries(files)) assert.equal(read(env.cwd, file), content);
}

export const modes = [
  {
    mode: 'reconsider',
    check({ result, env, calls, suspended }) {
      assert.equal(result.output.status, 'not-attempted');
      assert.equal(suspended, 0);
      assert.equal(result.output.riskLevel, 'reconsider');
      assert.equal(result.output.remaining.length, 2);
      noWriters(calls);
      untouched(env);
    },
  },
  {
    mode: 'declined',
    check({ result, env, calls, suspended }) {
      assert.equal(result.output.status, 'declined');
      assert.equal(suspended, 1);
      assert.match(result.output.approvedDigest, /^[a-f0-9]{64}$/u);
      noWriters(calls);
      untouched(env);
    },
  },
  {
    mode: 'upgrader-strays',
    check({ result, env, calls }) {
      // The upgrader's receipt names a file the plan does not list: nothing is integrated.
      const { output } = result;
      assert.equal(output.status, 'refused');
      assert.equal(
        output.refusal,
        'Upgrader changed files outside its approved set: target.mjs (modified)',
      );
      assert.deepEqual([output.rounds, output.verification], [0, []]);
      assert.deepEqual(ids(calls).slice(-1), ['apply']);
      untouched(env);
    },
  },
  {
    mode: 'fixer-fails',
    check({ result, env }) {
      // A failed fixer is journaled and leaves its cluster unfixed; with no change to integrate the
      // loop stops instead of verifying the same commit again, and nothing is published. What is
      // left failing is the triager's clusters.
      const { output } = result;
      assert.equal(output.status, 'unstable');
      assert.equal(output.rounds, 1);
      assert.deepEqual(
        output.verification[0].clusters.map((cluster) => cluster.fix),
        ['failed', 'unowned'],
      );
      assert.deepEqual(output.remaining, [stale, 'The fixture target looks stale']);
      untouched(env);
    },
  },
  {
    mode: 'triage-fails',
    input: () => ({ ...input(), maxFixRounds: 0 }),
    check({ result, env, calls }) {
      // maxFixRounds 0 verifies once and never fixes. The triage that would report the red round
      // fails; it is settled like upstream's unavailable verifier, and the failing commands remain.
      const { output } = result;
      assert.equal(output.status, 'unstable');
      assert.equal(output.rounds, 1);
      assert.deepEqual(
        [output.verification[0].triage, output.verification[0].clusters],
        ['failed', []],
      );
      assert.equal(output.remaining.length, 1);
      assert.match(output.remaining[0], / -e const fs=.*: exit 1$/su);
      assert.deepEqual(
        ids(calls)
          .filter((id) => id.startsWith('round/'))
          .sort(),
        ['round/0/triage'],
      );
      untouched(env);
    },
  },
  {
    mode: 'round-cap',
    input: () => ({ ...input(), maxFixRounds: 1 }),
    check({ result, env, calls }) {
      // Round 0 triages four root causes: three fixers run (two change nothing) and the fourth
      // cluster is over the cap. The one change keeps now(), so round 1 is red again with no fix
      // round left: the triage only reports, and its cluster is what remains.
      const { output } = result;
      assert.equal(output.status, 'unstable');
      assert.equal(output.rounds, 2);
      const [first, last] = output.verification;
      assert.deepEqual(
        first.clusters.map((cluster) => [cluster.fix, cluster.files]),
        [
          ['applied', ['src/report.mjs']],
          ['unchanged', ['src/clock.mjs']],
          ['unchanged', ['package.json']],
          ['deferred', ['package-lock.json']],
        ],
      );
      assert.deepEqual([last.passed, last.triage], [false, 'report']);
      assert.deepEqual(
        last.clusters.map((cluster) => [cluster.fix, cluster.files]),
        [['not-attempted', ['src/report.mjs']]],
      );
      assert.notEqual(last.commit, first.commit);
      assert.deepEqual(output.remaining, [stale]);
      assert.deepEqual(
        ids(calls)
          .filter((id) => id.startsWith('round/'))
          .sort(),
        [
          'round/0/fixes/0/fix',
          'round/0/fixes/1/fix',
          'round/0/fixes/2/fix',
          'round/0/triage',
          'round/1/triage',
        ],
      );
      untouched(env);
    },
  },
  {
    mode: 'fix-strays',
    check({ result, env }) {
      // A fixer that touched a file its cluster does not own is refused and never integrated.
      const { output } = result;
      assert.equal(output.status, 'unstable');
      const [refused] = output.verification[0].clusters;
      assert.equal(refused.fix, 'refused');
      assert.match(refused.summary, /target\.mjs \(modified\)/u);
      untouched(env);
    },
  },
  {
    mode: 'install-strays',
    input: () => ({
      ...input(),
      installCommand: [
        process.execPath,
        '-e',
        `${install}fs.writeFileSync('install.log','resolved\\n');`,
      ],
    }),
    check({ result, env }) {
      // The install wrote a file the plan does not list, which the snapshot captures. The green
      // tree's handle has no receipt, so code diffs the integration against the base and refuses
      // to publish it.
      const { output } = result;
      assert.equal(output.status, 'refused');
      assert.equal(output.verification.at(-1).passed, true);
      assert.match(output.refusal, /outside the plan: install\.log \(A\)$/u);
      untouched(env);
    },
  },
  {
    mode: 'checkout-moves',
    check({ result, env, calls }) {
      // Someone commits during the research: code sees it after the approval, before paying for
      // the upgrader or any verification.
      const { output } = result;
      assert.equal(output.status, 'base-moved');
      assert.deepEqual([output.rounds, output.commit], [0, null]);
      noWriters(calls);
      movedOnly(env);
    },
  },
  {
    mode: 'moves-mid-loop',
    check({ result, env, calls }) {
      // Someone commits while a fixer works: code sees it before integrating the fix, so no later
      // round verifies a tree that includes the foreign commit, and nothing is published.
      const { output } = result;
      assert.equal(output.status, 'base-moved');
      assert.equal(output.rounds, 1);
      assert.equal(output.verification[0].clusters[0].fix, 'applied');
      assert.equal(output.commit, output.verification[0].commit);
      assert.equal(
        ids(calls).some((id) => id.startsWith('round/1/')),
        false,
      );
      movedOnly(env);
    },
  },
];

/** A code-found file the analyst did not classify, or one it never saw, leaves the map partial. */
export const degraded = (output) =>
  output.usage.unclassified.length > 0 ||
  output.usage.unmapped.length > 0 ||
  output.usage.evidenceOmitted > 0;
