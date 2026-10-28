// requirements-to-prd: notes/kickoff.md and notes/tickets.md hold the raw material. The lenses
// quote it (one quote the material does not hold, so code keeps that finding only as inferred),
// the writer drafts without the assumption that finding needs, so code adds it, three critics
// raise a blocking, a major and a minor issue, and the writer revises. One question round asks the
// two open questions; the answer redoes the PRD under round/1, where findings quote the answers,
// and code writes docs/prd.md. docs/previous-prd.md stands for a previous run's PRD, which only
// a matching replace digest may redo, and notes/blank.md holds nothing to read.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commitAll, git, writeFiles } from './_support.mjs';

const kickoff = [
  '# Reminders kickoff',
  '',
  'Customers want overdue invoices to trigger reminder emails automatically.',
  'Finance wants to cut days sales outstanding by 10% this year.',
  'Reminders go out weekly until the invoice is paid.',
  '',
].join('\n');
const tickets = [
  '# Support tickets',
  '',
  '- #101: Please send reminders daily; weekly is too slow.',
  "- #102: Reminders must respect the customer's time zone.",
  '',
].join('\n');
const previous = '# Reminders PRD, first draft\n\nWeekly or daily is still open.\n';
const blank = '\n   \n\t\n';
const ownerAnswer = 'Reminders go out daily. The current DSO is 45 days.';
const product = 'B2B invoicing SaaS, 200 customers';

const lenses = ['user-needs', 'business', 'constraints', 'unknowns'];
const charters = ['ambiguity', 'scope', 'feasibility'];
const point = {
  overdue: 'Overdue invoices trigger reminder emails automatically',
  pause: 'Customers can pause reminders while an invoice is disputed',
  daily: 'Reminders go out daily',
  dso: 'Cut days sales outstanding by 10% this year',
  baseline: 'The DSO baseline is 45 days',
  zone: "Reminders respect the customer's time zone",
  email: 'Email is the only reminder channel at launch',
  reversed: 'Reminders follow the time zone',
  word: 'Reminders exist',
};
const cadence = {
  question: 'Should reminders go out weekly or daily?',
  consequences: 'Sets the scheduler cadence and the email volume.',
};
const baseline = {
  question: 'What is the current DSO baseline?',
  consequences: 'Without it the 10% goal cannot be measured.',
};
const howMany = {
  question: 'How many reminders does one invoice get?',
  consequences: 'Decides when reminders stop.',
};
const tiers = {
  question: 'Which plan tiers get reminders?',
  consequences: 'Decides who sees the feature at launch.',
};
// Enough open questions, at the schema's cap of 40, to overflow a question's details.
const many = Array.from({ length: 38 }, (_, index) => ({
  question: `Which escalation applies to dunning case ${String(index + 1)}? ${'Context '.repeat(55).trim()}`,
  consequences: 'Decides that case.',
}));

export async function setup(env) {
  await writeFiles(env.cwd, {
    'notes/kickoff.md': kickoff,
    'notes/tickets.md': tickets,
    'notes/blank.md': blank,
    'docs/previous-prd.md': previous,
  });
  commitAll(env.cwd, 'add the reminders material');
}

export const input = () => ({
  input: ['notes/kickoff.md', 'notes/tickets.md'],
  product,
  questionRounds: 1,
  out: 'docs/prd.md',
});

const finding = (text, quote, confidence = 'stated') => ({ point: text, quote, confidence });

