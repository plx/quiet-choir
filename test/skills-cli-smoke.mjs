import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { CliHarness, defineWorkflow, readRun, runWorkflow, stepId, z } from '../dist/index.js';
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
/** Spawn a shell fence in the background, collecting its stdout, as Monitor would run it. */
function background(code, options) {
  const child = spawn('sh', ['-c', code], {
    ...options,
    detached: true,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const state = { output: '', closed: once(child, 'close') };
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    state.output += chunk;
  });
  state.stop = () => {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* Already gone. */
    }
  };
  return state;
}
/** Wait for a background fence to exit, bounded so a hang fails the smoke instead of stalling it. */
async function finished(state, label) {
  const timer = delay(120_000, 'timeout', { ref: false });
  const outcome = await Promise.race([state.closed, timer]);
  state.stop();
  assert.notEqual(outcome, 'timeout', `${label} did not exit: ${state.output}`);
  return outcome[0];
}
const matchedEvents = (output) =>
  output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      assert.ok(Buffer.byteLength(line) <= 512, line);
      return JSON.parse(line);
    });
/**
 * Run every shell fence of the Claude package's /quiet-choir:run command verbatim, with the QC_*
 * values the command tells Claude to export. first.workflow.mts has no question, so the answer
 * loop runs against a local ask workflow written here.
 */
