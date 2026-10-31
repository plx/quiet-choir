// roadmap-plan: docs/spec.md describes a team notes app. The decomposer returns five capabilities
// whose longest chain is C1 -> C2 -> C3 (7 points); three strategists sequence them, the judge
// picks value-first and offers a de-risk-first graft, the critic reports two problems, and the
// finalizer applies one and declines the other; code renders the roadmap and creates
// docs/roadmap.md.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commitAll, enumOf, git, writeFiles } from './_support.mjs';

const spec = [
  '# Team notes',
  '',
  'Teams write notes together and share them in real time.',
  '',
  '## Requirements',
  '',
  '- People sign up and sign in with email.',
  '- Members create, edit and delete notes.',
  '- Two members can edit the same note at once and see each other’s changes.',
  '- Members search every note they can read.',
  '- Teams pay per seat each month.',
  '',
].join('\n');
const priorities = 'Demo live co-editing to investors in three weeks';

const capability = (id, name, size, dependsOn, risk, value) => ({
  id,
  name,
  summary: `${name} for the team notes app.`,
  size,
  dependsOn,
  risk,
  value,
});
const capabilities = [
  capability('C1', 'Accounts and sign-in', 'M', [], 'low', 'medium'),
  capability('C2', 'Note editing', 'M', ['C1'], 'low', 'high'),
  capability('C3', 'Real-time co-editing', 'L', ['C2'], 'high', 'high'),
  capability('C4', 'Search', 'M', ['C2'], 'medium', 'medium'),
  capability('C5', 'Seat billing', 'M', ['C1'], 'high', 'low'),
];
// C1 needs C3, which needs C2, which needs C1: no plan can respect it, so code refuses it.
const cyclic = capabilities.slice(0, 3).map((c, index) => ({
  ...c,
  dependsOn: [['C3'], ['C1'], ['C2']][index],
}));
const milestone = (name, capabilityIds, extra = {}) => ({
  name,
  capabilityIds,
  goal: `${name} ships`,
  gate: `${name} passes its demo`,
  ...extra,
});
const plans = {
  'de-risk-first': {
    milestones: [
      milestone('Spike co-editing', ['C1', 'C2', 'C3']),
      milestone('Billing', ['C5']),
      milestone('Search', ['C4']),
    ],
    deferred: [],
    rationale: 'Co-editing is the unknown; kill it first.',
  },
  'value-first': {
    milestones: [
      milestone('Write notes', ['C1', 'C2']),
      milestone('Share live', ['C3']),
      milestone('Find notes', ['C4'], { gate: 'Search feels fast' }),
    ],
    deferred: ['C5'],
    rationale: 'Users write notes first; billing waits.',
  },
  'foundation-first': {
    milestones: [
      milestone('Platform', ['C1', 'C5']),
      milestone('Notes', ['C2', 'C4']),
      milestone('Co-editing', ['C3']),
    ],
    deferred: [],
    rationale: 'Accounts and billing underpin everything.',
  },
};
// Co-editing before the notes it edits breaks the graph; code refuses it on both attempts.
const backwards = {
  milestones: [
    milestone('Co-editing first', ['C3']),
    milestone('Everything else', ['C1', 'C2', 'C4', 'C5']),
  ],
  deferred: [],
  rationale: 'Start with the hardest part.',
};
const graft = 'Spike the sync engine inside the first milestone';
const problems = [
  {
    kind: 'gate-unmeasurable',
    detail: 'The Find notes gate "Search feels fast" cannot be measured.',
    fix: 'Gate on p95 search latency under 300 ms.',
  },
  {
    kind: 'unbalanced-critical-path',
    detail: 'Share live carries the critical path’s largest capability alone.',
    fix: 'Move C3 into Write notes.',
  },
];
const final = [
  milestone('Write notes', ['C1', 'C2'], {
    gate: 'Ten pilot teams write notes daily',
    keyRisks: ['Sync spike overruns'],
  }),
  milestone('Share live', ['C3'], { keyRisks: ['C3 merge conflicts under load'] }),
  milestone('Find notes', ['C4'], { gate: 'p95 search latency under 300 ms', keyRisks: [] }),
];

export async function setup(env) {
  await writeFiles(env.cwd, { 'docs/spec.md': spec });
  commitAll(env.cwd, 'add the team notes spec');
}

export const input = () => ({
  spec: 'docs/spec.md',
  horizon: 'MVP then GA',
  priorities,
  out: 'docs/roadmap.md',
});

