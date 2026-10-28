// feature-factory: docs/prd.md asks for a shared formatter and hello and goodbye commands. The
// prd-decompose child reads it into three tickets (the formatter first), the planner makes the
// formatter a foundation and each command a feature module, and a human approves the plan. The
// foundation builds on HEAD and both features build in parallel on it, each in its own worktree.
// Each module gets a deep-code-review child over its own snapshot; hello's misspelled greeting is
// confirmed, the fixer corrects it in hello's snapshot, and the verification command (which needs
// the fix) passes on the integration before the checkout is fast-forwarded.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { commitAll, enumOf, git, leaf, writeFiles } from './_support.mjs';

const prd = [
  '# Greeter',
  '',
  '## Requirements',
  '',
  '- A shared formatter joins a greeting and a name as "Greeting, Name!".',
  '- The hello command greets a name: hello("Ada") returns "Hello, Ada!".',
  '- The goodbye command bids a name farewell: goodbye("Ada") returns "Goodbye, Ada!".',
  '',
].join('\n');
const greeter = [
  "import assert from 'node:assert/strict';",
  "import { goodbye } from '../src/goodbye.mjs';",
  "import { hello } from '../src/hello.mjs';",
  "assert.equal(hello('Ada'), 'Hello, Ada!');",
  "assert.equal(goodbye('Ada'), 'Goodbye, Ada!');",
  '',
].join('\n');
const formatCheck = [
  "import assert from 'node:assert/strict';",
  "import { format } from '../lib/format.mjs';",
  "assert.equal(format('Hi', 'Ada'), 'Hi, Ada!');",
  '',
].join('\n');
const source = {
  format: 'export const format = (greeting, name) => `${greeting}, ${name}!`;\n',
  hello:
    "import { format } from '../lib/format.mjs';\n\nexport const hello = (name) => format('Helo', name);\n",
  fixed:
    "import { format } from '../lib/format.mjs';\n\nexport const hello = (name) => format('Hello', name);\n",
  goodbye:
    "import { format } from '../lib/format.mjs';\n\nexport const goodbye = (name) => format('Goodbye', name);\n",
};
const typo = {
  title: 'hello misspells the greeting',
  file: 'src/hello.mjs',
  line: 3,
  severity: 'high',
  evidence: "format('Helo', name)",
  failureScenario: "hello('Ada') returns 'Helo, Ada!'",
};
const items = {
  formatter: ['Shared formatter', 'A shared formatter joins a greeting and a name'],
  hello: ['Hello command', 'The hello command greets a name'],
  goodbye: ['Goodbye command', 'The goodbye command bids a name farewell'],
};
const areas = { format: ['lib'], hello: ['src/hello.mjs'], goodbye: ['src/goodbye.mjs'] };
const node = (script) => [process.execPath, script];

export async function setup(env) {
  await writeFiles(env.cwd, {
    'docs/prd.md': prd,
    'checks/greeter.mjs': greeter,
    'checks/format.mjs': formatCheck,
  });
  env.head = commitAll(env.cwd, 'add the greeter PRD and checks');
}

export const input = () => ({
  prd: 'docs/prd.md',
  verifyCommands: [node('checks/greeter.mjs')],
  dimensions: ['correctness'],
  maxFindings: 4,
});
/** The degraded modes leave a module out, so only the foundation can be checked. */
const formatOnly = () => ({ ...input(), verifyCommands: [node('checks/format.mjs')] });

