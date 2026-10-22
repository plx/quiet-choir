// The decide-then-act recipe (#655): routes with a roster decider, acts with a tool-less agent and
// grades with a second decider, rehearsed through the CLI executor under --harness fixture and
// --dry-run with no provider base URL or token, then read back through inspect.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import { ThresholdLogger } from '../src/application/execution.js';
import type { HarnessFixtures } from '../src/harnesses/fixture.js';
import { WorkflowExecutor } from '../src/workflow/loader/executor.js';
import { inspectRun } from '../src/workflow/loader/inspection.js';
import { analyzeTypecheckEntrypoint } from '../src/workflow/typecheck/plan.js';
import { TypecheckProgramCache } from '../src/workflow/typecheck/program-cache.js';
import { it } from './setup/state-dir.js';

// One program cache for the file, so each compile after the first reuses its parse and checks
// (see CONTRIBUTING.md, "Test timeouts and storage sync").
const typecheckCache = new TypecheckProgramCache();
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const recipe = join(projectRoot, 'examples/patterns/decide-then-act.workflow.ts');
const ticket = 'I forgot my password and cannot sign in.';

async function recipeFixtures(): Promise<HarnessFixtures> {
  const text = await readFile(
    join(projectRoot, 'examples/patterns/decide-then-act.fixtures.json'),
    'utf8',
  );
  return JSON.parse(text) as HarnessFixtures;
}

function execute(
  stateDir: string,
  runId: string,
  options: { fixtures?: HarnessFixtures; dryRun?: boolean },
) {
  const analysis = analyzeTypecheckEntrypoint(recipe, projectRoot);
  if (!analysis.ok) throw new Error(analysis.error.message);
  const executor = new WorkflowExecutor({
    typecheckCache,
    logger: new ThresholdLogger('silent', () => undefined),
  });
  return executor.execute({
    kind: 'workflow.execute',
    typecheck: analysis.plan,
    runId,
    stateDir,
    cwd: stateDir,
    resume: false,
    input: { ticket },
    dryRun: options.dryRun ?? false,
    ...(options.fixtures === undefined
      ? {}
      : { harness: { kind: 'fixture' as const, config: {}, fixtures: options.fixtures } }),
  });
}

// measured: 1.4 s alone for the first compile, 4.8 s in the full coverage run (typecheck compile)
describe('the decide-then-act recipe', { timeout: 30_000 }, () => {
  beforeEach(() => {
    // No credentials: a decision that reached the provider would fail its configuration.
    vi.stubEnv('TYPESAFE_API_KEY', undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rehearses under --harness fixture and inspects both decisions', async ({ stateDir }) => {
    const executed = await execute(stateDir, 'fixture', { fixtures: await recipeFixtures() });
    expect(executed).toMatchObject({
      kind: 'workflow.run.result',
      ok: true,
      run: {
        status: 'completed',
        output: {
          outcome: 'sent',
          reply: 'Reset your password from Settings, then sign in again.',
        },
        harness: { kind: 'fixture' },
        steps: {
          triage: { meta: { integration: 'decision', op: 'decide', roster: 'Triage' } },
          grade: { meta: { integration: 'decision', op: 'decide', roster: 'Grader' } },
        },
      },
    });
    // A --harness fixture run reports no rehearsal (only --dry-run does): the served model shows
    // the fixture answered, and with no base URL or token a live request could not have.
    expect(executed).toMatchObject({
      run: {
        steps: {
          triage: { output: { model: 'jev-1.13' } },
          grade: { output: { model: 'jev-1.13' } },
        },
      },
    });

    const { summary } = await inspectRun({ stateDir, runId: 'fixture' });
    const decision = (id: string) => summary.steps.find((step) => step.id === id)?.decision;
    expect(decision('triage')).toEqual({
      op: 'decide',
      provider: 'jev',
      requestedModel: 'jev-latest',
      servedModel: 'jev-1.13',
      questions: [{ name: 'route', kind: 'choice', answer: 'answer', confidence: 0.85 }],
      usage: { attempts: 1, inputTokens: 140, outputTokens: 9 },
    });
    expect(decision('grade')).toEqual({
      op: 'decide',
      provider: 'jev',
      requestedModel: 'jev-latest',
      servedModel: 'jev-1.13',
      questions: [{ name: 'resolved', kind: 'noul', answer: 0.95 }],
      usage: { attempts: 1, inputTokens: 180, outputTokens: 4 },
    });
  });

  it('rehearses under --dry-run with the fixture file', async ({ stateDir }) => {
    const executed = await execute(stateDir, 'dry', {
      fixtures: await recipeFixtures(),
      dryRun: true,
    });
    expect(executed).toMatchObject({
      ok: true,
      run: { status: 'completed', output: { outcome: 'sent' } },
    });
    if (executed.kind !== 'workflow.run.result' || !executed.rehearsal)
      throw new Error('expected a rehearsal');
    expect(
      executed.rehearsal.decisions.map(({ stepId, provider, model, outputSource }) => ({
        stepId,
        provider,
        model,
        outputSource,
      })),
    ).toEqual([
      { stepId: 'triage', provider: 'jev', model: 'jev-latest', outputSource: 'fixture' },
      { stepId: 'grade', provider: 'jev', model: 'jev-latest', outputSource: 'fixture' },
    ]);
  });

  it('escalates without running the agent when the route confidence is low', async ({
    stateDir,
  }) => {
    const fixtures = await recipeFixtures();
    const unsure = {
      ...fixtures,
      decisions: {
        ...fixtures.decisions,
        triage: {
          answers: {
            route: {
              choice: 'answer',
              probabilities: { answer: 0.55, escalate: 0.45 },
              confidence: 0.5,
            },
          },
        },
      },
    };
    const executed = await execute(stateDir, 'unsure', { fixtures: unsure });
    expect(executed).toMatchObject({
      ok: true,
      run: { status: 'completed', output: { outcome: 'escalated', reply: '' } },
    });
    if (executed.kind !== 'workflow.run.result') throw new Error('expected a run');
    expect(Object.keys(executed.run.steps)).toEqual(['triage']);
  });

  it('reaches the needs-review branch under a bare --dry-run', async ({ stateDir }) => {
    // Synthesis picks the first option with confidence 1 and answers noul 0.
    const executed = await execute(stateDir, 'bare', { dryRun: true });
    expect(executed).toMatchObject({
      ok: true,
      run: { status: 'completed', output: { outcome: 'needs-review' } },
    });
    if (executed.kind !== 'workflow.run.result' || !executed.rehearsal)
      throw new Error('expected a rehearsal');
    expect(executed.rehearsal.decisions.map(({ outputSource }) => outputSource)).toEqual([
      'synthesized',
      'synthesized',
    ]);
  });
});