function pick(request) {
  const keys = enumOf(request.outputSchema, 'winner');
  const winner = keys.includes('value-first') ? 'value-first' : keys[0];
  const losers = keys.filter((key) => key !== winner);
  return {
    scores: [winner, ...losers].map((strategy, index) => ({
      strategy,
      score: 8 - index,
      why: `${strategy} fits the demo date ${index === 0 ? 'best' : 'less well'}`,
    })),
    winner,
    reasoning: 'The investor demo needs co-editing early and usable notes first.',
    graft: { from: losers[0], idea: graft },
  };
}

function finalize(request) {
  const schema = request.outputSchema.properties;
  const count = schema.resolutions.minItems;
  return {
    statement: 'Ship usable notes first, then live co-editing for the demo, then search.',
    milestones: final,
    deferred: ['C5'],
    resolutions: Array.from({ length: count }, (_, index) => ({
      problem: index + 1,
      action: index === 0 ? 'applied' : 'declined',
      note: index === 0 ? 'The gate is now a latency target.' : 'C3 alone keeps Write notes small.',
    })),
    graft:
      schema.graft.type === 'null' ? null : { action: 'applied', note: 'Spiked in milestone one.' },
  };
}

export function reply(request, env, mode) {
  const id = request.call.stepId;
  if (id === 'decompose')
    return {
      capabilities: mode === 'empty' ? [] : mode === 'cyclic-graph' ? cyclic : capabilities,
    };
  const strategy = /^strategies\/([a-z-]+)\/plan$/u.exec(id)?.[1];
  if (strategy)
    return mode === 'sole-survivor' && strategy === 'foundation-first'
      ? backwards
      : plans[strategy];
  if (id === 'panel') return pick(request);
  if (id === 'critic') return { problems: mode === 'strategist-fails' ? [] : problems };
  if (id === 'finalize') return finalize(request);
  throw new Error(`Unhandled roadmap-plan step ${id} (${mode})`);
}

