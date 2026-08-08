import { describe, expect, it } from 'vitest';

describe('package entry point', () => {
  it('loads as an ES module', async () => {
    const entryPoint = await import('../src/index.js');

    expect(Object.keys(entryPoint)).toEqual([]);
  });
});
