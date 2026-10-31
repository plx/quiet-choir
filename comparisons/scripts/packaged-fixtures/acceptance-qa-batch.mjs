// acceptance-qa-batch: slug.mjs lowercases and hyphenates but keeps punctuation, throws on null and
// hyphenates a spaced hyphen into three. QA-1's two probes exit 0, so the breaker attacks it: the
// null attack reproduces (exit 3, degrades) and the empty-title attack holds, so QA-1 passes.
// QA-2's punctuation probe exits 3 and its browser criterion is undemonstrable, so it fails
// unattacked. QA-3 has no criteria. Every probe runs alone in a checkout pinned at HEAD, after a
// human approves its list, with only the probeEnv variables; exit 0 and exit 3 are the only
// verdicts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitAll, git, leaf, writeFiles } from './_support.mjs';

const backlog = `# Backlog

## QA-1: Slugify titles

Turn a title into a URL slug.

- [x] slugify lowercases its input
- [x] slugify joins words with single
  hyphens

## QA-2: Strip punctuation

- [x] slugify removes punctuation
- [x] the slug renders in the browser address bar

## QA-3: Dark mode

Nobody wrote criteria for this one.
`;
const slug =
  "export function slugify(text) {\n  return text.trim().toLowerCase().split(/\\s+/u).join('-');\n}\n";
// Every probe prints its working directory and its environment's names first, so check can see
// where it ran and what it received.
const where =
  "console.log(process.cwd());\nconsole.log(Object.keys(process.env).sort().join(','));\n";
const call = (input, expected, from = './slug.mjs') =>
  `import { slugify } from '${from}';\n${where}const slug = slugify(${JSON.stringify(input)});\nconsole.log(JSON.stringify(slug));\nprocess.exit(slug === ${JSON.stringify(expected)} ? 0 : 3);\n`;
const probes = {
  lowercases: call('Hello', 'hello'),
  joins: call('a  b', 'a-b'),
  punctuation: call('Hello, world!', 'hello-world'),
  hangs: `${where}setInterval(() => {}, 1000);\n`,
  // A wrong import path: Node exits 1 on the unresolved module, which is no verdict.
  crashes: call('Hello', 'hello', './lib/slug.js'),
};
const pad = `// ${'x'.repeat(7600)}\n`;
const attack = {
  null: {
    description: 'A null title',
    severity: 'degrades',
    probe: `import { slugify } from './slug.mjs';\n${where}try { slugify(null); } catch (error) { console.log(error.message); process.exit(3); }\n`,
  },
  empty: { description: 'An empty title', severity: 'breaks-criterion', probe: call('', '') },
  spaced: {
    description: 'Words around a spaced hyphen',
    severity: 'breaks-criterion',
    probe: call('a - b', 'a-b'),
  },
  crashes: {
    description: 'A title with an umlaut',
    severity: 'breaks-criterion',
    probe: call('Ä', 'ä', './src/slug.mjs'),
  },
};
function attacks(mode) {
  // Two near-limit probes push the approval details past the question limit.
  if (mode === 'criterion-break')
    return [attack.null, attack.spaced].map((entry) => ({ ...entry, probe: pad + entry.probe }));
  if (mode === 'probe-crash') return [attack.null, attack.crashes];
  return [attack.null, attack.empty];
}
const qa1 = {
  id: 'QA-1',
  title: 'Slugify titles',
  description: 'Turn a title into a URL slug.',
  acceptanceCriteria: ['slugify lowercases its input', 'slugify joins words with single hyphens'],
};
const qa2 = {
  id: 'QA-2',
  title: 'Strip punctuation',
  description: null,
  acceptanceCriteria: [
    'slugify removes punctuation',
    'the slug renders in the browser address bar',
  ],
};
const skipped = [{ id: 'QA-3', reason: 'No acceptance criteria' }];
const runContext = 'Import { slugify } from ./slug.mjs at the repository root.';
const claims = {
  lowercases: 'slugify("Hello") is "hello"',
  joins: 'slugify("a  b") is "a-b"',
  punctuation: 'slugify("Hello, world!") is "hello-world"',
  browser: 'Paste a slug into a browser address bar and load it',
};
/** The same tickets as one line of JSON, for the inline mode. */
const backlogJson = JSON.stringify({
  tickets: [qa1, qa2, { id: 'QA-3', title: 'Dark mode', acceptanceCriteria: [] }],
});
/**
 * The tickets as a nested list, with titles as list items. QA-3's one item starts with another
 * ticket's ID but is QA-3's criterion, not a QA-1 title line.
 */
