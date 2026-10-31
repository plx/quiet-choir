// Per-package checks for Batch 03, shared by verify-packaged-ports.mjs (every package, writing the
// reports) and check-packaged-port.mjs (one package, for authoring). A package is checked for
// hygiene, CLI validation, a success run with completed replay and its template coverage, the
// F1–F5 fault matrix and its fixture module's extra modes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { format } from 'prettier';
import ts from 'typescript';
import { readRun } from 'quiet-choir';
import { degradation, fixResume, options, scenario, stable } from './fault-matrix.mjs';
import {
  assertNoReplyErrors,
  command,
  drive,
  harnessFor,
  inputFor,
  killSpec,
  load,
  packageRoot,
  packagedFixtures,
  prepare,
  project,
  runOptions,
  snapshot,
} from './idiomatic-fixtures.mjs';
import { killCase } from './verify-idiomatic-faults.mjs';

const prettier = JSON.parse(await readFile(join(project, '.prettierrc.json'), 'utf8'));
export const formatJson = (value) => format(JSON.stringify(value), { parser: 'json', ...prettier });
const formattedLines = async (path) =>
  (await format(await readFile(path, 'utf8'), { parser: 'typescript', ...prettier }))
    .trimEnd()
    .split('\n').length;

async function files(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await files(path)));
    else found.push(path);
  }
  return found.sort();
}
// One category per package part, so the reader can show where the lines went.
const category = (path) =>
  path === 'package.ts'
    ? 'manifest'
    : path.startsWith('workflows/')
      ? 'workflows'
      : path === 'contracts.ts'
        ? 'contracts'
        : path === 'roster.ts'
          ? 'roster'
          : path === 'prompts.ts'
            ? 'promptIndex'
            : path.startsWith('prompts/')
              ? 'templates'
              : path.startsWith('lib/')
                ? 'lib'
                : 'resources';
