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

/** The success run with completed replay and its assertions, without the fault matrix. */
export async function checkSuccess(name, { setup }) {
  const module = packagedFixtures[name];
  const env = await prepare(3, name, await setup()),
    definition = await load(3, name);
  const { harness, calls, replyErrors } = harnessFor(3, name, env),
    opts = await options(env, 3, name, harness);
  let approvedPlan;
  const { result, suspended } = await replied(
    module && replyErrors,
    name,
    drive(definition, opts, {
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
  await drive(definition, { ...opts, resume: true });
  assert.equal(calls.length, before, 'Completed replay must not call an agent');
  const record = await readRun(opts);
  const shape = recordShape(record);
  assert.equal(shape.templated, shape.agents, 'Every agent call renders a prompt template');
  if (module) await module.check({ result, env, calls, record, suspended });
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
  return { row, env, result, suspended, calls, shape };
}

/**
 * The success run with completed replay, its assertions and the F1–F5 matrix for one package.
 * `setup` makes a fresh fixture repository; `root` holds the kill case's own fixture.
 */
export async function checkPort(name, { setup, root }) {
  const module = packagedFixtures[name];
  const { row, env, result, suspended, calls, shape } = await checkSuccess(name, { setup });
  const writes = module ? killSpec(3, name) : !readOnlySix.includes(name);
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
            ? await killCase(join(root, `kill-3-${name}`), 3, name)
            : await notApplicable(
                env,
                module?.readOnly ?? 'Read-only intent: no prescribed write effect to kill',
              ),
          F4: await fixResume(setup, 3, name),
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
 * A fixture module's extra modes: each a fresh run under `harnessFor(..., { mode })` whose
 * outcome its `check` asserts, then a resume that must pay nothing again. A mode with `rejects`
 * expects the run to fail with that pattern; a refusal before the run starts leaves no record.
 * Every mode fails when a reply threw, unless it sets `allowReplyErrors`.
 */
export async function modeContracts(name, { setup }) {
  const rows = [];
  for (const mode of packagedFixtures[name]?.modes ?? []) {
    const env = await prepare(3, name, await setup()),
      definition = await load(3, name);
    const { harness, calls, replyErrors } = harnessFor(3, name, env, { mode: mode.mode });
    const base = runOptions(
      env,
      `mode-${mode.mode}`,
      harness,
      mode.input ? await mode.input(env) : await inputFor(3, name, env),
    );
    const opts = mode.options ? mode.options(base, env) : base;
    const checked = !mode.allowReplyErrors && replyErrors,
      label = `${name} ${mode.mode}`;
    if (mode.rejects) {
      await replied(checked, label, assert.rejects(drive(definition, opts), mode.rejects));
      const record = await readRun(opts).catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      await mode.check?.({ result: record, env, calls, record });
      rows.push({
        workflow: name,
        fixture: mode.mode,
        status: 'passed',
        finalStatus: record?.status ?? 'refused',
        agentCalls: calls.length,
      });
      continue;
    }
    const { result, suspended } = await replied(checked, label, drive(definition, opts));
    const record = await readRun(opts);
    await mode.check({ result, env, calls, record, suspended });
    const before = calls.length;
    await replied(checked, label, drive(definition, { ...opts, resume: true }));
    assert.equal(calls.length, before, `${mode.mode}: resume must not call an agent again`);
    rows.push({
      workflow: name,
      fixture: mode.mode,
      status: 'passed',
      finalStatus: result.status,
      outputStatus: result.output?.status ?? null,
      agentCalls: calls.length,
      completedCallsPaidAgain: 0,
    });
  }
  return rows;
}
