import { describe, expect, it } from 'vitest';

import { formatArgv } from '../src/workflow/runtime/commands.js';
import type { RunLockView, RunOwnership } from '../src/workflow/runtime/lock.js';
import type { HarnessProcessInspection } from '../src/workflow/runtime/process-registry.js';
import type { RunRecord, StepRecord } from '../src/workflow/runtime/record.js';
import {
  ownershipHold,
  removalRefusal,
  removalVerdict,
  type RemovalVerdict,
} from '../src/workflow/runtime/removal-decision.js';

// Removal guards as a pure table: no state directory, lock or process.
type OwnerState = NonNullable<RunLockView['owner']>['state'];
type MarkerState = NonNullable<RunLockView['recovery']>['state'];
type ChildState = 'none' | HarnessProcessInspection['state'];

function lock(
  kind: RunLockView['kind'],
  owner: OwnerState | 'unreadable' | null,
  recovery: MarkerState | 'unreadable' | null = null,
): RunLockView {
  return {
    kind,
    path: `/state/${kind}`,
    owner:
      owner === null || owner === 'unreadable'
        ? null
        : { pid: 4242, host: owner === 'remote' ? 'far' : 'here', state: owner, osStartTime: null },
    recovery:
      recovery === null || recovery === 'unreadable'
        ? null
        : { pid: 4343, host: recovery === 'remote' ? 'far' : 'here', state: recovery },
    ...(owner === 'unreadable' ? { warning: 'owner.json: Unexpected token' } : {}),
    ...(recovery === 'unreadable' ? { warning: 'recovery.json: Unexpected token' } : {}),
  };
}

function observed(locks: readonly RunLockView[], children: ChildState = 'none'): RunOwnership {
  const first = locks[0];
  return {
    locked: locks.length > 0,
    owner: first?.owner ?? null,
    processes:
      children === 'none'
        ? []
        : [
            { file: '1.json', process: null, state: 'dead' },
            { file: '2.json', process: null, state: children },
          ],
    locks,
  };
}

function run(status: RunRecord['status'], waiting = false): Pick<RunRecord, 'status' | 'steps'> {
  const step = (state: StepRecord['status']): StepRecord =>
    ({ kind: 'ask', status: state }) as unknown as StepRecord;
  return {
    status,
    steps: { done: step('completed'), ...(waiting ? { question: step('waiting') } : {}) },
  };
}

const unlocked = observed([]);
const dead = observed([lock('primary', 'dead'), lock('guard', 'dead')]);

