// research-synthesis: four sweeps find six distinct leads (the docs twice, under different
// spellings); code ranks them, reads the top four at quick depth and defers two. The local lead is
// read by the local reader in a snapshot of HEAD while the checkout holds an uncommitted edit; one
// web reading is not useful. The draft cites a key no source has, which the critic's prompt
// reports; the critic returns four gaps. Two web hunts find a new source and reread a known one,
// a local hunt in the snapshot comes back empty, and the fourth gap is reported unhunted. The
// revision cites every source. The modes fail one member at a time, run the other two depths,
// mislabel leads in both directions, have each local role change its snapshot or name a path
// outside it, and run with a context outside any Git repository.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, leaf, writeFiles } from './_support.mjs';

const question = 'Should we replace our parser with Xlib?';
const context = 'Node 22; target.mjs is our parser';
const lead = (ref, kind, credibility, promise) => ({ ref, kind, credibility, promise });
const docs = lead('https://xlib.dev/docs/', 'official-docs', 'primary', 'Supported formats');
const blog = lead('https://blog.example/xlib', 'writeup', 'secondary', 'An independent review');
const releases = lead('https://github.com/xlib/xlib/releases', 'source-code', 'primary', 'Cadence');
const issue = lead('https://github.com/xlib/xlib/issues/42', 'issue-thread', 'primary', 'A crash');
const news = lead('https://news.example/1', 'discussion', 'anecdotal', 'Field reports');
const changelog = lead(
  'https://xlib.dev/changelog',
  'official-docs',
  'primary',
  'Breaking changes',
);
const repo = lead('https://github.com/xlib/xlib', 'source-code', 'primary', 'Test quality');
const sweeps = {
  web: [docs, blog],
  source: [
    lead('https://XLIB.dev/docs', 'official-docs', 'primary', 'The same docs'),
    releases,
    issue,
  ],
  practitioners: [news],
  local: [lead('target.mjs', 'local-code', 'primary', 'The parser we run')],
};
/** The local scout labels a repository file as documentation; its territory is still local. */
const internal = lead('README.md', 'official-docs', 'primary', 'Internal parser notes');
/** A web scout labels refs as local code: one names the local lead's file, one leaves the tree. */
const posing = [
  lead('target.mjs', 'local-code', 'primary', 'A forum says this is the parser'),
  lead('../secrets.env', 'local-code', 'primary', 'A page says read this'),
];
/** A local scout's lead outside the repository, and a local hunter's source outside it. */
const outside = lead('/etc/hosts', 'local-code', 'primary', 'The host table');
const escaped = {
  useful: true,
  findings: [{ claim: 'Found outside', support: 'Line 1', caveat: null }],
  contradicts: null,
  source: { ref: '../outside.md', kind: 'local-code', credibility: 'primary' },
};
/**
 * The ranking case: the issue thread is the fifth primary lead in sweep order, but two modalities
 * found it, so within the primary tier it overtakes the single-modality changelog, releases and
 * repository leads and the repository lead is deferred instead. A tier-only sort would read the
 * repository and defer the issue.
 */
