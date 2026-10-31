// acceptance-qa-deep: greet.mjs is committed as a stub and then improved in the working tree, with
// an untracked test beside it. The workflow pins that dirty tree as a snapshot commit; the record
// must show that the test command ran in a checkout of that snapshot, and the fixture checker reads
// greet.mjs from its own checkout, so a checker given HEAD's stub would fail every criterion. The
// fixture decomposer plans from the criteria bullets its prompt carries, and the checker answers
// from a rule table: holds, fails, or cannot-verify for a check that needs a benchmark. The source
// checkout, its index, HEAD and branches must be exactly as setup left them.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commitAll, git, leaf, writeFiles } from './_support.mjs';

const stub = "export const greet = (name) => 'Hello ' + name;\n";
const delivered = [
  'export function greet(name) {',
  "  if (typeof name !== 'string' || name.trim() === '')",
  "    throw new TypeError('name must be a non-empty string');",
  '  return `Hello, ${name}!`;',
  '}',
  '',
].join('\n');
const test = [
  "import assert from 'node:assert/strict';",
  "import { greet } from './greet.mjs';",
  "assert.equal(greet('Ada'), 'Hello, Ada!');",
  "assert.throws(() => greet(' '), TypeError);",
  "console.log('greet: 2 assertions passed');",
  '',
].join('\n');

const returns = 'greet(name) returns "Hello, <name>!"';
const rejects = 'greet rejects an empty name';
const showsValue = 'greet rejects an empty name, naming the value it got';
const fast = 'greet answers within 1 ms';
const whitespace = 'Whitespace-only names are rejected';
const ticketOf = (...bullets) =>
  ['# Greeting', '', ...bullets.map((bullet) => `- ${bullet}`), ''].join('\n');
const ticket = ticketOf(returns, rejects);
const benchmark = 'A benchmark shows greet answering within 1 ms';

// How the fixture decomposer plans each stated criterion it finds in its prompt.
const plans = {
  [returns]: { checks: ['greet("Ada") returns "Hello, Ada!"'], kind: 'behavior' },
  [rejects]: {
    checks: ['greet("") throws a TypeError', 'The error message names the argument'],
    kind: 'error-handling',
  },
  [showsValue]: {
    checks: ['greet("") throws a TypeError', 'The error message shows the rejected value'],
    kind: 'error-handling',
  },
  [fast]: { checks: [benchmark], kind: 'performance' },
};
// What the fixture checker accepts as proof of each sub-check, read from the checker's checkout;
// null means only running the code could tell.
const rules = {
  'greet("Ada") returns "Hello, Ada!"': (source) => source.includes('`Hello, ${name}!`'),
  'greet("") throws a TypeError': (source) => source.includes('throw new TypeError'),
  'The error message names the argument': (source) => source.includes("TypeError('name"),
  'The error message shows the rejected value': (source) => source.includes('got ${'),
  [whitespace]: (source) => source.includes('.trim()'),
  [benchmark]: () => null,
};

export async function setup(env) {
  await writeFiles(env.cwd, { 'greet.mjs': stub, 'TICKET.md': ticket });
  env.head = commitAll(env.cwd, 'add greeting stub');
  await writeFiles(env.cwd, { 'greet.mjs': delivered, 'greet.test.mjs': test });
  env.status = git(env.cwd, 'status', '--porcelain=v1', '--untracked-files=all');
}

const testCommand = [process.execPath, 'greet.test.mjs'];
export const input = () => ({
  criteria: ticket,
  ticket: 'Goal: a friendly greeting. Non-goal: localization.',
  checkCommands: [testCommand],
});

/** The bullets of the criteria block of a decompose prompt. */
const bullets = (prompt) =>
  prompt
    .split('<criteria>\n')[1]
    .split('\n</criteria>')[0]
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2));
/** The numbered sub-checks of a check prompt, in order. */
const subChecks = (prompt) =>
  prompt
    .split('Sub-checks, in order:\n')[1]
    .split('\n\n')[0]
    .split('\n')
    .map((line) => line.replace(/^\d+\. /u, ''));