describe('removalVerdict', () => {
  it.each([
    ['completed', false, false, 'remove'],
    ['cancelled', false, false, 'remove'],
    ['failed', false, false, 'remove'],
    ['failed', true, false, 'active'],
    ['completed', true, false, 'active'],
    ['running', false, false, 'active'],
    ['suspended', false, false, 'active'],
    ['suspended', true, false, 'active'],
    ['running', false, true, 'remove'],
    ['suspended', true, true, 'remove'],
    ['failed', true, true, 'remove'],
  ] as const)('status %s, waiting %s, force %s: %s', (status, waiting, force, kind) => {
    for (const ownership of [unlocked, dead])
      expect(removalVerdict(run(status, waiting), ownership, { force }).kind).toBe(kind);
  });

  it('lists waiting steps and the status of an active run', () => {
    expect(removalVerdict(run('failed', true), unlocked, { force: false })).toEqual({
      kind: 'active',
      status: 'failed',
      waiting: ['question'],
    });
  });

  it.each<[string, RunLockView[], string, string]>([
    ['live primary owner', [lock('primary', 'alive')], 'owner', 'alive'],
    ['unknown primary owner', [lock('primary', 'unknown')], 'owner', 'unknown'],
    ['remote primary owner', [lock('primary', 'remote')], 'owner', 'remote'],
    ['live guard owner', [lock('primary', 'dead'), lock('guard', 'alive')], 'owner', 'alive'],
    ['guard alone, live', [lock('guard', 'alive')], 'owner', 'alive'],
    ['live recoverer', [lock('primary', 'dead', 'alive')], 'recovery', 'alive'],
    ['unknown recoverer', [lock('primary', 'released', 'unknown')], 'recovery', 'unknown'],
    ['remote recoverer', [lock('primary', 'dead', 'remote')], 'recovery', 'remote'],
    ['unreadable owner', [lock('primary', 'unreadable')], 'owner', 'unreadable'],
    ['missing owner', [lock('primary', null)], 'owner', 'unreadable'],
    ['unreadable marker', [lock('primary', 'dead', 'unreadable')], 'recovery', 'unreadable'],
  ])('refuses a %s even with force', (_name, locks, role, reason) => {
    for (const force of [false, true])
      for (const children of ['none', 'alive'] as const)
        expect(
          removalVerdict(run('completed'), observed(locks, children), { force }),
        ).toMatchObject({ kind: 'locked', role, reason });
  });

  it('decides by the top-level owner of an observation without lock views', () => {
    const top = (owner: RunOwnership['owner']): RunOwnership => ({
      locked: true,
      owner,
      processes: [],
      locks: [],
      warning: 'owner.json: bad',
    });
    expect(removalVerdict(run('completed'), top(null), { force: true })).toMatchObject({
      kind: 'locked',
      reason: 'unreadable',
      warning: 'owner.json: bad',
    });
    expect(
      removalVerdict(
        run('completed'),
        top({ pid: 1, host: 'h', state: 'alive', osStartTime: null }),
        { force: true },
      ),
    ).toMatchObject({ kind: 'locked', reason: 'alive' });
    expect(
      removalVerdict(
        run('completed'),
        top({ pid: 1, host: 'h', state: 'dead', osStartTime: null }),
        { force: true },
      ).kind,
    ).toBe('remove');
  });

  it.each<[OwnerState, MarkerState | null, ChildState, boolean, RemovalVerdict['kind']]>([
    ['dead', null, 'alive', true, 'orphans'],
    ['dead', null, 'unknown', false, 'orphans'],
    ['released', null, 'alive', true, 'orphans'],
    ['released', 'dead', 'unknown', true, 'orphans'],
    ['dead', null, 'dead', false, 'remove'],
    ['dead', null, 'reused', true, 'remove'],
    ['released', 'dead', 'none', false, 'remove'],
  ])('owner %s, recoverer %s, child %s, force %s: %s', (owner, recovery, children, force, kind) => {
    expect(
      removalVerdict(run('completed'), observed([lock('primary', owner, recovery)], children), {
        force,
      }).kind,
    ).toBe(kind);
  });

  it('ranks orphans ahead of an active status', () => {
    expect(
      removalVerdict(run('running'), observed([lock('primary', 'dead')], 'alive'), {
        force: false,
      }).kind,
    ).toBe('orphans');
  });
});

describe('ownershipHold', () => {
  it.each<[string, RunOwnership, string | null, string | null]>([
    ['no lock', unlocked, null, null],
    ['dead owners', dead, null, null],
    ['a live owner', observed([lock('primary', 'alive')]), 'locked', 'alive'],
    ['an unknown owner', observed([lock('primary', 'unknown')]), 'locked', 'unknown'],
    ['a remote owner', observed([lock('guard', 'remote')]), 'locked', 'remote'],
    ['an unreadable owner', observed([lock('primary', 'unreadable')]), 'locked', 'unreadable'],
    ['a live recoverer', observed([lock('primary', 'dead', 'alive')]), 'locked', 'alive'],
    ['a live orphan', observed([lock('primary', 'dead')], 'alive'), 'orphans', null],
    ['an unknown orphan', observed([lock('primary', 'released')], 'unknown'), 'orphans', null],
    ['a dead child', observed([lock('primary', 'dead')], 'dead'), null, null],
  ])('%s: %s', (_name, ownership, kind, reason) => {
    const hold = ownershipHold(ownership);
    expect(hold?.kind ?? null).toBe(kind);
    if (hold?.kind === 'locked') expect(hold.reason).toBe(reason);
  });

  it('is exactly the lock and orphan part of removalVerdict, whatever the record says', () => {
    const observations = [
      unlocked,
      dead,
      observed([lock('primary', 'alive')]),
      observed([lock('primary', 'dead', 'unknown')]),
      observed([lock('primary', 'dead')], 'alive'),
    ];
    for (const ownership of observations)
      for (const record of [run('completed'), run('running'), run('failed', true)])
        for (const force of [false, true]) {
          const verdict = removalVerdict(record, ownership, { force });
          const hold = ownershipHold(ownership);
          if (hold) expect(verdict).toEqual(hold);
          else expect(['remove', 'active']).toContain(verdict.kind);
        }
  });
});

