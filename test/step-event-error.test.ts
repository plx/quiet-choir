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

  it('keeps ordinary message lines that start with "at "', () => {
    expect(stepEventError('at least one finding is required')).toBe(
      'at least one finding is required',
    );
    expect(stepEventError('at least one recipient is required')).toBe(
      'at least one recipient is required',
    );
    expect(stepEventError('Review failed:\nat least 2 approvals')).toBe(
      'Review failed: at least 2 approvals',
    );
    expect(stepEventError('Job failed\nat noon the job ran out of time\nand stopped')).toBe(
      'Job failed at noon the job ran out of time and stopped',
    );
    // A message line, then a real frame: only the frame and what follows are cut.
    expect(
      stepEventError(
        'Error: bad\nat noon it broke\n    at foo (file.js:1:1)\n    at bar (x.js:2:2)',
      ),
    ).toBe('Error: bad at noon it broke');
  });

  it.each([
    ['    at foo (file.js:1:1)'],
    ['    at file:///a/b.js:1:1'],
    ['    at async foo (file.js:1:1)'],
    ['    at new Foo (file.js:1:1)'],
    ['    at Array.map (native)'],
    ['    at Object.<anonymous> (<anonymous>)'],
    ['    at foo (file.js:1:1)\r'],
  ])('treats %j as a stack frame', (frame) => {
    expect(stepEventError(`boom\n${frame}\n    at bar (file.js:2:2)`)).toBe('boom');
    expect(stepEventError(frame)).toBeUndefined();
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