/** The fixture checker's answer to one sub-check. */
function answer(check, source, red) {
  if (red && check.startsWith('greet("Ada")'))
    return { outcome: 'fails', evidence: 'command 1 exited 3: suite red' };
  const rule = rules[check];
  if (!rule) throw new Error(`No fixture rule for sub-check ${check}`);
  const holds = rule(source);
  if (holds === null)
    return { outcome: 'cannot-verify', evidence: 'No command timed greet; a benchmark run would' };
  return holds
    ? { outcome: 'holds', evidence: `greet.mjs:${source.split('\n').length - 2}` }
    : { outcome: 'fails', evidence: 'greet.mjs has no such code' };
}

export async function reply(request, env, mode) {
  const id = request.call.stepId,
    prompt = request.options.prompt;
  if (id === 'decompose') {
    if (mode === 'no-criteria') return { criteria: [], impliedCriteria: [] };
    const criteria = bullets(prompt).map((criterion) => {
      if (!plans[criterion]) throw new Error(`No fixture plan for ${criterion}`);
      return { criterion, ...plans[criterion] };
    });
    return { criteria, impliedCriteria: [whitespace] };
  }
  if (/^criteria\/\d+\/check$/u.test(id)) {
    const source = await readFile(join(request.cwd, 'greet.mjs'), 'utf8');
    const red = prompt.includes('exit="3"');
    return { results: subChecks(prompt).map((check) => answer(check, source, red)) };
  }
  if (/^criteria\/\d+\/challenge$/u.test(id)) {
    if (mode === 'letter-only' && prompt.includes(`Criterion: ${returns}`))
      return {
        honest: false,
        reasoning: 'Only the example name was exercised',
        gotcha: 'Works for Ada; nobody checked other names',
      };
    return { honest: true, reasoning: 'The code reads the argument', gotcha: null };
  }
  if (id === 'summary') return `QA verdict (${mode}): see the criteria`;
  throw new Error(`Unhandled acceptance-qa-deep step ${id} (${mode})`);
}

export function fail(request, mode) {
  const id = request.call.stepId;
  return (
    mode === 'agents-fail' &&
    (id === 'criteria/1/check' || id === 'criteria/0/challenge' || id === 'summary')
  );
}

/**
 * The source checkout, its index, HEAD and branches are exactly as setup left them; the only new
 * refs are the runtime's own pins of the snapshot its isolated checkouts started from.
 */
