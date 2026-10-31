// Batch 03 verifier: every package under its fixture intents and the F1–F5 matrix, plus the
// package contracts: validate --json package sections, prompt templates on every agent call,
// package hygiene, requireGrants delegation through the lifecycle and the decider-backed
// autoApprove through the CLI fixture harness. Batch 02's six reuse its fixture intents; the other
// ports bring a fixture module under packaged-fixtures/. packaged-checks.mjs holds the per-package
// checks, which check-packaged-port.mjs runs for one package while authoring.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readRun } from 'quiet-choir';
import {
  command,
  drive,
  fixture,
  harnessFor,
  inputFor,
  lifecycle,
  load,
  packageDirVariable,
  packageRoot,
  packagedNames,
  project,
  runOptions,
} from './idiomatic-fixtures.mjs';
import { checkPort, formatJson, modeContracts, validatePackage } from './packaged-checks.mjs';
import { cliContracts, extraContracts } from './verify-idiomatic-faults.mjs';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--check') || args.length > 1)
  throw new Error('Usage: verify-packaged-ports.mjs [--check]');
// The reports describe the committed packages, so a staged copy (check-packaged-port --root) is
// refused rather than measured.
if (process.env[packageDirVariable])
  throw new Error(`verify-packaged-ports.mjs checks ported/; unset ${packageDirVariable}`);
const root = await mkdtemp(join(tmpdir(), 'choir-packaged-'));
const batchDir = join(project, 'comparisons/batches/03-packaged-ports');
const metrics = [],
  results = [],
  manifests = {};
const stderr = console.error;
console.error = () => {};
let sequence = 0;
const setup = async () => fixture(join(root, String(sequence++)));
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
    { cwd: project, encoding: 'utf8', timeout: 300_000 },
  );
  assert.equal(checked.status, 0, checked.stderr + checked.stdout);
  const validated = [],
    modes = [];
  for (const name of packagedNames) {
    const { row, metric } = await checkPort(name, { setup, root });
    results.push(row);
    metrics.push(metric);
    const { manifest, row: validation } = await validatePackage(name);
    manifests[name] = manifest;
    validated.push(validation);
    modes.push(...(await modeContracts(name, { setup })));
    console.log(`${name}: success, F1-F5, validate and template contracts passed`);
  }
  results.push(
    ...validated,
    ...(await extraContracts(join(root, 'contracts'), 3)),
    ...modes,
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
      "Each package under its fixture intents (Batch 02's six reuse its intents), with deterministic schema-valid replies. Counts are fixture path observations, not quality or billing savings. formattedLines is the workflow module alone; package lines are raw lines per part (manifest, workflows, contracts, roster, prompt index, templates, lib, resources). Pair the six with the Batch 02 metrics for the same workflow.",
    rows: metrics,
  };
  for (const [file, value] of [
    ['verification.json', report],
    ['metrics.json', measurements],
    ['packages.json', manifests],
  ]) {
    const text = await formatJson(value);
    if (args.includes('--check'))
      assert.equal(await readFile(join(batchDir, file), 'utf8'), text, `Regenerate ${file}`);
    else await writeFile(join(batchDir, file), text);
  }
} finally {
  console.error = stderr;
  // Synchronous on purpose: every run leaves its AsyncLocalStorage instances registered with Node,
  // so after the whole matrix each async request carries thousands of properties, and the
  // promise-based recursive rm, which starts one request per entry at once, exhausts the heap.
  rmSync(root, { recursive: true, force: true });
}