const item = (key) => ({
  title: items[key][0],
  description: `${items[key][0]} as the PRD asks.`,
  prdAnchor: items[key][1],
  acceptanceCriteria: [`${items[key][0]} works`],
  estimate: 'S',
});
function lens(prompt, mode) {
  const name = /^Your lens is ([a-z-]+)\.$/mu.exec(prompt)?.[1];
  if (mode === 'no-tickets') return { items: [], openQuestions: [] };
  if (name === 'stories') return { items: [item('hello'), item('goodbye')], openQuestions: [] };
  if (name === 'foundations') return { items: [item('formatter')], openQuestions: [] };
  return { items: [], openQuestions: [] };
}
/** The formatter first, then each command after it, from whichever items the lenses produced. */
function merge(request) {
  const sources = enumOf(request.outputSchema, 'tickets', 'items', 'sources', 'items');
  const stories = sources.filter((id) => id.startsWith('stories-'));
  const picks = [
    ['formatter', sources.find((id) => id.startsWith('foundations-')), 'infra-migration'],
    ['hello', stories[0], 'feature'],
    ['goodbye', stories[1], 'feature'],
  ].filter(([, id]) => id);
  const first = picks[0]?.[0] === 'formatter';
  return {
    tickets: picks.map(([key, id, lane], index) => ({
      id: `T${String(index + 1)}`,
      title: items[key][0],
      description: `${items[key][0]} as the PRD asks.`,
      acceptanceCriteria: [`${items[key][0]} works`],
      estimate: 'S',
      lane,
      dependsOn: first && index > 0 ? ['T1'] : [],
      sources: [id],
    })),
    sequencing: 'The formatter lands first; both commands build on it.',
    openQuestions: [],
  };
}
/**
 * One module per ticket the planner sees, keyed by the ticket's title in the prompt, up to the
 * module limit it states; a ticket past it is deferred. The plan-retry mode's first attempt gives
 * hello all of src/, overlapping goodbye's area.
 */
