import { describe, expect, it } from 'vitest';

import packageJson from '../package.json' with { type: 'json' };

describe('package entry point', () => {
  it('loads as an ES module', async () => {
    const entryPoint = await import('../src/index.js');

    expect(Object.keys(entryPoint)).toEqual([]);
  });
});

describe('CLI package metadata', () => {
  it('publishes the quiet-choir launcher and oclif command directory', () => {
    expect(packageJson.bin).toEqual({ 'quiet-choir': './bin/run.js' });
    expect(packageJson.oclif.commands).toBe('./dist/commands');
    expect(packageJson.oclif.topicSeparator).toBe(' ');
  });

  it('ships everything needed for runtime type-checking', () => {
    expect(packageJson.dependencies['@oclif/core']).toBe('4.13.3');
    expect(packageJson.dependencies['@types/node']).toBe('22.13.17');
    expect(packageJson.dependencies.typescript).toContain('@typescript/typescript6');
  });
});
