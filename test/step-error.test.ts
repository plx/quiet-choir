import { describe, expect, it } from 'vitest';

import {
  errorKindSchema,
  isTransientErrorKind,
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
