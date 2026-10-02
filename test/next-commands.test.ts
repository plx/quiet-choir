import { describe, expect, it } from 'vitest';

import {
  failureNextCommands,
  formatArgv,
  maxAnswerEntries,
  runNextCommands,
  type FailureNextContext,
} from '../src/workflow/loader/next-commands.js';
import { divergenceRefusal, forkCommand } from '../src/workflow/loader/code-change-preflight.js';
import { StepIdentityChangedError } from '../src/workflow/runtime/run-errors.js';
import type { JsonValue } from '../src/workflow/runtime/model.js';
import type { RunRecord } from '../src/workflow/runtime/store.js';

const launcher = ['/x/node', '/y/bin/run.js'];
const prefix = [...launcher, 'workflow'];
const stateDir = '/state/runs';
const entrypoint = '/project/review.workflow.ts';

function question(audience: 'human' | 'agent' | 'any') {
  return { request: { audience }, rejections: [] };
}

function run(overrides: Record<string, unknown> = {}): RunRecord {
  return {
    id: 'r1',
    status: 'failed',
    formatVersion: 7,
    launch: { entrypoint, tsconfig: null },
    steps: {},
    ...overrides,
  } as unknown as RunRecord;
}

const resume = (...flags: string[]) => [
  ...prefix,
  'resume',
  'r1',
  '--state-dir',
  stateDir,
  ...flags,
];
const fork = (from: string) => [
  ...prefix,
  'execute',
  from,
  '--fork-from',
  'r1',
  '--run-id',
  '<NEW_RUN_ID>',
  '--state-dir',
  stateDir,
];
const answer = (stepId: string) => [
  ...prefix,
  'answer',
  'r1',
  stepId,
  '--state-dir',
  stateDir,
  '--json',
  '<ANSWER_JSON>',
];

describe('runNextCommands', () => {
  it.each<[string, RunRecord['status'] | 'stale', readonly (readonly string[])[]]>([
    ['failed', 'failed', [resume()]],
    ['stale', 'stale', [resume()]],
    ['completed', 'completed', []],
    ['running', 'running', []],
    ['cancelled', 'cancelled', []],
  ])('a %s run', (_label, status, expected) => {
    expect(runNextCommands(run(), status, stateDir, launcher).map((entry) => entry.argv)).toEqual(
      expected,
    );
  });

  it('answers waiting questions (at most five), skips plain waits, then resumes', () => {
    const steps: Record<string, unknown> = {
      poll: { status: 'waiting', kind: 'wait' },
      done: { status: 'completed', kind: 'ask', question: question('agent') },
    };
    for (let index = 0; index < 7; index++)
      steps[`ask-${String(index)}`] = {
        status: 'waiting',
        kind: 'ask',
        question: question(index === 0 ? 'human' : 'any'),
      };
    const next = runNextCommands(
      run({ status: 'suspended', steps }),
      'suspended',
      stateDir,
      launcher,
    );
    expect(next.map((entry) => entry.argv)).toEqual([
      ...Array.from({ length: maxAnswerEntries }, (_, index) => answer(`ask-${String(index)}`)),
      resume(),
    ]);
    expect(next[0]?.why).toContain('--by human:<name>');
    expect(next[1]?.why).not.toContain('--by');
    expect(next.at(-1)?.why).toContain('answered or due');
  });

  it('explains an interrupted suspension', () => {
    const next = runNextCommands(
      run({ status: 'suspended', interruptedBy: { reason: 'SIGINT', at: 'now' } }),
      'suspended',
      stateDir,
    );
    expect(next).toEqual([
      {
        why: expect.stringContaining('interrupted') as string,
        argv: ['quiet-choir', 'workflow', 'resume', 'r1', '--state-dir', stateDir],
      },
    ]);
  });

  it('offers nothing for an embedded run without a stored entrypoint', () => {
    expect(runNextCommands(run({ launch: undefined }), 'failed', stateDir, launcher)).toEqual([]);
  });
});

function failure(overrides: Partial<FailureNextContext>): readonly (readonly string[])[] {
  return failureNextCommands({
    code: 'workflow.failed',
    details: null,
    run: run(),
    runId: 'r1',
    stateDir,
    launcher,
    rehearsal: false,
    ...overrides,
  }).map((entry) => entry.argv);
}

const compatibility = (changed: string[], canAcceptCodeChange: boolean): JsonValue => ({
  compatible: false,
  changed,
  unchanged: [],
  canAcceptCodeChange,
});

