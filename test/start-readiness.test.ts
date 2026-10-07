import { describe, expect, it } from 'vitest';

import {
  decideStart,
  type StartDecision,
  type StartObservation,
} from '../src/workflow/loader/start-readiness.js';

// The readiness rule of `workflow start` as a pure table: no process, store or clock.
const base: StartObservation = {
  childPid: 100,
  exit: null,
  recordReadable: false,
  ownerPid: null,
  document: null,
  deadlinePassed: false,
};
const exited = { code: 0, signal: null };
const failure = (errorCode: string) => ({ ok: false, errorCode });

describe('decideStart', () => {
  it.each<[string, Partial<StartObservation>, StartDecision]>([
    ['alive, no record yet: wait', {}, { type: 'wait' }],
    ['alive, record readable but unlocked: wait', { recordReadable: true }, { type: 'wait' }],
    [
      'alive, record owned by the runner: started',
      { recordReadable: true, ownerPid: 100 },
      { type: 'started' },
    ],
    [
      'alive, record owned by another runner: wait',
      { recordReadable: true, ownerPid: 200 },
      { type: 'wait' },
    ],
    [
      'alive past the deadline without an owned record: timeout',
      { deadlinePassed: true, recordReadable: true, ownerPid: 200 },
      { type: 'failed', reason: 'timeout' },
    ],
    [
      'alive past the deadline with an owned record: started',
      { deadlinePassed: true, recordReadable: true, ownerPid: 100 },
      { type: 'started' },
    ],
    [
      'exited ok:true with a record (fast completion or suspension): started',
      { exit: exited, recordReadable: true, document: { ok: true, errorCode: null } },
      { type: 'started' },
    ],
    [
      'exited ok:true without a record: failed exited',
      { exit: exited, document: { ok: true, errorCode: null } },
      { type: 'failed', reason: 'exited' },
    ],
    [
      'exited workflow.failed with a record: started',
      {
        exit: { code: 1, signal: null },
        recordReadable: true,
        document: failure('workflow.failed'),
      },
      { type: 'started' },
    ],
    [
      'exited workflow.interrupted with a record: started',
      {
        exit: { code: 130, signal: null },
        recordReadable: true,
        document: failure('workflow.interrupted'),
      },
      { type: 'started' },
    ],
    [
      'exited run.exists with a record (someone else made it): failed document',
      { exit: { code: 3, signal: null }, recordReadable: true, document: failure('run.exists') },
      { type: 'failed', reason: 'document' },
    ],
    [
      'exited run.locked with a record (someone else holds it): failed document',
      { exit: { code: 3, signal: null }, recordReadable: true, document: failure('run.locked') },
      { type: 'failed', reason: 'document' },
    ],
    [
      'exited with an error document and no record: failed document',
      { exit: { code: 4, signal: null }, document: failure('load.typecheck') },
      { type: 'failed', reason: 'document' },
    ],
    [
      'exited without a document and no record: failed exited',
      { exit: { code: null, signal: 'SIGKILL' } },
      { type: 'failed', reason: 'exited' },
    ],
    [
      'exited without a document but with a record: failed exited',
      { exit: { code: null, signal: 'SIGKILL' }, recordReadable: true },
      { type: 'failed', reason: 'exited' },
    ],
    [
      'exited past the deadline: the exit decides, not the deadline',
      { exit: exited, deadlinePassed: true, document: failure('usage.flag') },
      { type: 'failed', reason: 'document' },
    ],
  ])('%s', (_label, overrides, expected) => {
    expect(decideStart({ ...base, ...overrides })).toEqual(expected);
  });
});

