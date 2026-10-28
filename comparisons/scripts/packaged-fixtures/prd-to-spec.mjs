// prd-to-spec: docs/prd.md commits the CSV export PRD beside src/export.mjs. The grounder maps the
// exporter; the data-model and architecture lenses raise the same load-bearing decision in
// different case and spacing (code merges it into D1 with both lenses' options), api-contracts a
// moderate one (D2) and operations a reversible one (D3). D1 goes to the design-tournament child,
// whose data-first ledger (C) wins; the merger adopts its design, the implementability audit finds
// one gap and the fidelity audit none, the repair adds an open question, and code writes
// docs/spec.md.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commitAll, enumOf, git, writeFiles } from './_support.mjs';

const prd = [
  '# CSV export',
  '',
  '## Requirements',
  '',
  '- Users can export any report as a CSV file.',
  '- Exports of up to 10,000 rows finish within 5 seconds.',
  '- A failed export can be retried.',
  '',
].join('\n');
const out = 'docs/spec.md';
const grounding = {
  summary: 'A Node service whose src/export.mjs renders reports synchronously.',
  conventions: ['Functions return plain objects; errors are thrown Error subclasses'],
  integrationPoints: ['src/export.mjs exportCsv'],
  constraints: [],
};
const lenses = ['data-model', 'api-contracts', 'architecture', 'edge-semantics', 'operations'];
const stateDecision = 'Where export state lives';
/** Each lens's raised decisions; data-model and architecture raise D1 in different spellings. */
const raised = {
  'data-model': [
    { decision: stateDecision, options: ['Postgres table', 'Object store'], stakes: 'moderate' },
  ],
  architecture: [
    {
      decision: '  where EXPORT state  lives',
      options: ['object store', 'Job queue payload'],
      stakes: 'load-bearing',
    },
  ],
  'api-contracts': [
    {
      decision: 'Pagination of export listings',
      options: ['Cursor', 'Offset'],
      stakes: 'moderate',
    },
  ],
  'edge-semantics': [],
  operations: [
    { decision: 'Metrics backend', options: ['StatsD', 'OpenTelemetry'], stakes: 'reversible' },
  ],
};
const merged = 'Who may export another team’s reports?';
const added = 'What is the largest report a single export accepts?';
const gap = {
  where: 'API contracts',
  problem: 'The retry route has no response shape.',
  fix: 'Define the 202 body.',
};
const tournamentDesign =
  '# Export design\n\n## Decision summary\n\nAdopt the append-only export ledger.';

/** A spec with the nine headings, the decision IDs, a fenced pseudo-heading and its questions. */
const spec = (title, ids, questions) =>
  [
    `# ${title}`,
    '',
    '## Overview',
    '',
    'CSV exports for every report.',
    '',
    '## Decisions',
    '',
    ...(ids.length ? ids.map((id) => `- ${id}: decided with a rationale.`) : ['None raised.']),
    '',
    '## Data model',
    '',
    '```sh',
    '## not a heading inside a fence',
    '```',
    '',
    '## API contracts',
    '',
    'POST /exports returns 202.',
    '',
    '## Architecture',
    '',
    'ExportService enqueues ledger rows.',
    '',
    '## Behavior & edge semantics',
    '',
    'An empty report exports its header row.',
    '',
    '## Operations',
    '',
    'export_duration_ms is emitted per export.',
    '',
    '## Out of scope',
    '',
    'PDF exports.',
    '',
    '## Open questions',
    '',
    ...(questions.length ? questions.map((q) => `- ${q}`) : ['None so far.']),
  ].join('\n');

const lensStep = /^lenses\/([a-z-]+)\/draft$/u;
const auditStep = /^audits\/([a-z]+)\/audit$/u;
const proposer = /^tournament\/proposals\/([a-z-]+)\/propose$/u;
const judge = /^tournament\/judges\/(\d+)\/score$/u;
/** The decision IDs the merge or repair prompt lists, in order. */
const idsOf = (prompt) => {
  const listed = /by its ID \(([^)]*)\)/u.exec(prompt.replace(/\n/gu, ' '))?.[1];
  return listed ? listed.split(', ') : [];
};

