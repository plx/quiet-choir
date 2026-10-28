// design-tournament: four proposers answer in character, three judges score every anonymized
// proposal in rotated orders, the data-first ledger (C) wins on 36, 36 and 24 with the third judge
// dissenting, the synthesizer grafts two runner-up ideas and rejects two, and code appends the
// tournament record and writes docs/design.md.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { enumOf, git } from './_support.mjs';

const philosophies = ['ship-simplest', 'evolvability', 'data-first', 'failure-first'];
const titles = {
  'ship-simplest': 'Single export job table',
  evolvability: 'Ports and adapters exporter',
  'data-first': 'Append-only export ledger',
  'failure-first': 'Idempotent export pipeline',
};
// Each philosophy's identity, as its prompt must state it; judges must never see these.
const identities = {
  'ship-simplest': 'ships correctly in two weeks',
  evolvability: 'make the NEXT change cheap',
  'data-first': 'live or die on their data model',
  'failure-first': 'the design IS its failure modes',
};
// Judge totals out of 40 by letter and seat; a fourth seat exists for the cross-harness mode.
const totals = {
  A: [28, 27, 30, 28],
  B: [30, 31, 32, 30],
  C: [36, 36, 24, 34],
  D: [26, 25, 28, 26],
};
// Best ideas by letter and seat: B's first two differ only in case and spacing, so they merge.
const best = {
  A: ['Cut scope before adding a concept', null, null, null],
  B: [
    'Versioned interfaces at module seams',
    'versioned  interfaces at module seams',
    'Plugin registry',
    null,
  ],
  C: ['Ledger rows as the export state', null, null, null],
  D: ['Idempotency keys per export', null, 'Idempotency keys per export', null],
};
const brief = 'Design CSV exports of reports up to 10,000 rows that finish within five seconds.';
const out = 'docs/design.md';
const synthesized =
  '# Export design\n\n## Decision summary\n\nAdopt the append-only export ledger.';
const decisions = { B1: 'grafted', B2: 'rejected', A1: 'rejected', D1: 'grafted' };

/** Four axis scores summing to `total`, highest first. */
const split = (total) =>
  [0, 1, 2, 3].map((axis) => Math.floor(total / 4) + (axis < total % 4 ? 1 : 0));
const order = (prompt) => [...prompt.matchAll(/^<proposal letter="([A-D])">$/gmu)].map((m) => m[1]);
const proposer = /^proposals\/([a-z-]+)\/propose$/u;
const judge = /^judges\/(\d+)\/score$/u;

export const input = () => ({ brief, context: 'src/export.mjs holds the current exporter.', out });

function propose(request) {
  const philosophy = proposer.exec(request.call.stepId)[1];
  assert.ok(request.options.prompt.includes(identities[philosophy]), philosophy);
  return {
    title: titles[philosophy],
    summary: `${titles[philosophy]} for report exports.`,
    components: [
      { name: 'ExportApi', responsibility: 'Accepts export requests', interfaces: 'POST /exports' },
      { name: 'ExportStore', responsibility: 'Keeps export state', interfaces: null },
    ],
    dataFlow: 'Request to ExportApi, rows streamed to ExportStore, link returned.',
    tradeoffs: [`${titles[philosophy]} over generality`],
    risks: ['Large reports exceed five seconds'],
    migrationPath: null,
  };
}

/** In the tie mode B matches C's totals with a point moved from fitness to simplicity. */
function axesOf(letter, seat, mode) {
  if (mode !== 'tie' || letter !== 'B') return split(totals[letter][seat]);
  const [fitness, simplicity, ...rest] = split(totals.C[seat]);
  return [fitness - 1, simplicity + 1, ...rest];
}

function score(request, mode) {
  const seat = Number(judge.exec(request.call.stepId)[1]);
  const letters = enumOf(request.outputSchema, 'scores', 'items', 'proposal');
  return {
    scores: letters.map((letter) => {
      const [fitness, simplicity, evolvability, operability] = axesOf(letter, seat, mode);
      return {
        proposal: letter,
        fitness,
        simplicity,
        evolvability,
        operability,
        rationale: `Judge ${seat + 1} on ${letter}: ExportStore carries the load`,
        bestIdea: best[letter][seat],
      };
    }),
  };
}

function synthesize(request, mode) {
  const ids = enumOf(request.outputSchema, 'grafts', 'items', 'idea');
  return {
    design: synthesized,
    grafts: ids
      .filter((id) => !(mode === 'undecided-graft' && id === 'A1'))
      .map((id) => ({ idea: id, decision: decisions[id] ?? 'rejected', reason: `Because ${id}` })),
  };
}

export function reply(request, env, mode) {
  const id = request.call.stepId;
  if (proposer.test(id)) return propose(request);
  if (judge.test(id)) return score(request, mode);
  if (id === 'synthesize') return synthesize(request, mode);
  throw new Error(`Unhandled design-tournament step ${id} (${mode})`);
}

