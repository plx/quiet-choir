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