export async function setup(env) {
  await writeFiles(env.cwd, {
    'docs/prd.md': prd,
    'src/export.mjs': 'export const exportCsv = (rows) => rows.join("\\n");\n',
  });
  commitAll(env.cwd, 'add the CSV export PRD');
}

export const input = () => ({
  prd: 'docs/prd.md',
  codebase: '.',
  decideArchitecture: true,
  out,
});

function lensReply(lens, mode) {
  const decisions =
    mode === 'greenfield-inline'
      ? (raised[lens] ?? []).map((decision) => ({ ...decision, stakes: 'moderate' }))
      : raised[lens];
  return {
    sections: [
      {
        heading: `${lens} section`,
        content: `The ${lens} slice of the CSV export.`,
        prdAnchors: ['Users can export any report as a CSV file.'],
      },
    ],
    contestedDecisions: decisions,
  };
}

const totals = { A: 28, B: 30, C: 36, D: 26 };
const split = (total) =>
  [0, 1, 2, 3].map((axis) => Math.floor(total / 4) + (axis < total % 4 ? 1 : 0));
function tournamentReply(request) {
  const id = request.call.stepId;
  if (proposer.test(id)) {
    const philosophy = proposer.exec(id)[1];
    return {
      title: philosophy === 'data-first' ? 'Append-only export ledger' : `${philosophy} exporter`,
      summary: `A ${philosophy} export design.`,
      components: [{ name: 'ExportService', responsibility: 'Runs exports', interfaces: null }],
      dataFlow: null,
      tradeoffs: ['Simplicity over generality'],
      risks: ['Large reports'],
      migrationPath: null,
    };
  }
  if (judge.test(id))
    return {
      scores: enumOf(request.outputSchema, 'scores', 'items', 'proposal').map((letter) => {
        const [fitness, simplicity, evolvability, operability] = split(totals[letter]);
        return {
          proposal: letter,
          fitness,
          simplicity,
          evolvability,
          operability,
          rationale: `ExportService in ${letter} carries the load`,
          bestIdea: `Best idea of ${letter}`,
        };
      }),
    };
  if (id === 'tournament/synthesize')
    return {
      design: tournamentDesign,
      grafts: enumOf(request.outputSchema, 'grafts', 'items', 'idea').map((idea) => ({
        idea,
        decision: 'rejected',
        reason: 'Out of scope here',
      })),
    };
  throw new Error(`Unhandled tournament step ${id}`);
}

export function reply(request, env, mode) {
  const id = request.call.stepId,
    prompt = request.options.prompt;
  if (id === 'ground') return grounding;
  if (lensStep.test(id)) return lensReply(lensStep.exec(id)[1], mode);
  if (id.startsWith('tournament/')) return tournamentReply(request);
  if (id === 'merge') {
    const ids = idsOf(prompt);
    // A first merge without the Operations heading is refused by the schema and retried.
    const text = spec('Export spec', ids, [merged]);
    if (mode === 'merge-retry' && request.call.attempt === 1)
      return { spec: text.replace('## Operations', '### Operations') };
    return { spec: mode === 'greenfield-inline' ? spec('Export spec', ids, []) : text };
  }
  if (auditStep.test(id)) {
    const audit = auditStep.exec(id)[1];
    return { gaps: audit === 'implementability' && mode !== 'greenfield-inline' ? [gap] : [] };
  }
  if (id === 'repair')
    return { spec: spec('Export spec, repaired', idsOf(prompt), [merged, added]) };
  throw new Error(`Unhandled prd-to-spec step ${id} (${mode})`);
}

