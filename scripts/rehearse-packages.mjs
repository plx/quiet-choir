// Rehearsal gate for the workflow packages under packages/ (#589, #590). For each package in
// PACKAGES it validates the package and checks the `package` section of `workflow validate --json`,
// checks the authoring rules the ports must keep (no raw harness calls in the package, no
// multi-line literals in workflows/), and rehearses every case in its rehearsal directory with
// `execute --dry-run --harness fixture:<case>.fixtures.json`: the run must complete with the
// expected ledger subset, answer every agent call and command from the fixtures, leave no
// fixture rule unused, fail no command except the `{ step, error }` simulations a case lists in
// `failures` (each of which must happen), and start the steps a case lists in `order` in that
// order (by their first command). A case with `child: { label, workflow }` must also end with that
// inline child frame completed, and the run summary `workflow inspect` prints must show it. Run
// after `npm run build`; the CLI runs from dist.
//
//   node scripts/rehearse-packages.mjs [case | package/case ...]
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ts from 'typescript';

const run = promisify(execFile);
const repository = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(repository, 'bin', 'run.js');

/**
 * The packages and what their `package` section must say: name, entry, workflow names, roster
 * entries (`Name:harness:model`, sorted) and the names in the package's own prompt set.
 */
const PACKAGES = [
  {
    dir: 'merge-down.quiet-choir',
    cases: 'merge-down',
    name: 'merge-down',
    entry: 'merge-down-pr',
    workflows: ['merge-down-pr'],
    roster: [
      'Judge:claude:opus',
      'Mechanic:claude:sonnet',
      'Reviewer:claude:opus',
      'Scribe:claude:sonnet',
      'Surgeon:claude:opus',
    ],
    prompts: [
      'DraftFollowups',
      'EscalatedReview',
      'FollowupEpicBody',
      'Implement',
      'IssueSummary',
      'ResolveConflicts',
      'ReviewChange',
      'ReviewDependency',
      'TriageLocalReview',
      'TriageThreads',
    ],
  },
  {
    dir: 'execute-epic-ticket.quiet-choir',
    cases: 'execute-epic-ticket',
    name: 'execute-epic-ticket',
    entry: 'execute-epic-ticket',
    workflows: ['execute-epic-ticket'],
    roster: [
      'Mechanic:claude:sonnet',
      'Planner:claude:opus',
      'Scribe:claude:sonnet',
      'Skeptic:claude:opus',
      'Surgeon:claude:opus',
    ],
    prompts: [
      'CloseSplitComment',
      'DecisionComment',
      'FollowupEpicBody',
      'FollowupsSection',
      'Implement',
      'Plan',
      'Skeptic',
      'SplitComment',
      'WriteFollowups',
      'WritePr',
      'WriteSlices',
    ],
  },
].map((p) => ({
  ...p,
  root: join(repository, 'packages', p.dir),
  caseDir: join(repository, 'packages', 'rehearsals', p.cases),
}));
const problems = [];
const fail = (message) => problems.push(message);

