// The --events stream through the built CLI: stdout-only events, the --json and start refusals, a
// live grep match while a run is still running, replay drops on resume, and answer/tick/start appends.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));
const runtime = JSON.stringify(join(project, 'dist/index.js'));
const bin = join(project, 'bin/run.js');
const root = mkdtempSync(join(tmpdir(), 'choir-events-cli-'));
const stateDir = join(root, 'state');
const groups = new Set();
const children = new Set();

function cli(args, options = {}) {
  const result = spawnSync(
    process.execPath,
    [bin, 'workflow', ...args, '--state-dir', options.stateDir ?? stateDir],
    { cwd: root, encoding: 'utf8', timeout: 60_000 },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stderr);
  return result;
}
function expectExit(result, code) {
  assert.equal(result.status, code, `${result.stdout}\n${result.stderr}`);
  return result;
}
/** Every line of an events file or stdout: parsed JSON, each within the 512-byte cap. */
function eventLines(text) {
  const lines = text.split('\n').filter(Boolean);
  for (const line of lines)
    assert.ok(Buffer.byteLength(line) <= 512, `event line over 512 bytes: ${line}`);
  return lines.map((line) => JSON.parse(line));
}
const readEvents = (path) => eventLines(readFileSync(path, 'utf8'));
const summary = (events) =>
  events.map((event) => `${event.ev}${event.step === undefined ? '' : ` ${event.step}`}`);
