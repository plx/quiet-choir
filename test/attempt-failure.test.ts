import { describe, expect, it } from 'vitest';

import {
  classifyAttemptFailure,
  type AttemptFailure,
  type AttemptFailureInput,
} from '../src/workflow/runtime/attempt-failure.js';
import { CheckpointError } from '../src/workflow/runtime/checkpoint.js';
import { ConfigurationError } from '../src/workflow/runtime/configuration-error.js';
import { CancelledError } from '../src/workflow/runtime/fan-out.js';
import { stepError } from '../src/workflow/runtime/step-error.js';

// ADR 0007 outcomes as a pure table: no state directory, store or workflow run.
const defaults: AttemptFailureInput = {
  cause: new Error('boom'),
  aborted: false,
  checkpointProblem: false,
  retryOn: undefined,
  attempt: 1,
  maxAttempts: 3,
  onError: 'throw',
};

function timeout(): Error {
  return Object.assign(new Error('slow'), { code: 'ETIMEDOUT' });
}

function abortError(): Error {
  const error = new Error('callback aborted');
  error.name = 'AbortError';
  return error;
}

const retrying = {
  scoped: false,
  status: 'failed',
  infrastructure: false,
  markFatal: false,
  fatal: false,
  retry: true,
  settle: false,
} as const;

const exhausted = { ...retrying, retry: false } as const;

const fatalFailure = {
  scoped: false,
  status: 'failed',
  infrastructure: false,
  markFatal: false,
  fatal: true,
  retry: false,
  settle: false,
} as const;

interface Row {
  name: string;
  input: Partial<AttemptFailureInput>;
  expected: AttemptFailure;
}

const rows: Row[] = [
  {
    name: 'external or run cancellation is scoped and never retried or settled',
    input: { aborted: true, onError: 'return' },
    expected: { ...fatalFailure, scoped: true, status: 'cancelled', errorKind: 'cancelled' },
  },
  {
    name: 'sibling cancellation is scoped and never retried or settled',
    input: {
      aborted: true,
      cause: new CancelledError('sibling', new Error('first'), 'map'),
      onError: 'return',
    },
    expected: { ...fatalFailure, scoped: true, status: 'cancelled', errorKind: 'cancelled' },
  },
  {
    name: "a callback's own AbortError fails the step but is still fatal",
    input: { cause: abortError(), onError: 'return' },
    expected: { ...fatalFailure, errorKind: 'cancelled' },
  },
  {
    name: "the run's own checkpoint failure while aborted stays a failure and is infrastructure",
    input: {
      aborted: true,
      checkpointProblem: true,
      cause: new CheckpointError('save', 'disk full', new Error('ENOSPC')),
      onError: 'return',
    },
    expected: { ...fatalFailure, infrastructure: true, errorKind: 'unknown' },
  },
  {
    name: 'a checkpoint failure without an aborted signal is still infrastructure',
    input: {
      checkpointProblem: true,
      cause: new CheckpointError('save', 'disk full', new Error('ENOSPC')),
      onError: 'return',
    },
    expected: { ...fatalFailure, infrastructure: true, errorKind: 'unknown' },
  },
  {
    name: 'a domain error reusing CheckpointError is not infrastructure',
    input: { cause: new CheckpointError('save', 'domain', new Error('x')) },
    expected: { ...retrying, errorKind: 'unknown' },
  },
  {
    name: 'ConfigurationError is fatal, marked, and never retried or settled',
    input: { cause: new ConfigurationError('bad config'), onError: 'return' },
    expected: {
      ...fatalFailure,
      infrastructure: true,
      markFatal: true,
      errorKind: 'unknown',
    },
  },
  {
    name: 'a retryable kind retries when retry.on is omitted',
    input: { cause: timeout() },
    expected: { ...retrying, errorKind: 'timeout' },
  },
  {
    name: 'a retryable kind retries when retry.on includes it',
    input: { cause: timeout(), retryOn: ['timeout'] },
    expected: { ...retrying, errorKind: 'timeout' },
  },
  {
    name: 'a retry.on filter excluding the kind settles under onError return',
    input: { cause: timeout(), retryOn: ['rate-limit'], onError: 'return' },
    expected: { ...exhausted, settle: true, errorKind: 'timeout' },
  },
  {
    name: 'a retry.on filter excluding the kind throws under onError throw',
    input: { cause: timeout(), retryOn: ['rate-limit'], onError: 'throw' },
    expected: { ...exhausted, errorKind: 'timeout' },
  },
  {
    name: 'an empty retry.on disables retry',
    input: { cause: timeout(), retryOn: [] },
    expected: { ...exhausted, errorKind: 'timeout' },
  },
  {
    name: 'exhausted attempts throw under onError throw',
    input: { cause: timeout(), attempt: 3, maxAttempts: 3 },
    expected: { ...exhausted, errorKind: 'timeout' },
  },
  {
    name: 'exhausted attempts settle under onError return',
    input: { cause: timeout(), attempt: 3, maxAttempts: 3, onError: 'return' },
    expected: { ...exhausted, settle: true, errorKind: 'timeout' },
  },
  {
    name: 'a single-attempt effect is exhausted on its first failure',
    input: { cause: timeout(), attempt: 1, maxAttempts: 1, onError: 'return' },
    expected: { ...exhausted, settle: true, errorKind: 'timeout' },
  },
  {
    name: 'an undefined onError behaves as throw',
    input: { cause: timeout(), attempt: 3, maxAttempts: 3, onError: undefined },
    expected: { ...exhausted, errorKind: 'timeout' },
  },
];

describe('classifyAttemptFailure (ADR 0007)', () => {
  it.each(rows)('$name', ({ input, expected }) => {
    const full = { ...defaults, ...input };
    const result = classifyAttemptFailure(full);
    expect(result).toEqual(expected);
    // The classified kind matches what the runner persists for the error it actually records.
    const recorded = result.scoped ? new CancelledError(null, full.cause, 'run') : full.cause;
    expect(result.errorKind).toBe(stepError(recorded, 1).kind);
  });
});