export function fail(request, mode) {
  const id = request.call.stepId;
  if (mode === 'two-proposers-fail')
    return /^proposals\/(?:evolvability|failure-first)\/propose$/u.test(id);
  if (mode === 'aborted') return proposer.test(id) && !id.includes('data-first');
  if (mode === 'judges-fail') return judge.test(id);
  if (mode === 'one-judge-fails') return id === 'judges/0/score';
  return false;
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
/** The calls whose step matches, in step order: concurrent members finish in any order. */
const byStep = (calls, pattern) =>
  calls
    .filter((call) => pattern.test(call.call.stepId))
    .sort((a, b) => a.call.stepId.localeCompare(b.call.stepId, 'en', { numeric: true }));

/** The written document is the returned design byte for byte, behind an exclusive create. */
async function assertWritten(env, output) {
  const text = await readFile(join(env.cwd, out), 'utf8');
  assert.equal(text, `${output.design}\n`);
  assert.equal(output.written.sha256, sha256(text));
  assert.equal(output.written.previousSha256, null);
  assert.ok(output.design.startsWith(`${synthesized}\n\n## Tournament record\n`));
}

export async function check({ result, env, calls, suspended }) {
  const { output } = result;
  assert.equal(output.status, 'complete');
  assert.equal(suspended, 0);
  assert.equal(calls.length, 8);
  assert.deepEqual(
    output.scoreboard.map((s) => [s.letter, s.philosophy, s.avg, s.votes]),
    [
      ['C', 'data-first', 32, 3],
      ['B', 'evolvability', 31, 3],
      ['A', 'ship-simplest', 28.3, 3],
      ['D', 'failure-first', 26.3, 3],
    ],
  );
  assert.deepEqual(output.winner.axes, {
    fitness: 8,
    simplicity: 8,
    evolvability: 8,
    operability: 8,
  });
  assert.deepEqual(output.winner.tiedWith, []);
  assert.deepEqual(
    output.dissent.map((d) => [d.judge, d.total, d.avg]),
    [[3, 24, 32]],
  );
  assert.deepEqual(
    output.grafts.map((g) => [g.id, g.from, g.judges, g.decision]),
    [
      ['B1', 'B', [1, 2], 'grafted'],
      ['B2', 'B', [3], 'rejected'],
      ['A1', 'A', [1], 'rejected'],
      ['D1', 'D', [1, 3], 'grafted'],
    ],
  );
  assert.deepEqual(output.failedProposals, []);
  assert.deepEqual(output.failedJudges, []);
  assert.equal(output.proposals.length, 4);
  // The record is code's: the scoreboard, every decision and the dissent are in the document.
  assert.match(output.design, /^1\. C, Append-only export ledger \(data-first\): 32\.0 of 40/mu);
  assert.match(output.design, /^- A1 from A, named by judges 1: .* \(rejected: Because A1\)$/mu);
  assert.match(output.design, /^- Judge 3 scored the winner 24 of 40 \(panel average 32\.0\)/mu);
  await assertWritten(env, output);
  assert.equal(git(env.cwd, 'status', '--porcelain', '--untracked-files=all'), `?? ${out}`);
  // Judges see letters, never philosophies, each seat in its own rotation of A to D.
  const judges = byStep(calls, judge);
  assert.deepEqual(
    judges.map((call) => order(call.options.prompt).join('')),
    ['ABCD', 'BCDA', 'CDAB'],
  );
  for (const call of judges) {
    // `evolvability` is also a rubric axis, so only the other three names are absent.
    for (const name of philosophies.filter((p) => p !== 'evolvability'))
      assert.ok(!call.options.prompt.includes(name), name);
    for (const phrase of Object.values(identities))
      assert.ok(!call.options.prompt.includes(phrase), phrase);
    assert.ok(call.options.prompt.includes(brief));
  }
  const [synthesis] = byStep(calls, /^synthesize$/u);
  assert.equal(order(synthesis.options.prompt).join(''), 'C');
  assert.match(synthesis.options.prompt, /^- D1, from D .*named by 2 of 3 judges/mu);
  assert.match(synthesis.options.prompt, /^- Judge 3 gave it 24 of 40: Judge 3 on C/mu);
  // Proposers and judges read; the synthesizer has no tools; nothing may edit.
  assert.deepEqual(synthesis.options.tools, []);
  for (const call of [...byStep(calls, proposer), ...judges])
    assert.deepEqual(call.options.tools, ['Read', 'Grep', 'Glob']);
}

export const kill = { step: '^write$', boundary: 'checkpoint', writeLocation: 'source-checkout' };

export const modes = [
  {
    mode: 'two-proposers-fail',
    async check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(output.failedProposals, ['evolvability', 'failure-first']);
      assert.deepEqual(
        output.scoreboard.map((s) => [s.letter, s.avg]),
        [
          ['C', 32],
          ['A', 28.3],
        ],
      );
      assert.deepEqual(
        byStep(calls, judge).map((call) => order(call.options.prompt).join('')),
        ['AC', 'CA', 'AC'],
      );
      assert.deepEqual(
        output.grafts.map((g) => g.id),
        ['A1'],
      );
      assert.match(
        output.design,
        /^Failed: proposers evolvability, failure-first; judges none\.$/mu,
      );
      await assertWritten(env, output);
    },
  },
  {
    mode: 'aborted',
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'aborted');
      assert.deepEqual(
        output.proposals.map((p) => p.letter),
        ['C'],
      );
      assert.deepEqual(output.failedProposals, ['ship-simplest', 'evolvability', 'failure-first']);
      assert.equal(output.winner, null);
      assert.equal(output.design, null);
      assert.equal(output.written, null);
      assert.equal(calls.filter((call) => !proposer.test(call.call.stepId)).length, 0);
      assert.equal(existsSync(join(env.cwd, out)), false);
    },
  },
  {
    mode: 'judges-fail',
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'unjudged');
      assert.deepEqual(output.failedJudges, [1, 2, 3]);
      assert.equal(output.proposals.length, 4);
      assert.deepEqual(output.scoreboard, []);
      assert.equal(output.design, null);
      assert.equal(byStep(calls, /^synthesize$/u).length, 0);
      assert.equal(existsSync(join(env.cwd, out)), false);
    },
  },
  {
    mode: 'one-judge-fails',
    input: () => ({ ...input(), judges: 4 }),
    async check({ result, env, calls }) {
      const { output } = result;
      // Seat 1 fails; the other three keep their own seat numbers in every record.
      assert.equal(output.status, 'degraded');
      assert.deepEqual(output.failedJudges, [1]);
      assert.deepEqual(
        output.scoreboard.map((s) => [s.letter, s.avg, s.votes]),
        [
          ['C', 31.3, 3],
          ['B', 31, 3],
          ['A', 28.3, 3],
          ['D', 26.3, 3],
        ],
      );
      assert.deepEqual(
        output.dissent.map((d) => [d.judge, d.total, d.avg]),
        [[3, 24, 31.3]],
      );
      assert.deepEqual(
        output.grafts.map((g) => [g.id, g.judges]),
        [
          ['B1', [2]],
          ['B2', [3]],
          ['D1', [3]],
        ],
      );
      assert.deepEqual(
        byStep(calls, judge).map((call) => order(call.options.prompt).join('')),
        ['ABCD', 'BCDA', 'CDAB', 'DABC'],
      );
      assert.match(output.design, /^Failed: proposers none; judges 1\.$/mu);
      assert.match(
        output.design,
        /^- Judge 3 scored the winner 24 of 40 \(panel average 31\.3\)/mu,
      );
      const [synthesis] = byStep(calls, /^synthesize$/u);
      assert.match(synthesis.options.prompt, /^- Judge 3 gave it 24 of 40: Judge 3 on C/mu);
      assert.match(synthesis.options.prompt, /^- B1, from B .*named by 1 of 3 judges/mu);
      await assertWritten(env, output);
    },
  },
  {
    mode: 'out-exists',
    input: () => ({ ...input(), out: 'README.md' }),
    check({ result, env, calls }) {
      const { output } = result;
      // The exclusive create would fail at the end; the check before the proposers costs nothing.
      assert.equal(output.status, 'refused');
      assert.equal(calls.length, 0);
      assert.deepEqual(output.proposals, []);
      assert.equal(output.design, null);
      assert.equal(output.written, null);
      assert.equal(git(env.cwd, 'status', '--porcelain', '--untracked-files=all'), '');
    },
  },
  {
    mode: 'undecided-graft',
    async check({ result, env }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(
        output.grafts.filter((g) => g.decision === null).map((g) => g.id),
        ['A1'],
      );
      assert.match(
        output.design,
        /^- A1 from A, .*\(undecided: the synthesis gave no decision\)$/mu,
      );
      await assertWritten(env, output);
    },
  },
  {
    mode: 'tie',
    async check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'complete');
      assert.deepEqual(
        output.scoreboard.slice(0, 2).map((s) => [s.letter, s.avg, s.axes.fitness]),
        [
          ['C', 32, 8],
          ['B', 32, 7],
        ],
      );
      assert.deepEqual(output.winner.tiedWith, ['B']);
      const [synthesis] = byStep(calls, /^synthesize$/u);
      assert.match(synthesis.options.prompt, /^It tied with B on the average/mu);
      await assertWritten(env, output);
    },
  },
  {
    mode: 'cross-harness-commit',
    input: () => ({ ...input(), judges: 4, crossHarness: true, publication: 'commit' }),
    async check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'complete');
      assert.equal(output.winner.letter, 'C');
      assert.equal(output.winner.avg, 32.5);
      assert.deepEqual(
        byStep(calls, judge).map((call) => [call.harness, call.options.sandbox ?? null]),
        [
          ['claude', null],
          ['codex', 'read-only'],
          ['claude', null],
          ['codex', 'read-only'],
        ],
      );
      await assertWritten(env, output);
      assert.equal(git(env.cwd, 'status', '--porcelain'), '');
      assert.equal(git(env.cwd, 'log', '-1', '--format=', '--name-only'), out);
    },
  },
];

/** A tournament that stopped before a winner is degraded, whatever its status calls it. */
export const degraded = (output) => output.status === 'aborted' || output.status === 'unjudged';