async function until(check, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(25);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

const hunt = join(root, 'loop-until-dry.workflow.mts');
writeFileSync(
  hunt,
  readFileSync(join(project, 'examples/patterns/loop-until-dry.workflow.ts'), 'utf8').replace(
    "'../../src/index.js'",
    runtime,
  ),
);
const fixtures = join(root, 'hunt.fixtures.json');
writeFileSync(
  fixtures,
  JSON.stringify({
    version: 1,
    calls: [
      { step: 'hunt/0', output: { findings: ['a', 'b'] } },
      { step: 'hunt/1', output: { findings: ['a'] } },
    ],
  }),
);
const huntArgs = (runId) => [
  'execute',
  hunt,
  '--run-id',
  runId,
  '--input',
  '{"topic":"dry","rounds":5}',
  '--harness',
  `fixture:${fixtures}`,
];

const observed = join(root, 'observed.workflow.mts');
writeFileSync(
  observed,
  `import { defineWorkflow, z } from ${runtime};
export default defineWorkflow({ name: 'observed', version: '1', input: z.object({}), output: z.number(),
  async run(ctx) {
    ctx.phase('discover', { total: 1 });
    ctx.log('Scanning inputs', { count: 2 });
    const found = await ctx.step('scan', { input: null, schema: z.number(), run: () => 2 });
    return ctx.phase('verify', () => ctx.step('check', { input: found, schema: z.number(), run: () => found }));
  },
});
`,
);

const release = join(root, 'release');
const live = join(root, 'live.workflow.mts');
writeFileSync(
  live,
  `import { defineWorkflow, z } from ${runtime};
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
export default defineWorkflow({ name: 'live', version: '1', input: z.object({}), output: z.string(),
  async run(ctx) {
    try {
      await ctx.step('boom', { input: null, schema: z.null(), run: () => { throw new Error('boom failed'); } });
    } catch {}
    await ctx.step('hold', { input: null, schema: z.null(), run: async () => {
      while (!existsSync(${JSON.stringify(release)})) await delay(25);
      return null;
    } });
    return 'released';
  },
});
`,
);

const marker = join(root, 'marker');
const replay = join(root, 'replay.workflow.mts');
writeFileSync(
  replay,
  `import { defineWorkflow, z } from ${runtime};
import { existsSync } from 'node:fs';
export default defineWorkflow({ name: 'replay', version: '1', input: z.object({}), output: z.string(),
  async run(ctx) {
    ctx.log('begin', { round: 1 });
    await ctx.step('a', { input: null, schema: z.string(), run: () => 'a' });
    return ctx.step('b', { input: null, schema: z.string(), run: () => {
      if (!existsSync(${JSON.stringify(marker)})) throw new Error('marker missing');
      return 'b';
    } });
  },
});
`,
);

const questions = join(root, 'questions.workflow.mts');
writeFileSync(
  questions,
  `import { defineWorkflow, z } from ${runtime};
export default defineWorkflow({ name: 'questions', version: '1', input: z.object({}), output: z.boolean(),
  async run(ctx) {
    await ctx.step('plan', { input: null, schema: z.string(), run: () => 'plan A' });
    const answer = await ctx.approve('approve', { prompt: 'Apply plan A?', subject: { revision: 'A' }, audience: 'human' });
    return answer.approved;
  },
});
`,
);

try {
  // (a) loop-until-dry with --events -: stdout carries only events, the human result is on stderr.
  {
    const result = expectExit(cli([...huntArgs('hunt'), '--events', '-']), 0);
    const events = eventLines(result.stdout);
    assert.deepEqual(summary(events), [
      'run.started',
      'step.completed hunt/0',
      'step.completed hunt/1',
      'run.completed',
    ]);
    assert.ok(events.every((event) => event.run === 'hunt' && typeof event.t === 'string'));
    assert.equal(events[1].harness, 'claude');
    assert.equal(typeof events.at(-1).ms, 'number');
    assert.match(result.stderr, /Run hunt completed\./u);
    assert.match(result.stderr, /"a",\s*"b"/u);
  }
  // Phase and log lines, with --events=- spelling.
  {
    const result = expectExit(cli(['execute', observed, '--run-id', 'observed', '--events=-']), 0);
    const events = eventLines(result.stdout);
    assert.deepEqual(summary(events), [
      'run.started',
      'phase',
      'log',
      'step.completed scan',
      'phase',
      'step.completed check',
      'run.completed',
    ]);
    assert.deepEqual(events[1], { ...events[1], phase: 'discover', msg: 'discover' });
    assert.equal(events[2].msg, 'Scanning inputs {"count":2}');
    assert.equal(events[5].phase, 'verify');
    assert.match(result.stderr, /Run observed completed\./u);
  }

  // (b) - with --json is refused before any run work; FILE with --json leaves the document alone.
  {
    const refused = expectExit(cli([...huntArgs('refused'), '--events', '-', '--json']), 2);
    const error = JSON.parse(refused.stdout);
    assert.equal(error.error.code, 'usage.flag');
    assert.match(error.error.message, /--json reserves/u);
    assert.equal(existsSync(join(stateDir, 'refused')), false);
    const answerRefused = expectExit(
      cli([
        'answer',
        'refused',
        'approve',
        '--json',
        '{"approved":true}',
        '--resume',
        '--events=-',
      ]),
      2,
    );
    assert.equal(JSON.parse(answerRefused.stdout).error.code, 'usage.flag');
    const started = expectExit(
      cli(['start', hunt, '--run-id', 'start-refused', '--events', '-', '--json']),
      2,
    );
    assert.equal(JSON.parse(started.stdout).error.code, 'usage.flag');
    assert.match(JSON.parse(started.stdout).error.message, /launch result file/u);
    assert.equal(existsSync(join(stateDir, 'start-refused')), false);

    const file = join(root, 'json.events.jsonl');
    const otherState = join(root, 'other-state');
    const withEvents = expectExit(cli([...huntArgs('same'), '--events', file, '--json']), 0);
    const without = expectExit(cli([...huntArgs('same'), '--json'], { stateDir: otherState }), 0);
    const normalize = (text, state) =>
      JSON.parse(
        text
          .replaceAll(state, '<state>')
          .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z/gu, '<time>')
          .replace(/("[A-Za-z]*(?:Ms|ms)":)\d+/gu, '$10'),
      );
    assert.equal(withEvents.stdout.trim().split('\n').length, 1);
    assert.deepEqual(normalize(withEvents.stdout, stateDir), normalize(without.stdout, otherState));
    assert.deepEqual(summary(readEvents(file)), [
      'run.started',
      'step.completed hunt/0',
      'step.completed hunt/1',
      'run.completed',
    ]);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }

  // A sink that cannot open warns once and leaves the run and its exit unchanged.
  {
    const result = expectExit(
      cli([...huntArgs('no-parent'), '--events', join(root, 'missing', 'e.jsonl')]),
      0,
    );
    assert.equal(result.stderr.match(/Events: /gu)?.length, 1, result.stderr);
    assert.match(result.stdout, /Run no-parent completed\./u);
  }

  // (c) A Monitor-style filter sees the failure line while the run is still running.
  {
    const file = join(root, 'live.events.jsonl');
    const run = spawn(
      process.execPath,
      [
        bin,
        'workflow',
        'execute',
        live,
        '--run-id',
        'live',
        '--state-dir',
        stateDir,
        '--events',
        file,
      ],
      { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    children.add(run);
    let runStderr = '';
    run.stderr.setEncoding('utf8').on('data', (chunk) => {
      runStderr += chunk;
    });
    const runClosed = once(run, 'close');
    const monitor = spawn(
      'sh',
      ['-c', `tail -n +1 -F '${file}' | grep --line-buffered '"ev":"step.failed"'`],
      { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    groups.add(monitor.pid);
    let matched = '';
    monitor.stdout.setEncoding('utf8').on('data', (chunk) => {
      matched += chunk;
    });
    await until(() => matched.includes('\n') || run.exitCode !== null, 'the step.failed line');
    assert.equal(run.exitCode, null, `the run ended before the match: ${runStderr}`);
    assert.equal(existsSync(release), false);
    const [failure] = eventLines(matched);
    assert.equal(failure.ev, 'step.failed');
    assert.equal(failure.step, 'boom');
    assert.equal(failure.attempt, 1);
    writeFileSync(release, 'go');
    const [code] = await runClosed;
    children.delete(run);
    assert.equal(code, 0, runStderr);
    assert.deepEqual(summary(readEvents(file)), [
      'run.started',
      'step.failed boom',
      'step.completed hold',
      'run.completed',
    ]);
  }

  // (d) A resume appends only real transitions: no replayed step.completed or log echo.
  {
    const file = join(root, 'replay.events.jsonl');
    expectExit(cli(['execute', replay, '--run-id', 'replay', '--events', file]), 1);
    const first = readEvents(file);
    assert.deepEqual(summary(first).slice(0, 3), ['run.started', 'log', 'step.completed a']);
    assert.ok(summary(first).includes('step.failed b'));
    assert.equal(summary(first).at(-1), 'run.failed b');
    writeFileSync(marker, 'ok');
    expectExit(cli(['resume', 'replay', '--events', file]), 0);
    const second = readEvents(file).slice(first.length);
    assert.deepEqual(summary(second), ['run.started', 'step.completed b', 'run.completed']);
  }

  // (e) answer --resume appends to the file the suspended execution wrote.
  {
    const file = join(root, 'answer.events.jsonl');
    expectExit(cli(['execute', questions, '--run-id', 'gate', '--events', file]), 75);
    const first = readEvents(file);
    assert.deepEqual(summary(first), [
      'run.started',
      'step.completed plan',
      'wait.opened approve',
      'run.suspended',
    ]);
    assert.match(first[2].msg, /Apply plan A\?/u);
    // --events needs --resume on answer.
    expectExit(
      cli(['answer', 'gate', 'approve', '--value', '{"approved":true}', '--events', file]),
      2,
    );
    expectExit(
      cli([
        'answer',
        'gate',
        'approve',
        '--value',
        '{"approved":true}',
        '--by',
        'human:Pat',
        '--resume',
        '--events',
        file,
      ]),
      0,
    );
    assert.deepEqual(summary(readEvents(file).slice(first.length)), [
      'run.started',
      'step.completed approve',
      'run.completed',
    ]);
  }

  // tick resumes a due run and appends its lines.
  {
    const file = join(root, 'tick.events.jsonl');
    expectExit(cli(['execute', questions, '--run-id', 'ticked']), 75);
    expectExit(
      cli(['answer', 'ticked', 'approve', '--value', '{"approved":false}', '--by', 'human:Pat']),
      0,
    );
    expectExit(cli(['tick', '--run', 'ticked', '--events', file, '--json']), 0);
    const events = readEvents(file);
    assert.deepEqual(summary(events), ['run.started', 'step.completed approve', 'run.completed']);
    assert.ok(events.every((event) => event.run === 'ticked'));
  }

  // start passes --events FILE to its detached runner.
  {
    const file = join(root, 'start.events.jsonl');
    expectExit(
      cli(['start', hunt, ...huntArgs('started').slice(2), '--events', file, '--json']),
      0,
    );
    expectExit(
      cli(['inspect', 'started', '--watch', '--final', '--json', '--summary', '--timeout', '2m']),
      0,
    );
    assert.deepEqual(summary(readEvents(file)).at(-1), 'run.completed');
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
  console.log(
    'Events CLI: stdout-only events, --json/start refusals, live grep match, replay drop, answer/tick/start appends passed.',
  );
} finally {
  for (const pid of groups)
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      /* Already gone. */
    }
  for (const child of children) child.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
}