async function composition(name) {
  const parts = {};
  let lines = 0,
    bytes = 0;
  const all = await files(packageRoot(name));
  for (const path of all) {
    const local = relative(packageRoot(name), path);
    const text = await readFile(path, 'utf8');
    const count = text.trimEnd().split('\n').length;
    const part = (parts[category(local)] ??= { files: 0, lines: 0 });
    part.files += 1;
    part.lines += count;
    lines += count;
    bytes += (await stat(path)).size;
  }
  return { files: all.length, lines, bytes, parts };
}
// The package hygiene of scripts/rehearse-packages.mjs: agents only through the roster or a team,
// and no literal in control flow that spans source lines (prose belongs in prompts/).
export async function hygiene(name) {
  for (const path of await files(packageRoot(name))) {
    if (!path.endsWith('.ts')) continue;
    const text = await readFile(path, 'utf8');
    assert.doesNotMatch(text, /\bctx\.(?:claude|codex)\b|\bctx\.agent\(/u, path);
    if (!relative(packageRoot(name), path).startsWith('workflows/')) continue;
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (
        (ts.isStringLiteral(node) ||
          ts.isNoSubstitutionTemplateLiteral(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node)) &&
        node.getText(source).includes('\n')
      )
        assert.fail(`${path}: multi-line literal; move the text to prompts/`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}
function recordShape(record) {
  const agents = Object.values(record.steps).filter((step) => step.request?.harness);
  const roles = {};
  for (const step of agents) roles[step.request.profile] = (roles[step.request.profile] ?? 0) + 1;
  return {
    templated: agents.filter((step) => step.request.promptTemplate).length,
    agents: agents.length,
    roles: Object.fromEntries(Object.entries(roles).sort()),
    templates: [...new Set(agents.map((step) => step.request.promptTemplate))].sort(),
  };
}

// The roster entry's effort is in the capability manifest of the declaring workflow's node.
function effortOf(node, workflow, entry) {
  if (node.name === workflow) {
    const role = node.capabilities.profiles[entry];
    return role?.[role.harness]?.effort ?? null;
  }
  for (const child of node.children ?? []) {
    const found = effortOf(child, workflow, entry);
    if (found !== undefined) return found;
  }
  return undefined;
}
/**
 * Validate one package through the CLI: no warning, the package and entry named like the
 * workflow. Returns the reader's manifest (absolute paths made relative) and the report row.
 */
export async function validatePackage(name) {
  await hygiene(name);
  const validated = spawnSync(
    process.execPath,
    [join(project, 'bin/run.js'), 'workflow', 'validate', packageRoot(name), '--json'],
    { cwd: project, encoding: 'utf8', timeout: 120_000 },
  );
  assert.equal(validated.status, 0, validated.stderr + validated.stdout);
  const { package: described, workflow } = JSON.parse(validated.stdout);
  assert.equal(described.name, name);
  assert.equal(described.entry, name);
  assert.equal(workflow.name, name);
  // Every warning would surface here: an unread parameter or a template problem fails the row.
  assert.doesNotMatch(validated.stderr, /\[warn\]/u, validated.stderr);
  const entries = described.prompts.flatMap((set) => set.entries);
  const manifest = {
    name: described.name,
    version: described.version,
    description: described.description,
    whenToUse: described.whenToUse,
    entry: described.entry,
    workflows: described.workflows.map((declared) => ({
      name: declared.name,
      version: declared.version,
      description: declared.description,
      module: relative(packageRoot(name), declared.entrypoint),
      roster: declared.roster.map((entry) => ({
        ...entry,
        effort: effortOf(workflow, declared.name, entry.name) ?? null,
      })),
    })),
    deciders: workflow.deciders,
    prompts: described.prompts.map((set) => ({
      root: relative(project, set.root),
      entries: set.entries,
    })),
    files: described.files,
  };
  const row = {
    workflow: name,
    fixture: 'package-validate',
    status: 'passed',
    workflows: described.workflows.map((declared) => declared.name),
    roster: Object.fromEntries(
      described.workflows.map((declared) => [
        declared.name,
        declared.roster.map((entry) => `${entry.name}:${entry.harness}/${entry.access}`),
      ]),
    ),
    deciders: Object.keys(workflow.deciders),
    prompts: entries.map((entry) => entry.name),
    fingerprintedFiles: described.files.count,
  };
  return { manifest, row };
}

// The success-run assertions of Batch 02's six; fixture modules carry their own `check`.
async function checkSix(name, { result, env, calls, opts, approvedPlan }) {
  if (name === 'release-notes') {
    assert.deepEqual(
      result.output.manifest,
      command(env.cwd, 'rev-list', '--reverse', `${env.since}..${env.until}`, '--').split('\n'),
    );
    assert.deepEqual(result.output.covered, result.output.manifest);
    assert.deepEqual(result.output.missing, []);
    assert.equal(result.output.status, 'verified');
    assert.equal(result.output.factChecked, true);
    assert.equal(
      await readFile(join(env.cwd, 'RELEASE_NOTES.md'), 'utf8'),
      `${result.output.notes}\n`,
    );
  }
  if (name === 'project-bootstrap') {
    assert.equal(result.output.status, 'applied');
    assert.equal(
      result.output.approvedDigest,
      createHash('sha256')
        .update(JSON.stringify(stable(approvedPlan.plan)))
        .digest('hex'),
    );
    assert.equal(result.output.appliedDigest, result.output.approvedDigest);
    const setters = calls.filter((call) => call.call.stepId.endsWith('/apply'));
    assert.equal(setters.length, 2);
    assert.equal(new Set(setters.map((call) => call.cwd)).size, 2);
    for (const call of setters) {
      assert.notEqual(call.cwd, env.cwd);
      assert.deepEqual(
        JSON.parse(call.options.prompt.split('Approved plan:\n')[1]),
        approvedPlan.plan,
      );
    }
    assert.ok(result.output.verification.every((check) => check.code === 0));
    assert.equal(await readFile(join(env.cwd, 'setup.txt'), 'utf8'), 'foundation\n');
    assert.equal(command(env.cwd, 'status', '--porcelain'), '');
  }
  if (name === 'test-gap-filler') {
    assert.equal(result.output.status, 'covered');
    assert.equal(result.output.mutations.length, 1);
    assert.equal(result.output.mutations[0].code, 1);
    assert.equal((await snapshot(env.cwd)).targetPristine, true);
  }
  if (name === 'incident-investigation') {
    assert.equal(result.output.clean, true);
    assert.equal(result.output.evidence.length, 4);
    assert.equal(result.output.confidence, 'high');
    assert.equal(result.output.rootCause, 'Lost update');
  }
  if (name === 'sdlc-orchestrator') {
    assert.equal(result.output.runId, opts.runId);
    assert.equal(result.output.status, 'complete');
    assert.equal(Object.keys(result.children).length, 2);
    assert.ok(result.output.stages.every((stage) => stage.review === 'human'));
  }
  if (name === 'bug-hunt') {
    assert.equal(result.output.status, 'complete');
    assert.deepEqual(
      result.output.findings.map((finding) => [finding.outcome, finding.upheld]),
      [['confirmed', 2]],
    );
  }
  if (name !== 'project-bootstrap')
    assert.ok(calls.every((call) => !(call.options.tools ?? []).includes('Write')));
}

const notApplicable = async (env, reason) => ({
  finalStatus: 'not-applicable',
  callsPaidAgain: 0,
  filesystem: await snapshot(env.cwd),
  outputAdmitsDegradation: null,
  reason,
});
const readOnlySix = ['incident-investigation', 'bug-hunt'];

/**
 * Await a fixture run, then fail when its replies threw (`replyErrors` falsy skips the check). A
 * settled call keeps a throwing reply as data, and a failed run's error would hide the cause.
 */
async function replied(replyErrors, label, run) {
  try {
    return await run;
  } finally {
    if (replyErrors) assertNoReplyErrors(replyErrors, label);
  }
}

// A node:assert generated message opens with a line that names no value (after any prefix such as
// `Step x failed: `); the values, or a `+ actual - expected` diff, follow it.
const assertOpener =
  /(?:^|: )(?:Expected values to be (?:strictly |loosely )?(?:deep-)?equal:|The expression evaluated to a falsy value:|The input (?:did not match|was expected to not match) the regular expression .*\. Input:)$/u;
const diffHeader = /^(?:\+ actual - expected|\.\.\. Skipped lines)$/u;
/**
 * The line of a message that says what failed: its first line, unless that is a generic node:assert
 * opener. Then the opener is followed by the first line that carries a value: for a diff, its first
 * actual (`+`) and expected (`-`) lines, whitespace collapsed, so `'applied' !== 'moved'` or the
 * changed field shows without the `cause`.
 */
export function headline(text) {
  const lines = String(text ?? '').split('\n');
  if (!assertOpener.test(lines[0])) return lines[0];
  const values = lines.slice(1).filter((line) => line.trim() && !diffHeader.test(line));
  const shown = lines.includes('+ actual - expected')
    ? ['+', '-'].flatMap((sign) => values.find((line) => line.startsWith(`${sign} `)) ?? [])
    : values.slice(0, 1);
  return [lines[0], ...shown.map((line) => line.trim().replace(/\s+/gu, ' '))].join(' ');
}
/**
 * What failed in a saved run, for a check's error: the run's status and error, then one line per
 * failed step (its ID, status, error kind and the `headline` of its message). The settled failures
 * follow under their own heading, since the run went on past them and a workflow may expect some
 * (a settled read of a file that should not exist): each settled-failed step, and each failed item
 * of a settled map (the map ID, the item's index and the step it failed at).
 */
export function failureSummary(record) {
  if (!record) return 'No run record: the run was refused before it saved one.';
  const failed = [],
    settled = [];
  for (const [id, step] of Object.entries(record.steps)) {
    if (step.status !== 'failed' && step.status !== 'settled-failed') continue;
    const kind = step.settledError?.kind ?? step.attemptHistory?.at(-1)?.errorKind ?? 'unknown';
    const message = step.settledError?.message ?? step.error;
    (step.status === 'failed' ? failed : settled).push(
      `${id} (${step.status}, ${kind}): ${headline(message)}`,
    );
  }
  for (const [id, map] of Object.entries(record.maps ?? {}))
    for (const [index, item] of (map.items ?? []).entries()) {
      if (item.outcome?.ok !== false) continue;
      const { kind, message, stepId } = item.outcome.error;
      const at = stepId ? ` at ${stepId}` : '';
      settled.push(
        `${id} item ${String(index)} (settled-failed${at}, ${kind}): ${headline(message)}`,
      );
    }
  const lines = [
    `Run ${record.id} ${record.status}${record.error ? `: ${headline(record.error)}` : ''}`,
    ...failed.map((line) => `  ${line}`),
  ];
  if (settled.length)
    lines.push(
      `  ${failed.length ? 'Settled' : 'No failed step. Settled'} failures, which the run kept as data:`,
      ...settled.map((line) => `    ${line}`),
    );
  else if (!failed.length) lines.push('  No failed or settled-failed step.');
  return lines.join('\n');
}
/**
 * Run the check `label` of the run that `opts` names; when it throws, rethrow with the error as
 * `cause` and the saved record's `failureSummary`, so a failed assertion names the steps that
 * failed. The error's `headline` follows the label once: a leading `<label>: ` or `<name>: ` of
 * its own is dropped.
 */
async function explained(name, label, opts, check) {
  try {
    return await check();
  } catch (error) {
    let summary;
    try {
      summary = failureSummary(await readRun(opts));
    } catch (unread) {
      summary =
        unread?.code === 'ENOENT'
          ? failureSummary(null)
          : `The run record could not be read: ${headline(unread?.message ?? unread)}`;
    }
    const line = headline(error?.message ?? error);
    const prefix = [`${label}: `, `${name}: `].find((own) => line.startsWith(own)) ?? '';
    throw new Error(`${label}: ${line.slice(prefix.length)}\n${summary}`, { cause: error });
  }
}

/** The success run with completed replay and its assertions, without the fault matrix. */
export async function checkSuccess(name, { setup }) {
  const env = await prepare(3, name, await setup()),
    definition = await load(3, name);
  const { harness, calls, replyErrors } = harnessFor(3, name, env),
    opts = await options(env, 3, name, harness);
  return explained(name, `${name} success`, opts, () =>
    successRun(name, { env, definition, calls, replyErrors, opts }),
  );
}
async function successRun(name, { env, definition, calls, replyErrors, opts }) {
  const module = packagedFixtures[name];
  let approvedPlan;
  const { result, suspended, questions } = await replied(
    module && replyErrors,
    name,
    drive(definition, opts, {
      env,
      onSuspended: (record) => {
        if (name === 'project-bootstrap') approvedPlan = record.pending[0].subject;
      },
    }),
  );
  assert.equal(result.status, 'completed', JSON.stringify(result.error ?? null));
  const before = calls.length;
  assert.equal(
    new Set(calls.map((call) => call.call.stepId)).size,
    calls.length,
    'Question resumes must not repeat completed calls',
  );
  await drive(definition, { ...opts, resume: true }, { env });
  assert.equal(calls.length, before, 'Completed replay must not call an agent');
  const record = await readRun(opts);
  const shape = recordShape(record);
  assert.equal(shape.templated, shape.agents, 'Every agent call renders a prompt template');
  if (module) await module.check({ result, env, calls, record, suspended, questions });
  else await checkSix(name, { result, env, calls, opts, approvedPlan });
  const row = {
    workflow: name,
    fixture: 'success-and-completed-replay',
    status: 'passed',
    agentCalls: calls.length,
    templatedCalls: shape.templated,
    roles: shape.roles,
    templates: shape.templates,
    completedCallsPaidAgain: 0,
    suspensions: suspended,
  };
  return { row, env, result, suspended, calls, shape, runId: opts.runId };
}

/**
 * The Git objects of a run's fixture repository as setup made them: every object reachable from the
 * commits `env` names (`since`, `until` and any a module's `setup` adds, such as `base`). Fixture
 * commits have fixed dates, so every run of one intent has the same IDs.
 */
function fixtureObjects(env) {
  const commits = Object.values(env).filter(
    (value) => typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value),
  );
  if (!commits.length) return [];
  return command(env.cwd, 'rev-list', '--objects', ...commits, '--')
    .split('\n')
    .map((line) => line.slice(0, 40));
}

/**
 * An output as JSON that another run of the same intent can equal: the run's checkout, scratch root
 * and run ID, every UUID (worktree directories carry one) and every number under a key ending in
 * `Ms` (a duration) are replaced. A Git object ID in `literal` (the fixture repository's own, see
 * `fixtureObjects`) stays as it is; any other, such as a commit dated at run time, is renamed in
 * order of first appearance, so only where each one recurs is compared.
 */
function portable(output, env, runId, literal) {
  const ids = new Map();
  return JSON.stringify(stable(output ?? null), (key, value) =>
    key.endsWith('Ms') && typeof value === 'number' ? '<ms>' : value,
  )
    .replaceAll(env.cwd, '<cwd>')
    .replaceAll(env.root, '<root>')
    .replaceAll(runId, '<run>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, '<uuid>')
    .replace(/\b[0-9a-f]{40}\b/gu, (id) => {
      if (literal.has(id)) return id;
      if (!ids.has(id)) ids.set(id, `<oid:${String(ids.size)}>`);
      return ids.get(id);
    });
}

/**
 * The success run with completed replay, its assertions and the F1–F5 matrix for one package.
 * `setup` makes a fresh fixture repository; `root` holds the kill case's own fixture.
 */
export async function checkPort(name, { setup, root }) {
  const module = packagedFixtures[name];
  const { row, env, result, suspended, calls, shape, runId } = await checkSuccess(name, { setup });
  const writes = module ? killSpec(3, name) : !readOnlySix.includes(name);
  // A fixture module's F3 and F4 cells say whether the resumed output is the success run's, once
  // each run's own paths and run ID are replaced (see `portable`); `faultCheck: true` makes a
  // difference fail.
  const compared = (fault, cell, output, resumedEnv, resumedRunId) => {
    const literal = new Set([...fixtureObjects(env), ...fixtureObjects(resumedEnv)]);
    const expected = portable(result.output, env, runId, literal),
      actual = portable(output, resumedEnv, resumedRunId, literal);
    if (module.faultCheck)
      assert.deepEqual(
        JSON.parse(actual),
        JSON.parse(expected),
        `${name} ${fault}: the resumed output differs from the success run's`,
      );
    return { ...cell, outputMatchesSuccess: actual === expected };
  };
  const kill = async () => {
    const killRoot = join(root, `kill-3-${name}`);
    const cell = await killCase(killRoot, 3, name);
    if (!module) return cell;
    const killed = JSON.parse(await readFile(join(killRoot, 'worker.json'), 'utf8'));
    const { output } = JSON.parse(await readFile(join(killRoot, 'result.json'), 'utf8'));
    return compared('F3', cell, output, killed, 'kill-case');
  };
  const fix = async () => {
    let output, fixed;
    const cell = await fixResume(setup, 3, name, {
      onResult: (resumed, resumedEnv) => {
        ({ output } = resumed);
        fixed = resumedEnv;
      },
    });
    return module ? compared('F4', cell, output, fixed, runId) : cell;
  };
  const metric = {
    workflow: name,
    batches: {
      3: {
        formattedLines: await formattedLines(join(packageRoot(name), 'workflows', `${name}.ts`)),
        package: await composition(name),
        agentCalls: calls.length,
        writeToolCalls: calls.filter(
          (call) =>
            (call.options.tools ?? []).some((tool) => /^(?:Write|Edit|Bash)(?:\(|$)/u.test(tool)) ||
            call.options.sandbox === 'workspace-write',
        ).length,
        templatedCalls: shape.templated,
        strictErrors: 0,
        faults: {
          F1: await scenario(setup, 3, name, 'F1'),
          F2: await scenario(setup, 3, name, 'F2'),
          F3: writes
            ? await kill()
            : await notApplicable(
                env,
                module?.readOnly ?? 'Read-only intent: no prescribed write effect to kill',
              ),
          F4: await fix(),
          F5: suspended
            ? {
                initialStatus: 'suspended',
                finalStatus: 'completed',
                suspensions: suspended,
                callsPaidAgain: 0,
                completedCallsPaidAgain: 0,
                filesystem: await snapshot(env.cwd),
                outputAdmitsDegradation: degradation(result, name),
                evidence: 'Real inbox answers and same-run replay in the success case',
              }
            : await notApplicable(env, 'This port has no human question effect'),
        },
      },
    },
  };
  return { row, metric };
}

/**
 * A rejects mode's `repair`: after its check, `repair.run(env, record)` heals the cause, and the run
 * resumes under a fresh harness in `repair.mode` (the mode's own by default) that appends to the
 * same `calls`. The resume must complete without paying a completed call again, and pay exactly
 * the step IDs `repair.paid` lists (in any order) when given; `resumeCheck` then asserts the
 * outcome, and a further resume must pay nothing.
 */
async function repairAndResume(name, definition, opts, context) {
  const { mode, env, calls, record, questions, label } = context;
  assert.ok(record, `${label}: a run refused before its record has nothing to resume`);
  const repairMode = mode.repair.mode ?? mode.mode;
  const completed = new Set(
    Object.entries(record.steps)
      .filter(([, step]) => step.status === 'completed')
      .map(([id]) => id),
  );
  await mode.repair.run?.(env, record);
  const before = calls.length;
  const { harness, replyErrors } = harnessFor(3, name, env, { mode: repairMode, calls });
  const resumed = { ...opts, harness, resume: true };
  const driven = { mode: repairMode, env, questions };
  const checked = !mode.allowReplyErrors && replyErrors;
  const { result, suspended } = await replied(
    checked,
    `${label} repaired`,
    drive(definition, resumed, driven),
  );
  assert.equal(
    result.status,
    'completed',
    `${label}: the repaired resume ended ${result.status}: ${JSON.stringify(result.error ?? null)}`,
  );
  const paid = calls.slice(before).map((call) => call.call.stepId);
  assert.deepEqual(
    paid.filter((id) => completed.has(id)),
    [],
    `${label}: the repaired resume paid completed calls again`,
  );
  if (mode.repair.paid)
    assert.deepEqual([...paid].sort(), [...mode.repair.paid].sort(), `${label}: calls paid`);
  await mode.resumeCheck?.({
    result,
    env,
    calls,
    record: await readRun(opts),
    suspended,
    questions,
  });
  const after = calls.length;
  await replied(checked, `${label} repaired`, drive(definition, resumed, driven));
  assert.equal(calls.length, after, `${label}: a completed resume must not call an agent again`);
  return { resumedStatus: result.status, resumedCalls: paid.length };
}

/**
 * The modes of `name` that `only` names, in the module's order, or every mode without `only`; a
 * name the module does not declare fails.
 */
export function selectModes(name, only) {
  const modes = packagedFixtures[name]?.modes ?? [];
  if (!only) return modes;
  const known = modes.map((mode) => mode.mode);
  const unknown = only.filter((wanted) => !known.includes(wanted));
  if (unknown.length)
    throw new Error(
      `${name} has no mode ${unknown.join(', ')}; its modes: ${known.join(', ') || 'none'}`,
    );
  return modes.filter((mode) => only.includes(mode.mode));
}

/**
 * A fixture module's extra modes: each a fresh run under `harnessFor(..., { mode })` whose
 * outcome its `check` asserts, then a resume that must pay nothing again. The module's `setup`
 * gets the mode, and the mode's own `setup` runs after it, before `input`. A mode with `rejects`
 * expects the run to fail with that pattern; a refusal before the run starts leaves no record. A
 * rejects mode with `repair` then heals the cause and resumes (see `repairAndResume`). Every mode
 * fails when a reply threw, unless it sets `allowReplyErrors`. `only` runs just the modes it names
 * (see `selectModes`). A failed mode throws with its run's `failureSummary`.
 */
export async function modeContracts(name, { setup, only }) {
  const rows = [];
  for (const mode of selectModes(name, only)) {
    const env = await prepare(3, name, await setup(), mode.mode);
    await mode.setup?.(env);
    const definition = await load(3, name);
    const { harness, calls, replyErrors } = harnessFor(3, name, env, { mode: mode.mode });
    const base = runOptions(
      env,
      `mode-${mode.mode}`,
      harness,
      mode.input ? await mode.input(env) : await inputFor(3, name, env),
    );
    const opts = mode.options ? mode.options(base, env) : base;
    const label = `${name} ${mode.mode}`;
    rows.push(
      await explained(name, label, opts, () =>
        modeRun(name, mode, { env, definition, calls, replyErrors, opts, label }),
      ),
    );
  }
  return rows;
}
async function modeRun(name, mode, { env, definition, calls, replyErrors, opts, label }) {
  const checked = !mode.allowReplyErrors && replyErrors;
  // The questions answered, kept across a rejected run and its repaired resume.
  const questions = [],
    driven = { mode: mode.mode, env, questions };
  if (mode.rejects) {
    await replied(
      checked,
      label,
      assert.rejects(drive(definition, opts, driven), mode.rejects, `${label}: no rejection`),
    );
    const record = await readRun(opts).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    await mode.check?.({ result: record, env, calls, record, questions });
    const row = {
      workflow: name,
      fixture: mode.mode,
      status: 'passed',
      finalStatus: record?.status ?? 'refused',
      agentCalls: calls.length,
    };
    if (mode.repair)
      Object.assign(
        row,
        await repairAndResume(name, definition, opts, {
          mode,
          env,
          calls,
          record,
          questions,
          label,
        }),
      );
    return row;
  }
  const { result, suspended } = await replied(checked, label, drive(definition, opts, driven));
  const record = await readRun(opts);
  await mode.check({ result, env, calls, record, suspended, questions });
  const before = calls.length;
  await replied(checked, label, drive(definition, { ...opts, resume: true }, driven));
  assert.equal(calls.length, before, `${label}: resume must not call an agent again`);
  return {
    workflow: name,
    fixture: mode.mode,
    status: 'passed',
    finalStatus: result.status,
    outputStatus: result.output?.status ?? null,
    agentCalls: calls.length,
    completedCallsPaidAgain: 0,
  };
}
