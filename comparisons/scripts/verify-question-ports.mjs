import assert from 'node:assert/strict';
import { readRun, runWorkflow, writeAnswer } from 'quiet-choir';

// These six cases replace differential equality for the two intentionally changed #55 ports.
// The upstream originals remain immutable; no native agents or workspace writes run here.
export async function verifyQuestionPorts({ definitions, sample, stateDir }) {
  const results = [];
  for (const mode of ['decline', 'approve', 'repair']) {
    const runId = `bootstrap-question-${mode}`;
    const calls = [];
    let interrupt = mode === 'repair';
    const harness = {
      async invoke(request) {
        calls.push(request);
        if (request.options.prompt.startsWith('Set up') && interrupt) {
          interrupt = false;
          throw new Error('fixture setup interruption');
        }
        let output = request.outputSchema
          ? sample(request.outputSchema, mode === 'repair' ? 'repair' : 'populated')
          : 'fixture text';
        if (request.options.prompt.startsWith('Plan the bootstrap')) {
          assert.equal(
            calls.filter((c) => c.options.prompt.startsWith('Plan the bootstrap')).length,
            1,
          );
          output.concerns[0].detail = 'APPROVED_PLAN_A';
        }
        return {
          text: request.outputSchema ? JSON.stringify(output) : output,
          sessionId: 'fixture',
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
        };
      },
    };
    const definition = definitions.get('project-bootstrap');
    const options = { runId, stateDir, harness };
    const suspended = await runWorkflow(definition, { ...options, input: {} });
    assert.equal(suspended.status, 'suspended');
    assert.equal(calls.length, 2);
    assert.equal(suspended.pending[0].stepId, 'approve-plan');
    assert.match(suspended.pending[0].details, /APPROVED_PLAN_A/u);
    const plan = suspended.pending[0].subject.plan;
    assert.equal(plan.concerns[0].detail, 'APPROVED_PLAN_A');
    await writeAnswer({
      stateDir,
      runId,
      stepId: 'approve-plan',
      value: { approved: mode !== 'decline' },
      by: 'human:fixture',
    });
    if (mode === 'repair')
      await assert.rejects(
        runWorkflow(definition, { ...options, resume: true }),
        /fixture setup interruption/u,
      );
    const completed = await runWorkflow(definition, { ...options, resume: true });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.output.applied, mode !== 'decline');
    const setup = calls.filter((call) => call.options.prompt.startsWith('Set up'));
    assert.equal(setup.length, mode === 'decline' ? 0 : mode === 'repair' ? 2 : 1);
    for (const call of setup) assert.match(call.options.prompt, /APPROVED_PLAN_A/u);
    assert.equal(completed.steps['approve-plan'].attempts, 1);
    assert.deepEqual(completed.steps['approve-plan'].question.request.subject.plan, plan);
    const before = calls.length;
    await runWorkflow(definition, { ...options, resume: true });
    assert.equal(calls.length, before);
    results.push({
      workflow: 'project-bootstrap',
      fixture: `durable-${mode}`,
      status: 'passed',
      contract: 'saved-plan-approval',
      agentCalls: calls.length,
      steps: Object.keys(completed.steps).length,
    });
  }
  for (const mode of ['plan', 'inline', 'redo']) {
    const runId = `sdlc-question-${mode}`;
    const calls = [];
    const harness = {
      async invoke(request) {
        calls.push(request);
        let output;
        if (request.call.stepId === 'intake')
          output = {
            entryStage: mode === 'redo' ? 'requirements' : 'spec',
            plan: mode === 'redo' ? ['requirements', 'spec'] : ['spec', 'implement'],
            flags: {},
          };
        else if (request.call.stepId.endsWith('/gate'))
          output = {
            gate: request.call.stepId === 'requirements/0/gate' ? 'blocked' : 'pass',
            blockingQuestions: ['Which durability rule?'],
            summary: 'Confirm durability.',
          };
        else
          output = request.outputSchema
            ? sample(request.outputSchema, 'populated')
            : 'fixture text';
        return {
          text: request.outputSchema ? JSON.stringify(output) : output,
          sessionId: 'fixture',
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
        };
      },
    };
    const definition = definitions.get('sdlc-orchestrator');
    const options = { stateDir, runId, harness };
    let completed = await runWorkflow(definition, {
      ...options,
      input: { goal: 'Build a queue', plan: mode === 'plan' },
    });
    if (mode === 'redo') {
      assert.equal(completed.status, 'suspended');
      assert.equal(completed.pending[0].stepId, 'requirements/0/review');
      const before = calls.length;
      await writeAnswer({
        stateDir,
        runId,
        stepId: 'requirements/0/review',
        value: { decision: 'redo', answer: 'HUMAN_STAGE_REQUIREMENTS_ONLY' },
        by: 'human:fixture',
      });
      completed = await runWorkflow(definition, { ...options, resume: true });
      const redo = calls.slice(before).filter((r) => r.call.stepId.startsWith('requirements/1/'));
      assert.ok(redo.length > 2);
      assert.ok(redo.every((r) => r.options.prompt.includes('HUMAN_STAGE_REQUIREMENTS_ONLY')));
      assert.ok(
        calls
          .filter((r) => r.call.stepId.startsWith('spec/'))
          .every((r) => !r.options.prompt.includes('HUMAN_STAGE_REQUIREMENTS_ONLY')),
      );
      assert.equal(calls.filter((r) => r.call.stepId === 'intake').length, 1);
      assert.equal(completed.steps['requirements/0/review'].attempts, 1);
      assert.equal((await readRun({ stateDir, runId })).input.goal, 'Build a queue');
    }
    assert.equal(completed.status, 'completed');
    assert.equal(completed.output.status, mode === 'plan' ? 'plan' : 'complete');
    if (mode === 'plan') assert.equal(calls.length, 1);
    if (mode === 'inline') {
      assert.deepEqual(completed.output.stagesRun, ['spec', 'implement']);
      assert.ok(
        calls.some(
          (r) => r.call.stepId.startsWith('spec/0/work/') && r.call.stepId.includes('child-'),
        ),
      );
      assert.ok(
        calls.some(
          (r) => r.call.stepId.startsWith('implement/0/work/') && r.call.stepId.includes('child-'),
        ),
      );
    }
    const before = calls.length;
    await runWorkflow(definition, { ...options, resume: true });
    assert.equal(calls.length, before);
    results.push({
      workflow: 'sdlc-orchestrator',
      fixture: `durable-${mode}`,
      status: 'passed',
      contract: 'one-run-stage-decisions',
      agentCalls: calls.length,
      steps: Object.keys(completed.steps).length,
    });
  }
  return results;
}