function extraction(lens, prompt, mode) {
  const answered = prompt.includes('<answers>');
  if (mode === 'empty')
    return {
      findings: [],
      unknowns: lens === 'unknowns' ? ['Is this requirements material at all?'] : [],
      conflicts: [],
    };
  if (lens === 'user-needs')
    return {
      findings: [
        finding(
          point.overdue,
          'Customers want overdue invoices to trigger reminder emails automatically.',
        ),
        // The material never says this: code keeps it only as inferred.
        finding(point.pause, 'Customers can pause reminders during a dispute.', 'implied'),
        ...(answered ? [finding(point.daily, 'Reminders go out daily.')] : []),
      ],
      unknowns: [tiers.question],
      conflicts: [],
    };
  if (lens === 'business')
    return {
      // Different case and an ellipsis still anchor.
      findings: [
        finding(point.dso, 'CUT days sales outstanding ... this year'),
        ...(answered && prompt.includes('DSO is 45')
          ? [finding(point.baseline, 'The current DSO is 45 days.')]
          : []),
      ],
      unknowns: ['which plan tiers get reminders?'],
      conflicts: [],
    };
  if (lens === 'constraints')
    return {
      findings: [
        finding(point.zone, 'Reminders must respect the customer’s time zone.'),
        finding(point.email, null, 'inferred'),
        // Parts out of order, and a single word, anchor nothing: code keeps both only as inferred.
        ...(mode === 'critic-fails'
          ? [
              finding(point.reversed, 'time zone ... Reminders must respect'),
              finding(point.word, 'Reminders'),
            ]
          : []),
      ],
      unknowns: [],
      conflicts: [],
    };
  return {
    findings: [],
    unknowns: [howMany.question],
    conflicts: answered ? [] : ['The kickoff says weekly reminders; ticket #101 asks for daily'],
  };
}

/** The finding ids, by point, that the Draft prompt and the PRD's traceability appendix list. */
const idsOf = (prompt) =>
  Object.fromEntries(
    [...prompt.matchAll(/^- (F\d+) \[[^\]]+\]: (.+?)(?: \(".*"\))?$/gmu)].map((m) => [m[2], m[1]]),
  );

function prd(ids, { revised, answered, mode }) {
  const cite = (...keys) => keys.flatMap((key) => (ids[point[key]] ? [ids[point[key]]] : []));
  // A requirement traces to at least one finding: when a failed lens took its own (a mode, or F1
  // landing on any lens), it cites the first finding there is.
  const trace = (...keys) => {
    const found = cite(...keys);
    return found.length ? found : [Object.values(ids)[0]];
  };
  const open = answered
    ? [howMany]
    : revised
      ? mode === 'left-open'
        ? [tiers, baseline, ...many]
        : [cadence, baseline]
      : [cadence];
  return {
    title: 'Automatic invoice reminders',
    problem: 'Overdue invoices wait on manual follow-up, which slows collection.',
    goals: [{ goal: point.dso, metric: answered ? 'DSO falls from 45 to 40.5 days' : null }],
    users: [{ user: 'Finance admin', job: 'Collect overdue payments without chasing customers' }],
    requirements: [
      {
        priority: 'must',
        text: answered
          ? 'Send a reminder email every day once an invoice is past due.'
          : revised
            ? "Send a reminder email one day after an invoice's due date passes."
            : 'Send a reminder email when an invoice becomes overdue.',
        findings: trace('overdue', ...(answered ? ['daily'] : [])),
      },
      // Relies on the inferred pause finding without an assumption: code adds it.
      {
        priority: 'should',
        text: 'Let a customer pause reminders while an invoice is disputed.',
        findings: trace('pause'),
      },
    ],
    nonFunctional: [
      {
        text: "Send reminders in the customer's time zone, by email only.",
        findings: trace('zone', 'email'),
      },
    ],
    outOfScope: ['SMS reminders'],
    openQuestions: open,
    assumptions: [
      { text: 'Email is the only reminder channel at launch.', findings: cite('email') },
      ...(revised ? [{ text: 'Overdue means one day past the due date.', findings: [] }] : []),
    ],
  };
}

const critiques = {
  ambiguity: {
    problem: '"becomes overdue" does not say when an invoice is overdue',
    severity: 'blocking',
    fix: 'Say overdue means one day past the due date.',
  },
  scope: {
    problem: '"pause reminders while an invoice is disputed" is a second feature',
    severity: 'minor',
    fix: 'Cut pausing to a later phase.',
  },
  feasibility: {
    problem: '"Cut days sales outstanding by 10%" has no baseline',
    severity: 'major',
    fix: 'Ask finance for the current DSO.',
  },
};

