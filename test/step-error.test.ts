import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ConfigurationError,
  GrantRequiredError,
} from '../src/workflow/runtime/configuration-error.js';
import { HarnessError } from '../src/workflow/runtime/harness-error.js';
import type { ErrorKind } from '../src/workflow/runtime/model.js';
import {
  errorKind,
  errorKindSchema,
  isTransientErrorKind,
  rootCauseKind,
  transientErrorKinds,
} from '../src/workflow/runtime/step-error.js';

describe('isTransientErrorKind', () => {
  it.each(errorKindSchema.options)('agrees with the transient set for %s', (kind) => {
    const transient: readonly string[] = transientErrorKinds;
    expect(isTransientErrorKind(kind)).toBe(transient.includes(kind));
  });

  it('is true for exactly the four transient kinds', () => {
    expect(errorKindSchema.options.filter((kind) => isTransientErrorKind(kind))).toEqual([
      'timeout',
      'idle-timeout',
      'rate-limit',
      'overloaded',
    ]);
  });

  it.each([null, undefined])('is false for a missing kind (%s)', (kind) => {
    expect(isTransientErrorKind(kind)).toBe(false);
  });
});

const harnessError = (kind: ErrorKind) =>
  new HarnessError({
    harness: 'fake',
    exit: { code: 1, signal: null },
    failure: null,
    reason: 'failed',
    stderr: '',
    stdout: '',
    kind,
  });

describe('rootCauseKind', () => {
  const schemaError = (() => {
    const parsed = z.string().safeParse(1);
    if (parsed.success) throw new Error('expected a schema failure');
    return parsed.error;
  })();

  it.each([
    ['a ConfigurationError', new ConfigurationError('refused')],
    ['a GrantRequiredError', new GrantRequiredError('editor', 'write')],
  ])('classifies %s raised before an attempt as configuration', (_name, error) => {
    expect(rootCauseKind(error, true)).toBe('configuration');
  });

  it('follows the cause chain of an error raised before an attempt', () => {
    // Agent request preparation wraps a grant refusal as `Step <id>: <message>`.
    const grant = new GrantRequiredError('editor', 'write');
    const wrapped = new Error(`Step edit: ${grant.message}`, { cause: grant });
    expect(rootCauseKind(wrapped, true)).toBe('configuration');
    expect(rootCauseKind(wrapped, false)).toBe('unknown');
    const cycle = new Error('outer');
    cycle.cause = new Error('inner', { cause: cycle });
    expect(rootCauseKind(cycle, true)).toBe('unknown');
  });

  it('keeps errorKind for a ConfigurationError an attempt recorded', () => {
    const error = new ConfigurationError('No harness adapter configured for codex.');
    expect(rootCauseKind(error, false)).toBe('unknown');
    expect(rootCauseKind(error, false)).toBe(errorKind(error));
  });

  it.each([
    ['a schema failure', schemaError, 'schema'],
    ['a plain Error', new Error('boom'), 'unknown'],
    ['a rate-limited harness error', harnessError('rate-limit'), 'rate-limit'],
  ] as const)('keeps errorKind for %s either way', (_name, error, kind) => {
    expect(rootCauseKind(error, true)).toBe(kind);
    expect(rootCauseKind(error, false)).toBe(kind);
  });

  it('never lets an attempt error claim the configuration kind', () => {
    // Reserved for root causes raised before an attempt, so no attempt is retried or settled on it.
    expect(errorKind(harnessError('configuration'))).toBe('unknown');
  });
});