export function fail(request, mode) {
  const id = request.call.stepId;
  if (mode === 'failed-members')
    return id === 'lenses/operations/draft' || id === 'audits/fidelity/audit';
  if (mode === 'undrafted') return lensStep.test(id);
  if (mode === 'tournament-fails') return id === 'tournament/synthesize';
  if (mode === 'tournament-aborted') return proposer.test(id) && !id.includes('data-first');
  if (mode === 'repair-fails') return id === 'repair';
  return false;
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const step = (calls, id) => calls.filter((call) => call.call.stepId === id);
const only = (calls, id) => {
  const found = step(calls, id);
  assert.equal(found.length, 1, id);
  return found[0];
};

/** The written document is the returned spec byte for byte, behind an exclusive create. */
async function assertWritten(env, output) {
  const text = await readFile(join(env.cwd, out), 'utf8');
  assert.equal(text, `${output.spec}\n`);
  assert.equal(output.written.sha256, sha256(text));
  assert.equal(output.written.previousSha256, null);
}

/** The merged decision ledger, ranked load-bearing first, with D1's two lenses and options. */
const ledger = (settledBy) => [
  [
    'D1',
    'load-bearing',
    ['data-model', 'architecture'],
    ['Postgres table', 'Object store', 'Job queue payload'],
    settledBy,
  ],
  ['D2', 'moderate', ['api-contracts'], ['Cursor', 'Offset'], 'merger'],
  ['D3', 'reversible', ['operations'], ['StatsD', 'OpenTelemetry'], 'merger'],
];
const rows = (output) =>
  output.decisions.map((d) => [d.id, d.stakes, d.lenses, d.options, d.settledBy]);

export async function check({ result, env, calls, suspended }) {
  const { output } = result;
  assert.equal(output.status, 'repaired');
  assert.equal(suspended, 0);
  // Ground, five lenses, eight tournament calls, merge, two audits and one repair.
  assert.equal(calls.length, 18);
  assert.deepEqual(output.prd, {
    source: 'file',
    path: 'docs/prd.md',
    sha256: sha256(prd),
    bytes: Buffer.byteLength(prd),
  });
  const tracked = git(env.cwd, 'ls-files').split('\n').length;
  assert.deepEqual(output.codebase, { path: '.', files: tracked, listed: tracked });
  assert.deepEqual(output.grounding, grounding);
  assert.deepEqual(output.failedLenses, []);
  assert.equal(output.sections, 5);
  assert.deepEqual(rows(output), ledger('tournament'));
  assert.equal(output.decisions[0].decision, stateDecision);
  assert.deepEqual(output.tournament, {
    decision: 'D1',
    status: 'complete',
    winner: { title: 'Append-only export ledger', philosophy: 'data-first', avg: 36, tiedWith: [] },
    adopted: true,
    failure: null,
  });
  // Code read the PRD and listed the codebase: the grounder gets both, and every lens the map.
  const ground = only(calls, 'ground');
  assert.ok(ground.options.prompt.includes(prd.trim()));
  assert.match(ground.options.prompt, /^src\/export\.mjs$/mu);
  for (const lens of lenses) {
    const call = only(calls, `lenses/${lens}/draft`);
    assert.match(call.options.prompt, new RegExp(`^Your lens is ${lens}\\.$`, 'mu'));
    assert.ok(call.options.prompt.includes(grounding.summary));
  }
  // The child received the top decision as its brief and the grounding and PRD as its context.
  const proposals = calls.filter((call) => proposer.test(call.call.stepId));
  assert.equal(proposals.length, 4);
  for (const call of proposals) {
    assert.match(call.options.prompt, /load-bearing decision .*: Where export state lives$/mu);
    assert.match(call.options.prompt, /^- Job queue payload$/mu);
    assert.ok(call.options.prompt.includes(grounding.summary));
    assert.ok(call.options.prompt.includes('- A failed export can be retried.'));
  }
  // The merger adopts the tournament's design, with the record the child appended.
  const merge = only(calls, 'merge').options.prompt;
  assert.match(merge, /^<tournament decision="D1">$/mu);
  assert.ok(merge.includes(tournamentDesign));
  assert.match(merge, /^## Tournament record$/mu);
  assert.match(merge, /^- D2 \(moderate, raised by api-contracts\): Pagination/mu);
  // Implementability reads the spec alone; fidelity also gets the PRD.
  assert.doesNotMatch(only(calls, 'audits/implementability/audit').options.prompt, /<prd>/u);
  assert.match(only(calls, 'audits/fidelity/audit').options.prompt, /^<prd>$/mu);
  const repair = only(calls, 'repair').options.prompt;
  assert.ok(
    repair.includes(`- implementability, at API contracts: ${gap.problem} Fix: ${gap.fix}`),
  );
  assert.match(repair, /^Decision D1 was settled by an independent design tournament/mu);
  assert.deepEqual(
    output.verification.audits.map((a) => [a.audit, a.completed, a.gaps.length]),
    [
      ['implementability', true, 1],
      ['fidelity', true, 0],
    ],
  );
  assert.equal(output.verification.repair, 'applied');
  assert.match(output.spec, /^# Export spec, repaired$/mu);
  assert.deepEqual(output.openQuestions, [merged, added]);
  await assertWritten(env, output);
  assert.equal(git(env.cwd, 'status', '--porcelain', '--untracked-files=all'), `?? ${out}`);
  // Grounder, lenses, proposers and judges read; the merger, auditors, repairer and synthesizer
  // have no tools; nothing may edit.
  const readers = calls.filter((call) =>
    /^(?:ground|lenses\/|tournament\/(?:proposals|judges)\/)/u.test(call.call.stepId),
  );
  assert.equal(readers.length, 13);
  for (const call of readers) assert.deepEqual(call.options.tools, ['Read', 'Grep', 'Glob']);
  for (const call of calls.filter((c) => !readers.includes(c)))
    assert.deepEqual(call.options.tools, [], call.call.stepId);
}

export const kill = { step: '^write$', boundary: 'checkpoint', writeLocation: 'source-checkout' };

const inlinePrd = `${prd}\n- Exports are audited.\n`;

export const modes = [
  {
    // An inline PRD on a greenfield project: no grounding, no load-bearing decision (so no
    // tournament although one was requested), clean audits and nothing written.
    mode: 'greenfield-inline',
    input: () => ({ prd: inlinePrd, codebase: 'greenfield', decideArchitecture: true }),
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'verified');
      assert.equal(calls.length, 8);
      assert.equal(step(calls, 'ground').length, 0);
      assert.equal(calls.filter((call) => call.call.stepId.startsWith('tournament/')).length, 0);
      assert.equal(output.prd.source, 'text');
      assert.equal(output.prd.sha256, sha256(inlinePrd));
      assert.equal(output.codebase, null);
      assert.equal(output.grounding, null);
      assert.equal(output.tournament, null);
      assert.deepEqual(
        output.decisions.map((d) => [d.id, d.stakes, d.settledBy]),
        [
          ['D1', 'moderate', 'merger'],
          ['D2', 'moderate', 'merger'],
          ['D3', 'moderate', 'merger'],
        ],
      );
      assert.match(
        only(calls, 'lenses/data-model/draft').options.prompt,
        /^This is a greenfield project/mu,
      );
      assert.ok(only(calls, 'merge').options.prompt.includes('- Exports are audited.'));
      assert.equal(output.verification.repair, 'not-needed');
      // A sentence under Open questions is not a question.
      assert.deepEqual(output.openQuestions, []);
      assert.equal(output.written, null);
      assert.equal(git(env.cwd, 'status', '--porcelain', '--untracked-files=all'), '');
    },
  },
  {
    // A failed lens and a failed auditor are counted, not fatal; the surviving gap is repaired.
    mode: 'failed-members',
    input: () => ({ ...input(), decideArchitecture: false }),
    async check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(output.failedLenses, ['operations']);
      assert.equal(output.sections, 4);
      assert.deepEqual(rows(output), ledger('merger').slice(0, 2));
      assert.equal(output.tournament, null);
      assert.deepEqual(
        output.verification.audits.map((a) => [a.audit, a.completed, a.gaps.length]),
        [
          ['implementability', true, 1],
          ['fidelity', false, 0],
        ],
      );
      assert.equal(output.verification.repair, 'applied');
      assert.doesNotMatch(only(calls, 'merge').options.prompt, /<draft lens="operations">/u);
      await assertWritten(env, output);
    },
  },
  {
    // A failed child is a settled frame: the merger decides D1 itself and the run is degraded.
    mode: 'tournament-fails',
    async check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.equal(output.tournament.status, 'failed');
      assert.equal(output.tournament.adopted, false);
      assert.match(output.tournament.failure, /fixture/u);
      assert.deepEqual(rows(output), ledger('merger'));
      assert.doesNotMatch(only(calls, 'merge').options.prompt, /<tournament/u);
      assert.doesNotMatch(only(calls, 'repair').options.prompt, /^Decision D1 was settled/mu);
      assert.equal(result.children.tournament.status, 'failed');
      await assertWritten(env, output);
    },
  },
  {
    // A child that completes without a winner (one proposal survives) adopts nothing.
    mode: 'tournament-aborted',
    async check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(output.tournament, {
        decision: 'D1',
        status: 'aborted',
        winner: null,
        adopted: false,
        failure: null,
      });
      assert.equal(calls.filter((call) => judge.test(call.call.stepId)).length, 0);
      assert.equal(output.decisions[0].settledBy, 'merger');
      assert.doesNotMatch(only(calls, 'merge').options.prompt, /<tournament/u);
      await assertWritten(env, output);
    },
  },
  {
    // A failed repair keeps the merged spec, and the status says so.
    mode: 'repair-fails',
    async check({ result, env }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.equal(output.verification.repair, 'failed');
      assert.match(output.spec, /^# Export spec$/mu);
      assert.deepEqual(output.openQuestions, [merged]);
      await assertWritten(env, output);
    },
  },
  {
    // The schema refuses a merged spec without the Operations heading; the retry is accepted.
    mode: 'merge-retry',
    input: () => ({ ...input(), decideArchitecture: false }),
    check({ result, calls }) {
      const { output } = result;
      assert.equal(output.status, 'repaired');
      assert.deepEqual(
        step(calls, 'merge').map((call) => call.call.attempt),
        [1, 2],
      );
      assert.match(output.spec, /^## Operations$/mu);
    },
  },
  {
    // Every lens failed: nothing is merged, audited or written.
    mode: 'undrafted',
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'undrafted');
      assert.deepEqual(output.failedLenses, lenses);
      assert.equal(output.spec, null);
      assert.equal(calls.filter((call) => !lensStep.test(call.call.stepId)).length, 1);
      assert.equal(existsSync(join(env.cwd, out)), false);
    },
  },
  {
    // An existing out refuses the run before any agent call.
    mode: 'out-exists',
    input: () => ({ ...input(), out: 'README.md' }),
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'refused');
      assert.equal(calls.length, 0);
      assert.equal(output.prd.path, 'docs/prd.md');
      assert.equal(output.spec, null);
      assert.equal(git(env.cwd, 'status', '--porcelain', '--untracked-files=all'), '');
    },
  },
  {
    // Under requireGrants with no grant, the child's Claude and Codex entries delegate onto the
    // Reader and CodexReader ceilings; a cross-harness panel seats a Codex judge, and the spec is
    // published as a managed commit.
    mode: 'require-grants-commit',
    input: () => ({ ...input(), judges: 2, crossHarness: true, publication: 'commit' }),
    options: (opts) => ({ ...opts, requireGrants: true, grants: [] }),
    async check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'repaired');
      assert.deepEqual(
        calls
          .filter((call) => judge.test(call.call.stepId))
          .map((call) => [call.call.stepId, call.harness, call.options.sandbox ?? null])
          .sort(([a], [b]) => a.localeCompare(b)),
        [
          ['tournament/judges/0/score', 'claude', null],
          ['tournament/judges/1/score', 'codex', 'read-only'],
        ],
      );
      await assertWritten(env, output);
      assert.equal(git(env.cwd, 'status', '--porcelain', '--untracked-files=all'), '');
      assert.equal(git(env.cwd, 'log', '-1', '--format=', '--name-only'), out);
    },
  },
];

/** A run that merged nothing has no spec, whatever else it reports. */
export const degraded = (output) => output.status === 'undrafted';