export function fail(request, mode) {
  const id = request.call.stepId;
  return (
    ((mode === 'strategist-fails' || mode === 'sole-survivor') &&
      id === 'strategies/value-first/plan') ||
    (mode === 'no-strategy' && id.startsWith('strategies/'))
  );
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const steps = (calls) => calls.map((call) => call.call.stepId).sort();
const prompt = (calls, id) => calls.find((call) => call.call.stepId === id).options.prompt;
const path = 'C1 (milestone 1) -> C2 (milestone 1) -> C3 (milestone 2), 7 points.';

export async function check({ result, env, calls }) {
  const { output } = result;
  assert.equal(output.status, 'complete');
  assert.deepEqual(output.spec, {
    source: 'file',
    path: 'docs/spec.md',
    sha256: sha256(spec),
    bytes: Buffer.byteLength(spec),
  });
  assert.deepEqual(steps(calls), [
    'critic',
    'decompose',
    'finalize',
    'panel',
    'strategies/de-risk-first/plan',
    'strategies/foundation-first/plan',
    'strategies/value-first/plan',
  ]);
  // Code reads the spec and writes the document, so no role has a tool.
  assert.ok(calls.every((call) => (call.options.tools ?? []).length === 0));
  assert.ok(prompt(calls, 'decompose').includes(`<spec>\n${spec}\n</spec>`));
  for (const strategy of Object.keys(plans))
    assert.ok(
      prompt(calls, `strategies/${strategy}/plan`).includes(
        `Business priorities to weigh: ${priorities}`,
      ),
    );
  for (const strategy of Object.keys(plans))
    assert.ok(prompt(calls, 'panel').includes(`Strategy ${strategy}. Rationale:`));
  // The critic sees the spec and the critical path code computed on the winner's plan.
  assert.ok(prompt(calls, 'critic').includes(path));
  assert.ok(prompt(calls, 'critic').includes(spec));
  assert.ok(prompt(calls, 'finalize').includes('1. gate-unmeasurable: The Find notes gate'));
  assert.ok(prompt(calls, 'finalize').includes(`from the de-risk-first strategy, or decline it`));
  assert.deepEqual(output.failedStrategies, []);
  assert.equal(output.strategy, 'value-first');
  assert.deepEqual(
    output.pick.scores.map((score) => [score.strategy, score.score]),
    [
      ['value-first', 8],
      ['de-risk-first', 7],
      ['foundation-first', 6],
    ],
  );
  assert.deepEqual(output.criticalPath, { capabilities: ['C1', 'C2', 'C3'], points: 7 });
  assert.deepEqual(
    output.milestones.map((m) => [m.name, m.capabilities, m.gate]),
    [
      ['Write notes', ['C1', 'C2'], 'Ten pilot teams write notes daily'],
      ['Share live', ['C3'], 'Share live passes its demo'],
      ['Find notes', ['C4'], 'p95 search latency under 300 ms'],
    ],
  );
  assert.deepEqual(output.deferred, ['C5']);
  assert.deepEqual(output.risks, [
    { capability: 'C3', name: 'Real-time co-editing', milestone: 'Share live' },
    { capability: 'C5', name: 'Seat billing', milestone: null },
  ]);
  assert.deepEqual(output.graft, {
    from: 'de-risk-first',
    idea: graft,
    action: 'applied',
    note: 'Spiked in milestone one.',
  });
  assert.equal(output.stress.sound, false);
  assert.deepEqual(
    output.stress.problems.map((p) => [p.kind, p.action]),
    [
      ['gate-unmeasurable', 'applied'],
      ['unbalanced-critical-path', 'declined'],
    ],
  );
  const document = await readFile(join(env.cwd, 'docs/roadmap.md'), 'utf8');
  assert.equal(document, output.roadmap);
  assert.equal(output.written.path, join(env.cwd, 'docs/roadmap.md'));
  assert.equal(output.written.sha256, sha256(document));
  assert.equal(output.written.previousSha256, null);
  assert.ok(document.includes('status: complete. Strategy: value-first, picked by the panel.'));
  assert.ok(
    document.includes(
      '| 2. Share live | Share live ships | C3 Real-time co-editing | Share live passes its demo | C3 merge conflicts under load |\n',
    ),
  );
  assert.ok(document.includes('Deferred beyond the horizon: C5 Seat billing.\n'));
  assert.ok(
    document.includes(
      'C1 Accounts and sign-in (milestone 1) -> C2 Note editing (milestone 1) -> C3 Real-time co-editing (milestone 2): 7 points',
    ),
  );
  assert.ok(document.includes('| C5 Seat billing | deferred |\n'));
  assert.ok(document.includes('2 problems in the value-first plan; 1 applied, 1 declined.'));
  assert.equal(git(env.cwd, 'status', '--porcelain'), '?? docs/roadmap.md');
}

export const kill = { step: '^write$', boundary: 'checkpoint', writeLocation: 'source-checkout' };

const unwritten = (env) => {
  assert.equal(existsSync(join(env.cwd, 'docs/roadmap.md')), false);
  assert.equal(git(env.cwd, 'status', '--porcelain'), '');
};

export const modes = [
  {
    mode: 'strategist-fails',
    check: async ({ result, env, calls }) => {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(
        output.failedStrategies.map((f) => [f.strategy, f.kind]),
        [['value-first', 'process']],
      );
      // A process failure is not retried; the two survivors compete.
      assert.equal(calls.filter((c) => c.call.stepId === 'strategies/value-first/plan').length, 1);
      assert.equal(prompt(calls, 'panel').includes('Strategy value-first.'), false);
      assert.equal(output.strategy, 'de-risk-first');
      assert.equal(output.pick.scores.length, 2);
      assert.equal(output.graft.from, 'foundation-first');
      // The register follows the finalizer's milestones, not the winner's: de-risk-first puts
      // C3 in 'Spike co-editing' and C5 in 'Billing'.
      assert.deepEqual(output.risks, [
        { capability: 'C3', name: 'Real-time co-editing', milestone: 'Share live' },
        { capability: 'C5', name: 'Seat billing', milestone: null },
      ]);
      assert.deepEqual(output.stress, { sound: true, problems: [] });
      assert.ok(prompt(calls, 'finalize').includes('The stress test found no problems'));
      const document = await readFile(join(env.cwd, 'docs/roadmap.md'), 'utf8');
      assert.ok(document.includes('status: degraded.'));
      assert.ok(document.includes('- value-first: failed (process); it did not compete.'));
      assert.ok(document.includes('The critic found no problems in the winning plan.'));
    },
  },
  {
    mode: 'sole-survivor',
    check: async ({ result, env, calls }) => {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      const [exited, refused] = output.failedStrategies;
      assert.deepEqual(
        [exited.strategy, exited.kind, refused.strategy, refused.kind],
        ['value-first', 'process', 'foundation-first', 'schema'],
      );
      // Code refused the backwards plan on both attempts, naming the broken dependency.
      assert.match(
        refused.message,
        /C3 in milestone 1 depends on C2, which is in later milestone 2/u,
      );
      assert.equal(
        calls.filter((c) => c.call.stepId === 'strategies/foundation-first/plan').length,
        2,
      );
      // One plan has no rival to score and no loser to graft from.
      assert.equal(
        calls.some((c) => c.call.stepId === 'panel'),
        false,
      );
      assert.equal(output.pick, null);
      assert.equal(output.graft, null);
      assert.equal(output.strategy, 'de-risk-first');
      assert.ok(prompt(calls, 'critic').includes('the de-risk-first strategy'));
      assert.ok(prompt(calls, 'critic').includes('C3 (milestone 1), 7 points.'));
      assert.ok(prompt(calls, 'finalize').includes('No graft was offered'));
      const document = await readFile(join(env.cwd, 'docs/roadmap.md'), 'utf8');
      assert.ok(document.includes('Strategy: de-risk-first, the only plan that competed.'));
      assert.ok(document.includes('- de-risk-first: unscored; no other strategy competed.'));
    },
  },
  {
    mode: 'no-strategy',
    check: ({ result, env, calls }) => {
      const { output } = result;
      assert.equal(output.status, 'no-strategy');
      assert.deepEqual(
        output.failedStrategies.map((f) => f.strategy),
        ['de-risk-first', 'value-first', 'foundation-first'],
      );
      assert.equal(output.capabilities.length, 5);
      assert.deepEqual(output.criticalPath, { capabilities: ['C1', 'C2', 'C3'], points: 7 });
      assert.deepEqual(steps(calls), [
        'decompose',
        'strategies/de-risk-first/plan',
        'strategies/foundation-first/plan',
        'strategies/value-first/plan',
      ]);
      assert.equal(output.strategy, null);
      assert.deepEqual(output.milestones, []);
      assert.equal(output.roadmap, null);
      assert.equal(output.written, null);
      unwritten(env);
    },
  },
  {
    mode: 'empty',
    // Inline spec text spans lines; the decomposer finds nothing to build in it.
    input: () => ({ spec: 'Nothing to build yet.\nAsk again later.\n', out: 'docs/roadmap.md' }),
    check: ({ result, env, calls }) => {
      const { output } = result;
      assert.equal(output.status, 'empty');
      assert.equal(output.spec.source, 'text');
      assert.equal(output.spec.path, null);
      assert.deepEqual(steps(calls), ['decompose']);
      assert.ok(calls[0].options.prompt.includes('The spec:\n\n<spec>\nNothing to build yet.'));
      assert.deepEqual(output.capabilities, []);
      assert.equal(output.criticalPath, null);
      assert.equal(output.written, null);
      unwritten(env);
    },
  },
  {
    mode: 'out-exists',
    // Exclusive creation refuses to replace README.md; every agent step stays completed, so a
    // resume after the operator frees the path pays for nothing again.
    input: () => ({ spec: 'docs/spec.md', out: 'README.md' }),
    rejects: /Step write \(write-file\) failed: File ifMatch failed/u,
    check: async ({ record, env }) => {
      assert.equal(record.status, 'failed');
      assert.equal(record.steps.finalize.status, 'completed');
      assert.equal(record.steps.write.status, 'failed');
      assert.equal(git(env.cwd, 'status', '--porcelain'), '');
    },
    repair: { run: (env) => rmSync(join(env.cwd, 'README.md')), paid: [] },
    resumeCheck: async ({ result, env }) => {
      const { output } = result;
      assert.equal(output.status, 'complete');
      const document = await readFile(join(env.cwd, 'README.md'), 'utf8');
      assert.equal(output.written.path, join(env.cwd, 'README.md'));
      assert.equal(output.written.sha256, sha256(document));
      assert.equal(output.written.previousSha256, null);
      assert.equal(git(env.cwd, 'status', '--porcelain'), 'M README.md');
    },
  },
  {
    mode: 'cyclic-graph',
    // The decomposition schema refuses the cycle on both attempts, before any strategist is paid.
    rejects: /The dependencies form a cycle: C1 -> C3 -> C2 -> C1/u,
    check: ({ record, env, calls }) => {
      assert.equal(record.status, 'failed');
      assert.deepEqual(
        calls.map((call) => call.call.stepId),
        ['decompose', 'decompose'],
      );
      unwritten(env);
    },
  },
];