const backlogList = `- QA-1: Slugify titles
  - [x] slugify lowercases its input
  - [x] slugify joins words with single hyphens
- QA-2: Strip punctuation
  - [x] slugify removes punctuation
  - [x] the slug renders in the browser address bar
- QA-3: Dark mode
  - [ ] QA-1 slugs stay readable in dark mode
`;
const probeEnv = ['PATH', 'HOME', 'LANG', 'TMPDIR'];
/** Writes an ignored node_modules/probe-kit into the checkout it runs in. */
const kit = `const fs = require('node:fs');
fs.mkdirSync('node_modules/probe-kit', { recursive: true });
fs.writeFileSync('node_modules/probe-kit/package.json', JSON.stringify({ name: 'probe-kit', type: 'module', exports: './index.js' }));
fs.writeFileSync('node_modules/probe-kit/index.js', 'export const verdict = (ok) => process.exit(ok ? 0 : 3);\\n');`;
/** A probe that reports through probe-kit, which only the prepare command installs. */
const kitCall = (input, expected) =>
  `import { verdict } from 'probe-kit';\nimport { slugify } from './slug.mjs';\n${where}verdict(slugify(${JSON.stringify(input)}) === ${JSON.stringify(expected)});\n`;

export async function setup(env) {
  await writeFiles(env.cwd, { 'slug.mjs': slug, 'backlog.md': backlog });
  commitAll(env.cwd, 'add slugify and its backlog');
  // reply records the commit each agent's checkout was at.
  env.agentHeads = {};
}

export const input = () => ({
  tickets: 'backlog.md',
  probeCommand: [process.execPath, '--input-type=module'],
});

function ingest(mode) {
  if (mode === 'nothing-transcribed' || mode === 'empty')
    return { tickets: [], skipped, runContext };
  // Skips two tickets that do have items under them; code reports the items.
  if (mode === 'skipped-items')
    return {
      tickets: [qa1],
      skipped: [
        { id: 'QA-2', reason: 'More than twenty criteria' },
        { id: 'QA-3', reason: 'Needs a browser to check' },
      ],
      runContext,
    };
  // Drops QA-1's second criterion: admitted, and the dropped item is reported.
  const dropped = { ...qa1, acceptanceCriteria: [qa1.acceptanceCriteria[0]] };
  if (mode === 'dropped-criterion') return { tickets: [dropped, qa2], skipped, runContext };
  if (mode === 'unfaithful')
    return {
      tickets: [
        qa1,
        // A duplicate, a truncated criterion, an invented ticket, and another ticket's criterion
        // under a ticket the backlog names and under one the ingester numbered.
        { ...qa1, title: 'Slugify again' },
        { ...qa2, acceptanceCriteria: ['slugify removes', qa2.acceptanceCriteria[1]] },
        { id: 'QA-9', title: 'Invented', description: null, acceptanceCriteria: ['slugify'] },
        {
          id: 'QA-3',
          title: 'Dark mode',
          description: null,
          acceptanceCriteria: [qa2.acceptanceCriteria[0]],
        },
        {
          id: 'T1',
          title: 'Unnumbered',
          description: null,
          acceptanceCriteria: [qa1.acceptanceCriteria[0]],
        },
      ],
      skipped: [],
      runContext,
    };
  return { tickets: [qa1, qa2], skipped, runContext };
}