async function runCommandRecipe(pkg, directory, target, env) {
  const file = join(repository, pkg, 'commands/run.md');
  const all = fences(await readFile(file, 'utf8'), file);
  const shell = all.filter((fence) => ['sh', 'bash', 'shell', 'zsh'].includes(fence.language));
  for (const fence of shell)
    assert.ok(fence.id, `${file}:${fence.line}: shell fence without an ID`);
  const executed = new Set();
  const fence = (id) => {
    const found = shell.find((candidate) => candidate.id === id);
    assert.ok(found, `Missing command fence ${id}`);
    executed.add(id);
    return found.code;
  };
  const run = (id, values, expected = 0) => {
    const result = spawnSync('sh', ['-c', fence(id)], {
      cwd: directory,
      env: { ...env, ...values },
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, expected, `${id}: ${result.stdout}\n${result.stderr}`);
    return result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  };

  const first = { QC_RUN: 'command-first', QC_INPUT: '{}' };
  const [validated, rehearsed] = run('run-preflight', first);
  assert.equal(validated.kind, 'workflow.validate.result');
  assert.equal(validated.ok, true);
  assert.equal(rehearsed.kind, 'workflow.rehearsal');
  assert.equal(rehearsed.ok, true);
  // The follower starts alongside the launch and waits for the record to appear.
  const follow = background(fence('run-follow'), { cwd: directory, env: { ...env, ...first } });
  const launched = run('run-launch', first);
  const snapshot = launched.at(-1);
  assert.equal(snapshot.id, 'command-first');
  assert.equal(snapshot.status, 'completed');
  assert.deepEqual(snapshot.output, { message: 'Hello from a durable local step.' });
  assert.equal(await finished(follow, 'run-follow'), 0);
  assert.deepEqual(
    matchedEvents(follow.output).map((line) => `${line.run} ${line.ev}`),
    ['command-first run.completed'],
  );

  const askWorkflow = join(directory, 'ask.workflow.mts');
  await writeFile(
    askWorkflow,
    `import { defineWorkflow, z } from ${JSON.stringify(join(repository, 'dist/index.js'))};
export default defineWorkflow({ name: 'ask', version: '1', input: z.object({}), output: z.boolean(),
  async run(ctx) {
    return ctx.ask('gate', { prompt: 'Ship?', schema: z.boolean() });
  },
});
`,
  );
  const ask = { QC_WORKFLOW: askWorkflow, QC_RUN: 'command-ask', QC_INPUT: '{}' };
  const suspended = run('run-launch', ask, 75).at(-1);
  assert.equal(suspended.status, 'suspended');
  const [listed] = run('run-pending', ask);
  assert.equal(listed.kind, 'workflow.pending.result');
  const open = listed.pending.filter((entry) => entry.runId === 'command-ask');
  assert.equal(open.length, 1);
  assert.equal(open[0].prompt, 'Ship?');
  const answer = {
    ...ask,
    QC_STEP: open[0].stepId,
    QC_ANSWER: 'true',
    QC_BY: 'agent:skills-smoke',
    QC_EXECUTION: String(suspended.execution),
  };
  assert.equal(answer.QC_STEP, 'gate');
  const again = background(fence('run-follow-again'), {
    cwd: directory,
    env: { ...env, ...answer },
  });
  const answered = run('run-answer', answer).at(-1);
  assert.equal(answered.status, 'completed');
  assert.equal(answered.output, true);
  assert.equal(await finished(again, 'run-follow-again'), 0);
  assert.deepEqual(
    matchedEvents(again.output).map((line) => `${line.run} ${line.ev}`),
    ['command-ask run.completed'],
  );
  // A new shell block must be added to this smoke, not left unexecuted.
  assert.deepEqual([...executed].sort(), shell.map((candidate) => candidate.id).sort());
  assert.equal(command('git', ['status', '--porcelain'], { cwd: target }), '');
}
const recorded = async (name) =>
  JSON.parse(await readFile(join(repository, 'test/fixtures/github', name), 'utf8'));
/** Run a shell fence; return its exit status and parsed stdout lines. */
function shell(code, options) {
  const result = spawnSync('sh', ['-c', code], { encoding: 'utf8', timeout: 120_000, ...options });
  assert.equal(result.error, undefined, result.error?.message);
  const lines = result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { status: result.status, lines, output: `${result.stdout}\n${result.stderr}` };
}
/** The recorded pull request #329 as `pr.head` reads it, at `sha`, with a "Tests" check. */
async function prHeadAt(sha, conclusion) {
  const pr = (await recorded('pr-view.json')).data.repository.pullRequest;
  const nodes = [
    ...pr.commits.nodes[0].commit.statusCheckRollup.contexts.nodes,
    {
      __typename: 'CheckRun',
      name: 'Tests',
      status: 'COMPLETED',
      conclusion,
      detailsUrl: 'https://github.com/octo-org/quiet-choir/actions/runs/37078499704/job/1',
      checkSuite: { workflowRun: { databaseId: 37078499704 } },
    },
  ];
  const statusCheckRollup = {
    state: 'PENDING',
    contexts: { pageInfo: { hasNextPage: false }, nodes },
  };
  return {
    data: {
      repository: {
        pullRequest: {
          number: pr.number,
          state: 'OPEN',
          headRefOid: sha,
          commits: { nodes: [{ commit: { oid: sha, statusCheckRollup } }] },
        },
      },
    },
  };
}
/**
 * Run the GitHub recipes of patterns.md and the porting reference's fences once, against
 * fixture files written here from the recorded gh responses. `commands: 'fixture'` refuses any
 * command no rule answers, so no gh or git runs and nothing reaches github.com.
 */
async function portingRecipes(skillRoot) {
  const directory = join(root, 'porting'),
    target = join(directory, 'target'),
    state = join(directory, 'state');
  await mkdir(target, { recursive: true });
  command('git', ['init', '--quiet'], { cwd: target });
  const write = async (name, data) => {
    const file = join(directory, name);
    await writeFile(file, typeof data === 'string' ? data : JSON.stringify(data));
    return file;
  };
  const workflowFile = async (name, file, id) =>
    write(
      name,
      sourceExample(await example(skillRoot, file, id), join(repository, 'dist/index.js')),
    );
  const env = { ...process.env, QC_CHECKOUT: repository, QC_TARGET: target, QC_RUNS: state };
  const cli = (args) =>
    shell(`node "$QC_CHECKOUT/bin/run.js" workflow ${args}`, { cwd: target, env });

  // CI-gated fix loop: the first head fails "Tests", one fix and push, the new head passes.
  const first = (await recorded('pr-view.json')).data.repository.pullRequest.headRefOid;
  const second = '5b4b02c0e1f2a3b4c5d6e7f8091a2b3c4d5e6f70';
  const gate = await workflowFile(
    'ci-gate.workflow.mts',
    'references/patterns.md',
    'pattern-ci-gate',
  );
  const gateFixtures = await write('ci-gate.fixtures.json', {
    version: 1,
    calls: [{ step: stepId('fix', first), text: 'Fixed the failing test.' }],
    exec: [
      { step: 'head', json: await recorded('pr-view.json') },
      { step: stepId('ci', first), json: await prHeadAt(first, 'FAILURE') },
      { step: stepId('push', first), stdout: `${second}\n` },
      { step: stepId('ci', second), json: await prHeadAt(second, 'SUCCESS') },
    ],
    commands: 'fixture',
  });
  const gated = cli(
    `execute "${gate}" --run-id ci-gate --state-dir "$QC_RUNS" --harness fixture:"${gateFixtures}" --grant write --input '{"repo":"octo-org/quiet-choir","pr":329,"rounds":2}' --json`,
  );
  assert.equal(gated.status, 0, gated.output);
  assert.equal(gated.lines.at(-1).status, 'completed');
  assert.deepEqual(gated.lines.at(-1).output, { status: 'success', sha: second, fixes: 1 });

  // Ticket loop: the documented driver, with only a fixture harness added to its launch.
  const epic = await recorded('epic-snapshot.json');
  const closed = structuredClone(epic);
  closed.data.repository.issue.subIssues.nodes.find((item) => item.number === 163).state = 'CLOSED';
  const pages = await recorded('issue-view-comments.json');
  for (const page of pages) page.data.repository.issue.number = 163;
  const ticketFixtures = await write('ticket.fixtures.json', {
    version: 1,
    calls: [{ step: 'implement', text: 'Implemented.' }],
    exec: [
      { step: 'before', json: epic },
      { step: 'after', json: closed },
      { step: 'issue', json: pages },
      {
        step: 'close',
        argvPrefix: ['gh', 'api', 'graphql'],
        json: {
          data: { repository: { issue: { number: 163, state: 'OPEN', stateReason: null } } },
        },
      },
      { step: 'close', argvPrefix: ['gh', 'api', '-X', 'PATCH'], json: { number: 163 } },
    ],
    commands: 'fixture',
  });
  const driverFence = await example(skillRoot, 'references/patterns.md', 'ticket-driver');
  const driver = driverFence.replace(
    '--grant write',
    `--grant write --harness fixture:"${ticketFixtures}"`,
  );
  assert.notEqual(driver, driverFence);
  const ticketEnv = {
    ...env,
    QC_WORKFLOW: await workflowFile(
      'ticket-loop.workflow.mts',
      'references/patterns.md',
      'pattern-ticket-loop',
    ),
    QC_REPO: 'octo-org/quiet-choir',
    QC_EPIC: '99',
    QC_TICKET: '163',
  };
  const last = async (n) =>
    JSON.parse((await readFile(join(state, `ticket-${n}.out`), 'utf8')).trim().split('\n').at(-1));
  // A second pass resumes the saved runs instead of starting them again.
  for (const pass of [1, 2]) {
    const driven = shell(driver, { cwd: target, env: ticketEnv });
    assert.equal(driven.status, 0, `pass ${String(pass)}: ${driven.output}`);
    // ticket-163 closes and names #164; ticket-164 sees #163 still picked in the recording and skips.
    assert.deepEqual((await last(163)).output, { status: 'closed', next: 164 });
    assert.deepEqual((await last(164)).output, { status: 'skipped', next: 163 });
  }

  // A lagging read: the recorded `after` snapshot still lists ticket 163 open, so the driver stops.
  const lagging = await write('ticket-lag.fixtures.json', {
    ...JSON.parse(await readFile(ticketFixtures, 'utf8')),
    exec: [
      { step: 'before', json: epic },
      { step: 'after', json: epic },
      { step: 'issue', json: pages },
      {
        step: 'close',
        argvPrefix: ['gh', 'api', 'graphql'],
        json: {
          data: { repository: { issue: { number: 163, state: 'OPEN', stateReason: null } } },
        },
      },
      { step: 'close', argvPrefix: ['gh', 'api', '-X', 'PATCH'], json: { number: 163 } },
    ],
  });
  // Nonexistent: the driver itself must create it.
  const lagRuns = join(directory, 'lag-state');
  // A shim in front of the CLI records each subcommand the driver runs.
  const shim = join(directory, 'shim');
  const calls = join(directory, 'shim-calls.log');
  await mkdir(join(shim, 'bin'), { recursive: true });
  await writeFile(
    join(shim, 'bin/run.js'),
    `const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(calls)}, process.argv[3] + '\\n');
const { status } = require('node:child_process').spawnSync(
  process.execPath,
  [${JSON.stringify(join(repository, 'bin/run.js'))}, ...process.argv.slice(2)],
  { stdio: 'inherit' },
);
process.exit(status ?? 1);
`,
  );
  const stale = shell(driver.replace(ticketFixtures, lagging), {
    cwd: target,
    env: { ...ticketEnv, QC_RUNS: lagRuns, QC_CHECKOUT: shim },
  });
  assert.equal(stale.status, 1, stale.output);
  assert.equal((await stat(lagRuns)).mode & 0o777, 0o700);
  assert.match(stale.output, /The epic still names #163 after it closed/u);
  // One inspect and one execute, then the stop: no resume and no run for another ticket.
  assert.deepEqual((await readFile(calls, 'utf8')).trim().split('\n'), ['inspect', 'execute']);
  assert.deepEqual((await readdir(lagRuns)).filter((entry) => entry.startsWith('ticket-')).sort(), [
    'ticket-163',
    'ticket-163.out',
  ]);

  // The porting reference's exec role: its --grant fence verbatim, then refused without the grant.
  const roleEnv = {
    ...env,
    QC_WORKFLOW: await workflowFile(
      'fix.workflow.mts',
      'references/porting-native-workflows.md',
      'porting-exec-profile',
    ),
  };
  const grantFence = await example(
    skillRoot,
    'references/porting-native-workflows.md',
    'porting-exec-grant',
  );
  const granted = shell(grantFence, { cwd: target, env: roleEnv });
  assert.equal(granted.status, 0, granted.output);
  assert.equal(granted.lines.at(-1).ok, true);
  const refused = shell(grantFence.replace(' --grant fixer', ''), { cwd: target, env: roleEnv });
  assert.equal(refused.status, 2, refused.output);
  assert.match(refused.lines.at(-1).error.message, /Profile fixer requires exec access/u);

  // The bounded loop: its run-cap fence with a fixture harness and an attempt cap of 2, then a resume.
  const huntEnv = {
    ...env,
    QC_WORKFLOW: await workflowFile(
      'hunt.workflow.mts',
      'references/porting-native-workflows.md',
      'porting-budget-loop',
    ),
  };
  const huntFixtures = await write('hunt.fixtures.json', {
    version: 1,
    calls: [
      { step: 'find/1', output: { findings: ['a'] } },
      { step: 'find/2', output: { findings: ['b'] } },
      { step: 'find/*', output: { findings: [] } },
    ],
  });
  const capsFence = await example(
    skillRoot,
    'references/porting-native-workflows.md',
    'porting-budget-caps',
  );
  const capped = capsFence.replace(
    '--max-run-agent-attempts 8',
    `--max-run-agent-attempts 2 --harness fixture:"${huntFixtures}"`,
  );
  assert.notEqual(capped, capsFence);
  const stopped = shell(capped, { cwd: target, env: huntEnv });
  assert.equal(stopped.status, 1, stopped.output);
  assert.match(stopped.lines.at(-1).error.message, /maxRunAgentAttempts limit 2 reached/u);
  const resumed = cli('resume hunt-1 --state-dir "$QC_RUNS" --max-run-agent-attempts 16 --json');
  assert.equal(resumed.status, 0, resumed.output);
  assert.deepEqual(resumed.lines.at(-1).output, ['a', 'b']);
  assert.equal(resumed.lines.at(-1).usage.attempts, 3);
  assert.equal(command('git', ['status', '--porcelain'], { cwd: target }), '');
  console.log('porting reference and GitHub recipes passed');
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
    if (pkg === packages[1]) {
      await claudeRecipe(skillRoot, directory, target, state, env);
      await runCommandRecipe(pkg, directory, target, env);
    }

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
      `${pkg}: documented golden path, ${pkg === packages[1] ? 'Claude launch and Monitor, /quiet-choir:run blocks, ' : ''}jq, logging, and resume recipes passed`,
    );
  }
  // Both copies carry the same references (skills:check), so run these recipes once.
  await portingRecipes(join(repository, packages[1], 'skills/quiet-choir'));
} finally {
  await rm(root, { recursive: true, force: true });
}
