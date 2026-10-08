import { describe, expect, it } from 'vitest';
import { HarnessError } from '../src/index.js';
import type { AttemptPolicy, ErrorKind } from '../src/workflow/runtime/model.js';
import {
  idleTimeoutError,
  profileLimitError,
} from '../src/workflow/runtime/profile-diagnostics.js';

const execution = {
  policy: {
    maxTurns: 10,
    maxBudgetUsd: 2,
    idleTimeoutMs: 100,
    retry: { maxAttempts: 1, delayMs: 0 },
  },
  sources: { maxTurns: 'override:0', maxBudgetUsd: 'harness', idleTimeoutMs: 'override:1' },
  requestedModel: null,
  effort: null,
} as AttemptPolicy;

function harnessError(kind: ErrorKind, reason = 'capped'): HarnessError {
  return new HarnessError({
    harness: 'claude',
    kind,
    exit: { code: 1, signal: null },
    failure: null,
    reason,
    stderr: '',
    stdout: '',
  });
}

/** A kinded error whose whole message is `message`, as a replayed fixture error rule throws it. */
function replayedError(kind: ErrorKind, message: string): HarnessError {
  const error = harnessError(kind);
  error.message = message;
  return error;
}

describe('recovery hints are added once', () => {
  it.each(['turn-limit', 'budget-limit'] as const)(
    'keeps a %s message that already carries the hint',
    (kind) => {
      const once = profileLimitError(harnessError(kind), 'x', 'text', execution);
      expect(once.message).toContain(
        `Step x hit ${kind === 'turn-limit' ? 'maxTurns' : 'maxBudgetUsd'}=`,
      );
      const twice = profileLimitError(once, 'x', 'text', execution);
      expect(twice.message).toBe(once.message);
      // A replayed fixture error carries the hint in a fresh error; it is still not added again.
      const replayed = replayedError(kind, once.message);
      expect(profileLimitError(replayed, 'x', 'text', execution).message).toBe(once.message);
    },
  );

  it('still annotates a limit error whose hint names another step', () => {
    const other = profileLimitError(harnessError('turn-limit'), 'y', 'text', execution);
    const annotated = profileLimitError(
      replayedError('turn-limit', other.message),
      'x',
      'text',
      execution,
    );
    expect(annotated.message).toContain('Step y hit maxTurns=');
    expect(annotated.message).toContain('Step x hit maxTurns=');
  });

  it('keeps an idle-timeout message that already carries the hint', () => {
    const plain = Object.assign(new Error('fake produced no output for 100ms (idleTimeoutMs).'), {
      code: 'QUIET_CHOIR_IDLE_TIMEOUT',
    });
    const once = idleTimeoutError(plain, 'x', 'text', execution) as Error;
    expect(once.message).toContain('Step x produced no output for idleTimeoutMs=100');
    expect((idleTimeoutError(once, 'x', 'text', execution) as Error).message).toBe(once.message);
    const kinded = idleTimeoutError(harnessError('idle-timeout'), 'x', 'text', execution) as Error;
    expect((idleTimeoutError(kinded, 'x', 'text', execution) as Error).message).toBe(
      kinded.message,
    );
    const replayed = replayedError('idle-timeout', kinded.message);
    expect((idleTimeoutError(replayed, 'x', 'text', execution) as Error).message).toBe(
      kinded.message,
    );
  });
});
