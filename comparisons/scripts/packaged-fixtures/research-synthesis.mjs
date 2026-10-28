// research-synthesis: four sweeps find six distinct leads (the docs twice, under different
// spellings); code ranks them, reads the top four at quick depth and defers two. The local lead is
// read by the local reader in a snapshot of HEAD while the checkout holds an uncommitted edit; one
// web reading is not useful. The draft cites a key no source has, which the critic's prompt
// reports; the critic returns four gaps. Two web hunts find a new source and reread a known one,
// a local hunt in the snapshot comes back empty, and the fourth gap is reported unhunted. The
// revision cites every source.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
const finding = (claim) => ({ claim, support: 'Section 1', caveat: null });
const readings = {
  'https://xlib.dev/docs': [finding('Xlib parses JSON5'), finding('Xlib needs Node 20')],
  'https://github.com/xlib/xlib/releases': [finding('Monthly releases since 2023')],
  'https://github.com/xlib/xlib/issues/42': [],
  'https://blog.example/xlib': [finding('A reviewer found Xlib fast')],
  'https://xlib.dev/changelog': [finding('Xlib 3 changed the error type')],
  'https://github.com/xlib/xlib': [finding('Xlib has fuzz tests')],
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

export const input = () => ({ question, context, depth: 'quick' });

export function reply(request, env, mode) {
  const id = request.call.stepId;
  const prompt = request.options.prompt;
  if (/^sweeps\/\d+\/sweep$/u.test(id))
    return {
      leads:
        mode === 'no-leads' ? [] : (mode === 'no-context' ? ranked : sweeps)[modalityOf(prompt)],
    };
  if (/^reads\/\d+\/read$/u.test(id)) {
    const ref = refOf(prompt);
    // The local reader reports what its snapshot holds, so a read of the dirty checkout shows.
    const findings =
      mode === 'no-findings'
        ? []
        : ref === 'target.mjs'
          ? [finding(`Our parser is ${readFileSync(join(request.cwd, ref), 'utf8').trim()}`)]
          : mode === 'no-context' && ref.endsWith('/42')
            ? [finding('Large files crash Xlib 2')]
            : readings[normalize(ref)];
    return { useful: findings.length > 0, findings, contradicts: null };
  }
  if (id === 'synthesize') return drafts[mode] ?? 'Adopt Xlib cautiously [S1][S2].';
  if (id === 'critic') return { gaps: mode === 'normal' || mode === 'failed-hunt' ? gaps : [] };
  if (/^hunts\/\d+\/hunt$/u.test(id)) return hunted[gapOf(prompt)];
  if (id === 'resynthesize') return revisions[mode];
  throw new Error(`Unhandled research-synthesis step ${id} (${mode})`);
}

export function fail(request, mode) {
  const id = request.call.stepId;
  const prompt = request.options.prompt;
  if (mode === 'failed-hunt')
    return /^hunts\/\d+\/hunt$/u.test(id) && gapOf(prompt) === 'No benchmark';
  if (mode !== 'failures') return false;
  return (
    id === 'critic' ||
    (/^sweeps\/\d+\/sweep$/u.test(id) && modalityOf(prompt) === 'web') ||
    (/^reads\/\d+\/read$/u.test(id) && refOf(prompt).endsWith('/releases'))
  );
}

const fileTools = ['Read', 'Grep', 'Glob'];
const webTools = ['WebSearch', 'WebFetch'];
/**
 * The checkout keeps its uncommitted edit and its HEAD. Every call is a web role (web tools only,
 * in the checkout), a local role (file tools only, in a snapshot whose pin is the head), the
 * tool-less synthesizer, or the Codex critic; no call holds both file and web tools.
 */
function readOnlyRun(env, calls) {
  assert.equal(git(env.cwd, 'status', '--porcelain', '--untracked-files=all'), 'M target.mjs');
  assert.equal(git(env.cwd, 'rev-parse', 'HEAD'), env.head);
  let snapshots = 0;
  for (const call of calls) {
    const id = call.call.stepId;
    if (id === 'critic') {
      assert.equal(call.harness, 'codex');
      assert.equal(call.options.sandbox, 'read-only');
      assert.equal(call.options.effort, 'high');
      assert.equal(call.cwd, env.cwd);
    } else if (id === 'synthesize' || id === 'resynthesize') {
      assert.deepEqual(call.options.tools, []);
      assert.equal(call.cwd, env.cwd);
    } else if (call.options.tools.includes('Read')) {
      assert.deepEqual(call.options.tools, fileTools);
      assert.ok(call.cwd.startsWith(env.worktrees.root), `${id} ran outside a snapshot`);
      snapshots += 1;
    } else {
      assert.deepEqual(call.options.tools, webTools, id);
      assert.equal(call.cwd, env.cwd);
    }
  }
  const pins = git(env.cwd, 'for-each-ref', '--format=%(objectname)', 'refs/quiet-choir');
  assert.deepEqual(pins.split('\n').filter(Boolean), Array(snapshots).fill(env.head));
  return snapshots;
}
const steps = (calls) => calls.map((call) => call.call.stepId).sort();
/** A map item's index; calls are recorded in admission order, not item order. */
const index = (call) => Number(call.call.stepId.split('/')[1]);
const ordered = (calls, name) =>
  calls.filter((call) => leaf(call.call.stepId) === name).sort((a, b) => index(a) - index(b));
/** A local role's call: it alone has the file tools. */
const local = (call) => call.options.tools?.includes('Read') === true;

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
    ordered(calls, 'sweep').map((call) => [modalityOf(call.options.prompt), local(call)]),
    [
      ['web', false],
      ['source', false],
      ['practitioners', false],
      ['local', true],
    ],
  );
  // The critic hears what code checked: the draft's unknown key, and the deferred leads.
  const critic = calls.find((call) => call.call.stepId === 'critic');
  assert.match(critic.options.prompt, /these cited keys match no source: S7\./u);
  assert.match(critic.options.prompt, /- https:\/\/news\.example\/1 \(discussion, anecdotal\)/u);
  assert.match(critic.options.prompt, /Give each gap a territory\./u);
  // Three hunts, routed by territory: the local one in a snapshot, the web ones without file tools.
  assert.deepEqual(
    ordered(calls, 'hunt').map((call) => [gapOf(call.options.prompt), local(call)]),
    [
      ['No benchmark', false],
      ['Version unclear', false],
      ['Call sites unknown', true],
    ],
  );
  assert.match(ordered(calls, 'hunt')[0].options.prompt, /already read[^]*- target\.mjs/u);
  const revision = calls.find((call) => call.call.stepId === 'resynthesize');
  assert.match(revision.options.prompt, /- No benchmark \(new evidence in \[S4\]\)/u);
  assert.match(revision.options.prompt, /- Call sites unknown \(a hunt found nothing\)/u);
  assert.match(revision.options.prompt, /- No security audit \(not hunted\)/u);
  assert.equal(calls.length, 14);
  // The local sweep, the local read and the local hunt each ran in their own snapshot.
  assert.equal(readOnlyRun(env, calls), 3);
}

