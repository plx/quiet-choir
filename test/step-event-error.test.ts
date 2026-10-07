import { describe, expect, it } from 'vitest';

import {
  STEP_EVENT_ERROR_MAX_CHARS,
  stepEventError,
} from '../src/workflow/runtime/step-event-error.js';

describe('stepEventError', () => {
  it('keeps plain text unchanged', () => {
    expect(stepEventError('boom')).toBe('boom');
  });

  it('collapses newlines and whitespace runs to single spaces', () => {
    expect(stepEventError('  line one\n\n  line\ttwo \r\n')).toBe('line one line two');
  });

  it('drops an embedded V8 stack from the first frame line on', () => {
    const text = 'Error: boom\n    at foo (file.js:1:1)\n    at bar (file.js:2:2)';
    expect(stepEventError(text)).toBe('Error: boom');
    expect(stepEventError(`first\nsecond\n    at foo (file.js:1:1)\ntrailing`)).toBe(
      'first second',
    );
    // An `at` inside a sentence is not a frame.
    expect(stepEventError('failed at step 3\nand again')).toBe('failed at step 3 and again');
  });

  it.each([undefined, null, '', '  \n\t ', '    at foo (file.js:1:1)'])(
    'returns undefined when nothing remains (%j)',
    (text) => {
      expect(stepEventError(text)).toBeUndefined();
    },
  );

  it('keeps text of exactly the maximum and cuts longer text with an ellipsis', () => {
    expect(STEP_EVENT_ERROR_MAX_CHARS).toBe(500);
    const exact = 'x'.repeat(STEP_EVENT_ERROR_MAX_CHARS);
    expect(stepEventError(exact)).toBe(exact);
    const cut = stepEventError('y'.repeat(2000)) ?? '';
    expect(Array.from(cut)).toHaveLength(STEP_EVENT_ERROR_MAX_CHARS);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).toBe(`${'y'.repeat(STEP_EVENT_ERROR_MAX_CHARS - 1)}…`);
  });

  it('never splits a surrogate pair at the boundary', () => {
    const cut = stepEventError(`${'a'.repeat(STEP_EVENT_ERROR_MAX_CHARS - 2)}😀😀😀`) ?? '';
    expect(Array.from(cut)).toHaveLength(STEP_EVENT_ERROR_MAX_CHARS);
    expect(cut).toBe(`${'a'.repeat(STEP_EVENT_ERROR_MAX_CHARS - 2)}😀…`);
    expect(cut).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
});