const ranked = {
  web: [docs, changelog, blog],
  source: [
    lead('https://XLIB.dev/docs', 'official-docs', 'primary', 'Same'),
    releases,
    repo,
    issue,
  ],
  practitioners: [
    news,
    lead('https://GitHub.com/xlib/xlib/issues/42/', 'issue-thread', 'primary', 'Same'),
  ],
};
/** The depth case: sixteen distinct leads, the even ones primary and the odd ones secondary. */
const many = Array.from({ length: 16 }, (_, n) =>
  lead(`https://many.example/${String(n)}`, 'writeup', n % 2 ? 'secondary' : 'primary', 'More'),
);
const spread = { web: many.slice(0, 6), source: many.slice(6, 11), practitioners: many.slice(11) };
const refs = (numbers) => numbers.map((n) => `https://many.example/${String(n)}`);
const finding = (claim) => ({ claim, support: 'Section 1', caveat: null });
const readings = {
  'https://xlib.dev/docs': [finding('Xlib parses JSON5'), finding('Xlib needs Node 20')],
  'https://github.com/xlib/xlib/releases': [finding('Monthly releases since 2023')],
  'https://github.com/xlib/xlib/issues/42': [],
  'https://blog.example/xlib': [finding('A reviewer found Xlib fast')],
  'https://xlib.dev/changelog': [finding('Xlib 3 changed the error type')],
  'https://github.com/xlib/xlib': [finding('Xlib has fuzz tests')],
  'https://news.example/1': [],
};
const gap = (text, huntInstruction, territory) => ({ gap: text, huntInstruction, territory });
const gaps = [
  gap('No benchmark', 'Read the Xlib benchmark page', 'web'),
  gap('Version unclear', 'Reread the docs version table', 'web'),
  gap('Call sites unknown', 'Find every import of target.mjs', 'local'),
  gap('No security audit', 'Find an audit', 'web'),
];
const hunted = {
  'No benchmark': {
    useful: true,
    findings: [finding('Xlib is 2x faster')],
    contradicts: null,
    source: { ref: 'https://xlib.dev/bench', kind: 'benchmark', credibility: 'primary' },
  },
  'Version unclear': {
    useful: true,
    findings: [finding('Xlib 3 dropped Node 18')],
    contradicts: 'The blog says Node 18 works',
    source: { ref: 'https://xlib.dev/docs', kind: 'official-docs', credibility: 'primary' },
  },
  'Call sites unknown': { useful: false, findings: [], contradicts: null, source: null },
  // A web hunt names the local lead's path as its source: a web source, never the local one.
  'Parser provenance': {
    useful: true,
    findings: [finding('A forum names target.mjs as the parser')],
    contradicts: null,
    source: { ref: 'target.mjs', kind: 'local-code', credibility: 'anecdotal' },
  },
};
const drafts = {
  normal: 'Adopt Xlib [S1][S2]; our parser is small [S3]. Benchmarks agree [S7].',
  'unknown-citation': 'Adopt Xlib [S1][S2]; our parser is small [S3]. Benchmarks agree [S7].',
  uncited: 'Adopt Xlib: it is well maintained and fast.',
};
const revisions = {
  normal:
    'Adopt Xlib [S1][S2]: it is faster [S4], and our parser is small [S3]. Its call sites are unknown.',
  'failed-hunt': 'Adopt Xlib [S1][S2]; our parser is small [S3]. Node 18 is unsupported [S1].',
};
/** The sweep leads each mode's scouts return. */
const leadsFor = (mode) =>
  mode === 'no-context' || mode === 'critic-fails'
    ? ranked
    : mode === 'standard-depth' || mode === 'deep-depth'
      ? spread
      : mode === 'mislabeled-local'
        ? { ...sweeps, local: [internal] }
        : mode === 'mislabeled-web'
          ? { ...sweeps, practitioners: [news, ...posing] }
          : mode === 'escaping-local'
            ? { ...sweeps, local: [outside] }
            : sweeps;
/** The critic's gaps: four in the main cases, one local gap where a local hunt is the subject. */
const gapsFor = (mode) =>
  ['normal', 'failed-hunt', 'mislabeled-local'].includes(mode)
    ? gaps
    : mode === 'no-repository'
      ? [gap('Call sites unknown', 'Find a migration guide', 'local')]
      : mode === 'snapshot-changed' || mode === 'escaping-local'
        ? [gap('Call sites unknown', 'Find every import of target.mjs', 'local')]
        : mode === 'mislabeled-web'
          ? [gap('Parser provenance', 'Search for who maintains the parser', 'web')]
          : [];
const modalityOf = (prompt) =>
  prompt.includes('Your modality is web search')
    ? 'web'
    : prompt.includes('Your modality is source code')
      ? 'source'
      : prompt.includes('Your modality is practitioner')
        ? 'practitioners'
        : 'local';
