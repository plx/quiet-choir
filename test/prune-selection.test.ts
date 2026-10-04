import { describe, expect, it } from 'vitest';

import type { InspectionStatus } from '../src/workflow/loader/inspection.js';
import {
  defaultPruneStatuses,
  pruneDecision,
  type PruneCandidate,
  type PruneDecision,
  type PruneFilters,
} from '../src/workflow/loader/prune-selection.js';
import type { OwnershipHold } from '../src/workflow/runtime/removal-decision.js';

// Prune selection as a pure table: no state directory, lock, clock or process.
const day = 86_400_000;
const now = Date.parse('2026-10-04T12:00:00.000Z');
const ago = (ms: number) => new Date(now - ms).toISOString();

function candidate(overrides: Partial<PruneCandidate> = {}): PruneCandidate {
  return {
    runId: 'run-1',
    stateDir: '/state',
    status: 'completed',
    updatedAt: ago(30 * day),
    cwdMissing: null,
    waiting: [],
    queuedAnswers: 0,
    hold: null,
    ...overrides,
  };
}

function filters(overrides: Partial<PruneFilters> = {}): PruneFilters {
  return { statuses: defaultPruneStatuses, olderThanMs: null, missingCwd: false, ...overrides };
}

const kind = (decision: PruneDecision) =>
  decision.kind === 'protect' ? `protect:${decision.reason}` : decision.kind;

const locked = (reason: 'alive' | 'unknown' | 'remote' | 'unreadable'): OwnershipHold => ({
  kind: 'locked',
  lock: { kind: 'primary', path: '/state/run-1/lock' },
  role: 'owner',
  reason,
  pid: reason === 'unreadable' ? null : 4242,
  host: reason === 'remote' ? 'far' : 'here',
  warning: reason === 'unreadable' ? 'owner.json: missing' : null,
});
const recovering: OwnershipHold = { ...locked('alive'), role: 'recovery' };
const orphans: OwnershipHold = {
  kind: 'orphans',
  owner: { pid: 4242, host: 'here', state: 'dead', osStartTime: null },
  processes: [{ file: '1.json', process: null, state: 'alive' }],
};

describe('pruneDecision filters', () => {
  it('defaults to the three terminal statuses', () => {
    expect(defaultPruneStatuses).toEqual(['completed', 'failed', 'cancelled']);
  });

  it.each<[string, Partial<PruneCandidate>, Partial<PruneFilters>, string]>([
    ['a completed run, default statuses', {}, {}, 'select'],
    ['a failed run, default statuses', { status: 'failed' }, {}, 'select'],
    ['a cancelled run, default statuses', { status: 'cancelled' }, {}, 'select'],
    [
      'a failed run, --status completed',
      { status: 'failed' },
      { statuses: ['completed'] },
      'ignore',
    ],
    [
      'a completed run, --status failed,cancelled',
      {},
      { statuses: ['failed', 'cancelled'] },
      'ignore',
    ],
    ['older than 7d by a day', { updatedAt: ago(8 * day) }, { olderThanMs: 7 * day }, 'select'],
    ['younger than 7d', { updatedAt: ago(6 * day) }, { olderThanMs: 7 * day }, 'ignore'],
    ['exactly 7d old', { updatedAt: ago(7 * day) }, { olderThanMs: 7 * day }, 'ignore'],
    ['7d and 1ms old', { updatedAt: ago(7 * day + 1) }, { olderThanMs: 7 * day }, 'select'],
    ['--older-than 0s, updated now', { updatedAt: ago(0) }, { olderThanMs: 0 }, 'ignore'],
    ['--older-than 0s, updated 1ms ago', { updatedAt: ago(1) }, { olderThanMs: 0 }, 'select'],
    [
      'an unparseable updatedAt with an age filter',
      { updatedAt: 'yesterday' },
      { olderThanMs: 0 },
      'ignore',
    ],
    ['an unparseable updatedAt without an age filter', { updatedAt: 'yesterday' }, {}, 'select'],
    ['a missing cwd', { cwdMissing: true }, { missingCwd: true }, 'select'],
    ['an existing cwd', { cwdMissing: false }, { missingCwd: true }, 'ignore'],
    ['an unknown cwd', { cwdMissing: null }, { missingCwd: true }, 'ignore'],
    ['a missing cwd without --missing-cwd', { cwdMissing: true }, {}, 'select'],
    [
      'every filter matching',
      { status: 'failed', updatedAt: ago(8 * day), cwdMissing: true },
      { statuses: ['failed'], olderThanMs: 7 * day, missingCwd: true },
      'select',
    ],
    [
      'every filter but age matching',
      { status: 'failed', updatedAt: ago(day), cwdMissing: true },
      { statuses: ['failed'], olderThanMs: 7 * day, missingCwd: true },
      'ignore',
    ],
    [
      'every filter but status matching',
      { status: 'cancelled', updatedAt: ago(8 * day), cwdMissing: true },
      { statuses: ['failed'], olderThanMs: 7 * day, missingCwd: true },
      'ignore',
    ],
    [
      'every filter but cwd matching',
      { status: 'failed', updatedAt: ago(8 * day), cwdMissing: false },
      { statuses: ['failed'], olderThanMs: 7 * day, missingCwd: true },
      'ignore',
    ],
  ])('%s: %s', (_name, run, filter, expected) => {
    expect(kind(pruneDecision(candidate(run), filters(filter), now))).toBe(expected);
  });
});

