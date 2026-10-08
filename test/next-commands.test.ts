import { describe, expect, it } from 'vitest';

import {
  failureNextCommands,
  formatArgv,
  maxAnswerEntries,
  queuedNextCommands,
  relaunchNextCommands,
  runNextCommands,
  type FailureNextContext,
} from '../src/workflow/loader/next-commands.js';
import { divergenceRefusal, forkCommand } from '../src/workflow/loader/code-change-preflight.js';
import {
  ReplaySkippedError,
  StepIdentityChangedError,
} from '../src/workflow/runtime/run-errors.js';
import type { JsonValue } from '../src/workflow/runtime/model.js';
import type { RecoveryCause } from '../src/workflow/runtime/recovery-hint.js';
import type { RunRecord } from '../src/workflow/runtime/store.js';

const launcher = ['/x/node', '/y/bin/run.js'];
const prefix = [...launcher, 'workflow'];
const stateDir = '/state/runs';
const entrypoint = '/project/review.workflow.ts';

function question(audience: 'human' | 'agent' | 'any') {
  return { request: { audience }, rejections: [] };
}

/** A run with one recorded step, so a failed run has work to reuse. */
function run(overrides: Record<string, unknown> = {}): RunRecord {
  return {
    id: 'r1',
    status: 'failed',
    formatVersion: 7,
    launch: { entrypoint, tsconfig: null },
    steps: { prepare: { status: 'completed', kind: 'step' } },
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
const grantResume = (profile: string, ...flags: string[]) => [
  ...prefix,
  'execute',
  '--resume',
  '--run-id',
  'r1',
  '--state-dir',
  stateDir,
  '--grant',
  profile,
  ...flags,
];
const answer = (stepId: string, human = false) => [
  ...prefix,
  'answer',
  'r1',
  stepId,
  '--state-dir',
  stateDir,
  '--json',
  '<ANSWER_JSON>',
  ...(human ? ['--by', 'human:<NAME>'] : []),
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
      ...Array.from({ length: maxAnswerEntries }, (_, index) =>
        answer(`ask-${String(index)}`, index === 0),
      ),
      resume(),
    ]);
    expect(next[0]?.why).toBe(
      'Answer ask-0: substitute <ANSWER_JSON> with a human decision and <NAME> with the name of the human who gave it.',
    );
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

  it('explains a window-gate suspension and when tick resumes it', () => {
    const next = runNextCommands(
      run({
        status: 'suspended',
        nextWakeAt: 1_791_360_000_000,
        budgetStop: {
          stepId: 'two',
          metric: 'maxWindowUtilization',
          limit: 0.5,
          observed: 0.84,
          at: '2026-10-04T00:00:00.000Z',
          harness: 'claude',
          window: 'seven_day',
          resetsAt: 1_791_360_000,
        },
      }),
      'suspended',
      stateDir,
    );
    expect(next).toEqual([
      {
        why: 'The --max-window-utilization gate suspended the run until 2026-10-07T08:00:00.000Z; workflow tick resumes it after then, and an earlier resume suspends it again.',
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

  it('carries a skip refusal fork command naming the first skipped ID, built with the same launcher', () => {
    const skip = new ReplaySkippedError('skipped', {
      kind: 'maps',
      skipped: ['reviews', 'audits'],
    });
    const refusal = divergenceRefusal(skip, { runId: 'r1', stateDir, entrypoint }, launcher);
    const expected = forkCommand(skip, { runId: 'r1', stateDir, entrypoint }, launcher);
    expect(expected.slice(0, 3)).toEqual(prefix);
    expect(
      expected.slice(expected.indexOf('--invalidate'), expected.indexOf('--invalidate') + 2),
    ).toEqual(['--invalidate', 'reviews']);
    expect(refusal.message).toContain(
      'The changed workflow skipped settled maps (reviews, audits).',
    );
    expect(refusal.message).toContain(formatArgv(expected));
    expect(refusal.details).toEqual({
      divergent: [
        { stepId: 'reviews', skipped: 'map' },
        { stepId: 'audits', skipped: 'map' },
      ],
      next: [expected],
    });
    expect(failure({ code: 'run.incompatible', details: refusal.details })).toEqual([expected]);
  });

  describe('run.locked', () => {
    const unlock = ['quiet-choir', 'workflow', 'unlock', 'r1', '--state-dir', stateDir];
    const entry = { why: 'Rerun once the owner has exited.', argv: unlock };
    const locked = (details: JsonValue, overrides: Partial<FailureNextContext> = {}) =>
      failureNextCommands({
        code: 'run.locked',
        details,
        run: null,
        runId: 'r1',
        stateDir,
        launcher,
        rehearsal: false,
        ...overrides,
      });

    it('passes the details.next entries the runtime built through', () => {
      const forced = { why: 'Only if far is gone.', argv: [...unlock, '--force-remote'] };
      expect(locked({ next: [entry, forced] })).toEqual([entry, forced]);
    });

    it.each<[string, JsonValue]>([
      ['no details', null],
      ['details without next', { lockPath: '/lock' }],
      ['a next that is not a list', { next: 'quiet-choir workflow unlock r1' }],
      ['a bare argv list, as run.incompatible divergence uses', { next: [unlock] }],
    ])('gives nothing for %s', (_label, details) => {
      expect(locked(details)).toEqual([]);
    });

    it('drops malformed entries and keeps the valid ones', () => {
      expect(
        locked({
          next: [
            { why: 'no argv' },
            { why: 'empty argv', argv: [] },
            { why: 'non-string argv', argv: ['quiet-choir', 1] },
            { argv: unlock },
            { why: 7, argv: unlock },
            'quiet-choir',
            null,
            entry,
          ],
        }),
      ).toEqual([entry]);
    });

    it('gives nothing for a rehearsal or without a run ID', () => {
      expect(locked({ next: [entry] }, { rehearsal: true })).toEqual([]);
      expect(locked({ next: [entry] }, { runId: null })).toEqual([]);
    });
  });

  describe('worktree.locked', () => {
    const unlock = ['quiet-choir', 'workflow', 'unlock', '--worktree-admin', '/repo/.git'];
    const entry = { why: 'Rerun once PID 7 on here has exited.', argv: unlock };
    const locked = (details: JsonValue, overrides: Partial<FailureNextContext> = {}) =>
      failureNextCommands({
        code: 'worktree.locked',
        details,
        run: null,
        runId: null,
        stateDir: null,
        launcher,
        rehearsal: false,
        ...overrides,
      });

    it('passes details.next through although the refusal names no run or state directory', () => {
      const forced = { why: 'Only if far is gone.', argv: [...unlock, '--force-remote'] };
      expect(locked({ next: [entry, forced] })).toEqual([entry, forced]);
      expect(locked({ next: [entry, { why: 'no argv' }] })).toEqual([entry]);
    });

    it('gives nothing without details.next or for a rehearsal', () => {
      expect(locked({ lockPath: '/repo/.git/quiet-choir/worktree-admin.lock' })).toEqual([]);
      expect(locked({ next: [entry] }, { rehearsal: true })).toEqual([]);
    });
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

describe('cause-aware failed-run entries (#284)', () => {
  const grant: RecoveryCause = { kind: 'grant', profile: 'edit', access: 'write' };
  const causes: readonly [string, RecoveryCause | undefined, readonly (readonly string[])[]][] = [
    ['grant', grant, [grantResume('edit')]],
    ['divergence', { kind: 'divergence' }, [fork(entrypoint)]],
    [
      'map-changed (mapper only)',
      { kind: 'map-changed', mapperOnly: true },
      [resume('--accept-code-change'), fork(entrypoint)],
    ],
    ['map-changed', { kind: 'map-changed', mapperOnly: false }, [fork(entrypoint)]],
    ['configuration', { kind: 'configuration' }, [resume()]],
    [
      'budget',
      { kind: 'budget', flag: '--max-run-cost-usd' },
      [resume('--max-run-cost-usd', '<LIMIT>')],
    ],
    ['authoring', { kind: 'authoring' }, [resume()]],
    ['effect', { kind: 'effect' }, [resume()]],
    ['cancelled', { kind: 'cancelled' }, [resume()]],
    ['absent (a record from an older build)', undefined, [resume()]],
  ];
  const failed = (cause: RecoveryCause | undefined, overrides: Record<string, unknown> = {}) =>
    run({ ...(cause === undefined ? {} : { recoveryCause: cause }), ...overrides });
  const argvs = (entries: readonly { readonly argv: readonly string[] }[]) =>
    entries.map(({ argv }) => argv);

  it.each(causes)('a failed run whose cause is %s', (_label, cause, expected) => {
    const saved = failed(cause);
    expect(argvs(runNextCommands(saved, 'failed', stateDir, launcher))).toEqual(expected);
    for (const code of ['workflow.failed', 'workflow.interrupted', 'start.timeout'] as const)
      expect(failure({ code, run: saved }), code).toEqual(expected);
  });

  it.each(causes)(
    'a failed run whose cause is %s and that recorded nothing gets no entry',
    (_label, cause) => {
      const empty = failed(cause, { steps: {} });
      expect(runNextCommands(empty, 'failed', stateDir, launcher)).toEqual([]);
      expect(failure({ run: empty })).toEqual([]);
      expect(failure({ code: 'start.timeout', run: empty })).toEqual([]);
    },
  );

  it.each(causes)('a rehearsal whose cause is %s gets no entry', (_label, cause) => {
    expect(failure({ run: failed(cause), rehearsal: true })).toEqual([]);
  });

  it('counts a settled map without steps as recorded work', () => {
    expect(failure({ run: failed(undefined, { steps: {}, maps: { files: {} } }) })).toEqual([
      resume(),
    ]);
  });

  it('offers no fork for a legacy run', () => {
    const legacy = { formatVersion: 1 };
    expect(failure({ run: failed({ kind: 'divergence' }, legacy) })).toEqual([]);
    expect(failure({ run: failed({ kind: 'map-changed', mapperOnly: false }, legacy) })).toEqual(
      [],
    );
    expect(failure({ run: failed({ kind: 'map-changed', mapperOnly: true }, legacy) })).toEqual([
      resume('--accept-code-change'),
    ]);
    expect(failure({ run: failed({ kind: 'divergence' }, { formatVersion: 6 }) })).toEqual([
      fork(entrypoint),
    ]);
  });

  it('repeats the launch policy on the grant and budget resumes, not on the fork', () => {
    const launch = {
      entrypoint,
      tsconfig: null,
      policy: {
        harness: { kind: 'fixture', fixtures: [{ path: '/p/f.json', sha256: 'a'.repeat(64) }] },
        waitMode: 'block',
      },
    };
    const flags = ['--harness', 'fixture:/p/f.json', '--wait-mode', 'block'];
    expect(failure({ run: failed(grant, { launch }) })).toEqual([grantResume('edit', ...flags)]);
    expect(
      failure({ run: failed({ kind: 'budget', flag: '--max-run-agent-attempts' }, { launch }) }),
    ).toEqual([resume('--max-run-agent-attempts', '<LIMIT>', ...flags)]);
    expect(failure({ run: failed({ kind: 'map-changed', mapperOnly: true }, { launch }) })).toEqual(
      [resume('--accept-code-change', ...flags), fork(entrypoint)],
    );
  });

  it('explains each cause and leaves <LIMIT> bare for the shell', () => {
    const why = (cause: RecoveryCause | undefined) =>
      runNextCommands(failed(cause), 'failed', stateDir).map((entry) => entry.why);
    expect(why(grant)).toEqual([
      'Profile edit needs write access; grant it and resume. The grant is saved for later resumes, and completed steps are reused.',
    ]);
    expect(why({ kind: 'budget', flag: '--max-run-cost-usd' })).toEqual([
      'A run budget stopped the run and stays in force on resume; substitute <LIMIT> with a higher --max-run-cost-usd value or off. Completed steps are reused.',
    ]);
    expect(why({ kind: 'divergence' })[0]).toContain('fork a new run');
    expect(why({ kind: 'map-changed', mapperOnly: false })[0]).toContain('restore the map');
    // The plain resume of the other causes is byte for byte the entry before #284.
    expect(why({ kind: 'effect' })).toEqual([
      'Resume the failed run; completed steps are reused and failed ones run again.',
    ]);
    const [budget] = runNextCommands(
      failed({ kind: 'budget', flag: '--max-run-cost-usd' }),
      'failed',
      stateDir,
    );
    expect(formatArgv(budget?.argv ?? [])).toBe(
      `quiet-choir workflow resume r1 --state-dir ${stateDir} --max-run-cost-usd <LIMIT>`,
    );
  });

  it('leaves stale and suspended entries alone', () => {
    for (const [, cause] of causes) {
      expect(argvs(runNextCommands(failed(cause), 'stale', stateDir, launcher))).toEqual([
        resume(),
      ]);
      expect(
        argvs(
          runNextCommands(failed(cause, { status: 'suspended' }), 'suspended', stateDir, launcher),
        ),
      ).toEqual([resume()]);
      expect(failure({ code: 'run.orphans', run: failed(cause) })).toEqual([
        resume('--kill-orphans'),
      ]);
    }
  });

  it('offers nothing for an embedded run whatever the cause', () => {
    expect(runNextCommands(failed(grant, { launch: undefined }), 'failed', stateDir)).toEqual([]);
  });
});

describe('queuedNextCommands', () => {
  it('resumes with the recorded launch policy behind the launcher', () => {
    const policy = {
      harness: { kind: 'fixture', fixtures: [{ path: '/p/f.json', sha256: 'a'.repeat(64) }] },
      waitMode: 'block',
    };
    const queued = queuedNextCommands(
      run({ status: 'suspended', launch: { entrypoint, tsconfig: null, policy } }),
      stateDir,
      launcher,
    );
    expect(queued).toEqual([
      {
        why: 'An answer is queued; resume the run so its owner ingests it.',
        argv: resume('--harness', 'fixture:/p/f.json', '--wait-mode', 'block'),
      },
    ]);
  });

  it('offers nothing for an embedded run without launch metadata', () => {
    expect(queuedNextCommands(run({ launch: undefined }), stateDir, launcher)).toEqual([]);
  });
});

describe('relaunchNextCommands', () => {
  const unlock = ['unlock', 'r1', '--state-dir', stateDir];
  const entry = (argv: unknown, why: unknown = 'Release.') => ({ why, argv });

  it('rewrites a runner-form entry behind the given launcher', () => {
    const next = [entry(['/x/node', '/abs/bin/run.js', 'workflow', ...unlock])];
    expect(relaunchNextCommands(next, ['quiet-choir'])).toEqual([
      { why: 'Release.', argv: ['quiet-choir', 'workflow', ...unlock] },
    ]);
    expect(relaunchNextCommands(next, launcher)).toEqual([
      { why: 'Release.', argv: [...prefix, ...unlock] },
    ]);
  });

  it('rewrites a development-form entry with loader flags and an installed-form entry', () => {
    const dev = ['/x/node', '--import', 'tsx', '/repo/bin/run.ts', 'workflow', ...unlock];
    const installed = ['quiet-choir', 'workflow', ...unlock];
    expect(relaunchNextCommands([entry(dev), entry(installed)], launcher)).toEqual([
      { why: 'Release.', argv: [...prefix, ...unlock] },
      { why: 'Release.', argv: [...prefix, ...unlock] },
    ]);
  });

  it('falls back to the default launcher when none is given', () => {
    const next = [entry(['/x/node', '/abs/bin/run.js', 'workflow', ...unlock])];
    expect(relaunchNextCommands(next, undefined)).toEqual([
      { why: 'Release.', argv: ['quiet-choir', 'workflow', ...unlock] },
    ]);
    expect(relaunchNextCommands(next, [])).toEqual(relaunchNextCommands(next, undefined));
  });

  it('keeps later words equal to workflow', () => {
    const argv = [
      '/x/node',
      '/abs/bin/run.js',
      'workflow',
      'inspect',
      'workflow',
      '--state-dir',
      'workflow',
    ];
    expect(relaunchNextCommands([entry(argv)], launcher)).toEqual([
      { why: 'Release.', argv: [...prefix, 'inspect', 'workflow', '--state-dir', 'workflow'] },
    ]);
  });

  describe('with the runner launcher', () => {
    const runnerLauncher = [
      '/usr/bin/node',
      '--title',
      'workflow',
      '--import',
      'tsx',
      '/abs/bin/dev.js',
    ];
    const resumeArgs = ['resume', 'r1', '--state-dir', stateDir];

    it('ends the program words after the runner launcher even when one of them is workflow', () => {
      const next = [entry([...runnerLauncher, 'workflow', ...resumeArgs], 'Resume.')];
      expect(relaunchNextCommands(next, ['quiet-choir'], runnerLauncher)).toEqual([
        { why: 'Resume.', argv: ['quiet-choir', 'workflow', ...resumeArgs] },
      ]);
    });

    it('falls back to the first workflow word for entries in other forms', () => {
      const runner = ['/x/node', '/abs/bin/run.js', 'workflow', ...unlock];
      const installed = ['quiet-choir', 'workflow', ...unlock];
      expect(
        relaunchNextCommands([entry(runner), entry(installed)], launcher, runnerLauncher),
      ).toEqual([
        { why: 'Release.', argv: [...prefix, ...unlock] },
        { why: 'Release.', argv: [...prefix, ...unlock] },
      ]);
    });
  });

  it('strips extra keys', () => {
    const next = [{ ...entry(['n', 'workflow', 'x']), extra: true }];
    expect(relaunchNextCommands(next, launcher)).toEqual([
      { why: 'Release.', argv: [...prefix, 'x'] },
    ]);
  });

  it.each([
    ['an object', { argv: ['n', 'workflow', 'x'] }],
    ['a string', 'workflow'],
    ['null', null],
    ['undefined', undefined],
  ])('returns nothing for %s instead of a list', (_name, value) => {
    expect(relaunchNextCommands(value, launcher)).toEqual([]);
  });

  it.each([
    ['a non-object element', 'text'],
    ['a null element', null],
    ['an array element', [['n', 'workflow', 'x']]],
    ['a missing why', { argv: ['n', 'workflow', 'x'] }],
    ['a non-string why', entry(['n', 'workflow', 'x'], 3)],
    ['an argv that is not a list', entry('n workflow x')],
    ['an argv with a non-string word', entry(['n', 'workflow', 7])],
    ['an empty argv', entry([])],
    ['an argv without a workflow word', entry(['n', 'inspect', 'x'])],
    ['workflow as the first word', entry(['workflow', 'x'])],
    ['workflow as the last word', entry(['n', 'workflow'])],
  ])('drops %s', (_name, element) => {
    expect(relaunchNextCommands([element], launcher)).toEqual([]);
  });
});

describe('formatArgv', () => {
  it('quotes for a POSIX shell and leaves placeholders bare', () => {
    expect(
      formatArgv(['/a b/node', "it's", 'plain-1.2/x', '<ANSWER_JSON>', '<lower>', '$HOME', '']),
    ).toBe(`'/a b/node' 'it'\\''s' plain-1.2/x <ANSWER_JSON> '<lower>' '$HOME' ''`);
  });

  it('leaves the human author placeholder bare but still quotes other angle-bracket values', () => {
    expect(formatArgv(['--by', 'human:<NAME>'])).toBe('--by human:<NAME>');
    expect(
      formatArgv(['human:<name>', 'human:Pat<x>', 'Human:<NAME>', 'human:<NAME>x', 'a:b:<NAME>']),
    ).toBe(`'human:<name>' 'human:Pat<x>' 'Human:<NAME>' 'human:<NAME>x' 'a:b:<NAME>'`);
  });
});