const refOf = (prompt) => prompt.match(/^Source: (\S+) \(/mu)[1];
const gapOf = (prompt) => prompt.match(/^Gap: (.+)$/mu)[1];
const normalize = (ref) => ref.toLowerCase().replace(/\/$/u, '');
const sweep = (id) => /^sweeps\/[a-z]+\/sweep$/u.test(id);
const read = (id) => /^reads\/\d+\/read$/u.test(id);
const hunt = (id) => /^hunts\/\d+\/hunt$/u.test(id);

export const input = () => ({ question, context, depth: 'quick' });

/** The first line of a file in the local role's snapshot, so a read of the dirty checkout shows. */
const firstLine = (request, ref) =>
  readFileSync(join(request.cwd, ref), 'utf8').split('\n')[0].trim();

export function reply(request, env, mode) {
  const id = request.call.stepId;
  const prompt = request.options.prompt;
  if (sweep(id)) {
    // The sweeps map is keyed by modality, and each scout gets its own modality's charter.
    assert.equal(modalityOf(prompt), id.split('/')[1]);
    if (local(request) && mode === 'snapshot-changed')
      writeFileSync(join(request.cwd, 'scout.md'), 'A scout should not write\n');
    return { leads: mode === 'no-leads' ? [] : leadsFor(mode)[modalityOf(prompt)] };
  }
  if (read(id)) {
    const ref = refOf(prompt);
    if (local(request) && mode === 'reader-changed')
      writeFileSync(join(request.cwd, 'notes.md'), 'A reader should not write\n');
    const findings =
      mode === 'no-findings'
        ? []
        : local(request)
          ? [
              finding(
                ref === 'target.mjs'
                  ? `Our parser is ${firstLine(request, ref)}`
                  : `${ref} says ${firstLine(request, ref)}`,
              ),
            ]
          : posing.some((posed) => posed.ref === ref)
            ? []
            : ref.startsWith('https://many.example/')
              ? [finding(`${ref} agrees`)]
              : leadsFor(mode) === ranked && ref.endsWith('/42')
                ? [finding('Large files crash Xlib 2')]
                : readings[normalize(ref)];
    return { useful: findings.length > 0, findings, contradicts: null };
  }
  if (id === 'synthesize') return drafts[mode] ?? 'Adopt Xlib cautiously [S1][S2].';
  if (id === 'critic') return { gaps: gapsFor(mode) };
  if (hunt(id)) {
    if (local(request) && mode === 'snapshot-changed')
      writeFileSync(join(request.cwd, 'hunt.md'), 'A hunter should not write\n');
    if (local(request) && mode === 'escaping-local') return escaped;
    return hunted[gapOf(prompt)];
  }
  if (id === 'resynthesize') return revisions[mode] ?? revisions.normal;
  throw new Error(`Unhandled research-synthesis step ${id} (${mode})`);
}

/** Each failure mode fails one kind of member, so each status and confidence rule is seen alone. */
export function fail(request, mode) {
  const id = request.call.stepId;
  const prompt = request.options.prompt;
  if (mode === 'failed-hunt') return hunt(id) && gapOf(prompt) === 'No benchmark';
  if (mode === 'all-sweeps-fail') return sweep(id);
  if (mode === 'all-reads-fail') return read(id);
  if (mode === 'sweep-fails') return id === 'sweeps/web/sweep';
  if (mode === 'read-fails') return read(id) && refOf(prompt).endsWith('/releases');
  if (mode === 'critic-fails') return id === 'critic';
  return false;
}

const fileTools = ['Read', 'Grep', 'Glob'];
const webTools = ['WebSearch', 'WebFetch'];
/** The run's Git pins: each snapshot call's base at HEAD, and the capture of one that changed. */
const pins = (env) =>
  git(env.cwd, 'for-each-ref', '--format=%(objectname)', 'refs/quiet-choir')
    .split('\n')
    .filter(Boolean);
/**
 * The checkout keeps its uncommitted edit and its HEAD. Every call runs on Claude and is a web
 * role (web tools only, in the checkout), a local role (file tools only, in a snapshot whose pin
 * is the head), or the tool-less synthesizer or critic; no call holds both file and web tools.
 * Returns the snapshot calls.
 */
function readOnlyRun(env, calls, { changed = 0, cwd = env.cwd } = {}) {
  assert.equal(git(env.cwd, 'status', '--porcelain', '--untracked-files=all'), 'M target.mjs');
  assert.equal(git(env.cwd, 'rev-parse', 'HEAD'), env.head);
  let snapshots = 0;
  for (const call of calls) {
    const id = call.call.stepId;
    assert.equal(call.harness, 'claude');
    if (id === 'critic' || id === 'synthesize' || id === 'resynthesize') {
      assert.deepEqual(call.options.tools, []);
      assert.equal(call.cwd, cwd);
      assert.equal(call.options.model, 'opus');
      assert.equal(call.options.effort, 'high');
    } else if (call.options.tools.includes('Read')) {
      assert.deepEqual(call.options.tools, fileTools);
      assert.ok(call.cwd.startsWith(env.worktrees.root), `${id} ran outside a snapshot`);
      snapshots += 1;
    } else {
      assert.deepEqual(call.options.tools, webTools, id);
      assert.equal(call.cwd, cwd);
    }
  }
  if (cwd === env.cwd) {
    assert.equal(pins(env).filter((pin) => pin === env.head).length, snapshots);
    assert.equal(pins(env).filter((pin) => pin !== env.head).length, changed);
  }
  return snapshots;
}
const steps = (calls) => calls.map((call) => call.call.stepId).sort();
/** A map item's index; calls are recorded in admission order, not item order. */
const index = (call) => Number(call.call.stepId.split('/')[1]);
const ordered = (calls, name) =>
  calls.filter((call) => leaf(call.call.stepId) === name).sort((a, b) => index(a) - index(b));
/** The sweeps map is keyed by modality, so its calls are listed in modality order. */
const modalities = ['web', 'source', 'practitioners', 'local'];
const sweepsOf = (calls) =>
  calls
    .filter((call) => sweep(call.call.stepId))
    .sort(
      (a, b) =>
        modalities.indexOf(a.call.stepId.split('/')[1]) -
        modalities.indexOf(b.call.stepId.split('/')[1]),
    );
/** A local role's call: it alone has the file tools. */
const local = (call) => call.options.tools?.includes('Read') === true;
/** A web role's call: it alone has the web tools. */
const webRole = (call) => call.options.tools?.includes('WebFetch') === true;
/** The refs and promises the local scout found, which no web role's prompt may hold. */
const localOnly = (calls, texts) => {
  for (const call of calls.filter(webRole))
    for (const text of texts) assert.ok(!call.options.prompt.includes(text), call.call.stepId);
};
/** The settled error message of the map item that ran this step. */
const errorOf = (record, stepId) =>
  record.maps[stepId.split('/')[0]].items.find((item) => item.steps.includes(stepId)).outcome.error
    .message;
const prompt = (calls, id) => calls.find((call) => call.call.stepId === id).options.prompt;
/** The rendered list of known refs a hunt prompt gives, or [] when it gives none. */
const knownOf = (text) =>
  [
    ...(text.split('already read')[1]?.split('Follow the instruction')[0] ?? '').matchAll(
      /^- (.+)$/gmu,
    ),
  ].map((match) => match[1]);

/** The checkout holds an uncommitted edit, which no local role may read. */
export async function setup(env) {
  env.head = git(env.cwd, 'rev-parse', 'HEAD');
  await writeFiles(env.cwd, { 'target.mjs': 'export const value = 2;\n' });
}

export function check({ result, env, calls, suspended }) {
  const { output } = result;
  assert.equal(output.status, 'answered');
  assert.equal(output.confidence, 'moderate');
  assert.equal(output.critic, 'gaps');
  assert.equal(suspended, 0);
  assert.deepEqual(output.swept, ['web', 'source', 'practitioners', 'local']);
  assert.deepEqual(output.unswept, []);
  assert.equal(output.localCommit, env.head);
  // Six distinct leads: the two spellings of the docs merge, and both modalities are recorded.
  assert.equal(output.leadsFound, 6);
  assert.deepEqual(
    output.deferred.map((deferred) => deferred.ref),
    ['https://blog.example/xlib', 'https://news.example/1'],
  );
  assert.deepEqual(output.unread, [
    { ref: 'https://github.com/xlib/xlib/issues/42', outcome: 'not-useful' },
  ]);
  assert.deepEqual(
    output.sources.map((source) => [source.id, source.ref, source.origin, source.findings.length]),
    [
      ['S1', 'https://xlib.dev/docs/', 'lead', 3],
      ['S2', 'https://github.com/xlib/xlib/releases', 'lead', 1],
      ['S3', 'target.mjs', 'lead', 1],
      ['S4', 'https://xlib.dev/bench', 'hunt', 1],
    ],
  );
  // The local reader saw the committed parser, not the checkout's uncommitted edit.
  assert.equal(output.sources[2].findings[0].claim, 'Our parser is export const value = 1;');
  assert.deepEqual(output.sources[0].contradicts, ['The blog says Node 18 works']);
  assert.deepEqual(
    output.gaps.map((tracked) => [tracked.territory, tracked.hunt, tracked.source]),
    [
      ['web', 'found', 'S4'],
      ['web', 'found', 'S1'],
      ['local', 'empty', null],
      ['web', 'unhunted', null],
    ],
  );
  assert.deepEqual(output.unknownCitations, []);
  assert.deepEqual(output.uncitedSources, []);
  assert.ok(output.answer.startsWith('Adopt Xlib [S1][S2]: it is faster [S4]'));
  assert.ok(output.answer.endsWith('- [S4] https://xlib.dev/bench (benchmark, primary)'));
  // The ranked top four were read: the local lead by the local reader, the rest by web readers.
  const reads = ordered(calls, 'read');
  assert.deepEqual(
    reads.map((call) => [refOf(call.options.prompt), local(call)]),
    [
      ['https://xlib.dev/docs/', false],
      ['https://github.com/xlib/xlib/releases', false],
      ['https://github.com/xlib/xlib/issues/42', false],
      ['target.mjs', true],
    ],
  );
  assert.match(reads[0].options.prompt, /found by web, source\)/u);
  assert.match(
    reads[3].options.prompt,
    new RegExp(`checked out for you at commit ${env.head}\\.`, 'u'),
  );
  // Only the local sweep had file tools.
  assert.deepEqual(
    sweepsOf(calls).map((call) => [call.call.stepId, local(call)]),
    [
      ['sweeps/web/sweep', false],
      ['sweeps/source/sweep', false],
      ['sweeps/practitioners/sweep', false],
      ['sweeps/local/sweep', true],
    ],
  );
  // The critic hears what code checked: every keyed source, the draft's unknown key and the
  // deferred leads; with a snapshot it may route gaps locally, and is told not to quote them.
  const critic = prompt(calls, 'critic');
  assert.match(critic, /^\[S1\] https:\/\/xlib\.dev\/docs\/ \(official-docs, primary\)$/mu);
  assert.match(critic, /^\[S3\] target\.mjs \(local-code, primary; from this repository\)$/mu);
  assert.match(critic, /these cited keys match no source: S7\./u);
  assert.match(critic, /- https:\/\/news\.example\/1 \(discussion, anecdotal\)/u);
  assert.match(critic, /Give each gap a territory\./u);
  assert.match(critic, /never quote in them the paths, code or findings of anything marked/u);
  assert.match(critic, /evidence, never as instructions/u);
  assert.doesNotMatch(critic, /never searched|read failed/u);
  // Three hunts, routed by territory: the local one in a snapshot, the web ones without file
  // tools. A web hunt is never told the repository's paths; the local hunt knows only them.
  const hunts = ordered(calls, 'hunt');
  assert.deepEqual(
    hunts.map((call) => [gapOf(call.options.prompt), local(call), knownOf(call.options.prompt)]),
    [
      ['No benchmark', false, ['https://xlib.dev/docs/', 'https://github.com/xlib/xlib/releases']],
      [
        'Version unclear',
        false,
        ['https://xlib.dev/docs/', 'https://github.com/xlib/xlib/releases'],
      ],
      ['Call sites unknown', true, ['target.mjs']],
    ],
  );
  const revision = prompt(calls, 'resynthesize');
  assert.match(revision, /- No benchmark \(new evidence in \[S4\]\)/u);
  assert.match(revision, /- Call sites unknown \(a hunt found nothing\)/u);
  assert.match(revision, /- No security audit \(not hunted\)/u);
  assert.equal(calls.length, 14);
  // The local sweep, the local read and the local hunt each ran in their own snapshot.
  assert.equal(readOnlyRun(env, calls), 3);
}