describe('removalRefusal', () => {
  const stateDir = '/state';
  const refuse = (verdict: RemovalVerdict) => {
    if (verdict.kind === 'remove') throw new Error('expected a refusal');
    return removalRefusal('run-1', stateDir, verdict);
  };

  it('points a remote owner to unlock --force-remote', () => {
    const refusal = refuse(
      removalVerdict(run('completed'), observed([lock('primary', 'remote')]), { force: true }),
    );
    expect(refusal.code).toBe('run.locked');
    expect(refusal.message).toContain(
      'quiet-choir workflow unlock run-1 --state-dir /state --force-remote',
    );
    expect(refusal.details).toMatchObject({ kind: 'primary', role: 'owner', state: 'remote' });
  });

  it('points unreadable metadata to unlock and a live owner to waiting', () => {
    const unreadable = refuse(
      removalVerdict(run('completed'), observed([lock('primary', 'unreadable')]), { force: true }),
    );
    expect(unreadable.message).toContain('quiet-choir workflow unlock run-1 --state-dir /state,');
    expect(unreadable.message).not.toContain('--force-remote');
    const live = refuse(
      removalVerdict(run('completed'), observed([lock('guard', 'alive')]), { force: true }),
    );
    expect(live.message).toMatch(/guard lock owner PID 4242 on here is alive; --force does not/u);
  });

  describe('behind a launcher', () => {
    const launcher = [process.execPath, '/abs/bin/run.js'];
    const unlock = [...launcher, 'workflow', 'unlock', 'run-1', '--state-dir', '/state'];
    const refuseWith = (verdict: RemovalVerdict, program?: readonly string[]) => {
      if (verdict.kind === 'remove') throw new Error('expected a refusal');
      return removalRefusal('run-1', stateDir, verdict, program);
    };

    it('builds the remote and unreadable commands from details.next', () => {
      const remote = refuseWith(
        removalVerdict(run('completed'), observed([lock('primary', 'remote')]), { force: true }),
        launcher,
      );
      expect(remote.details).toMatchObject({
        next: [{ why: expect.any(String) as unknown, argv: [...unlock, '--force-remote'] }],
      });
      expect(remote.message).toContain(formatArgv([...unlock, '--force-remote']));
      const unreadable = refuseWith(
        removalVerdict(run('completed'), observed([lock('primary', 'unreadable')]), {
          force: true,
        }),
        launcher,
      );
      expect(unreadable.details).toMatchObject({
        next: [{ why: expect.any(String) as unknown, argv: unlock }],
      });
      expect(unreadable.message).toContain(`${formatArgv(unlock)},`);
      expect(JSON.stringify(unreadable.details)).not.toContain('--force-remote');
    });

    it('falls back to the default launcher and gives live owners no entry', () => {
      const remote = refuseWith(
        removalVerdict(run('completed'), observed([lock('primary', 'remote')]), { force: true }),
      );
      expect(remote.details).toMatchObject({
        next: [
          {
            argv: [
              'quiet-choir',
              'workflow',
              'unlock',
              'run-1',
              '--state-dir',
              '/state',
              '--force-remote',
            ],
          },
        ],
      });
      for (const state of ['alive', 'unknown'] as const) {
        const live = refuseWith(
          removalVerdict(run('completed'), observed([lock('guard', state)]), { force: true }),
          launcher,
        );
        expect(live.details).not.toHaveProperty('next');
        expect(live.message).not.toContain('unlock');
      }
    });
  });

  it('explains orphans and active runs with their details', () => {
    const orphans = refuse(
      removalVerdict(run('completed'), observed([lock('primary', 'dead')], 'alive'), {
        force: true,
      }),
    );
    expect(orphans.code).toBe('run.orphans');
    expect(orphans.message).toContain('--kill-orphans');
    expect(orphans.details).toMatchObject({ owner: { state: 'dead' }, processes: [{}, {}] });
    const active = refuse(removalVerdict(run('failed', true), unlocked, { force: false }));
    expect(active).toMatchObject({
      code: 'run.active',
      details: { status: 'failed', waiting: ['question'] },
    });
    expect(active.message).toContain('still has waiting steps (waiting: question)');
    expect(active.message).toContain('--force');
  });
});
