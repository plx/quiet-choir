// Rehearsal gate for the workflow packages under packages/ (#589). For merge-down.quiet-choir it
// validates the package and checks the `package` section of `workflow validate --json`, checks
// the authoring rules the port must keep (no raw harness calls in the package, no multi-line
// literals in workflows/), and rehearses every case in packages/rehearsals/merge-down/ with
// `execute --dry-run --harness fixture:<case>.fixtures.json`: the run must complete with the
// expected ledger subset, answer every agent call and command from the fixtures, leave no
// fixture rule unused, and start the steps a case lists in `order` in that order (by their first
// command). Run after `npm run build`; the CLI runs from dist.
//
//   node scripts/rehearse-packages.mjs [case ...]
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ts from 'typescript';

const run = promisify(execFile);
const repository = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = join(repository, 'packages', 'merge-down.quiet-choir');
const cases = join(repository, 'packages', 'rehearsals', 'merge-down');
const cli = join(repository, 'bin', 'run.js');
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
async function checkValidate() {
  const result = await quietChoir(['workflow', 'validate', pkg, '--json']);
  if (result.ok !== true) {
    fail(`validate failed: ${JSON.stringify(result.error ?? result).slice(0, 2000)}`);
    return;
  }
  const section = result.package;
  const expect = (label, actual, wanted) => {
    if (JSON.stringify(actual) !== JSON.stringify(wanted))
      fail(
        `validate package.${label}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`,
      );
  };
  expect('name', section?.name, 'merge-down');
  expect('entry', section?.entry, 'merge-down-pr');
  expect(
    'workflows',
    section?.workflows?.map((w) => w.name),
    ['merge-down-pr'],
  );
  expect(
    'workflows[0].roster',
    section?.workflows?.[0]?.roster?.map((r) => `${r.name}:${r.harness}:${String(r.model)}`),
    [
      'Judge:claude:opus',
      'Mechanic:claude:sonnet',
      'Reviewer:claude:opus',
      'Scribe:claude:sonnet',
      'Surgeon:claude:opus',
    ],
  );
  expect('prompts', section?.prompts?.flatMap((set) => set.entries.map((e) => e.name)).sort(), [
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
  ]);
  const files = section?.files;
  if (!(files?.count > 0 && files?.bytes > 0 && /^[0-9a-f]{64}$/.test(files?.sha256 ?? '')))
    fail(
      `validate package.files: expected a count, bytes and a SHA-256, got ${JSON.stringify(files)}`,
    );
}

// ── Authoring rules ──────────────────────────────────────────────────────────────────────────
async function checkSources() {
  // Every agent call goes through ctx.roster (or a team slot filled from it) with a prompts.*
  // function; codex review is a command effect, not ctx.codex.
  for (const file of await sources(pkg)) {
    const text = await readFile(file, 'utf8');
    for (const [index, line] of text.split('\n').entries())
      if (/\bctx\.(claude|codex)\b|\bctx\.agent\(/.test(line))
        fail(
          `${relative(repository, file)}:${String(index + 1)}: raw harness call; use ctx.roster`,
        );
  }
  // Prose lives in prompts/*.md: no string or template literal in workflows/ carries a newline.
  for (const file of await sources(join(pkg, 'workflows'))) {
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

async function rehearse(name) {
  const {
    input,
    expect,
    order = [],
  } = JSON.parse(await readFile(join(cases, `${name}.json`), 'utf8'));
  const root = await mkdtemp(join(tmpdir(), `merge-down-${name}-`));
  try {
    const inputFile = join(root, 'input.json');
    await writeFile(inputFile, JSON.stringify({ ...input, root }));
    const report = await quietChoir([
      'workflow',
      'execute',
      pkg,
      '--dry-run',
      '--harness',
      `fixture:${join(cases, `${name}.fixtures.json`)}`,
      '--input',
      `@${inputFile}`,
      '--json',
    ]);
    const where = `rehearsal ${name}`;
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
    for (const command of report.commands ?? [])
      if (command.outputSource !== 'fixture' || command.error)
        fail(
          `${where}: command ${JSON.stringify(command.command)} of ${command.stepId}: ${command.error ?? command.outputSource}`,
        );
    const first = order.map((step) => (report.commands ?? []).findIndex((c) => c.stepId === step));
    order.forEach((step, index) => {
      if (first[index] === -1) fail(`${where}: step ${step} ran no command`);
      else if (index > 0 && first[index] < first[index - 1])
        fail(`${where}: step ${step} ran before ${order[index - 1]}`);
    });
    console.log(
      `Rehearsed ${name}: ${report.run.output.status}, ${String(report.calls?.length ?? 0)} agent call(s), ${String(report.commands?.length ?? 0)} command(s).`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const wanted = process.argv.slice(2);
const names = (await readdir(cases))
  .filter((file) => file.endsWith('.json') && !file.endsWith('.fixtures.json'))
  .map((file) => file.slice(0, -'.json'.length))
  .filter((name) => wanted.length === 0 || wanted.includes(name))
  .sort();
if (names.length === 0) fail(`no rehearsal cases in ${relative(repository, cases)}`);
await checkSources();
await Promise.all([checkValidate(), ...names.map(rehearse)]);
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  console.error(`Package rehearsals failed: ${String(problems.length)} problem(s).`);
  process.exitCode = 1;
} else {
  console.log(`Package rehearsals passed: ${String(names.length)} case(s).`);
}