export function reply(request, env, mode) {
  const id = request.call.stepId;
  const prompt = request.options.prompt;
  const answered = id.startsWith('round/');
  const local = answered ? id.split('/').slice(2).join('/') : id;
  const extract = /^extract\/(\d+)\/read$/u.exec(local);
  if (extract) return extraction(lenses[Number(extract[1])], prompt, mode);
  if (local === 'draft') return prd(idsOf(prompt), { revised: false, answered, mode });
  const attack = /^attack\/(\d+)\/critique$/u.exec(local);
  if (attack) return { issues: [critiques[charters[Number(attack[1])]]] };
  if (local === 'revise') return prd(idsOf(prompt), { revised: true, answered, mode });
  throw new Error(`Unhandled requirements-to-prd step ${id} (${mode})`);
}

export function fail(request, mode) {
  const id = request.call.stepId;
  return (
    (mode === 'critic-fails' && id === 'attack/1/critique') ||
    (mode === 'critics-fail' && /^attack\/\d+\/critique$/u.test(id)) ||
    (mode === 'lens-fails' && (id === 'extract/0/read' || id === 'round/1/extract/2/read')) ||
    (mode === 'reviser-fails' && id === 'revise')
  );
}

/** The question round's answer: the fixture's answers, unless only the plan tiers are open. */
export function answer(question) {
  if (!/^questions\/\d+$/u.test(question.stepId)) return undefined;
  const open = question.subject.questions.map((q) => q.question);
  return { answers: open.includes(tiers.question) ? '' : ownerAnswer };
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const steps = (calls) => calls.map((call) => call.call.stepId);
const round = (prefix) => [
  ...lenses.map((_, index) => `${prefix}extract/${index}/read`),
  `${prefix}draft`,
  ...charters.map((_, index) => `${prefix}attack/${index}/critique`),
  `${prefix}revise`,
];

const listed = (questions) =>
  questions
    .map((q, index) => `${String(index + 1)}. ${q.question} Consequences: ${q.consequences}`)
    .join('\n');
const reRun =
  'Re-run with answers and replace set to written.sha256, or set questionRounds, to resolve the open questions.';
const clean = { status: 'complete', failedLenses: [], failedCritics: [] };

export async function check({ result, env, calls, record, suspended }) {
  const { output } = result;
  assert.equal(output.status, 'complete');
  assert.deepEqual(output.material, [
    {
      source: 'file',
      path: 'notes/kickoff.md',
      sha256: sha256(kickoff),
      bytes: Buffer.byteLength(kickoff),
    },
    {
      source: 'file',
      path: 'notes/tickets.md',
      sha256: sha256(tickets),
      bytes: Buffer.byteLength(tickets),
    },
  ]);
  assert.deepEqual([...steps(calls)].sort(), [...round(''), ...round('round/1/')].sort());
  assert.ok(calls.every((call) => (call.options.tools ?? []).length === 0));
  assert.equal(suspended, 1);
  assert.deepEqual(output.asked, [{ round: 1, questions: 2, answered: true, ...clean }]);
  assert.equal(output.rounds, 2);
  assert.deepEqual(output.answers, [ownerAnswer]);
  // The durable question: a short title, a one-line prompt, the revised questions in full as its
  // subject and numbered with their consequences as its details.
  const asked = record.steps['questions/1'].question.request;
  assert.equal(asked.title, 'Questions');
  assert.equal(
    asked.prompt,
    'Answer the PRD open questions in one text to redo the PRD with them, or answer empty text to keep them open.',
  );
  assert.deepEqual(asked.subject, { round: 1, questions: [cadence, baseline] });
  assert.equal(asked.details, listed([cadence, baseline]));
  // Code checked out before reading the material: docs/prd.md did not exist, which a settled read
  // records as its failure.
  assert.equal(record.steps.existing.status, 'settled-failed');
  // Code read both files once; every lens of both rounds saw both, and the product context.
  for (const call of calls.filter((c) => /extract\/\d+\/read$/u.test(c.call.stepId))) {
    assert.ok(
      call.options.prompt.includes(
        `<material source="notes/kickoff.md">\n${kickoff.trim()}\n</material>`,
      ),
    );
    assert.ok(call.options.prompt.includes('<material source="notes/tickets.md">'));
    assert.ok(call.options.prompt.includes(`Product context: ${product}`));
    assert.equal(
      call.options.prompt.includes(`<answers>\n${ownerAnswer}\n</answers>`),
      call.call.stepId.startsWith('round/1/'),
    );
  }
  // The final round's findings: code assigned ids, attributed each quote and kept the
  // unquotable "implied" finding only as inferred.
  assert.deepEqual(
    output.findings.map((f) => [f.id, f.lens, f.claimed, f.confidence, f.source]),
    [
      ['F1', 'user-needs', 'stated', 'stated', 'notes/kickoff.md'],
      ['F2', 'user-needs', 'implied', 'inferred', null],
      ['F3', 'user-needs', 'stated', 'stated', 'answers'],
      ['F4', 'business', 'stated', 'stated', 'notes/kickoff.md'],
      ['F5', 'business', 'stated', 'stated', 'answers'],
      ['F6', 'constraints', 'stated', 'stated', 'notes/tickets.md'],
      ['F7', 'constraints', 'inferred', 'inferred', null],
    ],
  );
  assert.deepEqual(output.unknowns, [tiers.question, howMany.question]);
  assert.deepEqual(output.conflicts, []);
  assert.deepEqual(output.failedLenses, []);
  assert.deepEqual(output.failedCritics, []);
  assert.equal(output.revised, true);
  assert.deepEqual(
    output.issues.map((issue) => [issue.severity, issue.critic]),
    [
      ['blocking', 'ambiguity'],
      ['major', 'feasibility'],
      ['minor', 'scope'],
    ],
  );
  assert.deepEqual(output.addedAssumptions, ['F2']);
  assert.deepEqual(output.assumptions, [
    'Email is the only reminder channel at launch.',
    'Overdue means one day past the due date.',
    point.pause,
  ]);
  assert.deepEqual(output.openQuestions, [howMany]);
  assert.equal(output.critiqueSummary, `3 issues raised, 1 blocking. ${reRun}`);
  // Round 0: the conflict reached the writer, the critics read the code-added assumption, and
  // the reviser received the issues most severe first; the question listed the revised questions.
  const draft0 = calls.find((call) => call.call.stepId === 'draft');
  assert.ok(
    draft0.options.prompt.includes(
      '- The kickoff says weekly reminders; ticket #101 asks for daily',
    ),
  );
  assert.ok(
    draft0.options.prompt.includes(
      `- F2 [user-needs, inferred]: ${point.pause} ("Customers can pause`,
    ),
  );
  for (const call of calls.filter((c) => /^attack\/\d+\/critique$/u.test(c.call.stepId)))
    assert.ok(call.options.prompt.includes(`- ${point.pause} (F2)\n`));
  const revise0 = calls.find((call) => call.call.stepId === 'revise').options.prompt;
  assert.ok(
    revise0.indexOf('- blocking, from the ambiguity') <
      revise0.indexOf('- major, from the feasibility') &&
      revise0.indexOf('- major, from the feasibility') < revise0.indexOf('- minor, from the scope'),
  );
  // The published document is the final round's revision, rendered and traced by code.
  const document = await readFile(join(env.cwd, 'docs/prd.md'), 'utf8');
  assert.equal(document, output.prd);
  assert.deepEqual(output.written, {
    path: join(env.cwd, 'docs/prd.md'),
    sha256: sha256(document),
    bytes: Buffer.byteLength(document),
    previousSha256: null,
  });
  assert.ok(document.startsWith('# Automatic invoice reminders\n\n## Problem and context\n'));
  assert.ok(
    document.includes(
      '### Must\n\n- R1. Send a reminder email every day once an invoice is past due. (F1, F3)\n',
    ),
  );
  assert.ok(
    document.includes(
      '### Should\n\n- R2. Let a customer pause reminders while an invoice is disputed. (F2)\n',
    ),
  );
  assert.ok(document.includes(`(metric: DSO falls from 45 to 40.5 days)`));
  assert.ok(document.includes(`1. ${howMany.question} Consequences: ${howMany.consequences}\n`));
  assert.ok(
    document.includes(
      `- F3 [user-needs, stated, answers]: ${point.daily} ("Reminders go out daily.")\n`,
    ),
  );
  assert.ok(
    document.includes(
      '\nDrafted from notes/kickoff.md, notes/tickets.md by requirements-to-prd; status: complete.',
    ),
  );
  assert.equal(git(env.cwd, 'status', '--porcelain', '--untracked-files=all'), '?? docs/prd.md');
}

export const kill = { step: '^write$', boundary: 'checkpoint', writeLocation: 'source-checkout' };

const once = (base) => ({ ...base, questionRounds: 0 });
const readOut = (env, path = 'docs/prd.md') => readFile(join(env.cwd, path), 'utf8');

export const modes = [
  {
    mode: 'critic-fails',
    input: () => once(input()),
    check: async ({ result, env, calls }) => {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(output.failedCritics, ['scope']);
      assert.equal(output.revised, true);
      assert.deepEqual(
        output.issues.map((issue) => issue.critic),
        ['ambiguity', 'feasibility'],
      );
      assert.deepEqual(output.asked, []);
      assert.equal(output.rounds, 1);
      assert.deepEqual(steps(calls).sort(), round('').sort());
      const revise = calls.find((call) => call.call.stepId === 'revise').options.prompt;
      assert.equal(revise.includes('from the scope critic'), false);
      assert.deepEqual(output.openQuestions, [cadence, baseline]);
      assert.deepEqual(output.conflicts, [
        'The kickoff says weekly reminders; ticket #101 asks for daily',
      ]);
      // The quote check: parts out of order, or a single word, keep a "stated" finding inferred.
      assert.deepEqual(
        output.findings
          .filter((f) => f.lens === 'constraints')
          .map((f) => [f.point, f.claimed, f.confidence, f.source]),
        [
          [point.zone, 'stated', 'stated', 'notes/tickets.md'],
          [point.email, 'inferred', 'inferred', null],
          [point.reversed, 'stated', 'inferred', null],
          [point.word, 'stated', 'inferred', null],
        ],
      );
      const text = await readOut(env);
      assert.equal(text, output.prd);
      assert.ok(
        text.includes('status: degraded. 2 issues raised, 1 blocking. The scope critic failed.'),
      );
    },
  },
  {
    mode: 'critics-fail',
    input: () => once(input()),
    check: async ({ result, env, calls }) => {
      const { output } = result;
      assert.equal(output.status, 'unrevised');
      assert.deepEqual(output.failedCritics, charters);
      assert.deepEqual(output.issues, []);
      assert.equal(output.revised, false);
      // Nothing to revise from: no revision call, and the draft stands with its added assumption.
      assert.deepEqual(steps(calls).sort(), round('').slice(0, -1).sort());
      assert.equal(
        output.critiqueSummary,
        `0 issues raised, 0 blocking. The ambiguity, scope, feasibility critics failed. The draft was not critiqued. ${reRun}`,
      );
      assert.deepEqual(output.openQuestions, [cadence]);
      assert.deepEqual(output.addedAssumptions, ['F2']);
      const text = await readOut(env);
      assert.equal(text, output.prd);
      assert.ok(
        text.includes('- R1. Send a reminder email when an invoice becomes overdue. (F1)\n'),
      );
      assert.ok(text.includes('; status: unrevised. 0 issues raised'));
    },
  },
  {
    mode: 'lens-fails',
    // The user-needs lens fails in the first round and the constraints lens in the second.
    input: () => input(),
    check: async ({ result, env, calls, suspended }) => {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.equal(suspended, 1);
      assert.deepEqual(steps(calls).sort(), [...round(''), ...round('round/1/')].sort());
      // The first round's failure stays on record beside the question it asked.
      assert.deepEqual(output.asked, [
        {
          round: 1,
          questions: 2,
          answered: true,
          status: 'degraded',
          failedLenses: ['user-needs'],
          failedCritics: [],
        },
      ]);
      // The draft ran from the other three lenses.
      const draft0 = calls.find((call) => call.call.stepId === 'draft').options.prompt;
      assert.equal(draft0.includes('[user-needs'), false);
      assert.ok(draft0.includes(`- F1 [business, stated, notes/kickoff.md]: ${point.dso}`));
      assert.ok(draft0.includes('- The kickoff says weekly reminders; ticket #101 asks for daily'));
      assert.deepEqual(output.failedLenses, ['constraints']);
      assert.deepEqual(output.failedCritics, []);
      assert.deepEqual(
        output.findings.map((f) => [f.id, f.lens, f.source]),
        [
          ['F1', 'user-needs', 'notes/kickoff.md'],
          ['F2', 'user-needs', null],
          ['F3', 'user-needs', 'answers'],
          ['F4', 'business', 'notes/kickoff.md'],
          ['F5', 'business', 'answers'],
        ],
      );
      assert.equal(
        output.critiqueSummary,
        `3 issues raised, 1 blocking. The constraints lens failed. ${reRun}`,
      );
      const text = await readOut(env);
      assert.equal(text, output.prd);
      assert.ok(text.includes('; status: degraded. 3 issues raised, 1 blocking.'));
      assert.ok(
        text.includes("- N1. Send reminders in the customer's time zone, by email only. (F1)"),
      );
      assert.equal(
        git(env.cwd, 'status', '--porcelain', '--untracked-files=all'),
        '?? docs/prd.md',
      );
    },
  },
  {
    mode: 'reviser-fails',
    // Inline material spans lines, earlier answers come as input, and the PRD is committed.
    input: () => ({
      input: `${kickoff}\n${tickets}`,
      answers: 'Reminders go out daily.',
      out: 'docs/prd.md',
      publication: 'commit',
    }),
    check: async ({ result, env, calls }) => {
      const { output } = result;
      assert.equal(output.status, 'unrevised');
      assert.equal(output.revised, false);
      const text = `${kickoff}\n${tickets}`;
      assert.deepEqual(output.material, [
        { source: 'text', path: null, sha256: sha256(text), bytes: Buffer.byteLength(text) },
      ]);
      assert.deepEqual(output.answers, ['Reminders go out daily.']);
      assert.deepEqual(
        output.findings.map((f) => [f.point, f.source]),
        [
          [point.overdue, 'text'],
          [point.pause, null],
          [point.daily, 'answers'],
          [point.dso, 'text'],
          [point.zone, 'text'],
          [point.email, null],
        ],
      );
      assert.equal(calls.length, 9);
      assert.equal(output.issues.length, 3);
      // The draft stands, with the assumption code added for the inferred pause finding.
      assert.deepEqual(output.addedAssumptions, ['F2']);
      assert.match(output.critiqueSummary, /The revision failed; the draft stands\./u);
      const published = await readOut(env);
      assert.equal(published, output.prd);
      assert.equal(output.written.sha256, sha256(published));
      assert.ok(
        published.includes('- R1. Send a reminder email when an invoice becomes overdue. (F1)\n'),
      );
      assert.ok(published.includes(`- ${point.pause} (F2)\n`));
      assert.ok(
        published.includes(
          '\nDrafted from inline material by requirements-to-prd; status: unrevised.',
        ),
      );
      // A managed commit publishes the document, so the checkout stays clean.
      assert.equal(git(env.cwd, 'status', '--porcelain'), '');
      assert.equal(git(env.cwd, 'log', '-1', '--name-only', '--format='), 'docs/prd.md');
    },
  },
  {
    mode: 'empty',
    input: () => ({ input: 'Lunch menu\nTacos on Tuesday\n', out: 'docs/prd.md' }),
    check: ({ result, env, calls }) => {
      const { output } = result;
      assert.equal(output.status, 'empty');
      assert.equal(output.prd, null);
      assert.deepEqual(output.findings, []);
      assert.deepEqual(output.openQuestions, [
        { question: 'Is this requirements material at all?', consequences: null },
      ]);
      assert.equal(output.critiqueSummary, 'No requirements extracted. Is the input readable?');
      assert.deepEqual(steps(calls).sort(), round('').slice(0, 4).sort());
      assert.equal(output.written, null);
      assert.equal(existsSync(join(env.cwd, 'docs/prd.md')), false);
      assert.equal(git(env.cwd, 'status', '--porcelain'), '');
    },
  },
  {
    mode: 'blank',
    // A file of whitespace is read, and no lens is paid to read it.
    input: () => ({ input: ['notes/blank.md'], out: 'docs/prd.md' }),
    check: ({ result, env, calls }) => {
      const { output } = result;
      assert.equal(calls.length, 0);
      assert.equal(output.status, 'empty');
      assert.deepEqual(output.material, [
        {
          source: 'file',
          path: 'notes/blank.md',
          sha256: sha256(blank),
          bytes: Buffer.byteLength(blank),
        },
      ]);
      assert.deepEqual(output.failedLenses, []);
      assert.deepEqual(output.findings, []);
      assert.deepEqual(output.openQuestions, []);
      assert.equal(output.prd, null);
      assert.equal(output.written, null);
      assert.equal(existsSync(join(env.cwd, 'docs/prd.md')), false);
      assert.equal(git(env.cwd, 'status', '--porcelain'), '');
    },
  },
  {
    mode: 'left-open',
    input: () => ({ ...input(), questionRounds: 2 }),
    check: ({ result, calls, record, suspended }) => {
      const { output } = result;
      assert.equal(output.status, 'complete');
      assert.equal(suspended, 1);
      assert.deepEqual(output.asked, [{ round: 1, questions: 40, answered: false, ...clean }]);
      assert.equal(output.rounds, 1);
      assert.deepEqual(output.answers, []);
      assert.deepEqual(steps(calls).sort(), round('').sort());
      assert.deepEqual(output.openQuestions, [tiers, baseline, ...many]);
      assert.ok(output.prd.includes(`1. ${tiers.question} Consequences: ${tiers.consequences}\n`));
      assert.ok(output.prd.includes(`40. ${many[37].question} Consequences: `));
      // Forty questions overflow the details, which stop at a line and say how many are left out;
      // the subject holds them all.
      const asked = record.steps['questions/1'].question.request;
      assert.equal(asked.subject.questions.length, 40);
      const lines = asked.details.split('\n');
      const shown = lines.length - 1;
      assert.ok(shown > 2 && shown < 40);
      assert.ok(Buffer.byteLength(asked.details) <= 15_100);
      assert.equal(lines.slice(0, -1).join('\n'), listed(output.openQuestions.slice(0, shown)));
      assert.equal(
        lines.at(-1),
        `...and ${String(40 - shown)} more; the question's subject lists them all.`,
      );
    },
  },
  {
    mode: 'out-exists',
    // A previous run's PRD at out, and no replace digest: refused before anything is read or paid.
    input: () => ({ ...input(), out: 'docs/previous-prd.md' }),
    check: async ({ result, env, calls, record, suspended }) => {
      const { output } = result;
      assert.equal(output.status, 'refused');
      assert.equal(calls.length, 0);
      assert.equal(suspended, 0);
      assert.deepEqual(Object.keys(record.steps), ['existing']);
      assert.equal(
        output.critiqueSummary,
        `Not run: docs/previous-prd.md exists (sha256 ${sha256(previous)}); pass that digest as replace to redo it.`,
      );
      assert.deepEqual(output.material, []);
      assert.equal(output.rounds, 0);
      assert.equal(output.prd, null);
      assert.equal(output.written, null);
      assert.equal(await readOut(env, 'docs/previous-prd.md'), previous);
      assert.equal(git(env.cwd, 'status', '--porcelain', '--untracked-files=all'), '');
    },
  },
  {
    mode: 'replace',
    // The upstream's checkpoint loop: a re-run with the answers redoes the PRD a run wrote before.
    input: () => ({
      ...once(input()),
      out: 'docs/previous-prd.md',
      replace: sha256(previous),
      answers: ownerAnswer,
    }),
    check: async ({ result, env, calls }) => {
      const { output } = result;
      assert.equal(output.status, 'complete');
      assert.equal(calls.length, 9);
      assert.deepEqual(output.answers, [ownerAnswer]);
      assert.deepEqual(
        output.findings.filter((f) => f.source === 'answers').map((f) => f.point),
        [point.daily, point.baseline],
      );
      const text = await readOut(env, 'docs/previous-prd.md');
      assert.equal(text, output.prd);
      assert.deepEqual(output.written, {
        path: join(env.cwd, 'docs/previous-prd.md'),
        sha256: sha256(text),
        bytes: Buffer.byteLength(text),
        previousSha256: sha256(previous),
      });
      assert.equal(
        git(env.cwd, 'status', '--porcelain', '--untracked-files=all'),
        'M docs/previous-prd.md',
      );
    },
  },
];

/** A failed lens or critic in any round, or an unrevised draft, loses part of the critique. */
export const degraded = (output) =>
  output.failedLenses.length > 0 ||
  output.failedCritics.length > 0 ||
  output.status === 'unrevised' ||
  output.asked.some((entry) => entry.status !== 'complete');
