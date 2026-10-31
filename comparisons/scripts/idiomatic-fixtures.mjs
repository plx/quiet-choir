import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NodeProcessRunner, HarnessError, runWorkflow, writeAnswer } from 'quiet-choir';
import { sample } from './fixture-sample.mjs';

export const project = fileURLToPath(new URL('../../', import.meta.url));
export const names = [
  'release-notes',
  'project-bootstrap',
  'test-gap-filler',
  'incident-investigation',
  'sdlc-orchestrator',
  'bug-hunt',
];
// Batch 03 fixture modules for the ports beyond Batch 02's six, keyed by workflow name; see
// packaged-fixtures/README.md. Files starting with `_` are their shared support, not fixtures.
const fixturesDir = fileURLToPath(new URL('./packaged-fixtures/', import.meta.url));
export const packagedFixtures = Object.fromEntries(
  await Promise.all(
    (await readdir(fixturesDir))
      .filter((file) => file.endsWith('.mjs') && !file.startsWith('_'))
      .sort()
      .map(async (file) => {
        const name = file.slice(0, -'.mjs'.length);
        try {
          return [name, await import(pathToFileURL(join(fixturesDir, file)))];
        } catch (error) {
          // A module that fails to load fails only the checks of its own package.
          const broken = () => {
            throw new Error(`Fixture module ${file} failed to load`, { cause: error });
          };
          return [name, { input: broken, reply: broken, check: broken }];
        }
      }),
  ),
);
/** Every Batch 03 package: Batch 02's six, then the fixture-module ports in name order. */
export const packagedNames = [...names, ...Object.keys(packagedFixtures)];
export const lifecycle = [
  'requirements',
  'spec',
  'roadmap',
  'backlog',
  'bootstrap',
  'implement',
  'qa',
  'release-gate',
  'release-notes',
  'feedback',
];
export const pristine = 'export const value = 1;\n';
export const testContent = `import assert from 'node:assert/strict';\nimport { value } from './target.mjs';\nassert.equal(value, 1);\n`;
export const bug = {
  title: 'Lost update',
  file: 'target.mjs',
  line: 1,
  severity: 'high',
  evidence: 'Concurrent increments overwrite',
  failureScenario: 'Two writes read the same old value',
};
/** Batch 03 ports are packages: one `<name>.quiet-choir` directory per workflow. */
export const packageRoot = (name) =>
  join(project, 'comparisons/batches/03-packaged-ports/ported', `${name}.quiet-choir`);
export const load = async (batch, name) =>
  (
    await import(
      pathToFileURL(
        batch === 3
          ? join(packageRoot(name), 'workflows', `${name}.ts`)
          : join(
              project,
              'comparisons/batches',
              batch === 1 ? '01-direct-ports' : '02-idiomatic-ports',
              'ported',
              `${name}.workflow.ts`,
            ),
      )
    )
  ).default;
