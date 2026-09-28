import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { CliHarness, defineWorkflow, readRun, runWorkflow, z } from '../dist/index.js';
import { packages, repository, sourceExample } from '../scripts/check-skills.mjs';
import { fences } from '../scripts/skill-markdown.mjs';

const root = await mkdtemp(join(tmpdir(), 'qc-skill-recipes-'));
function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 30_000, ...options });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
async function example(skillRoot, file, id) {
  const all = fences(await readFile(join(skillRoot, file), 'utf8'), file);
  const found = all.find((fence) => fence.id === id);
  assert.ok(found, `Missing actual documented example ${id}`);
  return found.code;
}
async function moduleExample(skillRoot, id, directory) {
  const file = join(directory, `${id}.mts`);
  await writeFile(
    file,
    sourceExample(
      await example(skillRoot, 'references/extensions.md', id),
      join(repository, 'dist/index.js'),
    ),
  );
  return tsImport(pathToFileURL(file).href, import.meta.url);
}
try {
  for (const [index, pkg] of packages.entries()) {
    const skillRoot = join(repository, pkg, 'skills/quiet-choir');
    const directory = join(root, String(index)),
      target = join(directory, 'target'),
      state = join(directory, 'state');
    await mkdir(target, { recursive: true });
    command('git', ['init', '--quiet'], { cwd: target });
    const workflow = join(directory, 'first.workflow.mts');
    await writeFile(
      workflow,
      sourceExample(
        await example(skillRoot, 'SKILL.md', 'first-workflow'),
        join(repository, 'dist/index.js'),
      ),
    );
    const env = {
      ...process.env,
      QC_CHECKOUT: repository,
      QC_TARGET: target,
      QC_WORKFLOW: workflow,
      QC_RUNS: state,
    };
    // A reused, previously exposed state directory and outputs must end up owner-only too.
    await mkdir(state);
    await chmod(state, 0o755);
    for (const name of ['first.result.json', 'first.log']) {
      await writeFile(join(state, name), 'stale');
      await chmod(join(state, name), 0o644);
    }
    const launch = command('sh', ['-c', await example(skillRoot, 'SKILL.md', 'golden-path')], {
      cwd: directory,
      env,
    });
    assert.equal((await stat(state)).mode & 0o777, 0o700);
    assert.equal((await stat(join(state, 'first.result.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(join(state, 'first.log'))).mode & 0o777, 0o600);
    let saved;
    for (let tries = 0; tries < 300; tries++) {
      try {
        saved = JSON.parse(await readFile(join(state, 'first.json'), 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (saved && saved.status !== 'running') break;
      await delay(100);
    }
    assert.equal(saved?.status, 'completed', await readFile(join(state, 'first.log'), 'utf8'));
    assert.equal(
      saved.cwd,
      await import('node:fs/promises').then(({ realpath }) => realpath(target)),
    );
    assert.equal(
      JSON.parse(launch.split('\n')[0]).workflow.fingerprint,
      saved.workflow.fingerprint,
    );
    assert.equal(saved.output.message, 'Hello from a durable local step.');
    assert.equal(command('git', ['status', '--porcelain'], { cwd: target }), '');
    const summary = command(
      'sh',
      ['-c', await example(skillRoot, 'references/operating-runs.md', 'jq-summary')],
      { cwd: target, env },
    );
    assert.deepEqual(JSON.parse(summary), {
      status: 'completed',
      error: null,
      counts: { completed: 1 },
      open: [],
    });

    const { loggingHarness } = await moduleExample(skillRoot, 'logging-harness', directory);
    const { resumeOrStart } = await moduleExample(skillRoot, 'resume-or-start', directory);
    const log = join(directory, 'responses.jsonl');
    const native = new CliHarness({ claudeBinary: join(repository, 'test/bin/fake-claude.mjs') });
    const harness = loggingHarness(log, native);
    assert.equal(harness.kind, native.kind);
    assert.deepEqual(harness.policyDefaults('claude'), native.policyDefaults('claude'));
    const mismatch = defineWorkflow({
      name: 'invalid-response',
      version: '1',
      input: z.object({}),
      output: z.object({ missing: z.string() }),
      async run(ctx) {
        return ctx.claude.value('ask', {
          prompt: 'Return structured data.',
          schema: z.object({ missing: z.string() }),
        });
      },
    });
    await assert.rejects(
      runWorkflow(mismatch, {
        runId: 'invalid-response',
        cwd: target,
        stateDir: state,
        input: {},
        harness,
        fingerprint: 'v1',
      }),
    );
    const raw = JSON.parse((await readFile(log, 'utf8')).trim());
    assert.equal(raw.provider, 'claude');
    assert.deepEqual(JSON.parse(raw.text), { answer: 'captured answer' });
    assert.equal(raw.usage.inputTokens, 7);
    assert.equal(raw.call.stepId, 'ask');
    assert.equal((await stat(log)).mode & 0o777, 0o600);
    const failed = await readRun({ runId: 'invalid-response', cwd: target, stateDir: state });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.steps.ask.attemptHistory[0].usage.inputTokens, 7);
    assert.equal(failed.harnesses.claude.version, '2.1.283');

    let calls = 0;
    const fake = {
      kind: 'recipe-fixture',
      async invoke(_request, { signal }) {
        signal.throwIfAborted();
        calls++;
        return {
          text: 'fixture',
          sessionId: null,
          usage: { inputTokens: null, outputTokens: null, costUsd: null },
        };
      },
    };
    let failTail = true;
    const resumable = defineWorkflow({
      name: 'resume-example',
      version: '1',
      input: z.object({ topic: z.string() }),
      output: z.string(),
      async run(ctx, input) {
        const value = await ctx.codex.value('answer', { prompt: input.topic });
        if (failTail) throw new Error('temporary tail failure');
        return value;
      },
    });
    const options = {
      runId: 'resume-example',
      cwd: target,
      stateDir: state,
      input: { topic: 'saved prompt' },
      harness: fake,
      fingerprint: 'v1',
    };
    await assert.rejects(resumeOrStart(resumable, options), /temporary tail failure/u);
    failTail = false;
    const resumed = await resumeOrStart(resumable, {
      ...options,
      input: { topic: 'must not replace saved input' },
    });
    assert.equal(resumed.output, 'fixture');
    assert.deepEqual(resumed.input, { topic: 'saved prompt' });
    assert.equal(calls, 1, 'Resume must reuse the completed agent effect');
    await resumeOrStart(resumable, options);
    assert.equal(calls, 1);
    await writeFile(join(state, 'corrupt.json'), '{broken');
    await assert.rejects(resumeOrStart(resumable, { ...options, runId: 'corrupt' }));
    assert.equal(await readFile(join(state, 'corrupt.json'), 'utf8'), '{broken');
    assert.equal(calls, 1, 'Corruption must not become a fresh run');

    // Logging failure is deliberately best effort, including after an external response succeeds.
    const noLog = loggingHarness(join(directory, 'absent-parent', 'responses.jsonl'), fake);
    const original = console.error;
    const warnings = [];
    console.error = (...args) => warnings.push(args);
    try {
      const response = await noLog.invoke(
        {
          provider: 'codex',
          options: { prompt: 'p' },
          cwd: target,
          outputSchema: null,
          call: { runId: 'r', stepId: 's', attempt: 1, idempotencyKey: 'r/s' },
        },
        { signal: new AbortController().signal },
      );
      assert.equal(response.text, 'fixture');
    } finally {
      console.error = original;
    }
    assert.equal(warnings.length, 1);
    assert.equal(command('git', ['status', '--porcelain'], { cwd: target }), '');
    console.log(`${pkg}: documented golden path, jq, logging, and resume recipes passed`);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
