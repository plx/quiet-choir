// Batch 03 verifier: the six packages under the Batch 02 fixture intents and F1–F5 matrix, plus
// the package contracts: validate --json package sections, prompt templates on every agent call,
// package hygiene, requireGrants delegation through the lifecycle and the decider-backed
// autoApprove through the CLI fixture harness.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { format } from 'prettier';
import ts from 'typescript';
import { readRun } from 'quiet-choir';
import { degradation, fixResume, options, scenario, stable } from './fault-matrix.mjs';
import {
  command,
  drive,
  fixture,
  harnessFor,
  inputFor,
  lifecycle,
  load,
  names,
  packageRoot,
  project,
  runOptions,
  snapshot,
} from './idiomatic-fixtures.mjs';
import { cliContracts, extraContracts, killCase } from './verify-idiomatic-faults.mjs';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--check') || args.length > 1)
  throw new Error('Usage: verify-packaged-ports.mjs [--check]');
const root = await mkdtemp(join(tmpdir(), 'choir-packaged-'));
const batchDir = join(project, 'comparisons/batches/03-packaged-ports');
const prettier = JSON.parse(await readFile(join(project, '.prettierrc.json'), 'utf8'));
const metrics = [],
  results = [];
const stderr = console.error;
console.error = () => {};
let sequence = 0;
const setup = async () => fixture(join(root, String(sequence++)));
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
async function hygiene(name) {
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
const cliEnv = (env) => ({
  ...process.env,
  XDG_STATE_HOME: join(env.root, 'xdg-state'),
  XDG_CACHE_HOME: join(env.root, 'xdg-cache'),
});
const cli = (env, ...argv) =>
  spawnSync(process.execPath, [join(project, 'bin/run.js'), 'workflow', ...argv], {
    cwd: env.cwd,
    encoding: 'utf8',
    timeout: 60_000,
    env: cliEnv(env),
  });

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
// What the reader shows for each package, as `workflow validate --json` reports it, with the
// checkout's absolute paths made relative to the package root.
const manifests = {};
async function packageContracts() {
  const rows = [];
  for (const name of names) {
    await hygiene(name);
    const validated = spawnSync(
      process.execPath,
      [join(project, 'bin/run.js'), 'workflow', 'validate', packageRoot(name), '--json'],
      { cwd: project, encoding: 'utf8', timeout: 60_000 },
    );
    assert.equal(validated.status, 0, validated.stderr + validated.stdout);
    const { package: described, workflow } = JSON.parse(validated.stdout);
    assert.equal(described.name, name);
    assert.equal(described.entry, name);
    assert.equal(workflow.name, name);
    // Every warning would surface here: an unread parameter or a template problem fails the row.
    assert.doesNotMatch(validated.stderr, /\[warn\]/u, validated.stderr);
    const entries = described.prompts.flatMap((set) => set.entries);
    manifests[name] = {
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
    rows.push({
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
    });
  }
  return rows;
}

async function grantContracts() {
  // Under requireGrants the children's entries delegate onto the orchestrator's Reader and Writer
  // ceilings through options.profiles; one Writer grant covers every isolated writer.
  const out = [];
  for (const [fixtureName, grants] of [
    ['require-grants-refuses-without-writer', []],
    ['require-grants-delegates-full-lifecycle', ['Writer']],
  ]) {
    const env = await setup(),
      definition = await load(3, 'sdlc-orchestrator');
    const { harness, calls } = harnessFor(3, 'sdlc-orchestrator', env, { mode: 'full-lifecycle' });
    const opts = {
      ...runOptions(env, fixtureName, harness, {
        ...inputFor(3, 'sdlc-orchestrator', env),
        allowedStages: lifecycle,
        since: env.since,
      }),
      requireGrants: true,
      grants,
    };
    if (!grants.length) {
      await assert.rejects(drive(definition, opts), /Writer/u);
      assert.equal(calls.length, 0);
      out.push({ workflow: 'sdlc-orchestrator', fixture: fixtureName, status: 'passed' });
      continue;
    }
    const { result } = await drive(definition, opts);
    assert.equal(result.status, 'completed');
    assert.equal(result.output.status, 'complete');
    assert.equal(result.output.stages.length, 10);
    assert.equal(command(env.cwd, 'status', '--porcelain'), '');
    out.push({
      workflow: 'sdlc-orchestrator',
      fixture: fixtureName,
      status: 'passed',
      grants,
      agentCalls: calls.length,
      children: Object.keys(result.children).length,
    });
  }
  // A bootstrap launched on its own needs only its one writing entry granted.
  const env = await setup(),
    definition = await load(3, 'project-bootstrap');
  const { harness } = harnessFor(3, 'project-bootstrap', env);
  const { result } = await drive(definition, {
    ...runOptions(env, 'bootstrap-grant', harness, inputFor(3, 'project-bootstrap', env)),
    requireGrants: true,
    grants: ['Setter'],
  });
  assert.equal(result.output.status, 'applied');
  out.push({
    workflow: 'project-bootstrap',
    fixture: 'require-grants-setter-only',
    status: 'passed',
    grants: ['Setter'],
  });
  return out;
}

async function deciderContracts() {
  const out = [];
  for (const [fixtureName, confidence] of [
    ['auto-approve-confident-decider', [0.95, 0.95]],
    ['auto-approve-low-confidence-asks-human', [0.95, 0.6]],
  ]) {
    const env = await setup();
    const answer = (value) => ({
      answers: {
        proceed: {
          choice: 'continue',
          probabilities: { continue: value, review: Number((1 - value).toFixed(2)) },
          confidence: value,
        },
      },
      model: 'jev-fixture',
      usage: { inputTokens: 10, outputTokens: 1 },
    });
    const fixtures = join(env.root, 'fixtures.json');
    await writeFile(
      fixtures,
      JSON.stringify({
        version: 1,
        unmatched: 'error',
        calls: [
          {
            step: 'intake',
            output: { plan: ['requirements', 'spec'], rationale: 'Fixture lifecycle' },
          },
          { step: '**/draft', text: 'Fixture document' },
          { step: '**/review', output: { summary: 'Ready', gate: 'pass', details: [] } },
        ],
        decisions: {
          'requirements/0/screen': answer(confidence[0]),
          'spec/0/screen': answer(confidence[1]),
        },
      }),
    );
    const executed = cli(
      env,
      'execute',
      packageRoot('sdlc-orchestrator'),
      '--run-id',
      fixtureName,
      '--state-dir',
      env.stateDir,
      '--input',
      JSON.stringify({ ...inputFor(3, 'sdlc-orchestrator', env), autoApprove: true }),
      '--harness',
      `fixture:${fixtures}`,
      '--grant',
      'all',
      '--json',
    );
    const asked = confidence.some((value) => value < 0.8);
    assert.equal(executed.status, asked ? 75 : 0, executed.stderr + executed.stdout);
    let final = JSON.parse(executed.stdout);
    if (asked) {
      assert.deepEqual(
        final.pending.map((question) => question.stepId),
        ['spec/0/review'],
      );
      const answered = cli(
        env,
        'answer',
        fixtureName,
        'spec/0/review',
        '--json',
        JSON.stringify({ decision: 'continue', answer: '' }),
        '--by',
        'human:fixture',
        '--resume',
        '--harness',
        `fixture:${fixtures}`,
        '--state-dir',
        env.stateDir,
      );
      assert.equal(answered.status, 0, answered.stderr + answered.stdout);
      final = JSON.parse(answered.stdout);
    }
    assert.equal(final.status, 'completed');
    assert.equal(final.output.status, 'complete');
    const reviews = final.output.stages.map((stage) => stage.review);
    assert.deepEqual(reviews, asked ? ['auto', 'human'] : ['auto', 'auto']);
    const record = await readRun({ stateDir: env.stateDir, runId: fixtureName });
    assert.equal(record.steps['requirements/0/screen'].meta.roster, 'Gatekeeper');
    out.push({
      workflow: 'sdlc-orchestrator',
      fixture: fixtureName,
      status: 'passed',
      exit: asked ? 75 : 0,
      reviews,
    });
  }
  return out;
}

try {
  const checked = spawnSync(
    join(project, 'node_modules/.bin/tsc'),
    ['-p', join(batchDir, 'tsconfig.json')],
    { cwd: project, encoding: 'utf8', timeout: 120_000 },
  );
  assert.equal(checked.status, 0, checked.stderr + checked.stdout);
  for (const name of names) {
    const env = await setup(),
      definition = await load(3, name);
    const { harness, calls } = harnessFor(3, name, env),
      opts = options(env, 3, name, harness);
    let approvedPlan;
    const { result, suspended } = await drive(definition, opts, {
      onSuspended: (record) => {
        if (name === 'project-bootstrap') approvedPlan = record.pending[0].subject;
      },
    });
    assert.equal(result.status, 'completed');
    const before = calls.length;
    assert.equal(
      new Set(calls.map((call) => call.call.stepId)).size,
      calls.length,
      'Question resumes must not repeat completed calls',
    );
    await drive(definition, { ...opts, resume: true });
    assert.equal(calls.length, before);
    const shape = recordShape(await readRun(opts));
    assert.equal(shape.templated, shape.agents, 'Every agent call renders a prompt template');
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
    results.push({
      workflow: name,
      fixture: 'success-and-completed-replay',
      status: 'passed',
      agentCalls: calls.length,
      templatedCalls: shape.templated,
      roles: shape.roles,
      templates: shape.templates,
      completedCallsPaidAgain: 0,
      suspensions: suspended,
    });
    metrics.push({
      workflow: name,
      batches: {
        3: {
          formattedLines: await formattedLines(join(packageRoot(name), 'workflows', `${name}.ts`)),
          package: await composition(name),
          agentCalls: calls.length,
          writeToolCalls: calls.filter(
            (call) =>
              (call.options.tools ?? []).some((tool) =>
                /^(?:Write|Edit|Bash)(?:\(|$)/u.test(tool),
              ) || call.options.sandbox === 'workspace-write',
          ).length,
          templatedCalls: shape.templated,
          strictErrors: 0,
          faults: {
            F1: await scenario(setup, 3, name, 'F1'),
            F2: await scenario(setup, 3, name, 'F2'),
            F3: ['incident-investigation', 'bug-hunt'].includes(name)
              ? {
                  finalStatus: 'not-applicable',
                  callsPaidAgain: 0,
                  filesystem: await snapshot(env.cwd),
                  outputAdmitsDegradation: null,
                  reason: 'Read-only intent: no prescribed write effect to kill',
                }
              : await killCase(join(root, `kill-3-${name}`), 3, name),
            F4: await fixResume(setup, 3, name),
            F5: suspended
              ? {
                  initialStatus: 'suspended',
                  finalStatus: 'completed',
                  suspensions: suspended,
                  callsPaidAgain: 0,
                  completedCallsPaidAgain: 0,
                  filesystem: await snapshot(env.cwd),
                  outputAdmitsDegradation: degradation(result),
                  evidence: 'Real inbox answers and same-run replay in the success case',
                }
              : {
                  finalStatus: 'not-applicable',
                  callsPaidAgain: 0,
                  filesystem: await snapshot(env.cwd),
                  outputAdmitsDegradation: null,
                  reason: 'This port has no human question effect',
                },
          },
        },
      },
    });
    console.log(`${name}: success, F1-F5 and template contracts passed`);
  }
  results.push(
    ...(await packageContracts()),
    ...(await extraContracts(join(root, 'contracts'), 3)),
    ...(await cliContracts(join(root, 'cli'), 3)),
    ...(await grantContracts()),
    ...(await deciderContracts()),
  );
  for (const row of metrics)
    for (const [fault, cell] of Object.entries(row.batches[3].faults))
      results.push({
        workflow: row.workflow,
        batch: 3,
        fixture: fault,
        status: cell.finalStatus === 'not-applicable' ? 'not-applicable' : 'passed',
        finalStatus: cell.finalStatus,
        callsPaidAgain: cell.callsPaidAgain,
      });
  const report = {
    method:
      'Real engine, packages loaded as the CLI loads them, temporary Git/process fixtures and the CLI fixture harness for decisions; inert agent replies; no live model or decision calls',
    results,
  };
  const measurements = {
    method:
      'The six Batch 02 fixture intents against the packages, with deterministic schema-valid replies. Counts are fixture path observations, not quality or billing savings. formattedLines is the workflow module alone; package lines are raw lines per part (manifest, workflows, contracts, roster, prompt index, templates, lib, resources). Pair with the Batch 02 metrics for the same workflow.',
    rows: metrics,
  };
  for (const [file, value] of [
    ['verification.json', report],
    ['metrics.json', measurements],
    ['packages.json', manifests],
  ]) {
    const text = await format(JSON.stringify(value), { parser: 'json', ...prettier });
    if (args.includes('--check'))
      assert.equal(await readFile(join(batchDir, file), 'utf8'), text, `Regenerate ${file}`);
    else await writeFile(join(batchDir, file), text);
  }
} finally {
  console.error = stderr;
  await rm(root, { recursive: true, force: true });
}
