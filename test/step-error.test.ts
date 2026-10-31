import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ConfigurationError,
  GrantRequiredError,
} from '../src/workflow/runtime/configuration-error.js';
import { HarnessError } from '../src/workflow/runtime/harness-error.js';
import { formatIssues } from '../src/workflow/runtime/issue-format.js';
import type { ErrorKind } from '../src/workflow/runtime/model.js';
import {
  errorKind,
  errorKindSchema,
  isTransientErrorKind,
  rootCauseKind,
  stepError,
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

describe('stepError', () => {
  const schemaFailure = (schema: z.ZodType, value: unknown) => {
    const parsed = schema.safeParse(value);
    if (parsed.success) throw new Error('expected a schema failure');
    return parsed.error;
  };

  it('reads a schema failure as one path: message line per issue', () => {
    const plan = z
      .object({ tickets: z.array(z.object({ id: z.string() })) })
      .superRefine((value, ctx) => {
        value.tickets.forEach((ticket, index) => {
          const id = `T${String(index + 1)}`;
          if (ticket.id !== id)
            ctx.addIssue({
              code: 'custom',
              message: `${ticket.id} should be numbered ${id}`,
              path: ['tickets', index, 'id'],
            });
        });
      });
    expect(stepError(schemaFailure(plan, { tickets: [{ id: 'T9' }] }), 2)).toEqual({
      message: 'tickets[0].id: T9 should be numbered T1',
      kind: 'schema',
      attempts: 2,
    });
  });

  it.each([
    [
      'a root refinement as its bare message, on one line',
      z.string().refine(() => false, 'Name a\n  milestone'),
      'x',
      'Name a milestone',
    ],
    [
      'the nested message of a record key refinement',
      z.record(
        z.string().refine((key) => !key.startsWith('QC_'), 'QC_ keys are reserved'),
        z.string(),
      ),
      { QC_X: 'a' },
      'QC_X: QC_ keys are reserved',
    ],
    [
      'every option of a union',
      z.object({ v: z.union([z.object({ a: z.number() }), z.object({ b: z.string() })]) }),
      { v: {} },
      'v: Invalid input (option 1: v.a: Invalid input: expected number, received undefined; ' +
        'option 2: v.b: Invalid input: expected string, received undefined)',
    ],
    [
      'a key that is not an identifier in quoted brackets',
      z.object({ tickets: z.array(z.object({ id: z.string(), 'odd key': z.number() })) }),
      { tickets: [{ id: 1, 'odd key': 'x' }] },
      'tickets[0].id: Invalid input: expected string, received number\n' +
        'tickets[0]["odd key"]: Invalid input: expected number, received string',
    ],
  ] as const)('keeps %s', (_name, schema, value, message) => {
    expect(stepError(schemaFailure(schema, value), 1).message).toBe(message);
  });

  it('formats structural issues from another zod copy, symbols included', () => {
    expect(formatIssues([{ path: ['a', Symbol.for('s'), 0], message: 'Refused' }])).toBe(
      'a[Symbol(s)][0]: Refused',
    );
  });

  it.each([
    ['an Error', new Error('boom\nsecond line'), 'boom\nsecond line'],
    ['a thrown string', 'plain', 'plain'],
  ])('keeps the message of %s unchanged', (_name, error, message) => {
    expect(stepError(error, 1)).toEqual({ message, kind: 'unknown', attempts: 1 });
  });
});
