import { describe, expect, it, vi } from 'vitest';

import {
  classifyAttemptFailure,
  type AttemptFailure,
  type AttemptFailureInput,
} from '../src/workflow/runtime/attempt-failure.js';
import { CheckpointError } from '../src/workflow/runtime/checkpoint.js';
import { ConfigurationError } from '../src/workflow/runtime/configuration-error.js';
import { CancelledError } from '../src/workflow/runtime/fan-out.js';
import { stepError } from '../src/workflow/runtime/step-error.js';

// A second module instance, as `workflow execute` gives workflow and custom-adapter code (ADR 0028).
vi.resetModules();
const secondConfiguration = await import('../src/workflow/runtime/configuration-error.js');
const secondHarness = await import('../src/workflow/runtime/harness-error.js');

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

function idle(): Error {
  return Object.assign(new Error('silent'), { code: 'QUIET_CHOIR_IDLE_TIMEOUT' });
}

function harnessFailure(apiStatus: number): InstanceType<typeof secondHarness.HarnessError> {
  return new secondHarness.HarnessError({
    harness: 'custom',
    exit: { code: 1, signal: null },
    failure: {
      reason: `HTTP ${String(apiStatus)}`,
      subtype: null,
      terminalReason: null,
      apiStatus,
      sessionId: null,
      usage: null,
    },
    reason: 'failed',
    stderr: '',
    stdout: '',
  });
}

function spawnFailure(): Error {
  return Object.assign(new Error('missing'), { code: 'ENOENT' });
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
    name: "another module instance's ConfigurationError is fatal even with onError return",
    input: {
      cause: new secondConfiguration.ConfigurationError('bad config'),
      onError: 'return',
    },
    expected: {
      ...fatalFailure,
      infrastructure: true,
      markFatal: true,
      errorKind: 'unknown',
    },
  },
  {
    name: "another module instance's HarnessError 429 retries under retry.on rate-limit",
    input: {
      cause: new secondHarness.HarnessError({
        harness: 'custom',
        exit: { code: 1, signal: null },
        failure: {
          reason: 'Rate limit reached',
          subtype: null,
          terminalReason: null,
          apiStatus: 429,
          sessionId: null,
          usage: null,
        },
        reason: 'rate limited',
        stderr: '',
        stdout: '',
      }),
      retryOn: ['rate-limit'],
      onError: 'return',
    },
    expected: { ...retrying, errorKind: 'rate-limit' },
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
    name: 'transient retries a rate-limit failure',
    input: { cause: harnessFailure(429), retryOn: ['transient'] },
    expected: { ...retrying, errorKind: 'rate-limit' },
  },
  {
    name: 'transient retries an overloaded failure',
    input: { cause: harnessFailure(529), retryOn: ['transient'] },
    expected: { ...retrying, errorKind: 'overloaded' },
  },
  {
    name: 'transient retries a timeout',
    input: { cause: timeout(), retryOn: ['transient'] },
    expected: { ...retrying, errorKind: 'timeout' },
  },
  {
    name: 'an idle timeout retries when retry.on is omitted',
    input: { cause: idle() },
    expected: { ...retrying, errorKind: 'idle-timeout' },
  },
  {
    name: 'an idle timeout retries when retry.on names idle-timeout',
    input: { cause: idle(), retryOn: ['idle-timeout'] },
    expected: { ...retrying, errorKind: 'idle-timeout' },
  },
  {
    name: 'transient retries an idle timeout',
    input: { cause: idle(), retryOn: ['transient'] },
    expected: { ...retrying, errorKind: 'idle-timeout' },
  },
  {
    name: 'a wall-clock timeout filter does not retry an idle timeout',
    input: { cause: idle(), retryOn: ['timeout'], onError: 'return' },
    expected: { ...exhausted, settle: true, errorKind: 'idle-timeout' },
  },
  {
    name: 'an idle-timeout filter does not retry a wall-clock timeout',
    input: { cause: timeout(), retryOn: ['idle-timeout'] },
    expected: { ...exhausted, errorKind: 'timeout' },
  },
  {
    name: 'transient does not retry an invalid request',
    input: { cause: harnessFailure(404), retryOn: ['transient'], onError: 'return' },
    expected: { ...exhausted, settle: true, errorKind: 'invalid-request' },
  },
  {
    name: 'transient does not retry an unknown failure',
    input: { cause: new Error('boom'), retryOn: ['transient'] },
    expected: { ...exhausted, errorKind: 'unknown' },
  },
  {
    name: 'transient does not retry a process failure',
    input: { cause: spawnFailure(), retryOn: ['transient'] },
    expected: { ...exhausted, errorKind: 'process' },
  },
  {
    name: 'transient combines with an explicit kind',
    input: { cause: spawnFailure(), retryOn: ['transient', 'process'] },
    expected: { ...retrying, errorKind: 'process' },
  },
  {
    name: 'transient is still bounded by maxAttempts',
    input: { cause: harnessFailure(503), retryOn: ['transient'], attempt: 3, maxAttempts: 3 },
    expected: { ...exhausted, errorKind: 'overloaded' },
  },
  {
    name: 'an omitted retry.on does not retry an invalid request',
    input: { cause: harnessFailure(400), onError: 'return' },
    expected: { ...exhausted, settle: true, errorKind: 'invalid-request' },
  },
  {
    name: 'an omitted retry.on still retries an unknown failure',
    input: { cause: new Error('boom') },
    expected: { ...retrying, errorKind: 'unknown' },
  },
  {
    name: 'an omitted retry.on still retries an overloaded failure',
    input: { cause: harnessFailure(500) },
    expected: { ...retrying, errorKind: 'overloaded' },
  },
  {
    name: 'an omitted retry.on still retries a process failure',
    input: { cause: spawnFailure() },
    expected: { ...retrying, errorKind: 'process' },
  },
  {
    name: 'an explicit invalid-request filter still retries an invalid request',
    input: { cause: harnessFailure(422), retryOn: ['invalid-request'] },
    expected: { ...retrying, errorKind: 'invalid-request' },
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
