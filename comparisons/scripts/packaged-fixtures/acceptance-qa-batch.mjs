// acceptance-qa-batch: slug.mjs lowercases and hyphenates but keeps punctuation and throws on
// null. QA-1's two probes pass, so the breaker attacks it: the null attack reproduces (degrades)
// and the empty-title attack holds, so QA-1 passes. QA-2's punctuation probe exits 1 and its
// browser criterion is undemonstrable, so it fails unattacked. QA-3 has no criteria. Every probe
// runs alone in a checkout pinned at HEAD, after a human approves its list.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
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
const call = (input, expected) =>
  `import { slugify } from './slug.mjs';\nconst slug = slugify(${JSON.stringify(input)});\nconsole.log(process.cwd(), JSON.stringify(slug));\nprocess.exit(slug === ${JSON.stringify(expected)} ? 0 : 1);\n`;
const probes = {
  lowercases: call('Hello', 'hello'),
  joins: call('a  b', 'a-b'),
  punctuation: call('Hello, world!', 'hello-world'),
  hangs: 'setInterval(() => {}, 1000);\n',
  unsafe: `// UNSAFE: also posts the result to the production webhook\n${call('Hello', 'hello')}`,
};
const attacks = (mode) => [
  {
    description: 'A null title',
    severity: 'degrades',
    probe:
      "import { slugify } from './slug.mjs';\ntry { slugify(null); } catch (error) { console.log(error.message); process.exit(1); }\n",
  },
  {
    description: mode === 'declined-attacks' ? 'UNSAFE: an empty title' : 'An empty title',
    severity: 'breaks-criterion',
    probe: call('', ''),
  },
];
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

export async function setup(env) {
  await writeFiles(env.cwd, { 'slug.mjs': slug, 'backlog.md': backlog });
  commitAll(env.cwd, 'add slugify and its backlog');
}

export const input = () => ({
  tickets: 'backlog.md',
  probeCommand: [process.execPath, '--input-type=module'],
});

function ingest(mode) {
  if (mode === 'empty') return { tickets: [], skipped, runContext };
  if (mode === 'reworded')
    return {
      tickets: [
        qa1,
        { ...qa1, title: 'Slugify again' },
        { ...qa2, acceptanceCriteria: ['slugify strips all punctuation marks'] },
      ],
      skipped,
      runContext,
    };
  return { tickets: [qa1, qa2], skipped, runContext };
}

export async function reply(request, env, mode) {
  const id = request.call.stepId;
  if (id === 'ingest') return ingest(mode);
  if (id === 'demonstrate/QA-1/plan')
    return {
      criteria: [
        { claim: 'slugify("Hello") is "hello"', probe: probes.lowercases },
        {
          claim: 'slugify("a  b") is "a-b"',
          probe: mode === 'probe-timeout' ? probes.hangs : probes.joins,
        },
      ],
    };
  if (id === 'demonstrate/QA-2/plan')
    return {
      criteria: [
        {
          claim: 'slugify("Hello, world!") is "hello-world"',
          probe: mode === 'declined-probes' ? probes.unsafe : probes.punctuation,
        },
        { claim: 'Paste a slug into a browser address bar and load it', probe: null },
      ],
    };
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

/** A human declines a probe list that holds a probe marked unsafe; anything else is approved. */
export const answer = (question) =>
  /^approve-/u.test(leaf(question.stepId)) && JSON.stringify(question.subject).includes('UNSAFE')
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
const statuses = (ticket) => ticket.criteria.map((criterion) => criterion.status);
const ran = (record, prefix) =>
  Object.keys(record.steps)
    .filter((id) => id.startsWith(prefix) && id.endsWith('/probe'))
    .sort();
const stepIds = (calls) => calls.map((request) => request.call.stepId).sort();

export async function check({ result, env, calls, record, suspended }) {
  const { output } = result;
  assert.equal(output.status, 'complete');
  assert.equal(output.base, git(env.cwd, 'rev-parse', 'HEAD'));
  assert.deepEqual(output.dirty, []);
  assert.deepEqual(output.skipped, skipped);
  assert.deepEqual([output.rejected, output.deferred], [[], []]);
  assert.deepEqual(
    output.tickets.map((ticket) => [ticket.id, ticket.verdict, ticket.breaker]),
    [
      ['QA-1', 'pass', 'answered'],
      ['QA-2', 'fail', 'skipped'],
    ],
  );
  assert.deepEqual([output.passed, output.failed, output.unverified], [1, 1, 0]);
  const [first, second] = output.tickets;
  assert.deepEqual(statuses(first), ['demonstrated', 'demonstrated']);
  assert.deepEqual(statuses(second), ['failed', 'undemonstrable']);
  assert.deepEqual(first.manual, []);
  assert.deepEqual(second.manual, [
    'Criterion 2: Paste a slug into a browser address bar and load it',
  ]);
  // Each probe ran in its own run-owned checkout, never in the source checkout.
  const cwd = first.criteria[0].run.stdout.split(' ')[0];
  assert.ok(cwd.startsWith(env.worktrees.root), cwd);
  assert.equal(second.criteria[0].run.code, 1);
  assert.match(second.criteria[0].run.stdout, /"hello,-world!"/u);
  assert.deepEqual(
    first.attacks.map((attack) => [attack.outcome, attack.severity, attack.run.code]),
    [
      ['broke', 'degrades', 1],
      ['held', 'breaks-criterion', 0],
    ],
  );
  assert.match(first.attacks[0].run.stdout, /null/u);
  // The approved digests are the SHA-256 of exactly the lists code then ran.
  assert.equal(suspended, 2);
  assert.equal(
    output.probeDigest,
    digest([
      { ticket: 'QA-1', criterion: 0, probe: probes.lowercases },
      { ticket: 'QA-1', criterion: 1, probe: probes.joins },
      { ticket: 'QA-2', criterion: 0, probe: probes.punctuation },
    ]),
  );
  assert.equal(
    output.attackDigest,
    digest(
      attacks('normal').map((attack, number) => ({ ...attack, ticket: 'QA-1', attack: number })),
    ),
  );
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
    assert.notEqual(request.cwd, env.cwd);
    assert.ok(!request.options.tools.some((tool) => /^(?:Write|Edit|Bash)/u.test(tool)));
  }
  // Code read the backlog file and handed it over whole; the breaker sees the demonstrations.
  const ingester = calls.find((request) => request.call.stepId === 'ingest');
  assert.ok(ingester.options.prompt.includes(`<backlog>\n${backlog}\n</backlog>`));
  const breaker = calls.find((request) => request.call.stepId === 'break/QA-1/attacks');
  assert.ok(breaker.options.prompt.includes(probes.lowercases));
  assert.equal(git(env.cwd, 'status', '--porcelain'), '');
}