export const readOnly = 'Read-only: every role reads and the workflow writes nothing';

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
      assert.deepEqual(output.gaps, []);
      assert.ok(!steps(calls).some((id) => id === 'resynthesize' || id.startsWith('hunts/')));
      assert.ok(output.answer.startsWith('Adopt Xlib cautiously [S1][S2].\n\nSources:\n'));
      // Uncited sources are reported but do not degrade an answer whose citations all resolve.
      assert.deepEqual(output.uncitedSources, ['S3', 'S4']);
      assert.match(
        calls.find((call) => call.call.stepId === 'critic').options.prompt,
        /every hunt searches the web/u,
      );
      assert.equal(readOnlyRun(env, calls), 0);
    },
  },
  {
    mode: 'no-leads',
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'no-leads');
      assert.equal(output.answer, null);
      assert.equal(output.confidence, 'none');
      assert.equal(output.critic, 'not-run');
      assert.equal(output.leadsFound, 0);
      assert.deepEqual(steps(calls), [
        'sweeps/0/sweep',
        'sweeps/1/sweep',
        'sweeps/2/sweep',
        'sweeps/3/sweep',
      ]);
      assert.equal(readOnlyRun(env, calls), 1);
    },
  },
  {
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
    // The web sweep, one reader and the critic fail; each is kept beside its item and counted.
    mode: 'failures',
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(output.unswept, ['web']);
      assert.equal(output.critic, 'failed');
      assert.deepEqual(output.unread, [
        { ref: 'https://github.com/xlib/xlib/releases', outcome: 'failed' },
        { ref: 'https://github.com/xlib/xlib/issues/42', outcome: 'not-useful' },
      ]);
      assert.deepEqual(
        output.sources.map((source) => source.ref),
        ['https://XLIB.dev/docs', 'target.mjs'],
      );
      assert.deepEqual(output.gaps, []);
      assert.equal(output.confidence, 'low');
      assert.ok(output.answer.startsWith('Adopt Xlib cautiously [S1][S2].'));
      assert.ok(!steps(calls).some((id) => id === 'resynthesize' || id.startsWith('hunts/')));
      assert.equal(readOnlyRun(env, calls), 2);
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
      const revision = calls.find((call) => call.call.stepId === 'resynthesize');
      assert.match(revision.options.prompt, /- No benchmark \(its hunt failed\)/u);
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
  output.deferred.length > 0 ||
  output.gaps.some((tracked) => tracked.hunt === 'unhunted') ||
  output.unswept.length > 0 ||
  output.unread.some((unread) => unread.outcome === 'failed');