function plan(request, mode) {
  const prompt = request.options.prompt;
  const max = Number(/at most (\d+) implementation module/u.exec(prompt)[1]);
  const ids = Object.fromEntries(
    [...prompt.matchAll(/^- (T\d+): (.+) \[/gmu)].map((match) => [match[2], match[1]]),
  );
  const wanted = [
    ['format', ids[items.formatter[0]], true],
    ['hello', ids[items.hello[0]], false],
    ['goodbye', ids[items.goodbye[0]], false],
  ].filter(([, id]) => id);
  const overlap = mode === 'plan-retry' && request.call.attempt === 1;
  const modules = wanted.slice(0, max).map(([name, id, isFoundation]) => ({
    name,
    isFoundation,
    fileAreas: overlap && name === 'hello' ? ['src'] : areas[name],
    ticketIds: [id],
    notes: mode === 'declined' && isFoundation ? 'Keep it pure (decline)' : null,
  }));
  const deferred = wanted.slice(max).map(([, id]) => ({ ticket: id, reason: 'Module limit' }));
  return { modules, deferred };
}

const moduleOf = (prompt) => /^Implement the "([a-z]+)" module/mu.exec(prompt)?.[1];
/** Which module a review step reads, from the change list in its prompt. */
const reviewed = (prompt) =>
  prompt.includes('src/hello.mjs')
    ? 'hello'
    : prompt.includes('src/goodbye.mjs')
      ? 'goodbye'
      : 'format';
const isReview = (id) => /^reviews\/\d+\/review\//u.test(id);

async function build(request, mode) {
  const name = moduleOf(request.options.prompt);
  if (name === 'format') {
    if (mode === 'foundation-blocked')
      return { status: 'blocked', summary: 'No formatter style', blockers: ['House style?'] };
    await writeFiles(request.cwd, { 'lib/format.mjs': source.format });
    return { status: 'done', summary: 'Added the formatter', blockers: [] };
  }
  // A feature builds on the foundation's snapshot, never on the bare base.
  assert.equal(readFileSync(join(request.cwd, 'lib/format.mjs'), 'utf8'), source.format);
  if (name === 'hello') await writeFiles(request.cwd, { 'src/hello.mjs': source.hello });
  else {
    await writeFiles(request.cwd, { 'src/goodbye.mjs': source.goodbye });
    if (mode === 'overreach') await writeFiles(request.cwd, { 'README.md': 'Rewritten\n' });
  }
  return { status: 'done', summary: `Added ${name}`, blockers: [] };
}

function review(request) {
  const id = request.call.stepId,
    prompt = request.options.prompt;
  const target = reviewed(prompt);
  if (leaf(id) === 'scope') return { summary: `Adds the ${target} module.`, riskNotes: null };
  if (/\/reviews\/[a-z-]+\/review$/u.test(id)) {
    // Each review reads a snapshot of its own module's head, without the other feature.
    const own = { format: 'lib/format.mjs', hello: 'src/hello.mjs', goodbye: 'src/goodbye.mjs' };
    assert.ok(existsSync(join(request.cwd, own[target])));
    const other = target === 'hello' ? own.goodbye : own.hello;
    assert.equal(existsSync(join(request.cwd, other)), false);
    return { findings: target === 'hello' ? [typo] : [] };
  }
  if (/\/verify\/\d+\/refute$/u.test(id))
    return { refuted: false, reasoning: 'The PRD says Hello', adjustedSeverity: null };
  if (leaf(id) === 'report') return `## ${target}\n\nOne confirmed finding.`;
  throw new Error(`Unhandled review step ${id}`);
}

export async function reply(request, env, mode) {
  const id = request.call.stepId;
  if (/^decompose\/lenses\/\d+\/read$/u.test(id)) return lens(request.options.prompt, mode);
  if (id === 'decompose/merge') return merge(request);
  if (/^decompose\/audit\/\d+$/u.test(id)) return { gaps: [] };
  if (id === 'plan') return plan(request, mode);
  if (/^(?:foundations\/\d+|features\/\d+)\/build$/u.test(id)) {
    assert.notEqual(request.cwd, env.cwd);
    return build(request, mode);
  }
  if (isReview(id)) return review(request);
  if (/^repairs\/\d+\/fix$/u.test(id)) {
    assert.notEqual(request.cwd, env.cwd);
    // The fixer starts from hello's own snapshot.
    assert.equal(readFileSync(join(request.cwd, 'src/hello.mjs'), 'utf8'), source.hello);
    await writeFiles(request.cwd, { 'src/hello.mjs': source.fixed });
    return { summary: 'Spelled the greeting', unresolved: [] };
  }
  throw new Error(`Unhandled feature-factory step ${id} (${mode})`);
}

export function fail(request, mode) {
  const id = request.call.stepId,
    prompt = request.options.prompt;
  return (
    (mode === 'feature-fails' &&
      /^features\/\d+\/build$/u.test(id) &&
      moduleOf(prompt) === 'goodbye') ||
    (mode === 'review-fails' &&
      isReview(id) &&
      leaf(id) === 'scope' &&
      reviewed(prompt) === 'hello')
  );
}

/** The declined mode's planner marks its plan, since answer() does not receive the mode. */
export const answer = (question) =>
  leaf(question.stepId) === 'approve-plan' &&
  question.subject?.plan?.modules?.some((module) => module.notes?.includes('(decline)'))
    ? { approved: false, comment: 'Fixture human declined' }
    : undefined;

const steps = (calls) => calls.map((call) => call.call.stepId);
const read = (env, file) => readFileSync(join(env.cwd, file), 'utf8');
/** The checkout is the setup commit, clean. */
function untouched(env) {
  assert.equal(git(env.cwd, 'rev-parse', 'HEAD'), env.head);
  assert.equal(git(env.cwd, 'status', '--porcelain', '--untracked-files=all'), '');
}
/** Published: one fast-forward of the clean checkout to the output's commit, holding `files`. */
function published(env, output, files) {
  assert.equal(git(env.cwd, 'rev-parse', 'HEAD'), output.commit);
  assert.equal(git(env.cwd, 'status', '--porcelain', '--untracked-files=all'), '');
  git(env.cwd, 'merge-base', '--is-ancestor', env.head, 'HEAD');
  assert.deepEqual(git(env.cwd, 'diff', '--name-only', env.head, 'HEAD').split('\n'), files);
  assert.equal(read(env, 'README.md'), 'Fixture project\n');
}
const builds = (output) => output.modules.map((module) => [module.name, module.build]);
/** Only the builders and the fixer may edit, and each in its own isolated checkout. */
function isolated(env, calls) {
  const writers = calls.filter((call) => /\/(?:build|fix)$/u.test(call.call.stepId));
  assert.ok(writers.every((call) => call.cwd !== env.cwd));
  assert.equal(new Set(writers.map((call) => call.cwd)).size, writers.length);
  assert.ok(
    calls
      .filter((call) => !writers.includes(call))
      .every((call) => !(call.options.tools ?? []).some((tool) => /Write|Edit|Bash/u.test(tool))),
  );
}

export function check({ result, env, calls, suspended }) {
  const { output } = result;
  assert.equal(output.status, 'applied');
  assert.equal(suspended, 1);
  assert.deepEqual(output.backlog, {
    status: 'covered',
    tickets: [
      { id: 'T1', title: 'Shared formatter', dependsOn: [] },
      { id: 'T2', title: 'Hello command', dependsOn: ['T1'] },
      { id: 'T3', title: 'Goodbye command', dependsOn: ['T1'] },
    ],
    sequencing: 'The formatter lands first; both commands build on it.',
    openQuestions: [],
    gaps: 0,
  });
  // 11 decomposition, 2 plan and 3 x (1 build + 1 scope + 1 reviewer + 4 skeptics + 1 report + 1 fix).
  assert.deepEqual(output.limits, { modules: 4, callsAdmitted: 13 + 3 * 9, unlistedFiles: 0 });
  const { digest, ...plan } = output.plan;
  assert.deepEqual(
    plan.modules.map((module) => [module.name, module.isFoundation, module.fileAreas]),
    [
      ['format', true, ['lib']],
      ['hello', false, ['src/hello.mjs']],
      ['goodbye', false, ['src/goodbye.mjs']],
    ],
  );
  // Every builder receives the approved plan verbatim, and the digest is of that text.
  const builders = calls.filter((call) => leaf(call.call.stepId) === 'build');
  assert.equal(builders.length, 3);
  for (const call of builders) {
    const text = call.options.prompt.split('Approved plan:\n')[1];
    assert.equal(text, JSON.stringify(plan, null, 2));
    assert.equal(createHash('sha256').update(text).digest('hex'), digest);
    assert.ok(call.options.prompt.includes(`Approved plan digest: ${digest}`));
  }
  assert.deepEqual(builds(output), [
    ['format', 'done'],
    ['hello', 'done'],
    ['goodbye', 'done'],
  ]);
  // The foundation built on HEAD; both features built on the foundation's snapshot.
  const [format, hello, goodbye] = output.modules;
  assert.equal(format.base, env.head);
  assert.equal(hello.base, format.commit);
  assert.equal(goodbye.base, format.commit);
  assert.deepEqual(
    output.modules.map((module) => module.files),
    [['lib/format.mjs'], ['src/hello.mjs'], ['src/goodbye.mjs']],
  );
  assert.deepEqual(
    output.modules.map((module) => [module.review.status, module.review.confirmed]),
    [
      ['complete', 0],
      ['complete', 1],
      ['complete', 0],
    ],
  );
  assert.equal(hello.repair.status, 'repaired');
  assert.equal(format.repair, null);
  assert.equal(goodbye.repair, null);
  // Each module's review read only its own change.
  for (const call of calls.filter((c) => /\/reviews\/correctness\/review$/u.test(c.call.stepId))) {
    const files = [...call.options.prompt.matchAll(/^- ((?:lib|src)\/\S+) \(\+/gmu)].map(
      (match) => match[1],
    );
    assert.equal(files.length, 1);
  }
  const fixer = calls.find((call) => leaf(call.call.stepId) === 'fix').options.prompt;
  assert.ok(fixer.includes(`<findings>\n- high: ${typo.title}, at src/hello.mjs:3\n`));
  assert.ok(output.verification.every((row) => row.code === 0 && row.failure === null));
  published(env, output, ['lib/format.mjs', 'src/goodbye.mjs', 'src/hello.mjs']);
  assert.equal(read(env, 'src/hello.mjs'), source.fixed);
  assert.equal(read(env, 'lib/format.mjs'), source.format);
  assert.notEqual(output.integrated, null);
  assert.equal(Object.keys(result.children).length, 4);
  isolated(env, calls);
}

export const kill = {
  step: '^foundations/0/build$',
  boundary: 'response',
  writeLocation: 'isolated-checkout',
};

export const modes = [
  {
    mode: 'declined',
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'declined');
      assert.equal(output.plan.modules.length, 3);
      assert.deepEqual(output.modules, []);
      assert.equal(
        calls.some((call) => leaf(call.call.stepId) === 'build'),
        false,
      );
      untouched(env);
    },
  },
  {
    mode: 'red-verify',
    input: () => ({ ...input(), verifyCommands: [[process.execPath, '-e', 'process.exit(3)']] }),
    check({ result, env }) {
      const { output } = result;
      assert.equal(output.status, 'verification-failed');
      assert.equal(output.verification[0].code, 3);
      assert.equal(output.commit, null);
      // The verified-but-red integration stays on a run-owned ref; the checkout is untouched.
      assert.equal(git(env.cwd, 'show', `${output.integrated}:src/hello.mjs`), source.fixed.trim());
      untouched(env);
    },
  },
  {
    mode: 'feature-fails',
    input: formatOnly,
    check({ result, env }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(builds(output), [
        ['format', 'done'],
        ['hello', 'done'],
        ['goodbye', 'failed'],
      ]);
      assert.match(output.modules[2].summary, /^Build failed: .*fixture nonzero process/u);
      assert.equal(output.modules[2].review, null);
      published(env, output, ['lib/format.mjs', 'src/hello.mjs']);
      assert.equal(read(env, 'src/hello.mjs'), source.fixed);
    },
  },
  {
    mode: 'overreach',
    input: formatOnly,
    check({ result, env }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      const goodbye = output.modules[2];
      assert.deepEqual([goodbye.build, goodbye.outside], ['refused', ['README.md (modified)']]);
      assert.equal(goodbye.review, null);
      published(env, output, ['lib/format.mjs', 'src/hello.mjs']);
    },
  },
  {
    mode: 'foundation-blocked',
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'nothing-built');
      assert.deepEqual(builds(output), [
        ['format', 'blocked'],
        ['hello', 'skipped'],
        ['goodbye', 'skipped'],
      ]);
      assert.match(output.modules[1].summary, /T2 depends on T1, which was not built/u);
      assert.deepEqual(
        steps(calls).filter((id) => !id.startsWith('decompose/')),
        ['plan', 'foundations/0/build'],
      );
      untouched(env);
    },
  },
  {
    mode: 'review-fails',
    input: formatOnly,
    check({ result, env }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      const hello = output.modules[1];
      assert.equal(hello.review.status, 'failed');
      assert.equal(hello.repair, null);
      assert.equal(output.modules[2].review.status, 'complete');
      // An unreviewed module still lands, unrepaired, and the status says so.
      published(env, output, ['lib/format.mjs', 'src/goodbye.mjs', 'src/hello.mjs']);
      assert.equal(read(env, 'src/hello.mjs'), source.hello);
    },
  },
  {
    mode: 'no-tickets',
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'no-tickets');
      assert.equal(output.backlog.status, 'empty');
      assert.equal(output.plan, null);
      assert.equal(calls.length, 5);
      untouched(env);
    },
  },
  {
    mode: 'call-cap',
    // 11 decomposition + 2 plan calls leave 18 of 31, two modules of 9: goodbye is deferred.
    input: () => ({ ...formatOnly(), maxCalls: 31 }),
    check({ result, env }) {
      const { output } = result;
      assert.equal(output.status, 'limited');
      assert.equal(degraded(output), true);
      assert.deepEqual(output.limits, { modules: 2, callsAdmitted: 31, unlistedFiles: 0 });
      assert.deepEqual(output.plan.deferred, [{ ticket: 'T3', reason: 'Module limit' }]);
      assert.deepEqual(builds(output), [
        ['format', 'done'],
        ['hello', 'done'],
      ]);
      published(env, output, ['lib/format.mjs', 'src/hello.mjs']);
    },
  },
  {
    mode: 'plan-retry',
    // Overlapping areas fail the plan schema; the one schema retry re-asks and succeeds.
    check({ result, calls }) {
      assert.equal(result.output.status, 'applied');
      const planners = calls.filter((call) => call.call.stepId === 'plan');
      assert.equal(planners.length, 2);
      // The retry re-sends the same prompt: the refusal's problems never reach the planner.
      assert.equal(planners[1].options.prompt, planners[0].options.prompt);
      assert.deepEqual(result.output.plan.modules[1].fileAreas, ['src/hello.mjs']);
    },
  },
  {
    mode: 'require-grants',
    // Under requireGrants the children's entries delegate onto Reader: two writer grants suffice.
    options: (opts) => ({ ...opts, requireGrants: true, grants: ['Builder', 'Fixer'] }),
    check({ result }) {
      assert.equal(result.output.status, 'applied');
    },
  },
];

/** A limited status, or no tickets from a backlog no lens read, is short of what was asked. */
export const degraded = (output) =>
  output.status === 'limited' ||
  (output.status === 'no-tickets' && output.backlog.status !== 'empty');