describe('failureNextCommands', () => {
  it.each<[string, Partial<FailureNextContext>, readonly (readonly string[])[]]>([
    ['workflow.failed with a saved failed run', {}, [resume()]],
    ['workflow.failed without a readable run', { run: null }, []],
    ['workflow.failed whose run is still marked running', { run: run({ status: 'running' }) }, []],
    [
      'workflow.interrupted with a resumable suspension',
      { code: 'workflow.interrupted', run: run({ status: 'suspended' }) },
      [resume()],
    ],
    [
      'workflow.interrupted with a cancelled run',
      { code: 'workflow.interrupted', run: run({ status: 'cancelled' }) },
      [],
    ],
    [
      'start.timeout after the stopped runner saved a resumable suspension',
      { code: 'start.timeout', run: run({ status: 'suspended' }) },
      [resume()],
    ],
    ['start.timeout without a record', { code: 'start.timeout', run: null, runId: null }, []],
    ['start.exited', { code: 'start.exited', run: null, runId: null }, []],
    [
      'watch.timeout on a running run',
      { code: 'watch.timeout', run: run({ status: 'running' }) },
      [],
    ],
    ['watch.record_not_created', { code: 'watch.record_not_created', run: null }, []],
    ['run.orphans', { code: 'run.orphans' }, [resume('--kill-orphans')]],
    [
      'run.orphans of an embedded run',
      { code: 'run.orphans', run: run({ launch: undefined }) },
      [],
    ],
    [
      'run.incompatible for a code-only change',
      { code: 'run.incompatible', details: compatibility(['code'], true) },
      [resume('--accept-code-change'), fork(entrypoint)],
    ],
    [
      'run.incompatible for a code change on a completed run',
      {
        code: 'run.incompatible',
        details: compatibility(['code'], true),
        run: run({ status: 'completed' }),
      },
      [fork(entrypoint)],
    ],
    [
      'run.incompatible for a cwd change',
      { code: 'run.incompatible', details: compatibility(['cwd'], false) },
      [fork(entrypoint)],
    ],
    [
      'run.incompatible for a cwd change of a format-1 run (fork refuses legacy checkpoints)',
      {
        code: 'run.incompatible',
        details: compatibility(['cwd'], false),
        run: run({ formatVersion: 1 }),
      },
      [],
    ],
    [
      'run.incompatible for a code change of a format-1 run keeps only the resume entry',
      {
        code: 'run.incompatible',
        details: compatibility(['code'], true),
        run: run({ formatVersion: 1 }),
      },
      [resume('--accept-code-change')],
    ],
    [
      'run.incompatible for a cwd change of a format-6 run',
      {
        code: 'run.incompatible',
        details: compatibility(['cwd'], false),
        run: run({ formatVersion: 6 }),
      },
      [fork(entrypoint)],
    ],
    [
      'run.incompatible for a different requested entrypoint of a format-1 run',
      {
        code: 'run.incompatible',
        details: { storedEntrypoint: entrypoint, requestedEntrypoint: '/elsewhere/w.ts' },
        run: run({ formatVersion: 1 }),
      },
      [resume()],
    ],
    [
      'run.incompatible for a missing stored entrypoint of a format-1 run',
      {
        code: 'run.incompatible',
        details: { storedEntrypoint: entrypoint, reason: 'entrypoint_missing' },
        run: run({ formatVersion: 1 }),
      },
      [],
    ],
    [
      'run.incompatible for a workflow name change',
      { code: 'run.incompatible', details: compatibility(['name', 'code'], false) },
      [],
    ],
    [
      'run.incompatible for a different requested entrypoint',
      {
        code: 'run.incompatible',
        details: { storedEntrypoint: entrypoint, requestedEntrypoint: '/elsewhere/w.ts' },
      },
      [resume(), fork('/elsewhere/w.ts')],
    ],
    [
      'run.incompatible for a missing stored entrypoint',
      {
        code: 'run.incompatible',
        details: { storedEntrypoint: entrypoint, reason: 'entrypoint_missing' },
      },
      [fork('<ENTRYPOINT>')],
    ],
    [
      'run.incompatible for a harness change',
      { code: 'run.incompatible', details: { previousKind: 'cli', requestedKind: 'fixture' } },
      [],
    ],
    ['run.incompatible without details', { code: 'run.incompatible' }, []],
    [
      'run.not_found with candidates (at most five)',
      {
        code: 'run.not_found',
        run: null,
        details: {
          candidates: [
            ...Array.from({ length: 6 }, (_, index) => ({
              stateDir: `/c${String(index)}`,
              cwd: '/p',
            })),
          ],
        },
      },
      Array.from({ length: 5 }, (_, index) => [
        ...prefix,
        'inspect',
        'r1',
        '--state-dir',
        `/c${String(index)}`,
      ]),
    ],
    [
      'run.not_found of a --fork-from source inspects the missing run, not the named one',
      {
        code: 'run.not_found',
        runId: 'new-run',
        run: null,
        details: { runId: 'r1', candidates: [{ stateDir: '/c0', cwd: '/p' }] },
      },
      [[...prefix, 'inspect', 'r1', '--state-dir', '/c0']],
    ],
    ['run.not_found without candidates', { code: 'run.not_found', details: { count: 0 } }, []],
    ['a rehearsal failure', { rehearsal: true }, []],
    ['a failure without a run ID', { runId: null }, []],
    ['load.typecheck', { code: 'load.typecheck' }, []],
    ['run.locked', { code: 'run.locked' }, []],
  ])('%s', (_label, overrides, expected) => {
    expect(failure(overrides)).toEqual(expected);
  });

  it('carries a divergence refusal fork command, built with the same launcher', () => {
    const change = new StepIdentityChangedError('changed', {
      stepId: 'review',
      components: ['callback'],
      status: 'completed',
    });
    const refusal = divergenceRefusal(change, { runId: 'r1', stateDir, entrypoint }, launcher);
    const expected = forkCommand(change, { runId: 'r1', stateDir, entrypoint }, launcher);
    expect(expected.slice(0, 3)).toEqual(prefix);
    expect(refusal.message).toContain(formatArgv(expected));
    expect(failure({ code: 'run.incompatible', details: refusal.details })).toEqual([expected]);
  });
});

