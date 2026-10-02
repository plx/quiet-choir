import { describe, expect, it } from 'vitest';

import { workflowErrorDocument } from '../src/cli/workflow-errors.js';
import {
  failureKind,
  rootCauseErrorKind,
  rootCauseSummary,
  stepErrorKind,
} from '../src/workflow/loader/failure-kind.js';
import { workflowFailure } from '../src/workflow/loader/failure.js';
import type { AttemptRecord, RunRecord, StepRecord } from '../src/workflow/runtime/store.js';

const base = {
  formatVersion: 1,
  id: 'run-1',
  status: 'failed',
  workflow: { name: 'test', version: '1', fingerprint: null },
  cwd: '/project',
  input: {},
  output: null,
  error: 'boom',
  steps: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:01.000Z',
} satisfies RunRecord;

function step(status: StepRecord['status'], kinds: AttemptRecord['errorKind'][] = []): StepRecord {
  return {
    kind: 'agent',
    harness: 'claude',
    fingerprint: 'f',
    status,
    attempts: Math.max(kinds.length, 1),
    output: null,
    error: status === 'completed' ? null : 'failed',
    wakeAt: null,
    ...(kinds.length
      ? {
          attemptHistory: kinds.map((errorKind, index) => ({
            attempt: index + 1,
            status: 'failed',
            ...(errorKind === undefined ? {} : { errorKind }),
          })) as unknown as AttemptRecord[],
        }
      : {}),
  };
}

describe('stepErrorKind', () => {
  it('uses the last attempt, and null without an attempt or a kind', () => {
    expect(stepErrorKind(step('failed', ['rate-limit', 'authentication']))).toBe('authentication');
    expect(stepErrorKind(step('failed'))).toBeNull();
    expect(stepErrorKind(step('running', [undefined]))).toBeNull();
  });
});

describe('failureKind', () => {
  it('derives retryable from the transient set', () => {
    expect(failureKind('overloaded')).toEqual({ errorKind: 'overloaded', retryable: true });
    expect(failureKind('timeout')).toEqual({ errorKind: 'timeout', retryable: true });
    expect(failureKind('authentication')).toEqual({
      errorKind: 'authentication',
      retryable: false,
    });
    expect(failureKind(null)).toEqual({ errorKind: null, retryable: false });
  });
});

describe('rootCauseErrorKind', () => {
  const steps = { a: step('failed', ['process', 'rate-limit']) };

  it('prefers the stored kind, including a stored null', () => {
    expect(
      rootCauseErrorKind({ steps, rootCause: { stepId: 'a', error: 'e', errorKind: 'schema' } }),
    ).toBe('schema');
    expect(
      rootCauseErrorKind({ steps, rootCause: { stepId: 'a', error: 'e', errorKind: null } }),
    ).toBeNull();
  });

  it('falls back to the root step for a record without the field', () => {
    expect(rootCauseErrorKind({ steps, rootCause: { stepId: 'a', error: 'e' } })).toBe(
      'rate-limit',
    );
    expect(rootCauseErrorKind({ steps, rootCause: { stepId: null, error: 'e' } })).toBeNull();
    expect(rootCauseErrorKind({ steps, rootCause: { stepId: 'gone', error: 'e' } })).toBeNull();
  });

  it('is null without a root cause', () => {
    expect(rootCauseErrorKind({ steps, rootCause: null })).toBeNull();
    expect(rootCauseErrorKind({ steps })).toBeNull();
    expect(rootCauseSummary({ steps })).toBeNull();
  });
});

describe('workflowErrorDocument failure kinds', () => {
  it('adds errorKind and retryable to every failed or cancelled step', () => {
    const run: RunRecord = {
      ...base,
      steps: {
        ok: step('completed'),
        auth: step('failed', ['authentication']),
        busy: step('failed', ['overloaded']),
        sibling: step('cancelled', ['cancelled']),
        bare: step('failed'),
      },
      rootCause: { stepId: 'auth', error: 'denied', errorKind: 'authentication' },
    };
    const document = workflowErrorDocument(
      workflowFailure('workflow.failed', 'denied', {
        run,
        stepId: 'auth',
        details: failureKind(rootCauseErrorKind(run)),
      }),
    );
    expect(document).toMatchObject({
      error: { details: { errorKind: 'authentication', retryable: false } },
      failedSteps: [
        { id: 'auth', kind: 'agent', errorKind: 'authentication', retryable: false },
        { id: 'busy', errorKind: 'overloaded', retryable: true },
        { id: 'sibling', errorKind: 'cancelled', retryable: false },
        { id: 'bare', errorKind: null, retryable: false },
      ],
    });
  });
});
