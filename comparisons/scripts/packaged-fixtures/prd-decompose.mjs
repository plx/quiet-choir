// prd-decompose: docs/prd.md commits five requirements. Four lenses each anchor one item (the
// stories lens through an ellipsis and different case), the instrumentation lens misses the launch
// metric, the merger orders four tickets and code carries the items' anchors onto them. The first
// audit reports the metric missing and the retry ticket under-specified, the repair adds T5,
// retitles and amends the retry ticket and revises the sequencing, and the second audit passes;
// code writes docs/backlog.md.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commitAll, enumOf, git, leaf, writeFiles } from './_support.mjs';

const prd = [
  '# CSV export',
  '',
  '## Goals',
  '',
  'Users can export any report as a CSV file.',
  'Export success rate is tracked as the launch metric.',
  '',
  '## Requirements',
  '',
  '- Exports of up to 10,000 rows finish within 5 seconds.',
  '- A failed export shows a retry button.',
  '- Exports run through the existing jobs queue.',
  '',
].join('\n');
const metric = 'Export success rate is tracked as the launch metric.';
const retry = 'A failed export shows a retry button.';

/** One anchored item per lens; instrumentation misses the metric, as a lens can. */
const readings = {
  stories: {
    title: 'Export a report as CSV',
    prdAnchor: 'users can export ... CSV file',
    estimate: 'M',
  },
  edges: { title: 'Retry a failed export', prdAnchor: retry, estimate: 'S' },
  'non-functional': {
    title: 'Export within five seconds',
    prdAnchor: 'Exports of up to 10,000 rows finish within 5 seconds.',
    estimate: 'M',
  },
  foundations: {
    title: 'Run exports on the jobs queue',
    prdAnchor: 'Exports run through the existing jobs queue.',
    estimate: 'XL',
  },
};
const question = 'Does the five-second target include the download?';
const resequenced =
  'Milestone one lands the queue and the export; milestone two hardens and measures it.';
// The merger lists foundations first, then the story, then what builds on the story.
const order = ['foundations', 'stories', 'edges', 'non-functional'];
const lanes = {
  foundations: 'infra-migration',
  stories: 'feature',
  edges: 'edge-cases',
  'non-functional': 'non-functional',
};