describe('launch policy on next entries', () => {
  const policy = {
    harness: {
      kind: 'fixture',
      fixtures: [
        { path: '/p/f.json', sha256: 'a'.repeat(64) },
        { name: 'third', path: '/p/t.json', sha256: 'b'.repeat(64) },
      ],
    },
    waitMode: 'block',
  };
  const flags = [
    '--harness',
    'fixture:/p/f.json',
    '--harness',
    'third=fixture:/p/t.json',
    '--wait-mode',
    'block',
  ];
  const sticky = (overrides: Record<string, unknown> = {}) =>
    run({ launch: { entrypoint, tsconfig: null, policy }, ...overrides });
  const defaults = (overrides: Record<string, unknown> = {}) =>
    run({
      launch: {
        entrypoint,
        tsconfig: null,
        policy: { harness: { kind: 'cli' }, waitMode: 'suspend' },
      },
      ...overrides,
    });

  it('repeats a fixture/block policy on every resume entry of a run', () => {
    for (const status of ['failed', 'stale'] as const)
      expect(runNextCommands(sticky(), status, stateDir, launcher).map(({ argv }) => argv)).toEqual(
        [resume(...flags)],
      );
    const suspended = sticky({
      status: 'suspended',
      steps: { ask: { status: 'waiting', kind: 'ask', question: question('any') } },
    });
    // The answer entry only delivers; the resume entry after it carries the policy.
    expect(
      runNextCommands(suspended, 'suspended', stateDir, launcher).map(({ argv }) => argv),
    ).toEqual([answer('ask'), resume(...flags)]);
  });

  it.each<[string, Partial<FailureNextContext>, readonly (readonly string[])[]]>([
    ['workflow.failed', {}, [resume(...flags)]],
    ['run.orphans', { code: 'run.orphans' }, [resume('--kill-orphans', ...flags)]],
    [
      'run.incompatible for a code-only change (the fork is a new launch)',
      { code: 'run.incompatible', details: compatibility(['code'], true) },
      [resume('--accept-code-change', ...flags), fork(entrypoint)],
    ],
    [
      'run.incompatible for a different requested entrypoint',
      {
        code: 'run.incompatible',
        details: { storedEntrypoint: entrypoint, requestedEntrypoint: '/elsewhere/w.ts' },
      },
      [resume(...flags), fork('/elsewhere/w.ts')],
    ],
  ])('%s carries the policy flags on its resume entries', (_label, overrides, expected) => {
    expect(failure({ run: sticky(), ...overrides })).toEqual(expected);
  });

  it('adds no flags for a cli/suspend policy', () => {
    expect(runNextCommands(defaults(), 'failed', stateDir, launcher)[0]?.argv).toEqual(resume());
    expect(failure({ run: defaults(), code: 'run.orphans' })).toEqual([resume('--kill-orphans')]);
    expect(
      failure({
        run: defaults(),
        code: 'run.incompatible',
        details: compatibility(['code'], true),
      }),
    ).toEqual([resume('--accept-code-change'), fork(entrypoint)]);
  });
});

describe('formatArgv', () => {
  it('quotes for a POSIX shell and leaves placeholders bare', () => {
    expect(
      formatArgv(['/a b/node', "it's", 'plain-1.2/x', '<ANSWER_JSON>', '<lower>', '$HOME', '']),
    ).toBe(`'/a b/node' 'it'\\''s' plain-1.2/x <ANSWER_JSON> '<lower>' '$HOME' ''`);
  });
});
