import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
/** Run the claude-launch and claude-monitor fences verbatim against first.workflow.mts. */
async function claudeRecipe(skillRoot, directory, target, state, env) {
  const launched = command('sh', ['-c', await example(skillRoot, 'SKILL.md', 'claude-launch')], {
    cwd: directory,
    env,
  });
  const last = JSON.parse(launched.trim().split('\n').at(-1));
  assert.equal(last.id, 'review-42');
  assert.equal(last.status, 'completed', launched);
  assert.deepEqual(last.output, { message: 'Hello from a durable local step.' });
  const events = join(state, 'review-42.events.jsonl');
  const monitor = spawn('sh', ['-c', await example(skillRoot, 'SKILL.md', 'claude-monitor')], {
    cwd: directory,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let output = '';
  monitor.stdout.setEncoding('utf8').on('data', (chunk) => {
    output += chunk;
  });
  try {
    for (let tries = 0; tries < 1200 && !output.includes('"ev":"run.completed"'); tries++)
      await delay(50);
  } finally {
    try {
      process.kill(-monitor.pid, 'SIGTERM');
    } catch {
      /* Already gone. */
    }
  }
  const matched = output
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    matched.map((line) => line.ev),
    ['run.completed'],
    output,
  );
  assert.equal(matched[0].run, 'review-42');
  assert.equal((await stat(events)).mode & 0o777, 0o600);
  const lines = (await readFile(events, 'utf8')).trim().split('\n');
  for (const line of lines) assert.ok(Buffer.byteLength(line) <= 512, line);
  assert.deepEqual(
    lines.map((line) => JSON.parse(line).ev),
    ['run.started', 'step.completed', 'run.completed'],
  );
  assert.equal(command('git', ['status', '--porcelain'], { cwd: target }), '');
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
    const launch = command('sh', ['-c', await example(skillRoot, 'SKILL.md', 'golden-path')], {
      cwd: directory,
      env,
    });
    const [validated, started, inspected] = launch
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(started.kind, 'workflow.start.result');
    assert.equal(started.ok, true);
    assert.equal(started.runId, 'first');
    // inspect ran right after start and read the record (the golden path exits 0 only then).
    assert.equal(inspected.id, 'first');
    // start creates the missing state directory and its launch files owner-only.
    const launchDir = join(state, 'first', 'launch');
    assert.equal((await stat(state)).mode & 0o777, 0o700);
    assert.equal((await stat(launchDir)).mode & 0o777, 0o700);
    assert.equal(started.result, join(launchDir, '1.result.json'));
    assert.equal(started.log, join(launchDir, '1.log'));
    assert.equal((await stat(started.result)).mode & 0o777, 0o600);
    assert.equal((await stat(started.log)).mode & 0o777, 0o600);
    let saved;
    for (let tries = 0; tries < 300; tries++) {
      saved = JSON.parse(await readFile(join(state, 'first', 'run.json'), 'utf8'));
      if (saved.status !== 'running') break;
      await delay(100);
    }
    assert.equal(saved?.status, 'completed', await readFile(started.log, 'utf8'));
    assert.equal(
      saved.cwd,
      await import('node:fs/promises').then(({ realpath }) => realpath(target)),
    );
    assert.equal(validated.workflow.fingerprint, saved.workflow.fingerprint);
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
    // Only the Claude package documents the run_in_background launch and its Monitor filter.
    if (pkg === packages[1]) await claudeRecipe(skillRoot, directory, target, state, env);

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
    assert.equal(raw.harness, 'claude');
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
          harness: 'codex',
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
    console.log(
      `${pkg}: documented golden path, ${pkg === packages[1] ? 'Claude launch and Monitor, ' : ''}jq, logging, and resume recipes passed`,
    );
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