/** F3: killed after a probe ran in its pinned checkout, before the probe's checkpoint. */
export const kill = {
  step: '^criteria/QA-1/0/probe$',
  boundary: 'checkpoint',
  writeLocation: 'isolated-checkout',
};

const verdicts = (output) => output.tickets.map((ticket) => [ticket.id, ticket.verdict]);

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
    mode: 'empty',
    check({ result, calls, record }) {
      assert.equal(result.output.status, 'empty');
      assert.deepEqual(result.output.tickets, []);
      assert.deepEqual(result.output.skipped, skipped);
      assert.equal(calls.length, 1);
      assert.deepEqual(ran(record, ''), []);
    },
  },
  {
    mode: 'reworded',
    check({ result, calls }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(
        output.rejected.map((ticket) => ticket.id),
        ['QA-1', 'QA-2'],
      );
      assert.match(output.rejected[0].reason, /Duplicate/u);
      assert.match(output.rejected[1].reason, /strips all punctuation marks/u);
      assert.deepEqual(verdicts(output), [['QA-1', 'pass']]);
      assert.ok(!stepIds(calls).includes('demonstrate/QA-2/plan'));
    },
  },
  {
    mode: 'inline-capped',
    input: () => ({ ...input(), tickets: backlog, maxTickets: 1 }),
    check({ result, calls }) {
      const { output } = result;
      assert.equal(output.status, 'limited');
      assert.deepEqual(output.deferred, [{ id: 'QA-2', title: 'Strip punctuation' }]);
      assert.deepEqual(verdicts(output), [['QA-1', 'pass']]);
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
      assert.deepEqual([output.passed, output.failed, output.unverified], [0, 1, 1]);
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
    mode: 'probe-timeout',
    input: () => ({ ...input(), probeTimeoutMs: 1000 }),
    check({ result }) {
      const { output } = result;
      assert.equal(output.status, 'complete');
      const [first] = output.tickets;
      assert.deepEqual(statuses(first), ['demonstrated', 'inconclusive']);
      assert.equal(first.criteria[1].run.failure, 'timeout');
      assert.deepEqual(
        [first.verdict, first.breaker, first.manual],
        [
          'pass-pending-manual',
          'answered',
          ['Criterion 2: the probe ended without an exit code (timeout)'],
        ],
      );
    },
  },
  {
    mode: 'declined-probes',
    check({ result, record, calls }) {
      const { output } = result;
      assert.equal(output.status, 'declined');
      assert.match(output.probeDigest, /^[a-f0-9]{64}$/u);
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
    check({ result, record }) {
      const { output } = result;
      assert.equal(output.status, 'declined');
      const [first] = output.tickets;
      assert.deepEqual([first.verdict, first.breaker], ['pass-pending-manual', 'declined']);
      assert.deepEqual(
        first.attacks.map((attack) => attack.outcome),
        ['unrun', 'unrun'],
      );
      assert.deepEqual(first.manual, ['The attack probes were not approved']);
      assert.deepEqual(ran(record, 'attacks/'), []);
    },
  },
];

/** Deferred tickets are a cap the fault matrix does not read from 'limited'. */
export const degraded = (output) => output.deferred.length > 0;