const lensOf = (prompt) => /^Your lens is ([a-z-]+)\.$/mu.exec(prompt)?.[1];
const ticketIds = (prompt) =>
  Object.fromEntries(
    [...prompt.matchAll(/^(T\d+): (.+) \[/gmu)].map((match) => [match[2], match[1]]),
  );

export async function setup(env) {
  await writeFiles(env.cwd, {
    'docs/prd.md': prd,
    'src/export.mjs': 'export const exportCsv = () => "";\n',
  });
  commitAll(env.cwd, 'add the CSV export PRD');
}

export const input = () => ({ prd: 'docs/prd.md', codebase: '.', out: 'docs/backlog.md' });

function lensReply(prompt, mode) {
  const lens = lensOf(prompt);
  if (mode === 'empty' || mode === 'lens-fails-empty')
    return {
      items: [
        {
          title: `Invented ${lens} work`,
          description: 'Not in the PRD',
          prdAnchor: 'Users can import spreadsheets.',
          acceptanceCriteria: [],
          estimate: 'S',
        },
      ],
      openQuestions: [lens === 'edges' ? 'IS THERE A PRD?' : 'Is there a PRD?'],
    };
  const reading = readings[lens];
  return {
    items: reading
      ? [
          {
            ...reading,
            description: `${reading.title} as the PRD asks.`,
            acceptanceCriteria: [`${reading.title} is demonstrable`],
          },
        ]
      : [],
    openQuestions: lens === 'non-functional' ? [question] : [],
  };
}

function mergeReply(request) {
  const sources = enumOf(request.outputSchema, 'tickets', 'items', 'sources', 'items');
  const ids = {};
  const tickets = order.flatMap((lens) => {
    const source = sources.find((id) => id.startsWith(`${lens}-`));
    if (!source) return [];
    const id = `T${Object.keys(ids).length + 1}`;
    ids[lens] = id;
    const parent = lens === 'stories' ? ids.foundations : ids.stories;
    return [
      {
        id,
        title: readings[lens].title,
        description: `${readings[lens].title} as the PRD asks.`,
        acceptanceCriteria: [`${readings[lens].title} is demonstrable`],
        // The merger splits the XL foundation down to L.
        estimate: readings[lens].estimate === 'XL' ? 'L' : readings[lens].estimate,
        lane: lanes[lens],
        dependsOn: lens === 'foundations' || !parent ? [] : [parent],
        sources: [source],
      },
    ];
  });
  return {
    tickets,
    sequencing: 'Milestone one lands the queue and the export; milestone two hardens it.',
    openQuestions: request.options.prompt.includes(question) ? [question] : [],
  };
}

function auditReply(request, mode) {
  if (leaf(request.call.stepId) !== '0' || mode === 'lens-fails') return { gaps: [] };
  const retryTicket = ticketIds(request.options.prompt)['Retry a failed export'];
  return {
    gaps: [
      {
        prdRequirement: metric,
        problem: 'missing',
        ticket: null,
        suggestion: 'Track an export-success event on a dashboard',
      },
      ...(retryTicket
        ? [
            {
              prdRequirement: retry,
              problem: 'under-specified',
              ticket: retryTicket,
              suggestion: 'Say what the retry repeats',
            },
          ]
        : []),
    ],
  };
}

function repairReply(prompt, mode) {
  const next = /Number new tickets from (T\d+) on/u.exec(prompt)[1];
  // A misquoting repairer paraphrases the PRD, which the patch schema refuses on both attempts.
  const quote = (text) => (mode === 'repair-misquotes' ? `${text.slice(0, -1)} soon.` : text);
  const stories = ticketIds(prompt)['Export a report as CSV'];
  const amend = [...prompt.matchAll(/^- under-specified \((T\d+)\)/gmu)].map((match) => match[1]);
  return {
    added: [
      {
        id: next,
        title: 'Track export success rate',
        description: 'Emit an export-success event and chart the rate.',
        acceptanceCriteria: ['The dashboard shows the daily export success rate'],
        estimate: 'S',
        lane: 'instrumentation',
        dependsOn: stories ? [stories] : [],
        prdAnchors: [quote(metric)],
      },
    ],
    amended: amend.map((id) => ({
      id,
      title: 'Retry a failed export job',
      description: 'Retry the same export job after a failure.',
      acceptanceCriteria: ['The retry button resubmits the failed job', 'A second failure says so'],
      estimate: 'S',
      prdAnchors: [quote(retry)],
    })),
    sequencing: resequenced,
  };
}

export function reply(request, env, mode) {
  const id = request.call.stepId;
  if (/^lenses\/\d+\/read$/u.test(id)) return lensReply(request.options.prompt, mode);
  if (id === 'merge') return mergeReply(request);
  if (/^audit\/\d+$/u.test(id)) return auditReply(request, mode);
  if (/^repair\/\d+$/u.test(id)) return repairReply(request.options.prompt, mode);
  throw new Error(`Unhandled prd-decompose step ${id} (${mode})`);
}

export function fail(request, mode) {
  const id = request.call.stepId;
  const lens = /^lenses\/\d+\/read$/u.test(id) ? lensOf(request.options.prompt) : null;
  return (
    (lens !== null && mode === 'unread') ||
    (lens === 'edges' && (mode === 'lens-fails' || mode === 'lens-fails-empty')) ||
    (mode === 'critic-fails' && id === 'audit/0') ||
    (mode === 'merge-fails' && id === 'merge')
  );
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const steps = (calls) => calls.map((call) => call.call.stepId);

export async function check({ result, env, calls }) {
  const { output } = result;
  assert.equal(output.status, 'covered');
  assert.deepEqual(output.prd, {
    source: 'file',
    path: 'docs/prd.md',
    sha256: sha256(prd),
    bytes: Buffer.byteLength(prd),
  });
  const tracked = git(env.cwd, 'ls-files').split('\n').length;
  assert.deepEqual(output.codebase, { path: '.', files: tracked, listed: tracked });
  assert.deepEqual(steps(calls).slice(5), ['merge', 'audit/0', 'repair/0', 'audit/1']);
  // Code hands every lens the PRD and the tracked files; no role has a tool.
  for (const call of calls.slice(0, 5)) {
    assert.ok(call.options.prompt.includes('<files>\n.gitignore\nREADME.md\ndocs/prd.md\n'));
    assert.ok(call.options.prompt.includes(retry));
  }
  assert.ok(calls.every((call) => (call.options.tools ?? []).length === 0));
  assert.deepEqual(output.failedLenses, []);
  assert.deepEqual(output.unanchored, []);
  assert.deepEqual(output.unmerged, []);
  assert.deepEqual(
    output.tickets.map((t) => [t.id, t.lane, t.estimate, t.dependsOn, t.sources]),
    [
      ['T1', 'infra-migration', 'L', [], ['foundations-4']],
      ['T2', 'feature', 'M', ['T1'], ['stories-1']],
      ['T3', 'edge-cases', 'S', ['T2'], ['edges-2']],
      ['T4', 'non-functional', 'M', ['T2'], ['non-functional-3']],
      ['T5', 'instrumentation', 'S', ['T2'], []],
    ],
  );
  // Merged tickets carry their source items' anchors verbatim; the repair's quotes were checked.
  assert.deepEqual(
    output.tickets.map((t) => t.prdAnchors),
    [
      ['Exports run through the existing jobs queue.'],
      ['users can export ... CSV file'],
      [retry],
      ['Exports of up to 10,000 rows finish within 5 seconds.'],
      [metric],
    ],
  );
  // The repair replaced only the retry ticket's text; every other ticket is the merger's.
  assert.equal(output.tickets[2].title, 'Retry a failed export job');
  assert.equal(output.tickets[2].lane, 'edge-cases');
  assert.equal(output.tickets[2].acceptanceCriteria.length, 2);
  assert.deepEqual(output.tickets[3].acceptanceCriteria, [
    'Export within five seconds is demonstrable',
  ]);
  assert.equal(output.sequencing, resequenced);
  const repair = calls.find((call) => call.call.stepId === 'repair/0').options.prompt;
  assert.ok(repair.includes(`<prd>\n${prd}\n</prd>`));
  assert.ok(
    repair.includes('The current sequencing: Milestone one lands the queue and the export;'),
  );
  assert.deepEqual(output.waves, [['T1'], ['T2'], ['T3', 'T4', 'T5']]);
  assert.deepEqual(output.criticalPath, { tickets: ['T1', 'T2', 'T4'], days: 10 });
  assert.equal(output.coverage.audits, 2);
  assert.equal(output.coverage.repairs, 1);
  assert.equal(output.coverage.covered, true);
  assert.deepEqual(output.coverage.gaps, []);
  assert.deepEqual(
    output.coverage.repaired.map((gap) => [gap.problem, gap.ticket]),
    [
      ['missing', null],
      ['under-specified', 'T3'],
    ],
  );
  assert.deepEqual(output.openQuestions, [question]);
  // The second audit read the repaired backlog.
  const reaudit = calls.find((call) => call.call.stepId === 'audit/1');
  assert.ok(
    reaudit.options.prompt.includes('T5: Track export success rate [instrumentation, S, after T2]'),
  );
  assert.ok(reaudit.options.prompt.includes('- The retry button resubmits the failed job'));
  const document = await readFile(join(env.cwd, 'docs/backlog.md'), 'utf8');
  assert.equal(output.written.path, join(env.cwd, 'docs/backlog.md'));
  assert.equal(output.written.sha256, sha256(document));
  assert.equal(output.written.previousSha256, null);
  assert.ok(document.includes('| T5 | Track export success rate | instrumentation | S | T2 |\n'));
  assert.ok(document.includes('Critical path: T1 -> T2 -> T4 (10 days by estimate).'));
  assert.ok(document.includes(`## T3: Retry a failed export job\n`));
  assert.ok(document.includes(`\n${resequenced}\n`));
  assert.ok(document.includes('status: covered.'));
  assert.equal(git(env.cwd, 'status', '--porcelain'), '?? docs/backlog.md');
}

export const kill = { step: '^write$', boundary: 'checkpoint', writeLocation: 'source-checkout' };

/** The lenses are a settled fan-out, so F1 and F2 fail the merge, the first call that throws. */
export const faults = { F1: '^merge$', F2: '^merge$' };

export const modes = [
  {
    mode: 'lens-fails',
    check: async ({ result, env, calls }) => {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(output.failedLenses, ['edges']);
      assert.equal(output.coverage.covered, true);
      assert.deepEqual(
        output.tickets.map((t) => [t.id, t.title]),
        [
          ['T1', 'Run exports on the jobs queue'],
          ['T2', 'Export a report as CSV'],
          ['T3', 'Export within five seconds'],
        ],
      );
      assert.equal(calls.filter((call) => call.call.stepId === 'merge').length, 1);
      const document = await readFile(join(env.cwd, 'docs/backlog.md'), 'utf8');
      assert.ok(document.includes('status: degraded.'));
      assert.ok(document.includes('Failed lenses: edges.'));
    },
  },
  {
    mode: 'gaps-remain',
    input: () => ({ prd: 'docs/prd.md', maxRepairs: 0 }),
    check: ({ result, env, calls }) => {
      const { output } = result;
      assert.equal(output.status, 'gaps-remain');
      assert.equal(output.codebase, null);
      assert.ok(calls.every((call) => !call.options.prompt.includes('<files>')));
      assert.deepEqual(steps(calls).slice(5), ['merge', 'audit/0']);
      assert.deepEqual(
        output.coverage.gaps.map((gap) => [gap.problem, gap.ticket]),
        [
          ['missing', null],
          ['under-specified', 'T3'],
        ],
      );
      assert.equal(output.coverage.repairs, 0);
      assert.equal(output.tickets.length, 4);
      assert.equal(output.written, null);
      assert.equal(existsSync(join(env.cwd, 'docs/backlog.md')), false);
      assert.equal(git(env.cwd, 'status', '--porcelain'), '');
    },
  },
  {
    mode: 'empty',
    // Inline PRD text spans lines; every lens quotes text the PRD does not contain.
    input: () => ({ prd, out: 'docs/backlog.md' }),
    check: ({ result, env, calls }) => {
      const { output } = result;
      assert.equal(output.status, 'empty');
      assert.deepEqual(output.prd, {
        source: 'text',
        path: null,
        sha256: sha256(prd),
        bytes: Buffer.byteLength(prd),
      });
      assert.equal(output.unanchored.length, 5);
      assert.deepEqual(output.openQuestions, ['Is there a PRD?']);
      assert.deepEqual(output.tickets, []);
      assert.equal(output.coverage, null);
      assert.equal(calls.length, 5);
      assert.equal(output.written, null);
      assert.equal(existsSync(join(env.cwd, 'docs/backlog.md')), false);
    },
  },
  {
    mode: 'critic-fails',
    input: () => ({
      prd: 'docs/prd.md',
      codebase: '.',
      maxCodebaseFiles: 1,
      out: 'docs/backlog.md',
      publication: 'commit',
    }),
    check: async ({ result, env, calls }) => {
      const { output } = result;
      assert.equal(output.status, 'unaudited');
      // The listing cap is reported, and the prompt says how many files it leaves out. The tree
      // before the managed commit is the one the lenses saw.
      const tracked = git(env.cwd, 'ls-tree', '-r', '--name-only', 'HEAD^').split('\n').length;
      assert.deepEqual(output.codebase, { path: '.', files: tracked, listed: 1 });
      assert.equal(degraded(output), true);
      assert.ok(
        calls[0].options.prompt.includes(
          `the first 1 (${String(tracked - 1)} more are not listed):\n\n<files>\n.gitignore\n</files>`,
        ),
      );
      assert.deepEqual(output.coverage.failure.stage, 'audit');
      assert.equal(output.coverage.audits, 0);
      assert.equal(output.coverage.covered, false);
      assert.equal(
        calls.some((call) => call.call.stepId.startsWith('repair/')),
        false,
      );
      // A managed commit publishes the document, so the checkout stays clean.
      assert.equal(git(env.cwd, 'status', '--porcelain'), '');
      assert.equal(git(env.cwd, 'log', '-1', '--name-only', '--format='), 'docs/backlog.md');
      const document = await readFile(join(env.cwd, 'docs/backlog.md'), 'utf8');
      assert.equal(output.written.sha256, sha256(document));
      assert.ok(document.includes('the final backlog did not pass a coverage audit.'));
      assert.ok(
        document.includes('The coverage audit failed, so no audit read the final backlog.'),
      );
    },
  },
  {
    mode: 'unread',
    // Every lens fails: a completed run must not pass this off as a PRD with nothing to build.
    check: ({ result, env, calls }) => {
      const { output } = result;
      assert.equal(output.status, 'unread');
      assert.deepEqual(output.failedLenses, [
        'stories',
        'edges',
        'non-functional',
        'foundations',
        'instrumentation',
      ]);
      assert.equal(calls.length, 5);
      assert.deepEqual([output.tickets, output.coverage, output.written], [[], null, null]);
      assert.equal(existsSync(join(env.cwd, 'docs/backlog.md')), false);
    },
  },
  {
    mode: 'lens-fails-empty',
    // One lens fails and the rest anchor nothing: degraded, not empty, and nothing is merged.
    check: ({ result, env, calls }) => {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(output.failedLenses, ['edges']);
      assert.equal(output.unanchored.length, 4);
      assert.deepEqual(output.openQuestions, ['Is there a PRD?']);
      assert.equal(calls.length, 5);
      assert.deepEqual([output.tickets, output.written], [[], null]);
      assert.equal(existsSync(join(env.cwd, 'docs/backlog.md')), false);
    },
  },
  {
    mode: 'repair-misquotes',
    // Both repair attempts paraphrase the PRD; the patch schema refuses them and nothing applies.
    check: async ({ result, env, calls }) => {
      const { output } = result;
      assert.equal(output.status, 'gaps-remain');
      assert.deepEqual(steps(calls).slice(5), ['merge', 'audit/0', 'repair/0', 'repair/0']);
      assert.equal(output.coverage.failure.stage, 'repair');
      assert.match(
        output.coverage.failure.message,
        /T5: the PRD anchor \\?"Export success rate is tracked as the launch metric soon\.\\?" is not in the PRD/u,
      );
      assert.deepEqual([output.coverage.audits, output.coverage.repairs], [1, 0]);
      assert.equal(output.coverage.gaps.length, 2);
      assert.equal(output.tickets.length, 4);
      assert.equal(output.tickets[2].title, 'Retry a failed export');
      const document = await readFile(join(env.cwd, 'docs/backlog.md'), 'utf8');
      assert.equal(output.written.sha256, sha256(document));
      assert.ok(document.includes('status: gaps-remain.'));
      assert.ok(document.includes('The repair failed, so the gaps below remain.'));
      assert.ok(document.includes(`- missing: "${metric}"`));
    },
  },
  {
    mode: 'out-exists',
    // Exclusive creation refuses to replace README.md after every agent step completed.
    input: () => ({ prd: 'docs/prd.md', out: 'README.md' }),
    rejects: /Step write \(write-file\) failed: File ifMatch failed/u,
    check: ({ record, env }) => {
      assert.equal(record.status, 'failed');
      assert.equal(record.steps['audit/1'].status, 'completed');
      assert.equal(record.steps.write.status, 'failed');
      assert.equal(
        readFileSync(join(env.cwd, 'README.md'), 'utf8'),
        git(env.cwd, 'show', 'HEAD:README.md') + '\n',
      );
      assert.equal(git(env.cwd, 'status', '--porcelain'), '');
    },
  },
  {
    mode: 'prose-codebase',
    // A prose hint is a valid path shape, but Git lists nothing under it: refused before any call.
    input: () => ({ prd: 'docs/prd.md', codebase: 'the Next.js app' }),
    rejects: /The codebase "the Next\.js app" has no tracked files/u,
    check: ({ record, calls }) => {
      assert.equal(record.status, 'failed');
      assert.equal(calls.length, 0);
    },
  },
  {
    mode: 'merge-fails',
    // Unlike upstream's empty 'Merge failed' backlog, a failed merge fails the run; resume retries.
    rejects: /Step merge \(claude\) failed/u,
    check: ({ record, env, calls }) => {
      assert.equal(record.status, 'failed');
      assert.equal(record.steps.merge.status, 'failed');
      assert.deepEqual(steps(calls).slice(5), ['merge']);
      assert.equal(existsSync(join(env.cwd, 'docs/backlog.md')), false);
    },
    // Once the merger answers, the resume pays the merge and what follows it, never a lens again.
    repair: { mode: 'normal', paid: ['merge', 'audit/0', 'repair/0', 'audit/1'] },
    resumeCheck: async ({ result, env }) => {
      const { output } = result;
      assert.equal(output.status, 'covered');
      const document = await readFile(join(env.cwd, 'docs/backlog.md'), 'utf8');
      assert.equal(output.written.sha256, sha256(document));
      assert.equal(output.written.previousSha256, null);
    },
  },
];

/** Unanchored or unmerged items and a truncated listing lose coverage the status does not show. */
export const degraded = (output) =>
  output.unanchored.length > 0 ||
  output.unmerged.length > 0 ||
  (output.codebase !== null && output.codebase.listed < output.codebase.files);
