import assert from 'node:assert/strict';
import { runWorkflow, readRun } from 'quiet-choir';

// Intentional repairs to two inherited crash paths. Originals remain immutable;
// these cases name the divergence instead of claiming differential equivalence.
export async function verifyStrictPorts({ definitions, sources, sample, stateDir }) {
  const results = [];
  for (const name of ['dependency-upgrade', 'api-migration']) {
    const dependency = name === 'dependency-upgrade';
    const input = dependency
      ? { package: 'example', maxFixRounds: 1 }
      : { from: 'old()', to: 'new()', paths: 'src/' };
    const fixture = dependency ? 'missing-verification-clusters' : 'empty-migration-group';
    const reply = (prompt, schema) => {
      if (dependency && prompt.startsWith('Verify the '))
        return { passed: false, summary: 'No clusters reported' };
      const output = schema ? sample(schema, 'populated') : 'fixture text';
      if (!dependency && schema?.properties?.groups) output.groups[0].files = [];
      return output;
    };
    const source = sources.get(name);
    await assert.rejects(
      source(
        input,
        (prompt, options) => Promise.resolve(reply(prompt, options?.schema)),
        (tasks) => Promise.all(tasks.map((task) => task())),
        () => {
          throw new Error('Unexpected source pipeline');
        },
        () => {
          throw new Error('Unexpected source child');
        },
        () => {},
        () => {},
        { total: 0, remaining: () => Infinity },
      ),
      (error) => error instanceof TypeError && /undefined/.test(error.message),
      'The preserved original must reproduce the inherited crash.',
    );
    const calls = [];
    const harness = {
      invoke(request) {
        calls.push(request.options.prompt);
        const output = reply(request.options.prompt, request.outputSchema);
        return Promise.resolve({
          text: typeof output === 'string' ? output : JSON.stringify(output),
          sessionId: null,
        });
      },
    };
    const options = { runId: `strict-${name}`, stateDir, input, harness };
    if (dependency) {
      const run = await runWorkflow(definitions.get(name), options);
      assert.equal(run.output.status, 'unstable');
      assert.deepEqual(run.output.remaining, ['verifier reported failure without clusters']);
      assert.equal(
        calls.filter((prompt) => prompt.startsWith('Execute this dependency')).length,
        1,
      );
      const before = calls.length;
      await runWorkflow(definitions.get(name), { ...options, resume: true });
      assert.equal(calls.length, before, 'Replay must not repeat the applied upgrade.');
    } else {
      await assert.rejects(
        runWorkflow(definitions.get(name), options),
        /Migration group has no files/,
      );
      assert.equal(calls.length, 1, 'The empty group must not start a writer.');
      assert.equal((await readRun(options)).status, 'failed');
    }
    results.push({
      workflow: name,
      fixture,
      status: 'intentional-strictness-correction',
      sourceFailure: 'TypeError',
      finalStatus: dependency ? 'completed' : 'failed',
      agentCalls: calls.length,
      repeatedCompletedCalls: 0,
    });
    console.log(`PASS ${name} / ${fixture} (intentional inherited-crash correction)`);
  }
  return results;
}