async function quietChoir(args) {
  try {
    const { stdout } = await run(process.execPath, [cli, ...args], {
      cwd: repository,
      maxBuffer: 256 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (error) {
    if (typeof error?.stdout === 'string' && error.stdout.trim().startsWith('{'))
      return JSON.parse(error.stdout);
    throw error;
  }
}

/** Every `.ts` file under `directory`, recursively. */
async function sources(directory) {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

// ── The package section ──────────────────────────────────────────────────────────────────────
async function checkValidate(pkg) {
  const result = await quietChoir(['workflow', 'validate', pkg.root, '--json']);
  if (result.ok !== true) {
    fail(`${pkg.name}: validate failed: ${JSON.stringify(result.error ?? result).slice(0, 2000)}`);
    return;
  }
  const section = result.package;
  const expect = (label, actual, wanted) => {
    if (JSON.stringify(actual) !== JSON.stringify(wanted))
      fail(
        `${pkg.name}: validate package.${label}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`,
      );
  };
  expect('name', section?.name, pkg.name);
  expect('entry', section?.entry, pkg.entry);
  expect(
    'workflows',
    section?.workflows?.map((w) => w.name),
    pkg.workflows,
  );
  expect(
    'workflows[0].roster',
    section?.workflows?.[0]?.roster?.map((r) => `${r.name}:${r.harness}:${String(r.model)}`),
    pkg.roster,
  );
  // The package's own prompt set; a child's sets (merge-down's, for execute-epic-ticket) follow it.
  const own = section?.prompts?.filter((set) => set.root === join(pkg.root, 'prompts'));
  expect('prompts', own?.flatMap((set) => set.entries.map((e) => e.name)).sort(), pkg.prompts);
  const files = section?.files;
  if (!(files?.count > 0 && files?.bytes > 0 && /^[0-9a-f]{64}$/.test(files?.sha256 ?? '')))
    fail(
      `${pkg.name}: validate package.files: expected a count, bytes and a SHA-256, got ${JSON.stringify(files)}`,
    );
}

// ── Authoring rules ──────────────────────────────────────────────────────────────────────────
async function checkSources(pkg) {
  // Every agent call goes through ctx.roster (or a team slot filled from it) with a prompts.*
  // function; codex review is a command effect, not ctx.codex.
  for (const file of await sources(pkg.root)) {
    const text = await readFile(file, 'utf8');
    for (const [index, line] of text.split('\n').entries())
      if (/\bctx\.(claude|codex)\b|\bctx\.agent\(/.test(line))
        fail(
          `${relative(repository, file)}:${String(index + 1)}: raw harness call; use ctx.roster`,
        );
  }
  // Prose lives in prompts/*.md: no string or template literal in workflows/ carries a newline.
  for (const file of await sources(join(pkg.root, 'workflows'))) {
    const text = await readFile(file, 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      const literal =
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node);
      if (literal && (node.text.includes('\n') || node.getText(source).includes('\n'))) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        fail(
          `${relative(repository, file)}:${String(line + 1)}: multi-line literal; move the text to prompts/`,
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}

// ── Rehearsals ───────────────────────────────────────────────────────────────────────────────
/** Whether `actual` holds `expected`: objects by key, arrays element-wise at the same length. */
function subset(actual, expected, path, mismatches) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      mismatches.push(
        `${path}: expected ${String(expected.length)} item(s), got ${JSON.stringify(actual)}`,
      );
      return;
    }
    expected.forEach((item, index) =>
      subset(actual[index], item, `${path}[${String(index)}]`, mismatches),
    );
  } else if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object') {
      mismatches.push(`${path}: expected an object, got ${JSON.stringify(actual)}`);
      return;
    }
    for (const [key, value] of Object.entries(expected))
      subset(actual[key], value, `${path}.${key}`, mismatches);
  } else if (actual !== expected) {
    mismatches.push(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function rehearse(pkg, name) {
  const {
    input,
    expect,
    order = [],
    failures = [],
    child,
  } = JSON.parse(await readFile(join(pkg.caseDir, `${name}.json`), 'utf8'));
  const root = await mkdtemp(join(tmpdir(), `${pkg.cases}-${name}-`));
  try {
    const inputFile = join(root, 'input.json');
    await writeFile(inputFile, JSON.stringify({ ...input, root }));
    const report = await quietChoir([
      'workflow',
      'execute',
      pkg.root,
      '--dry-run',
      '--harness',
      `fixture:${join(pkg.caseDir, `${name}.fixtures.json`)}`,
      '--input',
      `@${inputFile}`,
      '--json',
    ]);
    const where = `rehearsal ${pkg.cases}/${name}`;
    if (report.ok !== true || report.run?.status !== 'completed') {
      fail(
        `${where}: ${report.run?.status ?? 'failed'}: ${JSON.stringify(report.error ?? report.run?.error).slice(0, 2000)}`,
      );
      return;
    }
    const mismatches = [];
    subset(report.run.output, expect, 'output', mismatches);
    for (const mismatch of mismatches) fail(`${where}: ${mismatch}`);
    if (report.staleExecFixtures?.length)
      fail(`${where}: stale exec fixtures ${JSON.stringify(report.staleExecFixtures)}`);
    if (report.staleCallFixtures?.length)
      fail(`${where}: stale call fixtures ${JSON.stringify(report.staleCallFixtures)}`);
    for (const call of report.calls ?? [])
      if (call.outputSource !== 'fixture')
        fail(`${where}: agent call ${call.stepId} was ${call.outputSource}`);
    // A fixture error rule the case lists in `failures` simulates a failed command on purpose.
    const simulated = (command) =>
      command.fixtureIndex !== null &&
      failures.some((f) => f.step === command.stepId && f.error === command.error);
    for (const command of report.commands ?? [])
      if (command.outputSource !== 'fixture' || (command.error && !simulated(command)))
        fail(
          `${where}: command ${JSON.stringify(command.command)} of ${command.stepId}: ${command.error ?? command.outputSource}`,
        );
    for (const f of failures)
      if (!(report.commands ?? []).some((c) => c.stepId === f.step && c.error === f.error))
        fail(`${where}: step ${f.step} never failed with ${JSON.stringify(f.error)}`);
    const first = order.map((step) => (report.commands ?? []).findIndex((c) => c.stepId === step));
    order.forEach((step, index) => {
      if (first[index] === -1) fail(`${where}: step ${step} ran no command`);
      else if (index > 0 && first[index] < first[index - 1])
        fail(`${where}: step ${step} ran before ${order[index - 1]}`);
    });
    if (child) await checkChild(where, report.run, child);
    console.log(
      `Rehearsed ${pkg.cases}/${name}: ${report.run.output.status}, ${String(report.calls?.length ?? 0)} agent call(s), ${String(report.commands?.length ?? 0)} command(s).`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * The inline child frame `child` names must have completed in the run record, and the run summary
 * `workflow inspect` prints must show it in the workflow tree: the record goes through the CLI's
 * own summarizeRun and formatRunSummary, with the ownership of a finished, unlocked run.
 */
async function checkChild(where, record, child) {
  const frame = Object.values(record.children ?? {}).find((c) => c.label === child.label);
  if (frame?.workflow?.name !== child.workflow || frame?.status !== 'completed') {
    fail(
      `${where}: expected a completed child frame ${child.label} of ${child.workflow}, got ${JSON.stringify(record.children ?? {})}`,
    );
    return;
  }
  const { summarizeRun } = await import(
    join(repository, 'dist', 'workflow', 'loader', 'inspection.js')
  );
  const { formatRunSummary } = await import(join(repository, 'dist', 'cli', 'inspection-view.js'));
  const ownership = { locked: false, owner: null, processes: [], locks: [] };
  const line = `${child.label}: ${child.workflow}@${frame.workflow.version} completed`;
  if (!formatRunSummary(summarizeRun(record, ownership)).includes(line))
    fail(`${where}: the inspect summary does not show "${line}"`);
}

const wanted = process.argv.slice(2);
const selected = [];
for (const pkg of PACKAGES) {
  const names = (await readdir(pkg.caseDir))
    .filter((file) => file.endsWith('.json') && !file.endsWith('.fixtures.json'))
    .map((file) => file.slice(0, -'.json'.length))
    .filter(
      (name) =>
        wanted.length === 0 || wanted.includes(name) || wanted.includes(`${pkg.cases}/${name}`),
    )
    .sort();
  if (names.length === 0 && wanted.length === 0)
    fail(`no rehearsal cases in ${relative(repository, pkg.caseDir)}`);
  selected.push(...names.map((name) => ({ pkg, name })));
}
if (selected.length === 0) fail(`no rehearsal case matches ${wanted.join(', ')}`);
for (const pkg of PACKAGES) await checkSources(pkg);
// Each case is a CLI process that type-checks its whole package (about 700 MB). Running all of them
// at once can exhaust a container's memory, and type-checking is CPU-bound, so run one per CPU.
const tasks = [
  ...PACKAGES.map((pkg) => () => checkValidate(pkg)),
  ...selected.map(
    ({ pkg, name }) =>
      () =>
        rehearse(pkg, name),
  ),
];
await Promise.all(
  Array.from({ length: Math.min(tasks.length, availableParallelism()) }, async () => {
    for (let task = tasks.shift(); task; task = tasks.shift()) await task();
  }),
);
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  console.error(`Package rehearsals failed: ${String(problems.length)} problem(s).`);
  process.exitCode = 1;
} else {
  console.log(
    `Package rehearsals passed: ${String(selected.length)} case(s) in ${String(PACKAGES.length)} package(s).`,
  );
}