describe('pruneDecision protections', () => {
  // Every filter matches the run, including statuses that only a direct caller could pass.
  const all = (status: InspectionStatus): PruneFilters => ({
    statuses: [status],
    olderThanMs: day,
    missingCwd: true,
  });
  const matching = (overrides: Partial<PruneCandidate>) =>
    candidate({ updatedAt: ago(30 * day), cwdMissing: true, ...overrides });

  it.each<[string, Partial<PruneCandidate>, string]>([
    ['a running run', { status: 'running' }, 'protect:active'],
    ['a stale run', { status: 'stale' }, 'protect:active'],
    ['a suspended run', { status: 'suspended' }, 'protect:active'],
    ['a live lock owner', { hold: locked('alive') }, 'protect:locked'],
    ['an unverifiable lock owner', { hold: locked('unknown') }, 'protect:locked'],
    ['a lock owner on a foreign host', { hold: locked('remote') }, 'protect:locked'],
    ['unreadable lock metadata', { hold: locked('unreadable') }, 'protect:locked'],
    ['a live recoverer', { hold: recovering }, 'protect:locked'],
    ['a live orphan', { hold: orphans }, 'protect:orphans'],
    ['a waiting step', { status: 'failed', waiting: ['gate'] }, 'protect:waiting'],
    ['a queued answer', { queuedAnswers: 1 }, 'protect:queued-answer'],
  ])('protects %s even when every filter matches', (_name, run, expected) => {
    const subject = matching(run);
    expect(kind(pruneDecision(subject, all(subject.status), now))).toBe(expected);
  });

  it('carries the details of each protection', () => {
    expect(pruneDecision(matching({ status: 'suspended' }), all('suspended'), now)).toEqual({
      kind: 'protect',
      reason: 'active',
      status: 'suspended',
    });
    expect(pruneDecision(matching({ hold: orphans }), all('completed'), now)).toEqual({
      kind: 'protect',
      reason: 'orphans',
      hold: orphans,
    });
    expect(pruneDecision(matching({ waiting: ['a', 'b'] }), all('completed'), now)).toEqual({
      kind: 'protect',
      reason: 'waiting',
      waiting: ['a', 'b'],
    });
    expect(pruneDecision(matching({ queuedAnswers: 2 }), all('completed'), now)).toEqual({
      kind: 'protect',
      reason: 'queued-answer',
      queuedAnswers: 2,
    });
  });

  it('checks protections in order: active, hold, waiting, queued answer', () => {
    const everything = {
      hold: locked('alive'),
      waiting: ['gate'],
      queuedAnswers: 1,
    } satisfies Partial<PruneCandidate>;
    const decide = (overrides: Partial<PruneCandidate>) => {
      const subject = matching(overrides);
      return kind(pruneDecision(subject, all(subject.status), now));
    };
    expect(decide({ ...everything, status: 'running' })).toBe('protect:active');
    expect(decide({ ...everything, status: 'completed' })).toBe('protect:locked');
    expect(decide({ ...everything, hold: orphans })).toBe('protect:orphans');
    expect(decide({ ...everything, hold: null })).toBe('protect:waiting');
    expect(decide({ queuedAnswers: 1 })).toBe('protect:queued-answer');
    expect(decide({})).toBe('select');
  });

  it('ignores a protected run that does not match, rather than reporting it', () => {
    expect(kind(pruneDecision(candidate({ status: 'suspended' }), filters(), now))).toBe('ignore');
    expect(
      kind(
        pruneDecision(
          candidate({ hold: locked('alive'), updatedAt: ago(0) }),
          filters({ olderThanMs: day }),
          now,
        ),
      ),
    ).toBe('ignore');
  });
});
