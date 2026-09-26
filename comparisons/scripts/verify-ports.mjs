// Differential fixture checks: execute the original harness dialect with inert
// agents, then run the port through the real durable engine with the same replies.
// No Claude process, shell command, network call, or workspace edit is performed.
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import ts from 'typescript';
import { runWorkflow, readRun } from 'quiet-choir';
const base = fileURLToPath(new URL('../batches/01-direct-ports/', import.meta.url));
const files = (await readdir(`${base}/originals`)).filter((f) => f.endsWith('.js')).sort();
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const normalize = (value) => JSON.parse(JSON.stringify(value));
const noLog = () => {};
const actualError = console.error;
console.error = noLog;
const stateDir = await mkdtemp(join(tmpdir(), 'choir-port-fixtures-'));
const sources = new Map(),
  definitions = new Map();
const inputs = {
  'acceptance-qa-batch': { tickets: 'tickets.md' },
  'acceptance-qa-deep': { criteria: 'criteria.md', ticket: 'Ticket context' },
  'api-migration': { from: 'old()', to: 'new()', paths: 'src/', notes: 'Keep behavior' },
  'dependency-upgrade': { package: 'example', maxFixRounds: 1 },
  'design-tournament': { brief: 'Design a queue' },
  'docs-drift-audit': { paths: 'docs/' },
  'feature-factory': { prd: 'prd.md' },
  'feedback-synthesis': { source: 'feedback/' },
  'incident-investigation': { incident: 'Requests time out', artifacts: 'logs/' },
  'prd-decompose': { prd: 'prd.md' },
  'prd-to-spec': { prd: 'prd.md', decideArchitecture: true },
  'release-notes': { since: 'v1.0.0' },
  'requirements-to-prd': { input: 'requirements.md', out: 'prd.md' },
  'research-synthesis': { question: 'How should retries work?' },
  'roadmap-plan': { spec: 'spec.md' },
  'sdlc-orchestrator': { goal: 'Build a queue', plan: true },
};
function sample(schema, mode, key = '', depth = 0) {
  if (schema.enum) {
    const preferred = [
      ...(mode === 'repair' ? ['blocker', 'survives'] : []),
      'pass',
      'demonstrated',
      'green',
      'flaky',
      'refactored',
      'done',
      'high',
      'go',
      'feature',
      'foundation',
    ];
    return preferred.find((x) => schema.enum.includes(x)) ?? schema.enum[0];
  }
  if (schema.type === 'object')
    return Object.fromEntries(
      Object.entries(schema.properties ?? {})
        .filter(([name]) => mode !== 'empty' || (schema.required ?? []).includes(name))
        .map(([name, s]) => [name, sample(s, mode, name, depth + 1)]),
    );
  if (schema.type === 'array')
    return mode !== 'empty' && depth < 8 ? [sample(schema.items, mode, key, depth + 1)] : [];
  if (schema.type === 'boolean')
    return ![
      'refuted',
      'done',
      'allPassed',
      'allGreen',
      'clean',
      'fixed',
      ...(mode === 'repair'
        ? ['passed', 'green', 'covered', 'complete', 'adequate', 'isFoundation']
        : []),
    ].includes(key);
  if (schema.type === 'number' || schema.type === 'integer') return key === 'failures' ? 0 : 1;
  if (schema.type === 'null') return null;
  if (schema.type === 'string') {
    if (['file', 'path', 'location', 'testFile', 'netFile'].includes(key)) return 'src/sample.ts';
    if (['proposal', 'letter'].includes(key)) return 'A';
    if (key === 'plan') return 'spec';
    return 'sample';
  }
  throw new Error(`Unsupported fixture schema: ${JSON.stringify(schema)}`);
}
for (const file of files) {
  const name = file.slice(0, -3),
    text = await readFile(`${base}/originals/${file}`, 'utf8');
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const meta = tree.statements.find(
    (n) =>
      ts.isVariableStatement(n) && n.declarationList.declarations[0]?.name.getText(tree) === 'meta',
  );
  const body = text.slice(0, meta.getStart(tree)) + text.slice(meta.end);
  sources.set(
    name,
    new AsyncFunction(
      'args',
      'agent',
      'parallel',
      'pipeline',
      'workflow',
      'phase',
      'log',
      'budget',
      body,
    ),
  );
  definitions.set(
    name,
    (await import(pathToFileURL(`${base}/ported/${name}.workflow.ts`))).default,
  );
}
const results = [];
let failed = 0;
try {
  for (const mode of ['empty', 'populated', 'repair'])
    for (const [name, definition] of definitions) {
      if (
        mode === 'repair' &&
        ![
          'api-migration',
          'codebase-atlas',
          'dead-code-sweep',
          'dependency-upgrade',
          'docs-drift-audit',
          'feature-factory',
          'flaky-test-hunt',
          'prd-decompose',
          'prd-to-spec',
          'project-bootstrap',
          'refactor-campaign',
          'release-gate',
          'release-notes',
          'research-synthesis',
          'sdlc-orchestrator',
        ].includes(name)
      )
        continue;
      const input = {
        ...(inputs[name] ?? {}),
        ...(mode === 'repair' ? { apply: true, fix: true, out: 'fixture-output.md' } : {}),
      };
      if (mode === 'repair' && name === 'sdlc-orchestrator') {
        delete input.plan;
        input.autoApprove = true;
        input.state = {
          goal: 'Build a queue',
          flags: { greenfield: true, hasFeedbackSource: true },
          inputs: {},
          answers: {},
          paths: {},
          plan: [
            'requirements',
            'roadmap',
            'backlog',
            'bootstrap',
            'qa',
            'release-gate',
            'release-notes',
            'feedback',
            'spec',
          ],
          cursor: 0,
          artifacts: {},
          log: [],
        };
      }
      const originalCalls = [],
        portedCalls = [];
      const respond = (prompt, schema, calls) => {
        const output = schema ? sample(schema, mode) : 'fixture text';
        calls.push({ prompt, output });
        return output;
      };
      async function original(workflowName, args) {
        return sources.get(workflowName)(
          args,
          (p, o) => Promise.resolve(respond(p, o?.schema, originalCalls)),
          (tasks) => Promise.all(tasks.map((fn) => fn())),
          (items, ...stages) =>
            Promise.all(
              items.map(async (item, index) => {
                let value = item;
                for (const stage of stages) value = await stage(value, item, index);
                return value;
              }),
            ),
          original,
          noLog,
          noLog,
          { total: 0, remaining: () => Infinity },
        );
      }
      let expected, expectedError;
      try {
        expected = normalize(await original(name, normalize(input)));
      } catch (e) {
        expectedError = e.message;
      }
      let actual,
        portError,
        stepCount = 0;
      try {
        const result = await runWorkflow(definition, {
          runId: `${name}-${mode}`,
          stateDir,
          input: normalize(input),
          harness: {
            async invoke(request) {
              assert.equal(request.provider, 'claude');
              return {
                text:
                  typeof request.outputSchema === 'object' && request.outputSchema !== null
                    ? JSON.stringify(
                        respond(request.options.prompt, request.outputSchema, portedCalls),
                      )
                    : respond(request.options.prompt, null, portedCalls),
                sessionId: 'fixture',
                usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
              };
            },
          },
        });
        actual = result.output;
        stepCount = Object.keys(result.steps).length;
        const callsBefore = portedCalls.length;
        const replay = await runWorkflow(definition, {
          runId: `${name}-${mode}`,
          stateDir,
          resume: true,
          harness: {
            invoke() {
              throw new Error('Completed run invoked a harness');
            },
          },
        });
        assert.deepEqual(replay.output, actual);
        assert.equal(callsBefore, portedCalls.length);
      } catch (e) {
        portError = e.message;
      }
      try {
        assert.equal(portError, expectedError, `Errors differ for ${name}/${mode}`);
        if (!expectedError)
          assert.deepEqual(actual, expected, `Output differs for ${name}/${mode}`);
        const canonical = (v) =>
          Array.isArray(v)
            ? v.map(canonical)
            : v && typeof v === 'object'
              ? Object.fromEntries(
                  Object.keys(v)
                    .sort()
                    .map((k) => [k, canonical(v[k])]),
                )
              : v;
        const stable = (calls) => calls.map((c) => JSON.stringify(canonical(c))).sort();
        assert.deepEqual(
          stable(portedCalls),
          stable(originalCalls),
          `Prompts/replies differ for ${name}/${mode}`,
        );
        results.push({
          workflow: name,
          fixture: mode,
          status: expectedError ? 'matching-source-error' : 'passed',
          agentCalls: portedCalls.length,
          steps: stepCount,
          ...(expectedError ? { sourceError: expectedError } : {}),
        });
        console.log(
          `PASS ${name} / ${mode} (${portedCalls.length} calls)${expectedError ? ' — both reject fixture: ' + expectedError : ''}`,
        );
      } catch (e) {
        failed++;
        results.push({ workflow: name, fixture: mode, status: 'failed', error: e.message });
        actualError(e.message);
      }
    }
  // A mid-pipeline interruption must reuse prior results, keep per-item IDs stable
  // under changed completion order, and retry only unfinished calls.
  const definition = definitions.get('acceptance-qa-batch');
  const requests = [];
  let fail = true;
  const harness = {
    async invoke(request) {
      const p = request.options.prompt;
      requests.push(p);
      if (p.startsWith('Ticket ') && fail) {
        fail = false;
        throw new Error('fixture interruption');
      }
      const output = p.startsWith('Parse ')
        ? {
            tickets: [
              { id: 'one', title: 'One', acceptanceCriteria: ['works'] },
              { id: 'two', title: 'Two', acceptanceCriteria: ['works'] },
            ],
            runContext: 'fixture',
          }
        : p.startsWith('Demonstrate ')
          ? { criteria: [{ criterion: 'works', status: 'demonstrated', evidence: 'fixture' }] }
          : { breaks: [] };
      return {
        text: JSON.stringify(output),
        sessionId: 'fixture',
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
      };
    },
  };
  await assert.rejects(
    runWorkflow(definition, {
      runId: 'resume-mid-pipeline',
      input: inputs['acceptance-qa-batch'],
      stateDir,
      harness,
    }),
    /fixture interruption/,
  );
  const before = await readRun(stateDir, 'resume-mid-pipeline');
  const completed = Object.entries(before.steps)
    .filter(([, s]) => s.status === 'completed')
    .map(([id]) => id);
  const events = [];
  const resumed = await runWorkflow(definition, {
    runId: 'resume-mid-pipeline',
    stateDir,
    resume: true,
    harness,
    onEvent: (e) => events.push(e),
  });
  assert.equal(resumed.output.passed, 2);
  for (const id of completed)
    assert.ok(events.some((e) => e.type === 'step.replayed' && e.stepId === id));
  results.push({
    workflow: 'acceptance-qa-batch',
    fixture: 'interrupted-pipeline-resume',
    status: 'passed',
    replayedSteps: completed.length,
  });
  console.log(
    `PASS interrupted pipeline resumes with ${completed.length} completed steps replayed`,
  );
  await writeFile(
    `${base}/verification.json`,
    JSON.stringify(
      {
        method:
          'Deterministic differential fixtures plus interrupted durable resume; no live agents',
        results,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  console.error = actualError;
  await rm(stateDir, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;