function plan(id, mode) {
  if (id === 'QA-2')
    return [
      {
        claim: claims.punctuation,
        probe: probes.punctuation,
      },
      { claim: claims.browser, probe: null },
    ];
  const first = { claim: claims.lowercases, probe: probes.lowercases };
  if (mode === 'dropped-criterion') return [first];
  if (mode === 'prepared')
    return [
      { claim: claims.lowercases, probe: kitCall('Hello', 'hello') },
      { claim: claims.joins, probe: kitCall('a  b', 'a-b') },
    ];
  if (mode === 'probe-crash')
    return [
      { ...first, probe: probes.crashes },
      { claim: claims.joins, probe: probes.joins },
    ];
  return [
    first,
    { claim: claims.joins, probe: mode === 'probe-timeout' ? probes.hangs : probes.joins },
  ];
}

export async function reply(request, env, mode) {
  const id = request.call.stepId;
  if (env.agentHeads) env.agentHeads[id] = git(request.cwd, 'rev-parse', 'HEAD');
  if (id === 'ingest') return ingest(mode);
  const demonstrate = /^demonstrate\/(QA-[12])\/plan$/u.exec(id);
  if (demonstrate) return { criteria: plan(demonstrate[1], mode) };
  if (id === 'break/QA-1/attacks') return { attacks: attacks(mode) };
  throw new Error(`Unhandled acceptance-qa-batch step ${id} (${mode})`);
}

export function fail(request, mode) {
  const id = request.call.stepId;
  return (
    (mode === 'demonstrator-fails' && id === 'demonstrate/QA-1/plan') ||
    (mode === 'breaker-fails' && id === 'break/QA-1/attacks')
  );
}

/** A declined mode's human declines its probe list or its attack list; the rest is approved. */
export const answer = (question, env, mode) =>
  ({ 'declined-probes': 'approve-probes', 'declined-attacks': 'approve-attacks' })[mode] ===
  leaf(question.stepId)
    ? { approved: false, comment: 'Not against production' }
    : undefined;

const sorted = (value) =>
  Array.isArray(value)
    ? value.map(sorted)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, sorted(value[key])]),
        )
      : value;
/** The SHA-256 of the sorted-key, two-space JSON of an approved list. */
const digest = (list) =>
  createHash('sha256')
    .update(JSON.stringify(sorted(list), null, 2))
    .digest('hex');
/** The criterion probes the success run's demonstrators propose, as code lists them. */
const approvedProbes = [
  {
    ticket: 'QA-1',
    position: 0,
    criterion: qa1.acceptanceCriteria[0],
    claim: claims.lowercases,
    probe: probes.lowercases,
  },
  {
    ticket: 'QA-1',
    position: 1,
    criterion: qa1.acceptanceCriteria[1],
    claim: claims.joins,
    probe: probes.joins,
  },
  {
    ticket: 'QA-2',
    position: 0,
    criterion: qa2.acceptanceCriteria[0],
    claim: claims.punctuation,
    probe: probes.punctuation,
  },
];
/** The attack probes QA-1's breaker proposes in `mode`, as code lists them. */
const approvedAttacks = (mode) =>
  attacks(mode).map((entry, number) => ({ ...entry, ticket: 'QA-1', attack: number }));
/**
 * The approval question `id` was asked once and showed under `key` exactly `list`, whose digest it
 * carries: a human approves the list itself, not only its digest.
 */
function shownList(questions, id, key, list, approvedDigest) {
  const asked = questions.filter(({ question }) => question.stepId === id);
  assert.equal(asked.length, 1, id);
  const { subject } = asked[0].question;
  assert.deepEqual(subject[key], list);
  assert.equal(subject.digest, approvedDigest);
  assert.equal(digest(subject[key]), approvedDigest);
}
const statuses = (ticket) => ticket.criteria.map((criterion) => criterion.status);
const verdicts = (output) => output.tickets.map((ticket) => [ticket.id, ticket.verdict]);
const tallies = (output) => [output.passed, output.failed, output.unverified, output.inconclusive];
const ran = (record, prefix) =>
  Object.keys(record.steps)
    .filter((id) => id.startsWith(prefix) && id.endsWith('/probe'))
    .sort();
