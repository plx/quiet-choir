import { describe, expect, it } from 'vitest';

import type { RunOwnership } from '../src/workflow/runtime/lock.js';
import type { HarnessProcessInspection } from '../src/workflow/runtime/process-registry.js';
import type { StepRecord } from '../src/workflow/runtime/record.js';
import {
  classifyRecovery,
  countCompletedSteps,
  crashLoopMessage,
  decideStaleRecovery,
  STALE_RECOVERY_CAP,
  type RecoveryClass,
} from '../src/workflow/runtime/recovery-decision.js';

// Recovery rules as a pure table: no state directory, lock or process.
type OwnerState = NonNullable<RunOwnership['owner']>['state'];
type ProcessStates = 'none' | HarnessProcessInspection['state'];

function ownership(owner: OwnerState | null, processes: ProcessStates): RunOwnership {
  return {
    locked: true,
    owner: owner === null ? null : { pid: 4242, host: 'here', state: owner },
    processes:
      processes === 'none'
        ? []
        : [
            { file: '1.json', process: null, state: 'dead' },
            { file: '2.json', process: null, state: processes },
          ],
  };
}

const owners: readonly (OwnerState | null)[] = [
  null,
  'alive',
  'unknown',
  'remote',
  'dead',
  'released',
];
const processStates: readonly ProcessStates[] = ['none', 'dead', 'reused', 'alive', 'unknown'];

function expected(owner: OwnerState | null, processes: ProcessStates): RecoveryClass {
  if (owner !== 'dead' && owner !== 'released') return 'held';
  return processes === 'alive' || processes === 'unknown' ? 'orphans' : 'reclaimable';
}

describe('classifyRecovery', () => {
  it('treats a missing lock as free', () => {
    expect(classifyRecovery({ locked: false, owner: null, processes: [] })).toBe('free');
  });

  it.each(owners.flatMap((owner) => processStates.map((processes) => [owner, processes] as const)))(
    'classifies owner %s with processes %s',
    (owner, processes) => {
      expect(classifyRecovery(ownership(owner, processes))).toBe(expected(owner, processes));
    },
  );

  it('holds an unreadable lock even with a warning and no processes', () => {
    expect(
      classifyRecovery({ locked: true, owner: null, processes: [], warning: 'bad owner.json' }),
    ).toBe('held');
  });
});

function step(status: StepRecord['status']): Pick<StepRecord, 'status'> {
  return { status };
}

describe('countCompletedSteps', () => {
  it('counts only completed steps', () => {
    const steps = {
      a: step('completed'),
      b: step('completed'),
      c: step('settled-failed'),
      d: step('superseded'),
      e: step('waiting'),
      f: step('running'),
      g: step('failed'),
      h: step('withdrawn'),
      i: step('cancelled'),
    } as unknown as Record<string, StepRecord>;
    expect(countCompletedSteps({ steps })).toBe(2);
    expect(countCompletedSteps({ steps: {} })).toBe(0);
  });
});

describe('decideStaleRecovery', () => {
  const at = '2026-09-30T00:00:00.000Z';
  const earlier = '2026-09-29T00:00:00.000Z';

  it.each([
    ['first recovery', undefined, 4, { kind: 'recover', staleRecovery: { count: 1 } }],
    [
      'same baseline 1 -> 2',
      { count: 1, completedSteps: 4 },
      4,
      { kind: 'recover', staleRecovery: { count: 2 } },
    ],
    [
      'same baseline 2 -> 3',
      { count: 2, completedSteps: 4 },
      4,
      { kind: 'recover', staleRecovery: { count: 3 } },
    ],
    [
      'cap with same baseline',
      { count: 3, completedSteps: 4 },
      4,
      { kind: 'crash-loop', count: 3 },
    ],
    [
      'cap with a grown baseline resets',
      { count: 3, completedSteps: 3 },
      4,
      { kind: 'recover', staleRecovery: { count: 1 } },
    ],
    [
      'changed baseline at 2 resets',
      { count: 2, completedSteps: 5 },
      4,
      { kind: 'recover', staleRecovery: { count: 1 } },
    ],
  ] as const)('%s', (_name, previous, completedSteps, decision) => {
    const result = decideStaleRecovery(
      previous === undefined ? undefined : { ...previous, at: earlier },
      completedSteps,
      at,
    );
    if (decision.kind === 'crash-loop') expect(result).toEqual(decision);
    else
      expect(result).toEqual({
        kind: 'recover',
        staleRecovery: { count: decision.staleRecovery.count, completedSteps, at },
      });
  });

  it('caps at three and names the explicit resume', () => {
    expect(STALE_RECOVERY_CAP).toBe(3);
    const message = crashLoopMessage('r1', 3);
    expect(message).toContain('cap 3');
    expect(message).toContain("'quiet-choir workflow resume r1'");
  });
});
