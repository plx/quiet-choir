import { describe, expect, it } from 'vitest';

import { parseDuration } from '../src/cli/duration.js';

describe('parseDuration', () => {
  it.each([
    ['250ms', 250],
    ['0s', 0],
    ['540s', 540_000],
    ['1.5s', 1_500],
    ['9m', 540_000],
    ['2h', 7_200_000],
    ['7d', 604_800_000],
    ['1.5d', 129_600_000],
    ['0d', 0],
  ])('reads %s as %d ms', (value, ms) => {
    expect(parseDuration(value)).toBe(ms);
  });

  it.each(['', 'd', '7', '7 d', '-1d', '7days', '7D', '1w', '.5d', '7d ', 'ms'])(
    'rejects %j',
    (value) => {
      expect(parseDuration(value)).toBeNaN();
    },
  );
});