// The resume rule (ADR 0056): the record exists from the start, so only an execution recorded by the
// runner itself counts while it lives; after it exits, its own document decides otherwise.
describe('decideStart for a resume', () => {
  const resume: StartObservation = { ...base, mode: 'resume', recordReadable: true };
  const owned = { executionByRunner: true };
  it.each<[string, Partial<StartObservation>, StartDecision]>([
    ['alive, record readable, no new execution: wait', {}, { type: 'wait' }],
    [
      'alive, lock owned by the runner but no new execution yet: wait',
      { ownerPid: 100 },
      { type: 'wait' },
    ],
    [
      'alive, a new execution by the runner: started',
      { ...owned, ownerPid: 100 },
      { type: 'started' },
    ],
    [
      'alive, a new execution by the runner while the record reads as unlocked: started',
      owned,
      { type: 'started' },
    ],
    [
      'alive, a new execution by another PID (or an old one by the runner’s PID): wait',
      { executionByRunner: false, ownerPid: 200 },
      { type: 'wait' },
    ],
    [
      'alive, record not readable even with a matching execution flag: wait',
      { ...owned, recordReadable: false },
      { type: 'wait' },
    ],
    [
      'alive past the deadline without a new execution: timeout',
      { deadlinePassed: true, ownerPid: 100 },
      { type: 'failed', reason: 'timeout' },
    ],
    [
      'alive past the deadline with a new execution: started',
      { ...owned, deadlinePassed: true },
      { type: 'started' },
    ],
    [
      'exited workflow.failed after a new execution: started',
      { ...owned, exit: { code: 1, signal: null }, document: failure('workflow.failed') },
      { type: 'started' },
    ],
    [
      'exited workflow.interrupted after a new execution: started',
      { ...owned, exit: { code: 130, signal: null }, document: failure('workflow.interrupted') },
      { type: 'started' },
    ],
    [
      'exited ok:true after a new execution (completed or suspended): started',
      { ...owned, exit: exited, document: { ok: true, errorCode: null } },
      { type: 'started' },
    ],
    [
      'exited ok:true without a new execution (a completed run replayed): started',
      { exit: exited, document: { ok: true, errorCode: null } },
      { type: 'started' },
    ],
    [
      'exited ok:true without a readable record: failed exited',
      { exit: exited, recordReadable: false, document: { ok: true, errorCode: null } },
      { type: 'failed', reason: 'exited' },
    ],
    [
      'exited run.locked without a new execution: failed document',
      { exit: { code: 3, signal: null }, document: failure('run.locked') },
      { type: 'failed', reason: 'document' },
    ],
    [
      'exited run.orphans without a new execution: failed document',
      { exit: { code: 3, signal: null }, document: failure('run.orphans') },
      { type: 'failed', reason: 'document' },
    ],
    [
      'exited run.incompatible without a new execution: failed document',
      { exit: { code: 3, signal: null }, document: failure('run.incompatible') },
      { type: 'failed', reason: 'document' },
    ],
    [
      'exited workflow.failed without a new execution (a refusal under the lock): failed document',
      { exit: { code: 1, signal: null }, document: failure('workflow.failed') },
      { type: 'failed', reason: 'document' },
    ],
    [
      'exited without a document: failed exited',
      { exit: { code: null, signal: 'SIGKILL' } },
      { type: 'failed', reason: 'exited' },
    ],
    [
      'exited without a document after a new execution: failed exited, as for a new run',
      { ...owned, exit: { code: null, signal: 'SIGKILL' } },
      { type: 'failed', reason: 'exited' },
    ],
  ])('%s', (_label, overrides, expected) => {
    expect(decideStart({ ...resume, ...overrides })).toEqual(expected);
  });

  it('keeps the new-run rule when mode is new or absent', () => {
    // A readable record owned by the runner is a new run's signal, never a resume's.
    const observation = { ...base, recordReadable: true, ownerPid: 100 };
    expect(decideStart(observation)).toEqual({ type: 'started' });
    expect(decideStart({ ...observation, mode: 'new' })).toEqual({ type: 'started' });
    expect(decideStart({ ...observation, mode: 'resume' })).toEqual({ type: 'wait' });
  });
});