function untouched(env) {
  assert.equal(git(env.cwd, 'status', '--porcelain=v1', '--untracked-files=all'), env.status);
  assert.equal(git(env.cwd, 'diff', '--cached', '--name-only'), '');
  assert.equal(git(env.cwd, 'rev-parse', 'HEAD'), env.head);
  const refs = git(env.cwd, 'for-each-ref', '--format=%(refname)').split('\n');
  assert.deepEqual(
    refs.filter((ref) => !ref.startsWith('refs/quiet-choir/')),
    [git(env.cwd, 'symbolic-ref', 'HEAD')],
  );
}
/** The run pins the snapshot under its own refs, so the commit it reports survives gc. */
function pinned(env, snapshot) {
  const refs = git(env.cwd, 'for-each-ref', '--format=%(refname)', '--points-at', snapshot);
  assert.ok(
    refs.split('\n').some((ref) => ref.startsWith('refs/quiet-choir/')),
    refs,
  );
}
const red = [process.execPath, '-e', 'console.error("suite red");process.exit(3)'];
const killed = [process.execPath, '-e', 'process.kill(process.pid, "SIGKILL")'];
/** Each command block of a prompt: index, parsed argv, other attributes, first output line. */
const commandTags = (prompt) =>
  [...prompt.matchAll(/<command index="(\d)" argv=(\[.*?\])((?: \w+="[^"]*")*)>\n(.*)\n/gu)].map(
    ([, index, argv, rest, first]) => [index, JSON.parse(argv), rest, first],
  );
const statuses = (output) => output.criteria.map((item) => [item.criterion, item.status]);
/** The step IDs of the challenge calls, in criterion order: the challenger sees only passes. */
const challenged = (calls) =>
  calls
    .map((call) => call.call.stepId)
    .filter((id) => leaf(id) === 'challenge')
    .sort();
const ran = [['1', testCommand, ' exit="0"', 'greet: 2 assertions passed']];

export async function check({ result, env, calls, record }) {
  const { output } = result;
  assert.equal(output.status, 'complete');
  assert.equal(output.verdict, 'done');
  // The snapshot is a child of HEAD holding the dirty tree, untracked test included.
  assert.equal(output.head, env.head);
  assert.equal(output.base, env.head);
  assert.equal(output.uncommitted, true);
  assert.notEqual(output.snapshot, env.head);
  assert.equal(git(env.cwd, 'rev-parse', `${output.snapshot}^`), env.head);
  assert.equal(git(env.cwd, 'show', `${output.snapshot}:greet.test.mjs`), test.trimEnd());
  pinned(env, output.snapshot);
  assert.deepEqual(output.files, [
    { path: 'greet.mjs', status: 'modified' },
    { path: 'greet.test.mjs', status: 'added' },
  ]);
  assert.deepEqual(output.commands, [
    { argv: testCommand, code: 0, truncated: false, failure: null },
  ]);
  // The command, every checker and every challenger ran in a checkout of the snapshot.
  for (const id of ['command/0', 'criteria/0/check', 'criteria/1/check', 'criteria/0/challenge'])
    assert.equal(record.steps[id]?.worktree?.base, output.snapshot, id);
  assert.deepEqual(statuses(output), [
    [returns, 'pass'],
    [rejects, 'pass'],
    [whitespace, 'pass'],
  ]);
  assert.equal(output.criteria[2].implied, true);
  assert.deepEqual(output.mustFix, []);
  assert.deepEqual(output.pendingManual, []);
  assert.equal(output.summary, 'QA verdict (normal): see the criteria');
  assert.equal(output.summarySource, 'narrator');
  untouched(env);
  const checkers = calls.filter((call) => leaf(call.call.stepId) === 'check');
  const challengers = calls.filter((call) => leaf(call.call.stepId) === 'challenge');
  assert.equal(checkers.length, 3);
  assert.equal(challengers.length, 3);
  for (const call of [...checkers, ...challengers]) {
    assert.notEqual(call.cwd, env.cwd);
    assert.match(call.options.prompt, new RegExp(`snapshot ${output.snapshot}`, 'u'));
    // Each checker and challenger sees the code-run command output.
    assert.deepEqual(commandTags(call.options.prompt), ran);
  }
  for (const call of checkers)
    assert.match(call.options.prompt, /<patch>\ndiff --git a\/greet\.mjs b\/greet\.mjs/u);
  assert.ok(
    challengers.every((call) => call.harness === 'codex' && call.options.sandbox === 'read-only'),
  );
  const first = challengers.find((call) => call.call.stepId === 'criteria/0/challenge');
  assert.match(first.options.prompt, /greet\("Ada"\) returns "Hello, Ada!": greet\.mjs:4/u);
  assert.ok(calls.every((call) => !(call.options.tools ?? []).includes('Write')));
  const decompose = calls.find((call) => call.call.stepId === 'decompose');
  assert.match(decompose.options.prompt, /- modified: greet\.mjs\n- added: greet\.test\.mjs/u);
  assert.match(decompose.options.prompt, /limits are\n60 stated criteria, 30 implied criteria/u);
}

export const readOnly =
  'Read-only gate: agents and commands read a pinned snapshot in runtime-owned checkouts; the source checkout, its index and branches are never written';

export const modes = [
  {
    mode: 'letter-only',
    check({ result, env }) {
      const { output } = result;
      assert.equal(output.status, 'complete');
      assert.equal(output.verdict, 'not-done');
      assert.equal(output.criteria[0].status, 'fail-spirit');
      assert.deepEqual(output.mustFix, [
        {
          criterion: returns,
          why: 'Works for Ada; nobody checked other names',
          evidence: 'greet("Ada") returns "Hello, Ada!": greet.mjs:4',
        },
      ]);
      untouched(env);
    },
  },
  {
    // A sub-check only a benchmark could settle: cannot-verify is a manual case, never a pass, and
    // is never challenged.
    mode: 'manual',
    input: () => ({ criteria: ticketOf(returns, rejects, fast), checkCommands: [testCommand] }),
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'complete');
      assert.equal(output.verdict, 'done-pending-manual');
      assert.deepEqual(statuses(output), [
        [returns, 'pass'],
        [rejects, 'pass'],
        [fast, 'cannot-verify'],
        [whitespace, 'pass'],
      ]);
      assert.equal(output.criteria[2].kind, 'performance');
      assert.deepEqual(output.criteria[2].checks, [
        {
          check: benchmark,
          outcome: 'cannot-verify',
          evidence: 'No command timed greet; a benchmark run would',
        },
      ]);
      assert.deepEqual(output.mustFix, []);
      assert.deepEqual(output.pendingManual, [
        { criterion: fast, why: `Needs a running environment: ${benchmark}` },
      ]);
      assert.deepEqual(challenged(calls), [
        'criteria/0/challenge',
        'criteria/1/challenge',
        'criteria/3/challenge',
      ]);
      untouched(env);
    },
  },
  {
    // Some sub-checks hold and one fails: partial is a must-fix, and the benchmark stays manual.
    mode: 'partial',
    input: () => ({ criteria: ticketOf(returns, showsValue, fast), checkCommands: [testCommand] }),
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'complete');
      assert.equal(output.verdict, 'not-done');
      assert.deepEqual(statuses(output), [
        [returns, 'pass'],
        [showsValue, 'partial'],
        [fast, 'cannot-verify'],
        [whitespace, 'pass'],
      ]);
      assert.deepEqual(
        output.criteria[1].checks.map((item) => item.outcome),
        ['holds', 'fails'],
      );
      assert.deepEqual(output.mustFix, [
        {
          criterion: showsValue,
          why: 'Failing sub-checks: The error message shows the rejected value',
          evidence: 'The error message shows the rejected value: greet.mjs has no such code',
        },
      ]);
      assert.deepEqual(output.pendingManual, [
        { criterion: fast, why: `Needs a running environment: ${benchmark}` },
      ]);
      assert.deepEqual(challenged(calls), ['criteria/0/challenge', 'criteria/3/challenge']);
      untouched(env);
    },
  },
  {
    mode: 'agents-fail',
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.equal(output.verdict, 'done-pending-manual');
      assert.deepEqual(statuses(output), [
        [returns, 'unchallenged'],
        [rejects, 'unchecked'],
        [whitespace, 'pass'],
      ]);
      assert.deepEqual(output.pendingManual, [
        {
          criterion: returns,
          why: 'Passed, but its letter-vs-spirit challenge failed; confirm the pass by hand',
        },
        { criterion: rejects, why: 'Its checker failed; check it by hand or in a new run' },
      ]);
      // The failed checker's criterion was never challenged; the other two were.
      assert.deepEqual(challenged(calls), ['criteria/0/challenge', 'criteria/2/challenge']);
      // The narrator failed too, so code wrote the upstream's fallback summary.
      assert.equal(
        output.summary,
        'done-pending-manual: 0 criteria failing, 2 pending manual confirmation.',
      );
      assert.equal(output.summarySource, 'code');
      untouched(env);
    },
  },
  {
    mode: 'red-command',
    input: (env) => ({
      criteriaFile: 'TICKET.md',
      base: env.since,
      paths: ['greet.mjs'],
      checkCommands: [red, killed],
    }),
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'complete');
      assert.equal(output.verdict, 'not-done');
      assert.equal(output.base, env.since);
      assert.deepEqual(output.files, [{ path: 'greet.mjs', status: 'added' }]);
      // A nonzero exit is a completed result; a signal settles as a failure without an exit code.
      assert.deepEqual(output.commands, [
        { argv: red, code: 3, truncated: false, failure: null },
        { argv: killed, code: null, truncated: null, failure: 'process' },
      ]);
      const checker = calls.find((call) => call.call.stepId === 'criteria/0/check');
      assert.deepEqual(commandTags(checker.options.prompt), [
        ['1', red, ' exit="3"', 'suite red'],
        ['2', killed, ' failure="process" truncated="true"', 'Command exited with SIGKILL.'],
      ]);
      assert.equal(output.criteria[0].status, 'fail');
      assert.equal(
        output.mustFix[0].evidence,
        'greet("Ada") returns "Hello, Ada!": command 1 exited 3: suite red',
      );
      // The failing criterion is not challenged: fails are already actionable.
      assert.deepEqual(challenged(calls), ['criteria/1/challenge', 'criteria/2/challenge']);
      const decompose = calls.find((call) => call.call.stepId === 'decompose');
      assert.match(decompose.options.prompt, /The workflow read them from TICKET\.md\./u);
      assert.match(decompose.options.prompt, /<criteria>\n# Greeting\n/u);
      untouched(env);
    },
  },
  {
    mode: 'capped',
    input: () => ({ criteria: ticket, maxCriteria: 2 }),
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'limited');
      assert.equal(output.verdict, 'done-pending-manual');
      assert.deepEqual(output.criteria.at(-1), {
        criterion: whitespace,
        kind: 'behavior',
        implied: true,
        status: 'skipped',
        checks: [],
        gotcha: null,
      });
      assert.deepEqual(output.pendingManual.at(-1), {
        criterion: whitespace,
        why: 'Past maxCriteria; never checked',
      });
      assert.deepEqual(output.commands, []);
      for (const call of calls.filter((item) => item.call.stepId.startsWith('criteria/')))
        assert.match(call.options.prompt, /selected no check commands/u);
      assert.equal(calls.filter((call) => leaf(call.call.stepId) === 'check').length, 2);
      untouched(env);
    },
  },
  {
    // The work is committed before the run, so the default base is the latest commit's parent.
    mode: 'committed',
    setup(env) {
      env.stubHead = env.head;
      env.head = commitAll(env.cwd, 'deliver greeting');
      env.status = '';
    },
    input: () => ({ criteria: ticket }),
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'complete');
      assert.equal(output.verdict, 'done');
      assert.equal(output.uncommitted, false);
      assert.equal(output.snapshot, env.head);
      assert.equal(output.base, env.stubHead);
      assert.deepEqual(
        output.files.map((file) => file.path),
        ['greet.mjs', 'greet.test.mjs'],
      );
      const checker = calls.find((call) => call.call.stepId === 'criteria/0/check');
      assert.doesNotMatch(checker.options.prompt, /uncommitted and untracked/u);
      untouched(env);
    },
  },
  {
    mode: 'no-criteria',
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'no-criteria');
      assert.equal(output.verdict, 'no-criteria');
      assert.equal(output.summarySource, 'code');
      assert.deepEqual(output.commands, []);
      assert.deepEqual(
        calls.map((call) => call.call.stepId),
        ['decompose'],
      );
      // Nothing was checked, yet the snapshot the output reports is pinned.
      assert.notEqual(output.snapshot, env.head);
      pinned(env, output.snapshot);
      untouched(env);
    },
  },
];

/**
 * A failed checker or challenger, or a criterion past the cap, means the gate is not whole; a
 * summary code wrote for a checked gate means the narrator failed.
 */
export const degraded = (output) =>
  output.status === 'degraded' ||
  output.status === 'limited' ||
  (output.status !== 'no-criteria' && output.summarySource === 'code');