export function command(cwd, ...args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
export async function fixture(root) {
  await mkdir(root, { recursive: true });
  root = await realpath(root);
  const cwd = join(root, 'repo');
  await mkdir(cwd);
  command(cwd, 'init', '-q');
  await writeFile(join(cwd, 'target.mjs'), pristine);
  await writeFile(join(cwd, '.gitignore'), 'node_modules/\n');
  command(cwd, 'add', '.');
  command(
    cwd,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@localhost',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'baseline',
  );
  const since = command(cwd, 'rev-parse', 'HEAD');
  await writeFile(join(cwd, 'README.md'), 'Fixture project\n');
  command(cwd, 'add', '.');
  command(
    cwd,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@localhost',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'document project',
  );
  const until = command(cwd, 'rev-parse', 'HEAD');
  return {
    root,
    cwd,
    since,
    until,
    stateDir: join(root, 'state'),
    processRunner: new NodeProcessRunner(),
    worktrees: { root: join(root, 'worktrees') },
  };
}
export function inputFor(batch, name, env) {
  if (batch === 3 && packagedFixtures[name]) return packagedFixtures[name].input(env);
  if (batch === 1)
    return {
      $claude: { tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash'] },
      ...{
        'release-notes': { since: env.since, out: 'RELEASE_NOTES.md' },
        'project-bootstrap': { spec: 'Build a queue' },
        'test-gap-filler': { scope: 'target.mjs', count: 1 },
        'incident-investigation': { incident: 'Lost update', artifacts: 'logs/' },
        'sdlc-orchestrator': { goal: 'Build a queue' },
        'bug-hunt': { scope: 'target.mjs', maxRounds: 2, votes: 3 },
      }[name],
    };
  return {
    'release-notes': { since: env.since, out: 'RELEASE_NOTES.md' },
    'project-bootstrap': { spec: 'Build a queue', concerns: ['foundation', 'tests'] },
    'test-gap-filler': {
      target: 'target.mjs',
      testFile: 'target.test.mjs',
      testCommand: [process.execPath, 'target.test.mjs'],
      behavior: 'value is one',
    },
    'incident-investigation': { incident: 'Lost update', since: env.since },
    'sdlc-orchestrator': {
      goal: 'Build a queue',
      testCommand: [process.execPath, '-e', 'process.exit(0)'],
      allowedStages: ['requirements', 'spec'],
    },
    'bug-hunt': { scope: 'target.mjs', maxRounds: 2, votes: 3 },
  }[name];
}
export async function reply(batch, name, request, env, mode = 'normal') {
  const id = request.call.stepId,
    prompt = request.options.prompt;
  if (batch === 1) {
    if (name === 'bug-hunt' && request.outputSchema?.properties?.bugs)
      return { bugs: id.startsWith('round-1/') ? [bug] : [] };
    if (name === 'sdlc-orchestrator' && id === 'intake')
      return { entryStage: 'requirements', plan: ['requirements', 'spec'], flags: {} };
    if (name === 'sdlc-orchestrator' && id.endsWith('/gate'))
      return { gate: 'concerns', blockingQuestions: ['Review artifact'], summary: 'Review stage' };
    const output = request.outputSchema
      ? sample(request.outputSchema, 'populated')
      : 'Fixture document';
    if (name === 'test-gap-filler' && request.outputSchema) {
      // The old agent-owned mutation and new code-owned mutation address the same source bytes.
      for (const item of [...(output.gaps ?? []), ...(output.ranked ?? [])])
        item.file = 'target.mjs';
      if ('testFile' in output) output.testFile = 'target.test.mjs';
    }
    return output;
  }
  if (batch === 3) return packagedReply(name, request, env, mode);
  if (name === 'release-notes') {
    if (id.endsWith('/summarize'))
      return {
        changes:
          mode === 'missing-coverage'
            ? []
            : request.outputSchema.properties.changes.items.properties.sha.enum.map((sha) => ({
                sha,
                category: 'feature',
                summary: 'Document project',
              })),
      };
    if (id.startsWith('fact-check')) return { concerns: [] };
    return 'Release notes: documented project';
  }
  if (name === 'project-bootstrap') {
    if (id === 'detect') return { existing: [], missing: ['foundation', 'tests'] };
    if (id === 'plan')
      return {
        concerns: [
          { name: 'foundation', detail: 'APPROVED_PLAN_A', files: ['setup.txt'] },
          { name: 'tests', detail: 'Write test configuration', files: ['checks.txt'] },
        ],
        verifyCommands: [
          [
            process.execPath,
            '-e',
            mode === 'red-verify'
              ? 'process.exit(7)'
              : mode === 'signal-verify'
                ? "process.kill(process.pid, 'SIGKILL')"
                : "const fs=require('node:fs');if(fs.readFileSync('setup.txt','utf8')!=='foundation\\n'||fs.readFileSync('checks.txt','utf8')!=='tests\\n')process.exit(3)",
          ],
        ],
      };
    if (id.endsWith('/apply')) {
      const foundation = prompt.startsWith('Apply only concern foundation');
      await writeFile(
        join(request.cwd, foundation ? 'setup.txt' : 'checks.txt'),
        foundation ? 'foundation\n' : 'tests\n',
      );
      return { summary: 'Applied approved concern' };
    }
  }
  if (name === 'test-gap-filler') {
    if (id.endsWith('/gaps'))
      return {
        gaps:
          mode === 'no-gaps'
            ? []
            : [{ key: 'value', reason: 'No equality assertion for the value contract' }],
      };
    if (id === 'rank') return { selected: ['value'] };
    return {
      test: testContent,
      mutants: [
        { id: 'zero', before: 'value = 1', after: 'value = 0', reason: 'Detect incorrect value' },
      ],
    };
  }
  if (name === 'incident-investigation') {
    if (id.endsWith('/collect')) {
      assert.equal(request.harness, 'codex');
      assert.equal(request.options.sandbox, 'read-only');
      if (mode === 'dirty')
        await writeFile(join(request.cwd, 'unexpected.txt'), 'collector violated read-only intent');
      return { observations: ['Commit added README'], unknowns: [] };
    }
    if (id === 'hypotheses')
      return { items: [{ cause: 'Lost update', evidence: ['Concurrent writes'] }] };
    if (id.endsWith('/challenge')) return { counterEvidence: [] };
    return {
      conclusion: 'Investigate concurrent writes',
      uncertainties: ['Need production trace'],
    };
  }
  if (name === 'sdlc-orchestrator') {
    if (id === 'intake')
      return {
        plan: mode === 'full-lifecycle' ? lifecycle : ['requirements', 'spec'],
        rationale: 'Prepare feature',
      };
    for (const [stage, child] of [
      ['bootstrap', 'project-bootstrap'],
      ['release-notes', 'release-notes'],
    ]) {
      if (id.startsWith(`${stage}/`))
        return reply(
          2,
          child,
          { ...request, call: { ...request.call, stepId: id.split('/work/')[1] } },
          env,
          mode,
        );
    }
    if (id.startsWith('implement/') && id.endsWith('/apply')) {
      await writeFile(join(request.cwd, 'implementation.txt'), 'Implemented fixture\n');
      return 'Implemented fixture';
    }
    if (id.endsWith('/review')) return { summary: 'Ready', gate: 'pass', details: [] };
    return 'Fixture lifecycle document';
  }
  if (name === 'bug-hunt') {
    if (id.endsWith('/find')) return { bugs: id.startsWith('round/0/') ? [bug] : [] };
    return { refuted: id.includes('/1/'), reasoning: 'Fixture evidence' };
  }
  throw new Error(`Unhandled fixture request: ${name} ${id}`);
}
// Batch 03 replies: the same intents and fixture data as Batch 02, keyed by the packages' step IDs
// (std.patterns adds `answer`, `review/<n>` and `revise/<n>` leaves).
async function packagedReply(name, request, env, mode) {
  if (packagedFixtures[name]) return packagedFixtures[name].reply(request, env, mode);
  const id = request.call.stepId,
    prompt = request.options.prompt;
  if (name === 'release-notes') {
    if (id.endsWith('/summarize'))
      return {
        changes:
          mode === 'missing-coverage'
            ? []
            : request.outputSchema.properties.changes.items.properties.sha.enum.map((sha) => ({
                sha,
                kind: 'feature',
                summary: 'Document project',
                userVisible: true,
                migrationNote: null,
              })),
      };
    if (/(?:^|\/)fact-check\/review\/\d+$/u.test(id)) return { approved: true, feedback: '' };
    return 'Release notes: documented project';
  }
  if (name === 'project-bootstrap') {
    if (id === 'detect')
      return { stack: 'Node.js', existing: [], missing: ['foundation', 'tests'] };
    if (id === 'plan') return reply(2, name, request, env, mode);
    if (id.endsWith('/apply')) {
      const foundation = prompt.startsWith('Apply only concern foundation');
      await writeFile(
        join(request.cwd, foundation ? 'setup.txt' : 'checks.txt'),
        foundation ? 'foundation\n' : 'tests\n',
      );
      return { summary: 'Applied approved concern' };
    }
  }
  if (name === 'test-gap-filler') return reply(2, name, request, env, mode);
  if (name === 'incident-investigation') {
    if (id.endsWith('/collect')) {
      assert.equal(request.harness, 'codex');
      assert.equal(request.options.sandbox, 'read-only');
      if (mode === 'dirty')
        await writeFile(join(request.cwd, 'unexpected.txt'), 'collector violated read-only intent');
      return {
        facts: [
          {
            fact: 'Commit added README',
            source: env.until,
            timestamp: '2020-01-01T00:00:00Z',
            oddity: false,
          },
        ],
      };
    }
    if (id === 'hypotheses')
      return {
        hypotheses: [
          {
            id: 'H1',
            story: 'Lost update',
            mechanism: 'Concurrent writes overwrite each other',
            predictions: ['Two writers read the same value'],
            priorPlausibility: 'high',
          },
          {
            id: 'H2',
            story: 'Configuration drift',
            mechanism: 'A changed default reorders writes',
            predictions: ['A configuration file changed in the window'],
            priorPlausibility: 'low',
          },
        ],
      };
    if (id.endsWith('/falsify'))
      return {
        verdict: id.startsWith('falsifiers/0/') ? 'survives' : 'falsified',
        reasoning: 'Fixture evidence',
        checkedPredictions: [],
      };
    return 'Incident report: lost update';
  }
  if (name === 'sdlc-orchestrator') {
    if (id === 'intake')
      return {
        plan: mode === 'full-lifecycle' ? lifecycle : ['requirements', 'spec'],
        rationale: 'Prepare feature',
      };
    for (const [stage, child] of [
      ['bootstrap', 'project-bootstrap'],
      ['release-notes', 'release-notes'],
    ]) {
      if (id.startsWith(`${stage}/`))
        return packagedReply(
          child,
          { ...request, call: { ...request.call, stepId: id.split('/work/')[1] } },
          env,
          mode,
        );
    }
    if (id.startsWith('implement/') && id.endsWith('/apply')) {
      await writeFile(join(request.cwd, 'implementation.txt'), 'Implemented fixture\n');
      return 'Implemented fixture';
    }
    if (id.endsWith('/review')) return { summary: 'Ready', gate: 'pass', details: [] };
    return 'Fixture lifecycle document';
  }
  if (name === 'bug-hunt') {
    if (/\/finders\/\d+\/answer$/u.test(id))
      return { bugs: id.startsWith('round/0/') ? [bug] : [] };
    return { refuted: /\/skeptics\/\d+\/1\/answer$/u.test(id), reasoning: 'Fixture evidence' };
  }
  throw new Error(`Unhandled fixture request: ${name} ${id}`);
}
export const response = (output, request) => ({
  text: request.outputSchema ? JSON.stringify(output) : output,
  sessionId: 'fixture',
  usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 },
});
export function exitFailure(request) {
  const child = spawnSync(
    process.execPath,
    ['-e', 'process.stderr.write("fixture exit");process.exit(17)'],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 17);
  return new HarnessError({
    harness: request.harness,
    kind: 'process',
    reason: 'fixture nonzero process',
    exit: { code: child.status, signal: child.signal },
    stdout: child.stdout,
    stderr: child.stderr,
    failure: null,
    usage: { inputTokens: 1, outputTokens: 0, costUsd: 0.01 },
  });
}
/**
 * The inert harness of one run: `calls` are the requests in admission order, `replyErrors` what
 * each fixture reply threw (`{ stepId, message }`, also passed to `onReplyError`).
 *
 * `fault` injects F1 (a process failure) into the first request, or F2 (a schema-invalid reply)
 * into the first schema request; a Batch 03 fixture module may name the step each fault targets
 * through its `faults` export. For a fixture module, F2 holds on the faulted step through its
 * in-run schema retries until `endFault()`. `faultedStep()` is the step that was faulted, or null.
 */
export function harnessFor(
  batch,
  name,
  env,
  { mode = 'normal', fault = null, onCall, onReplyError } = {},
) {
  const calls = [],
    replyErrors = [];
  const module = batch === 3 ? packagedFixtures[name] : undefined;
  const named = fault && module?.faults?.[fault];
  const target = named ? new RegExp(named, 'u') : null;
  const holds = fault === 'F2' && Boolean(module);
  let injected = false,
    faultedStep = null,
    ended = false;
  const harness = {
    async invoke(request) {
      calls.push(request);
      await onCall?.(request, calls.length);
      const id = request.call.stepId;
      const first =
        !injected &&
        (fault === 'F1' || (fault === 'F2' && request.outputSchema)) &&
        (!target || target.test(id));
      if (!ended && (first || (holds && injected && id === faultedStep))) {
        injected = true;
        faultedStep = id;
        if (fault === 'F1') throw exitFailure(request);
        return response({ deliberatelyInvalid: true }, request);
      }
      if (
        batch === 2 &&
        name === 'bug-hunt' &&
        mode === 'failed-skeptic' &&
        request.call.stepId.endsWith('/2/verify')
      )
        throw exitFailure(request);
      if (
        batch === 2 &&
        name === 'bug-hunt' &&
        mode === 'failed-finders' &&
        request.call.stepId.endsWith('/find')
      )
        throw exitFailure(request);
      if (
        batch === 3 &&
        name === 'bug-hunt' &&
        ((mode === 'failed-skeptic' && /\/skeptics\/\d+\/2\/answer$/u.test(request.call.stepId)) ||
          (mode === 'failed-finders' && /\/finders\/\d+\/answer$/u.test(request.call.stepId)))
      )
        throw exitFailure(request);
      if (batch === 3 && module?.fail?.(request, mode)) throw exitFailure(request);
      if (
        batch === 3 &&
        name === 'incident-investigation' &&
        mode === 'failed-falsifier' &&
        request.call.stepId.startsWith('falsifiers/1/')
      )
        throw exitFailure(request);
      let output;
      try {
        output = await reply(batch, name, request, env, mode);
      } catch (error) {
        // The engine journals a throwing reply as an agent failure, which a settled call keeps.
        const entry = { stepId: id, message: String(error?.message ?? error) };
        replyErrors.push(entry);
        onReplyError?.(entry);
        throw error;
      }
      return response(output, request);
    },
  };
  return {
    calls,
    harness,
    replyErrors,
    faultedStep: () => faultedStep,
    endFault: () => {
      ended = true;
    },
  };
}
/** Fail when a Batch 03 fixture module's replies threw: a settled call would hide the throw. */
export function assertNoReplyErrors(replyErrors, label) {
  assert.deepEqual(
    replyErrors,
    [],
    `${label}: fixture replies threw\n${replyErrors
      .map((error) => `${error.stepId}: ${error.message}`)
      .join('\n')}`,
  );
}
export async function drive(definition, options, { redo = false, onSuspended } = {}) {
  let result = await runWorkflow(definition, options);
  let redone = false,
    suspended = 0;
  while (result.status === 'suspended') {
    assert.ok(++suspended <= 64, 'Fixture must not loop through unbounded questions');
    await onSuspended?.(result);
    const packaged = packagedFixtures[definition.name];
    for (const question of result.pending) {
      let value = packaged?.answer?.(question);
      if (value !== undefined);
      else if (
        question.stepId.endsWith('approve-plan') ||
        (packaged && /(?:^|\/)approve-[^/]+$/u.test(question.stepId))
      )
        value = { approved: true };
      else {
        const again = redo && !redone;
        value = {
          decision: again ? 'redo' : 'continue',
          answer: again ? 'HUMAN_STAGE_REQUIREMENTS_ONLY' : '',
        };
        redone ||= again;
      }
      await writeAnswer({
        stateDir: options.stateDir,
        runId: options.runId,
        stepId: question.stepId,
        value,
        by: 'human:fixture',
      });
    }
    result = await runWorkflow(definition, { ...options, resume: true });
  }
  return { result, suspended };
}
/** Let a Batch 03 fixture module add its own files to a fresh fixture repository. */
export async function prepare(batch, name, env) {
  if (batch === 3) await packagedFixtures[name]?.setup?.(env);
  return env;
}
/** A Batch 03 fixture module's F3 kill point, or null. */
export const killSpec = (batch, name) => (batch === 3 && packagedFixtures[name]?.kill) || null;
export function runOptions(env, runId, harness, input) {
  assert.notEqual(
    typeof input?.then,
    'function',
    `${runId}: the workflow input is a Promise; await input(env) before the run`,
  );
  return {
    cwd: env.cwd,
    stateDir: env.stateDir,
    worktrees: env.worktrees,
    processRunner: env.processRunner,
    grants: ['all'],
    agentLimit: 1,
    runId,
    harness,
    input,
  };
}
export async function snapshot(cwd) {
  // Git status plus tracked fixture target are enough to distinguish the contracted effects.
  const target = await readFile(join(cwd, 'target.mjs'), 'utf8');
  return {
    targetPristine: target === pristine,
    status: command(cwd, 'status', '--porcelain=v1', '--untracked-files=all'),
  };
}
export async function writeFixture(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}