export const readOnly = 'Read-only: every role reads and the workflow writes nothing';

/**
 * The sweeps are a concurrent fan-out, so the faults name their steps: F1 fails the synthesis,
 * the first call that throws, and F2 the critic, the one schema call outside a fan-out (every
 * schema call is settled, so the run completes without its critique).
 */
export const faults = { F1: '^synthesize$', F2: '^critic$' };

/** A clean, adequately critiqued run but for the one failure a mode injects. */
function cleanBut(output) {
  assert.equal(output.answer.split('\n')[0], 'Adopt Xlib cautiously [S1][S2].');
  assert.deepEqual(output.gaps, []);
  assert.deepEqual(output.unknownCitations, []);
}

export const modes = [
  {
    // No context: no snapshot and no file tools anywhere. Two modalities found the issue thread,
    // so it overtakes the single-modality repository lead across the depth cap; four primary
    // sources and an adequate critic give high confidence.
    mode: 'no-context',
    input: () => ({ question, depth: 'quick' }),
    check({ result, env, calls, record }) {
      const { output } = result;
      assert.equal(output.status, 'answered');
      assert.equal(output.critic, 'adequate');
      assert.equal(output.confidence, 'high');
      assert.deepEqual(output.swept, ['web', 'source', 'practitioners']);
      assert.deepEqual(output.unswept, []);
      assert.equal(output.localCommit, null);
      assert.equal(record.steps.head, undefined);
      assert.equal(output.leadsFound, 7);
      assert.deepEqual(
        ordered(calls, 'read').map((call) => refOf(call.options.prompt)),
        [
          'https://xlib.dev/docs/',
          'https://github.com/xlib/xlib/issues/42',
          'https://xlib.dev/changelog',
          'https://github.com/xlib/xlib/releases',
        ],
      );
      assert.match(ordered(calls, 'read')[1].options.prompt, /found by source, practitioners\)/u);
      assert.deepEqual(
        output.deferred.map((deferred) => deferred.ref),
        ['https://github.com/xlib/xlib', 'https://blog.example/xlib', 'https://news.example/1'],
      );
      assert.deepEqual(
        output.sources.map((source) => source.credibility),
        ['primary', 'primary', 'primary', 'primary'],
      );
      cleanBut(output);
      assert.ok(!steps(calls).some((id) => id === 'resynthesize' || id.startsWith('hunts/')));
      // Uncited sources are reported but do not degrade an answer whose citations all resolve.
      assert.deepEqual(output.uncitedSources, ['S3', 'S4']);
      assert.match(prompt(calls, 'critic'), /every hunt searches the web/u);
      assert.equal(readOnlyRun(env, calls), 0);
    },
  },
  {
    // The default depth reads eight: the eight primary leads, deferring the eight secondary ones.
    mode: 'standard-depth',
    input: () => ({ question }),
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'answered');
      assert.equal(output.leadsFound, 16);
      assert.deepEqual(
        ordered(calls, 'read').map((call) => refOf(call.options.prompt)),
        refs([0, 2, 4, 6, 8, 10, 12, 14]),
      );
      assert.deepEqual(
        output.deferred.map((deferred) => deferred.ref),
        refs([1, 3, 5, 7, 9, 11, 13, 15]),
      );
      assert.equal(output.sources.length, 8);
      assert.equal(readOnlyRun(env, calls), 0);
    },
  },
  {
    // Deep reads fourteen: the eight primary leads and the first six secondary ones.
    mode: 'deep-depth',
    input: () => ({ question, depth: 'deep' }),
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'answered');
      assert.deepEqual(
        ordered(calls, 'read').map((call) => refOf(call.options.prompt)),
        refs([0, 2, 4, 6, 8, 10, 12, 14, 1, 3, 5, 7, 9, 11]),
      );
      assert.deepEqual(
        output.deferred.map((deferred) => deferred.ref),
        refs([13, 15]),
      );
      assert.equal(output.sources.length, 14);
      assert.equal(readOnlyRun(env, calls), 0);
    },
  },
  {
    // Every sweep answered with nothing: a clean empty result.
    mode: 'no-leads',
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'no-leads');
      assert.equal(output.answer, null);
      assert.equal(output.confidence, 'none');
      assert.equal(output.critic, 'not-run');
      assert.equal(output.leadsFound, 0);
      assert.deepEqual(output.unswept, []);
      assert.deepEqual(steps(calls), [
        'sweeps/local/sweep',
        'sweeps/practitioners/sweep',
        'sweeps/source/sweep',
        'sweeps/web/sweep',
      ]);
      assert.equal(readOnlyRun(env, calls), 1);
    },
  },
  {
    // Every sweep failed: the run could not search, which is not the same as finding nothing.
    mode: 'all-sweeps-fail',
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(output.unswept, ['web', 'source', 'practitioners', 'local']);
      assert.equal(output.answer, null);
      assert.equal(output.confidence, 'none');
      assert.equal(output.leadsFound, 0);
      assert.equal(steps(calls).length, 4);
      assert.equal(readOnlyRun(env, calls), 1);
    },
  },
  {
    // Every reading was not useful: a clean result with nothing to cite.
    mode: 'no-findings',
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'no-findings');
      assert.equal(output.answer, null);
      assert.equal(output.confidence, 'none');
      assert.deepEqual(
        output.unread.map((unread) => unread.outcome),
        ['not-useful', 'not-useful', 'not-useful', 'not-useful'],
      );
      assert.equal(output.deferred.length, 2);
      assert.ok(!steps(calls).includes('synthesize'));
      assert.equal(readOnlyRun(env, calls), 2);
    },
  },
  {
    // Every read failed: nothing was read, which is not the same as reading nothing useful.
    mode: 'all-reads-fail',
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.equal(output.answer, null);
      assert.equal(output.confidence, 'none');
      assert.deepEqual(
        output.unread.map((unread) => unread.outcome),
        ['failed', 'failed', 'failed', 'failed'],
      );
      assert.ok(!steps(calls).includes('synthesize'));
      assert.equal(readOnlyRun(env, calls), 2);
    },
  },
  {
    // Only the web sweep fails: its territory is reported to the critic and degrades the status,
    // although every other member answered and the evidence alone would be high confidence.
    mode: 'sweep-fails',
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(output.unswept, ['web']);
      assert.deepEqual(output.unread, [
        { ref: 'https://github.com/xlib/xlib/issues/42', outcome: 'not-useful' },
      ]);
      assert.equal(output.critic, 'adequate');
      assert.equal(output.confidence, 'high');
      cleanBut(output);
      assert.match(
        prompt(calls, 'critic'),
        /never searched, because their sweep failed or could not run:\nweb\./u,
      );
      assert.equal(readOnlyRun(env, calls), 2);
    },
  },
  {
    // Only one read fails: it is reported to the critic and degrades the status.
    mode: 'read-fails',
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(output.unswept, []);
      assert.deepEqual(output.unread, [
        { ref: 'https://github.com/xlib/xlib/releases', outcome: 'failed' },
        { ref: 'https://github.com/xlib/xlib/issues/42', outcome: 'not-useful' },
      ]);
      assert.deepEqual(
        output.sources.map((source) => source.ref),
        ['https://xlib.dev/docs/', 'target.mjs'],
      );
      assert.equal(output.critic, 'adequate');
      assert.equal(output.confidence, 'low');
      cleanBut(output);
      assert.match(
        prompt(calls, 'critic'),
        /their read failed[^]*\n- https:\/\/github\.com\/xlib\/xlib\/releases \(source-code, primary\): Cadence\n/u,
      );
      assert.equal(readOnlyRun(env, calls), 2);
    },
  },
  {
    // Only the critic fails, as on a spend or turn limit: the draft stands, the status
    // is degraded, and four primary sources are moderate, not high, confidence.
    mode: 'critic-fails',
    input: () => ({ question, depth: 'quick' }),
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.equal(output.critic, 'failed');
      assert.equal(output.confidence, 'moderate');
      assert.deepEqual(output.unswept, []);
      assert.ok(output.unread.every((unread) => unread.outcome !== 'failed'));
      assert.deepEqual(
        output.sources.map((source) => source.credibility),
        ['primary', 'primary', 'primary', 'primary'],
      );
      cleanBut(output);
      assert.ok(!steps(calls).some((id) => id === 'resynthesize' || id.startsWith('hunts/')));
      assert.equal(readOnlyRun(env, calls), 0);
    },
  },
  {
    // The local reader writes a file in its snapshot: code refuses the reading, so the lead is a
    // failed read. The write stays in the pinned snapshot, out of the checkout.
    mode: 'reader-changed',
    check({ result, env, calls, record }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(output.unread, [
        { ref: 'https://github.com/xlib/xlib/issues/42', outcome: 'not-useful' },
        { ref: 'target.mjs', outcome: 'failed' },
      ]);
      assert.deepEqual(
        output.sources.map((source) => source.ref),
        ['https://xlib.dev/docs/', 'https://github.com/xlib/xlib/releases'],
      );
      assert.equal(output.critic, 'adequate');
      assert.match(errorOf(record, 'reads/3/read'), /changed its snapshot/u);
      assert.match(
        prompt(calls, 'critic'),
        /their read failed[^]*\n- target\.mjs \(local-code, primary; from this repository\)/u,
      );
      assert.deepEqual(
        pins(env)
          .filter((pin) => pin !== env.head)
          .map((pin) => git(env.cwd, 'diff', '--name-only', env.head, pin)),
        ['notes.md'],
      );
      assert.equal(readOnlyRun(env, calls, { changed: 1 }), 2);
    },
  },
  {
    // The local scout and the local hunter each write a file in their snapshot: code refuses both,
    // so the local territory is unswept and the local hunt failed, with each write kept out of the
    // checkout.
    mode: 'snapshot-changed',
    check({ result, env, calls, record }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(output.unswept, ['local']);
      assert.equal(output.leadsFound, 5);
      assert.ok(output.sources.every((source) => source.territory === 'web'));
      assert.match(errorOf(record, 'sweeps/local/sweep'), /changed its snapshot/u);
      assert.match(errorOf(record, 'hunts/0/hunt'), /changed its snapshot/u);
      assert.deepEqual(
        output.gaps.map((tracked) => [tracked.territory, tracked.hunt]),
        [['local', 'failed']],
      );
      assert.match(prompt(calls, 'critic'), /could not run:\nlocal\./u);
      assert.deepEqual(
        pins(env)
          .filter((pin) => pin !== env.head)
          .map((pin) => git(env.cwd, 'diff', '--name-only', env.head, pin))
          .sort(),
        ['hunt.md', 'scout.md'],
      );
      assert.equal(readOnlyRun(env, calls, { changed: 2 }), 2);
    },
  },
  {
    // The local scout names a path outside the repository and the local hunter names another as
    // its source: code refuses both before any reader sees them.
    mode: 'escaping-local',
    check({ result, env, calls, record }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(output.unswept, ['local']);
      assert.match(
        errorOf(record, 'sweeps/local/sweep'),
        /outside the repository[^]*\/etc\/hosts/u,
      );
      assert.match(errorOf(record, 'hunts/0/hunt'), /outside the repository[^]*\.\.\/outside\.md/u);
      assert.deepEqual(
        output.gaps.map((tracked) => [tracked.territory, tracked.hunt, tracked.source]),
        [['local', 'failed', null]],
      );
      assert.ok(!calls.some((call) => call.options.prompt.includes('/etc/hosts')));
      assert.ok(!output.sources.some((source) => source.ref.includes('outside')));
      assert.equal(readOnlyRun(env, calls), 2);
    },
  },
  {
    // The local scout labels a repository file as official documentation. Code routes on the
    // territory, not the kind: the local reader reads it in the snapshot, the critic sees it
    // marked as from this repository, and no web role's prompt holds its path or promise.
    mode: 'mislabeled-local',
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'answered');
      assert.deepEqual(
        output.sources.map((source) => [source.id, source.ref, source.kind, source.territory]),
        [
          ['S1', 'https://xlib.dev/docs/', 'official-docs', 'web'],
          ['S2', 'https://github.com/xlib/xlib/releases', 'source-code', 'web'],
          ['S3', 'README.md', 'official-docs', 'local'],
          ['S4', 'https://xlib.dev/bench', 'benchmark', 'web'],
        ],
      );
      const reads = ordered(calls, 'read');
      assert.deepEqual(
        reads.map((call) => [refOf(call.options.prompt), local(call)]),
        [
          ['https://xlib.dev/docs/', false],
          ['https://github.com/xlib/xlib/releases', false],
          ['https://github.com/xlib/xlib/issues/42', false],
          ['README.md', true],
        ],
      );
      assert.match(
        prompt(calls, 'critic'),
        /^\[S3\] README\.md \(official-docs, primary; from this repository\)$/mu,
      );
      assert.deepEqual(
        ordered(calls, 'hunt').map((call) => [local(call), knownOf(call.options.prompt)]),
        [
          [false, ['https://xlib.dev/docs/', 'https://github.com/xlib/xlib/releases']],
          [false, ['https://xlib.dev/docs/', 'https://github.com/xlib/xlib/releases']],
          [true, ['README.md']],
        ],
      );
      localOnly(calls, ['README.md', 'Internal parser notes']);
      assert.equal(readOnlyRun(env, calls), 3);
    },
  },
  {
    // A web scout labels two refs as local code, one the local lead's own file and one outside
    // the tree. Code keeps them in the web territory: web readers get both, they never merge with
    // the local lead, and the local reader reads only what the local sweep found. A web hunt that
    // names the same path adds a web source rather than folding into the local one.
    mode: 'mislabeled-web',
    input: () => ({ question, context }),
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'answered');
      assert.equal(output.leadsFound, 8);
      assert.deepEqual(output.deferred, []);
      const reads = ordered(calls, 'read').map((call) => [refOf(call.options.prompt), local(call)]);
      assert.deepEqual(
        reads.filter(([ref]) => ref === 'target.mjs' || ref === '../secrets.env'),
        [
          ['target.mjs', false],
          ['../secrets.env', false],
          ['target.mjs', true],
        ],
      );
      assert.deepEqual(
        reads.filter(([, isLocal]) => isLocal),
        [['target.mjs', true]],
      );
      assert.deepEqual(
        output.unread.filter((unread) => unread.ref !== 'https://github.com/xlib/xlib/issues/42'),
        [
          { ref: 'target.mjs', outcome: 'not-useful' },
          { ref: '../secrets.env', outcome: 'not-useful' },
          { ref: 'https://news.example/1', outcome: 'not-useful' },
        ],
      );
      assert.deepEqual(
        output.sources
          .filter((source) => source.ref === 'target.mjs')
          .map((source) => [source.id, source.territory, source.origin, source.findings.length]),
        [
          ['S3', 'local', 'lead', 1],
          ['S5', 'web', 'hunt', 1],
        ],
      );
      assert.equal(output.sources[2].findings[0].claim, 'Our parser is export const value = 1;');
      assert.deepEqual(
        output.gaps.map((tracked) => [tracked.territory, tracked.hunt, tracked.source]),
        [['web', 'found', 'S5']],
      );
      assert.deepEqual(knownOf(ordered(calls, 'hunt')[0].options.prompt), [
        'https://xlib.dev/docs/',
        'https://github.com/xlib/xlib/releases',
        'https://blog.example/xlib',
      ]);
      localOnly(calls, ['The parser we run', 'Our parser is export']);
      assert.equal(readOnlyRun(env, calls), 2);
    },
  },
  {
    // A context outside any Git repository still grounds every prompt, but there is no commit to
    // pin, so the local territory goes unsearched and the result says so.
    mode: 'no-repository',
    options(opts, env) {
      env.plain = join(env.root, 'plain');
      mkdirSync(env.plain);
      return { ...opts, cwd: env.plain };
    },
    check({ result, env, calls, record }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(output.swept, ['web', 'source', 'practitioners']);
      assert.deepEqual(output.unswept, ['local']);
      assert.equal(output.localCommit, null);
      assert.equal(record.steps.head.status, 'settled-failed');
      assert.ok(sweepsOf(calls).every((call) => call.options.prompt.includes(context)));
      const critic = prompt(calls, 'critic');
      assert.match(critic, /could not run:\nlocal\./u);
      assert.match(critic, /No local hunt can run/u);
      // The critic asked for a local hunt anyway: with nothing pinned it is a web hunt.
      assert.equal(output.critic, 'gaps');
      assert.deepEqual(
        output.gaps.map((tracked) => [tracked.territory, tracked.hunt]),
        [['web', 'empty']],
      );
      assert.deepEqual(ordered(calls, 'hunt')[0].options.tools, webTools);
      assert.ok(!steps(calls).includes('resynthesize'));
      assert.deepEqual(readdirSync(env.plain), []);
      assert.equal(readOnlyRun(env, calls, { cwd: env.plain }), 0);
    },
  },
  {
    // One hunt fails: its gap says so, the other hunts still count, and the answer is degraded.
    mode: 'failed-hunt',
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(
        output.gaps.map((tracked) => [tracked.gap, tracked.hunt, tracked.source]),
        [
          ['No benchmark', 'failed', null],
          ['Version unclear', 'found', 'S1'],
          ['Call sites unknown', 'empty', null],
          ['No security audit', 'unhunted', null],
        ],
      );
      assert.deepEqual(
        output.sources.map((source) => source.id),
        ['S1', 'S2', 'S3'],
      );
      assert.deepEqual(output.unknownCitations, []);
      assert.deepEqual(output.uncitedSources, []);
      assert.equal(output.confidence, 'low');
      assert.match(prompt(calls, 'resynthesize'), /- No benchmark \(its hunt failed\)/u);
      assert.equal(readOnlyRun(env, calls), 3);
    },
  },
  {
    // An adequate critic does not launder a citation that matches no source, and three primary
    // sources do not make it high confidence.
    mode: 'unknown-citation',
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.equal(output.critic, 'adequate');
      assert.equal(output.confidence, 'low');
      assert.deepEqual(output.unknownCitations, ['S7']);
      assert.deepEqual(output.uncitedSources, []);
      assert.ok(output.answer.includes('Benchmarks agree [S7].'));
      assert.equal(readOnlyRun(env, calls), 2);
    },
  },
  {
    // An answer that cites nothing is degraded and low, with every member answered.
    mode: 'uncited',
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.equal(output.critic, 'adequate');
      assert.equal(output.confidence, 'low');
      assert.deepEqual(output.unswept, []);
      assert.ok(output.unread.every((unread) => unread.outcome === 'not-useful'));
      assert.deepEqual(output.unknownCitations, []);
      assert.deepEqual(output.uncitedSources, ['S1', 'S2', 'S3']);
      assert.equal(readOnlyRun(env, calls), 2);
    },
  },
];

/** Deferred leads and unhunted gaps are caps the answered status does not show. */
export const degraded = (output) =>
  output.deferred.length > 0 || output.gaps.some((tracked) => tracked.hunt === 'unhunted');