const stepIds = (calls) => calls.map((request) => request.call.stepId).sort();
const details = (record, id) => record.steps[id].question.request.details;
/** Every probe run of the output, criteria first. */
const runs = (output) =>
  output.tickets.flatMap((ticket) => [
    ...ticket.criteria.map((criterion) => criterion.run),
    ...ticket.attacks.map((entry) => entry.run),
  ]);

export async function check({ result, env, calls, record, suspended, questions }) {
  const { output } = result;
  assert.equal(output.status, 'complete');
  assert.equal(output.base, git(env.cwd, 'rev-parse', 'HEAD'));
  assert.deepEqual(output.dirty, []);
  assert.deepEqual(output.skipped, skipped);
  assert.deepEqual([output.rejected, output.unclaimed, output.deferred], [[], [], []]);
  assert.deepEqual(
    output.tickets.map((ticket) => [ticket.id, ticket.verdict, ticket.breaker]),
    [
      ['QA-1', 'pass', 'answered'],
      ['QA-2', 'fail', 'skipped'],
    ],
  );
  assert.deepEqual(tallies(output), [1, 1, 0, 0]);
  const [first, second] = output.tickets;
  assert.deepEqual(statuses(first), ['demonstrated', 'demonstrated']);
  assert.deepEqual(statuses(second), ['failed', 'undemonstrable']);
  assert.deepEqual(first.manual, []);
  assert.deepEqual(second.manual, [`Criterion 2: ${claims.browser}`]);
  assert.deepEqual([second.criteria[0].run.code, second.criteria[0].run.failure], [3, null]);
  assert.match(second.criteria[0].run.stdout, /"hello,-world!"/u);
  assert.deepEqual(
    first.attacks.map((entry) => [entry.outcome, entry.severity, entry.run.code]),
    [
      ['broke', 'degrades', 3],
      ['held', 'breaks-criterion', 0],
    ],
  );
  assert.match(first.attacks[0].run.stdout, /null/u);
  // Each of the five probes ran in its own run-owned checkout, never in the source checkout.
  const dirs = runs(output)
    .filter(Boolean)
    .map((run) => run.stdout.split('\n')[0]);
  assert.equal(new Set(dirs).size, 5);
  for (const dir of dirs) assert.ok(dir.startsWith(env.worktrees.root), dir);
  // A probe receives only the probeEnv variables (and the runtime's own), although this process
  // has others.
  const allowed = (name) => probeEnv.includes(name) || name.startsWith('QUIET_CHOIR_');
  assert.ok(Object.keys(process.env).some((name) => !allowed(name)));
  for (const run of runs(output).filter(Boolean)) {
    const names = run.stdout.split('\n')[1].split(',');
    assert.ok(names.includes('PATH') && names.every(allowed), names.join(','));
  }
  // The approved digests are the SHA-256 of exactly the lists code then ran, and the probe list a
  // human reads names each criterion and the claim its probe makes.
  assert.equal(suspended, 2);
  assert.equal(output.probeDigest, digest(approvedProbes));
  assert.equal(output.attackDigest, digest(approvedAttacks('normal')));
  // Each approval showed the whole list its digest covers.
  assert.deepEqual(
    questions.map(({ question }) => question.stepId),
    ['approve-probes', 'approve-attacks'],
  );
  shownList(questions, 'approve-probes', 'probes', approvedProbes, output.probeDigest);
  shownList(
    questions,
    'approve-attacks',
    'attacks',
    approvedAttacks('normal'),
    output.attackDigest,
  );
  const shown = details(record, 'approve-probes');
  assert.ok(
    shown.includes(`QA-1, criterion 2: ${qa1.acceptanceCriteria[1]}\nClaim: ${claims.joins}`),
  );
  assert.ok(
    shown.includes(`receives only these variables from your environment: ${probeEnv.join(', ')}.`),
  );
  assert.match(shown, /with nothing installed or built beyond that commit/u);
  const { subject } = record.steps['approve-probes'].question.request;
  assert.deepEqual(
    [subject.prepare, subject.probeEnv, subject.digest],
    [[], probeEnv, output.probeDigest],
  );
  assert.ok(shown.includes(output.probeDigest) && !shown.includes('Truncated'));
  assert.deepEqual(ran(record, 'criteria/'), [
    'criteria/QA-1/0/probe',
    'criteria/QA-1/1/probe',
    'criteria/QA-2/0/probe',
  ]);
  assert.deepEqual(ran(record, 'attacks/'), ['attacks/QA-1/0/probe', 'attacks/QA-1/1/probe']);
  assert.deepEqual(stepIds(calls), [
    'break/QA-1/attacks',
    'demonstrate/QA-1/plan',
    'demonstrate/QA-2/plan',
    'ingest',
  ]);
  // Agents read the pinned commit in their own checkouts and hold no write or shell tool.
  for (const request of calls) {
    assert.ok(request.cwd.startsWith(env.worktrees.root), request.cwd);
    assert.equal(env.agentHeads[request.call.stepId], output.base);
    assert.ok(!request.options.tools.some((tool) => /^(?:Write|Edit|Bash)/u.test(tool)));
  }
  // Code read the backlog file and handed it over whole; the breaker sees the demonstrations.
  const ingester = calls.find((request) => request.call.stepId === 'ingest');
  assert.ok(ingester.options.prompt.includes(`<backlog>\n${backlog}\n</backlog>`));
  const breaker = calls.find((request) => request.call.stepId === 'break/QA-1/attacks');
  assert.ok(breaker.options.prompt.includes(probes.lowercases));
  assert.match(breaker.options.prompt, /and\s+3 when the break reproduces/u);
  assert.equal(git(env.cwd, 'status', '--porcelain'), '');
}

