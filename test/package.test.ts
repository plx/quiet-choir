import { describe, expect, it } from 'vitest';

import packageJson from '../package.json' with { type: 'json' };

describe('package entry point', () => {
  it('loads as an ES module', async () => {
    const entryPoint = await import('../src/index.js');

    expect(entryPoint.defineWorkflow).toBeTypeOf('function');
    expect(entryPoint.runWorkflow).toBeTypeOf('function');
    expect(entryPoint.CliHarness).toBeTypeOf('function');
  });
});

describe('CLI package metadata', () => {
  it('publishes the quiet-choir launcher and oclif command directory', () => {
    expect(packageJson.bin).toEqual({ 'quiet-choir': './bin/run.js' });
    expect(packageJson.oclif.commands).toBe('./dist/commands');
    expect(packageJson.oclif.topicSeparator).toBe(' ');
  });
});

interface PolicyPackage {
  readonly engines: { readonly node: string };
  readonly dependencies: Readonly<Record<string, string>>;
}

/** Lowest major.minor across the `||`-separated ranges of an `engines.node` value. */
function enginesFloor(range: string): string {
  const floors = range.split('||').flatMap((part) => {
    const match = /(\d+)\.(\d+)/u.exec(part);
    return match?.[1] === undefined || match[2] === undefined
      ? []
      : [[Number(match[1]), Number(match[2])] as const];
  });
  const [lowest] = floors.sort(([aMajor, aMinor], [bMajor, bMinor]) =>
    aMajor === bMajor ? aMinor - bMinor : aMajor - bMajor,
  );
  if (lowest === undefined) throw new Error(`No version in engines.node: ${range}`);
  return `${String(lowest[0])}.${String(lowest[1])}`;
}

/**
 * The dependency pin policy (CONTRIBUTING.md, "Dependency pin policy"), as violations. The policy
 * fixes relationships, never specific versions, so Dependabot can bump what it may bump.
 */
function pinPolicyViolations(pkg: PolicyPackage): string[] {
  const violations: string[] = [];
  const floor = enginesFloor(pkg.engines.node);
  const types = pkg.dependencies['@types/node'];
  if (types === undefined || !new RegExp(`^${floor.replace('.', '\\.')}\\.\\d+$`, 'u').test(types))
    violations.push(
      `@types/node must be ${floor}.x (the engines.node floor), not ${String(types)}`,
    );
  if (!pkg.dependencies['typescript']?.startsWith('npm:@typescript/typescript6@'))
    violations.push('typescript must alias npm:@typescript/typescript6');
  const oclif = pkg.dependencies['@oclif/core'];
  if (oclif === undefined || !/^\d+\.\d+\.\d+$/u.test(oclif))
    violations.push('@oclif/core must be a runtime dependency pinned to an exact x.y.z version');
  return violations;
}

describe('dependency pin policy', () => {
  const current: PolicyPackage = packageJson;
  const mutate = (dependencies: Record<string, string | undefined>): PolicyPackage => {
    const merged = { ...current.dependencies, ...dependencies };
    return {
      ...current,
      dependencies: Object.fromEntries(
        Object.entries(merged).flatMap(([name, version]) =>
          version === undefined ? [] : [[name, version]],
        ),
      ),
    };
  };

  it('holds for the checked-in package.json', () => {
    expect(pinPolicyViolations(current)).toEqual([]);
  });

  it('derives the lowest major.minor across the engines ranges', () => {
    expect(enginesFloor('^22.13.0 || ^24.0.0 || ^26.0.0')).toBe('22.13');
    expect(enginesFloor('^24.2.0 || ^22.14.1')).toBe('22.14');
  });

  it.each(['25.9.8', '22.14.0', '22.12.4', '^22.13.0'])(
    'rejects @types/node %s, which is off the engines floor',
    (version) => {
      expect(pinPolicyViolations(mutate({ '@types/node': version }))).toEqual([
        expect.stringContaining('@types/node'),
      ]);
    },
  );

  it('accepts a @types/node patch bump', () => {
    expect(pinPolicyViolations(mutate({ '@types/node': '22.13.99' }))).toEqual([]);
  });

  it('accepts an @oclif/core bump but requires an exact runtime pin', () => {
    expect(pinPolicyViolations(mutate({ '@oclif/core': '5.1.0' }))).toEqual([]);
    for (const version of ['^4.0.0', 'latest', undefined])
      expect(pinPolicyViolations(mutate({ '@oclif/core': version }))).toEqual([
        expect.stringContaining('@oclif/core'),
      ]);
  });

  it('requires the typescript alias to target @typescript/typescript6', () => {
    for (const version of ['npm:typescript@7.0.2', '6.0.2', undefined])
      expect(pinPolicyViolations(mutate({ typescript: version }))).toEqual([
        expect.stringContaining('typescript'),
      ]);
  });
});