/** F3: killed after a probe ran in its pinned checkout, before the probe's checkpoint. */
export const kill = {
  step: '^criteria/QA-1/0/probe$',
  boundary: 'checkpoint',
  writeLocation: 'isolated-checkout',
};

export const modes = [
  {
    mode: 'refused-dirty',
    options(opts, env) {
      writeFileSync(join(env.cwd, 'target.mjs'), 'export const value = 2;\n');
      return opts;
    },
    check({ result, calls }) {
      assert.equal(result.output.status, 'refused');
      assert.deepEqual(result.output.dirty, ['target.mjs']);
      assert.equal(result.output.base, null);
      assert.equal(calls.length, 0);
    },
  },
  {
    // The ingester returns no ticket although the backlog lists criteria under two headings.
    mode: 'nothing-transcribed',
    check({ result, calls, record }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(output.tickets, []);
      assert.deepEqual(
        output.unclaimed,
        [...qa1.acceptanceCriteria, ...qa2.acceptanceCriteria].map((item) => ({
          ticket: null,
          item,
        })),
      );
      assert.equal(calls.length, 1);
      assert.deepEqual(ran(record, ''), []);
    },
  },
  {
    mode: 'empty',
    input: () => ({ ...input(), tickets: '## QA-3: Dark mode\n\nNobody wrote criteria.\n' }),
    check({ result, calls }) {
      assert.equal(result.output.status, 'empty');
      assert.deepEqual([result.output.tickets, result.output.unclaimed], [[], []]);
      assert.deepEqual(result.output.skipped, skipped);
      assert.equal(calls.length, 1);
    },
  },
  {
    // An uncommitted edit to the backlog file itself does not refuse the run, and code hands the
    // ingester the edited text while every agent and probe still sees the committed tree.
    mode: 'uncommitted-backlog',
    options(opts, env) {
      writeFileSync(join(env.cwd, 'backlog.md'), backlog.replace('this one.', 'this one yet.'));
      return opts;
    },
    check({ result, calls, env }) {
      const { output } = result;
      assert.equal(output.status, 'complete');
      assert.deepEqual(output.dirty, []);
      assert.deepEqual(verdicts(output), [
        ['QA-1', 'pass'],
        ['QA-2', 'fail'],
      ]);
      const ingester = calls.find((request) => request.call.stepId === 'ingest');
      assert.ok(ingester.options.prompt.includes('Nobody wrote criteria for this one yet.'));
      assert.equal(git(env.cwd, 'status', '--porcelain'), 'M backlog.md');
    },
  },
  {
    // A nested-list backlog: the ingester skips two tickets that have items, so code lists every
    // item under them, including QA-3's, which starts with QA-1's ID.
    mode: 'skipped-items',
    input: () => ({ ...input(), tickets: backlogList }),
    check({ result, calls }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(output.rejected, []);
      assert.deepEqual(
        output.skipped.map((entry) => entry.id),
        ['QA-2', 'QA-3'],
      );
      assert.deepEqual(output.unclaimed, [
        ...qa2.acceptanceCriteria.map((item) => ({ ticket: 'QA-2', item })),
        { ticket: 'QA-3', item: 'QA-1 slugs stay readable in dark mode' },
      ]);
      assert.deepEqual(verdicts(output), [['QA-1', 'pass']]);
      assert.deepEqual(output.tickets[0].manual, []);
      assert.deepEqual(stepIds(calls), ['break/QA-1/attacks', 'demonstrate/QA-1/plan', 'ingest']);
    },
  },
  {
    mode: 'dropped-criterion',
    check({ result }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(output.rejected, []);
      assert.deepEqual(output.unclaimed, [{ ticket: 'QA-1', item: qa1.acceptanceCriteria[1] }]);
      assert.deepEqual(verdicts(output), [
        ['QA-1', 'pass-pending-manual'],
        ['QA-2', 'fail'],
      ]);
      assert.deepEqual(output.tickets[0].manual, [
        `Not transcribed from the backlog: ${qa1.acceptanceCriteria[1]}`,
      ]);
    },
  },
  {
    mode: 'unfaithful',
    check({ result, calls }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(
        output.rejected.map((entry) => [entry.id, entry.reason]),
        [
          ['QA-1', 'Duplicate ticket ID; the first is checked'],
          ['QA-2', 'Criterion is not a whole backlog item or line: slugify removes'],
          ['QA-9', 'Ticket ID not in the backlog'],
          ['QA-3', `Criterion is not under QA-3 in the backlog: ${qa2.acceptanceCriteria[0]}`],
          [
            'T1',
            `Criterion belongs to another ticket in the backlog: ${qa1.acceptanceCriteria[0]}`,
          ],
        ],
      );
      // QA-2's items are under a rejected ticket, which the rejection already reports.
      assert.deepEqual(output.unclaimed, []);
      assert.deepEqual(verdicts(output), [['QA-1', 'pass']]);
      assert.deepEqual(stepIds(calls), ['break/QA-1/attacks', 'demonstrate/QA-1/plan', 'ingest']);
    },
  },
  {
    mode: 'inline-capped',
    input: () => ({ ...input(), tickets: backlogJson, maxTickets: 1 }),
    check({ result, calls }) {
      const { output } = result;
      assert.equal(output.status, 'limited');
      assert.deepEqual([output.rejected, output.unclaimed], [[], []]);
      assert.deepEqual(output.deferred, [{ id: 'QA-2', title: 'Strip punctuation' }]);
      assert.deepEqual(verdicts(output), [['QA-1', 'pass']]);
      const ingester = calls.find((request) => request.call.stepId === 'ingest');
      assert.ok(ingester.options.prompt.includes(backlogJson));
      assert.ok(!stepIds(calls).includes('demonstrate/QA-2/plan'));
    },
  },
  {
    mode: 'demonstrator-fails',
    check({ result, calls, suspended }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      const [first] = output.tickets;
      assert.deepEqual(
        [first.verdict, first.demonstrator, first.breaker],
        ['unverified', 'failed', 'skipped'],
      );
      assert.deepEqual(statuses(first), ['unrun', 'unrun']);
      assert.match(first.manual[0], /demonstrator failed/u);
      assert.deepEqual(tallies(output), [0, 1, 1, 0]);
      assert.ok(!stepIds(calls).includes('break/QA-1/attacks'));
      assert.equal(suspended, 1);
    },
  },
  {
    mode: 'breaker-fails',
    check({ result, record, suspended }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      const [first] = output.tickets;
      assert.deepEqual([first.verdict, first.breaker], ['pass-pending-manual', 'failed']);
      assert.deepEqual(first.manual, ['The breaker failed; attack the feature by hand']);
      assert.equal(output.passed, 1);
      assert.equal(output.attackDigest, null);
      assert.deepEqual(ran(record, 'attacks/'), []);
      assert.equal(suspended, 1);
    },
  },
  {
    mode: 'criterion-break',
    check({ result, record }) {
      const { output } = result;
      assert.equal(output.status, 'complete');
      const [first] = output.tickets;
      assert.deepEqual(
        first.attacks.map((entry) => [entry.outcome, entry.severity, entry.run.code]),
        [
          ['broke', 'degrades', 3],
          ['broke', 'breaks-criterion', 3],
        ],
      );
      assert.match(first.attacks[1].run.stdout, /"a---b"/u);
      assert.deepEqual(verdicts(output), [
        ['QA-1', 'fail'],
        ['QA-2', 'fail'],
      ]);
      assert.deepEqual(tallies(output), [0, 2, 0, 0]);
      // The two long attacks do not both fit in the question's details; the subject has both.
      const shown = details(record, 'approve-attacks');
      assert.ok(Buffer.byteLength(shown) <= 16_384);
      assert.match(shown, /Truncated: 1 of 2 entries shown/u);
      const { subject } = record.steps['approve-attacks'].question.request;
      assert.equal(subject.attacks.length, 2);
    },
  },
  {
    mode: 'probe-crash',
    check({ result }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      const [first, second] = output.tickets;
      assert.deepEqual(statuses(first), ['inconclusive', 'demonstrated']);
      const [crashed] = first.criteria;
      assert.deepEqual([crashed.run.code, crashed.run.failure], [1, null]);
      assert.match(crashed.run.stderr, /ERR_MODULE_NOT_FOUND/u);
      assert.deepEqual(
        first.attacks.map((entry) => [entry.outcome, entry.run.code]),
        [
          ['broke', 3],
          ['inconclusive', 1],
        ],
      );
      // A crash is no verdict: the ticket is left for a human, not failed.
      assert.deepEqual([first.verdict, second.verdict], ['pass-pending-manual', 'fail']);
      assert.deepEqual(first.manual, [
        'Criterion 1: the probe gave no verdict (exit 1, not 0 or 3)',
        `Attack without a verdict (exit 1, not 0 or 3): ${attack.crashes.description}`,
      ]);
      assert.deepEqual(tallies(output), [1, 1, 0, 2]);
    },
  },
  {
    mode: 'probe-timeout',
    input: () => ({ ...input(), probeTimeoutMs: 1000 }),
    check({ result }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      const [first] = output.tickets;
      assert.deepEqual(statuses(first), ['demonstrated', 'inconclusive']);
      const { failure } = first.criteria[1].run;
      assert.deepEqual([failure.stage, failure.kind], ['probe', 'timeout']);
      assert.match(failure.message, /1000ms deadline/u);
      assert.deepEqual([first.verdict, first.breaker], ['pass-pending-manual', 'answered']);
      assert.deepEqual(first.manual, [
        `Criterion 2: the probe gave no verdict (timeout: ${failure.message})`,
      ]);
      assert.equal(output.inconclusive, 1);
    },
  },
  {
    // The operator's prepare command installs the probe-kit package that QA-1's probes import,
    // in each probe's own checkout, ignored there and absent from the source checkout.
    mode: 'prepared',
    input: () => ({ ...input(), prepare: [[process.execPath, '-e', kit]] }),
    check({ result, env, record }) {
      const { output } = result;
      assert.equal(output.status, 'complete');
      const [first] = output.tickets;
      assert.deepEqual(statuses(first), ['demonstrated', 'demonstrated']);
      assert.deepEqual(verdicts(output), [
        ['QA-1', 'pass'],
        ['QA-2', 'fail'],
      ]);
      // Without the prepared package, the probes would die on their import (no verdict).
      assert.deepEqual(
        first.criteria.map((criterion) => criterion.run.code),
        [0, 0],
      );
      assert.ok(!existsSync(join(env.cwd, 'node_modules')));
      const { subject, details: shown } = record.steps['approve-probes'].question.request;
      assert.deepEqual(subject.prepare, [[process.execPath, '-e', kit]]);
      assert.ok(shown.includes('ran there with your full environment'));
      assert.equal(git(env.cwd, 'status', '--porcelain'), '');
    },
  },
  {
    // A prepare command that fails leaves every probe unrun: no verdict, never a failure.
    mode: 'prepare-fails',
    input: () => ({
      ...input(),
      prepare: [[process.execPath, '-e', 'console.error("no lockfile"); process.exit(2)']],
    }),
    check({ result, calls, suspended }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(verdicts(output), [
        ['QA-1', 'unverified'],
        ['QA-2', 'unverified'],
      ]);
      const failures = runs(output).filter(Boolean);
      assert.equal(failures.length, 3);
      for (const run of failures) {
        assert.deepEqual(
          [run.code, run.failure.stage, run.failure.kind],
          [null, 'prepare', 'process'],
        );
        assert.match(run.failure.message, /process\.exit\(2\)"\]: Command exited with 2\./u);
        assert.match(run.stderr, /no lockfile/u);
      }
      assert.match(
        output.tickets[0].manual[0],
        /^Criterion 1: the probe did not run \(prepare process: /u,
      );
      assert.deepEqual(tallies(output), [0, 0, 2, 3]);
      assert.ok(!stepIds(calls).includes('break/QA-1/attacks'));
      assert.equal(suspended, 1);
    },
  },
  {
    mode: 'probe-command-missing',
    input: () => ({ ...input(), probeCommand: ['/nonexistent/probe-runner'] }),
    check({ result, calls, suspended }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(verdicts(output), [
        ['QA-1', 'unverified'],
        ['QA-2', 'unverified'],
      ]);
      const failures = runs(output)
        .filter(Boolean)
        .map((run) => [run.code, run.signal, run.failure.stage, run.failure.kind]);
      assert.deepEqual(failures, Array(3).fill([null, null, 'probe', 'process']));
      assert.match(output.tickets[0].manual[0], /Cannot start \/nonexistent\/probe-runner/u);
      assert.deepEqual(tallies(output), [0, 0, 2, 3]);
      assert.ok(!stepIds(calls).includes('break/QA-1/attacks'));
      assert.equal(suspended, 1);
    },
  },
  {
    mode: 'declined-probes',
    check({ result, record, calls, questions }) {
      const { output } = result;
      assert.equal(output.status, 'declined');
      assert.deepEqual(
        questions.map(({ question }) => question.stepId),
        ['approve-probes'],
      );
      shownList(questions, 'approve-probes', 'probes', approvedProbes, output.probeDigest);
      assert.deepEqual(verdicts(output), [
        ['QA-1', 'unverified'],
        ['QA-2', 'unverified'],
      ]);
      assert.deepEqual(statuses(output.tickets[1]), ['unrun', 'undemonstrable']);
      assert.deepEqual(ran(record, ''), []);
      assert.ok(!stepIds(calls).includes('break/QA-1/attacks'));
    },
  },
  {
    mode: 'declined-attacks',
    check({ result, record, questions }) {
      const { output } = result;
      assert.equal(output.status, 'declined');
      const list = approvedAttacks('declined-attacks');
      shownList(questions, 'approve-attacks', 'attacks', list, output.attackDigest);
      const [first] = output.tickets;
      assert.deepEqual([first.verdict, first.breaker], ['pass-pending-manual', 'declined']);
      assert.deepEqual(
        first.attacks.map((entry) => entry.outcome),
        ['unrun', 'unrun'],
      );
      assert.deepEqual(first.manual, ['The attack probes were not approved']);
      assert.deepEqual(ran(record, 'attacks/'), []);
    },
  },
];

/** The fault matrix reads neither 'limited' (deferred tickets) nor 'declined' as degraded. */
export const degraded = (output) => output.status === 'limited' || output.status === 'declined';
