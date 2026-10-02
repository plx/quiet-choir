import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  harnessConfigDigest,
  inheritHarnessSelection,
  launchPolicyOf,
  readHarnessSelection,
  type HarnessSelection,
} from '../src/workflow/loader/harness-selection.js';
import { workflowLaunchSchema } from '../src/workflow/runtime/question-schema.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

const cli = (
  config: HarnessSelection['config'],
  extra: Partial<HarnessSelection> = {},
): HarnessSelection => ({ kind: 'cli', config, ...extra });

describe('harnessConfigDigest', () => {
  it('digests an absent selection like the default configuration, pinned as a golden value', async () => {
    // Changing the digested shape strands every recorded run behind --allow-harness-config-change,
    // so this golden must only move with a deliberate decision.
    const golden = 'd616b1e64ebd1f515febf33486b05d3f4efd5a63b997e6899849ff4389a3b175';
    expect(createHash('sha256').update('{"config":{},"configurations":{}}').digest('hex')).toBe(
      golden,
    );
    expect(harnessConfigDigest()).toBe(golden);
    expect(harnessConfigDigest(cli({}))).toBe(golden);
    expect(harnessConfigDigest(cli({}, { configurations: {} }))).toBe(golden);
    const cwd = await mkdtemp(join(tmpdir(), 'choir-selection-'));
    directories.push(cwd);
    expect(harnessConfigDigest(await readHarnessSelection('cli', undefined, cwd))).toBe(golden);
    expect(harnessConfigDigest(await readHarnessSelection('cli', '{}', cwd))).toBe(golden);
  });

  it('ignores key order in config and configurations', () => {
    expect(
      harnessConfigDigest(
        cli(
          { claudeBinary: '/bin/claude', maxOutputBytes: 10 },
          { configurations: { third: { a: 1, b: 2 }, claude: { binary: '/x' } } },
        ),
      ),
    ).toBe(
      harnessConfigDigest(
        cli(
          { maxOutputBytes: 10, claudeBinary: '/bin/claude' },
          { configurations: { claude: { binary: '/x' }, third: { b: 2, a: 1 } } },
        ),
      ),
    );
  });

  it('excludes killGraceMs, the selection kind, fixtures and named fixtures', () => {
    const base = harnessConfigDigest(cli({ claudeBinary: '/bin/claude' }));
    expect(harnessConfigDigest(cli({ claudeBinary: '/bin/claude', killGraceMs: 50 }))).toBe(base);
    expect(
      harnessConfigDigest({
        kind: 'fixture',
        config: { claudeBinary: '/bin/claude' },
        fixtures: { version: 1, calls: [] },
        named: { third: { version: 1, calls: [], unmatched: 'synthesize' } },
      }),
    ).toBe(base);
  });

  it('changes with each configuration value that shapes execution', () => {
    const base = harnessConfigDigest(cli({}));
    const variants: HarnessSelection[] = [
      cli({ claudeBinary: '/bin/claude' }),
      cli({ codexBinary: '/bin/codex' }),
      cli({ maxOutputBytes: 1024 }),
      cli({ maxRetainedBytes: 1024 }),
      cli({ maxStreamBytes: 1024 }),
      cli({ scrubEnv: false }),
      cli({ scrubEnv: ['SECRET'] }),
      cli({}, { configurations: { third: { binary: 'third-cli' } } }),
      cli({}, { configurations: { third: { binary: 'other-cli' } } }),
    ];
    const digests = variants.map((variant) => harnessConfigDigest(variant));
    expect(new Set([base, ...digests]).size).toBe(variants.length + 1);
  });

  it('digests relative binary paths as resolved against the command cwd', async () => {
    const first = await mkdtemp(join(tmpdir(), 'choir-selection-'));
    const second = await mkdtemp(join(tmpdir(), 'choir-selection-'));
    directories.push(first, second);
    const config = '{"claudeBinary":"./bin/claude"}';
    const fromFirst = harnessConfigDigest(await readHarnessSelection('cli', config, first));
    expect(fromFirst).toBe(
      harnessConfigDigest(cli({ claudeBinary: join(first, 'bin', 'claude') })),
    );
    expect(harnessConfigDigest(await readHarnessSelection('cli', config, second))).not.toBe(
      fromFirst,
    );
  });
});

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const fixtureText = (step: string) =>
  JSON.stringify({ version: 1, calls: [{ step, text: 'fixed' }] });

async function fixtureDirectory() {
  const cwd = await mkdtemp(join(tmpdir(), 'choir-selection-'));
  directories.push(cwd);
  const global = fixtureText('call');
  const third = fixtureText('third-call');
  await writeFile(join(cwd, 'f.json'), global);
  await writeFile(join(cwd, 'third.json'), third);
  return { cwd, global, third };
}

describe('launch policy of a harness selection', () => {
  it('records the fixture files a selection read, by absolute path and content digest', async () => {
    const { cwd, global, third } = await fixtureDirectory();
    const selection = await readHarnessSelection(
      ['third=fixture:third.json', 'fixture:./f.json'],
      '{"claudeBinary":"./bin/claude","harnesses":{"third":{"token":"value"}}}',
      cwd,
    );
    expect(selection.sources).toEqual([
      { path: join(cwd, 'f.json'), sha256: sha256(global) },
      { name: 'third', path: join(cwd, 'third.json'), sha256: sha256(third) },
    ]);
    const policy = launchPolicyOf(selection, 'block');
    expect(policy).toEqual({
      harness: {
        kind: 'fixture',
        fixtures: [
          { path: join(cwd, 'f.json'), sha256: sha256(global) },
          { name: 'third', path: join(cwd, 'third.json'), sha256: sha256(third) },
        ],
      },
      waitMode: 'block',
    });
    // Configuration values (binary paths, harnesses.<name>) never enter the policy.
    expect(JSON.stringify(policy)).not.toMatch(/claude|token|value/u);
    expect(
      workflowLaunchSchema.parse({ entrypoint: '/w.ts', tsconfig: null, policy }).policy,
    ).toEqual(policy);
  });

  it('records cli with named fixtures only, and nothing for an embedder selection without files', async () => {
    const { cwd, third } = await fixtureDirectory();
    expect(
      launchPolicyOf(
        await readHarnessSelection(['third=fixture:third.json'], undefined, cwd),
        'suspend',
      ),
    ).toEqual({
      harness: {
        kind: 'cli',
        fixtures: [{ name: 'third', path: join(cwd, 'third.json'), sha256: sha256(third) }],
      },
      waitMode: 'suspend',
    });
    expect(launchPolicyOf(undefined, 'suspend')).toEqual({
      harness: { kind: 'cli' },
      waitMode: 'suspend',
    });
    expect(
      launchPolicyOf({ kind: 'fixture', config: {}, fixtures: { version: 1, calls: [] } }, 'block'),
    ).toBeUndefined();
    expect(
      launchPolicyOf(
        { kind: 'cli', config: {}, named: { third: { version: 1, calls: [] } } },
        'suspend',
      ),
    ).toBeUndefined();
  });

  it.each([
    ['a fixture kind without an unnamed fixture', { kind: 'fixture' }],
    [
      'an unnamed fixture under kind cli',
      { kind: 'cli', fixtures: [{ path: '/f', sha256: 'a'.repeat(64) }] },
    ],
    [
      'a duplicate name',
      {
        kind: 'cli',
        fixtures: [
          { name: 'x', path: '/f', sha256: 'a'.repeat(64) },
          { name: 'x', path: '/g', sha256: 'a'.repeat(64) },
        ],
      },
    ],
    [
      'a relative path',
      { kind: 'fixture', fixtures: [{ path: 'f.json', sha256: 'a'.repeat(64) }] },
    ],
    ['a short digest', { kind: 'fixture', fixtures: [{ path: '/f', sha256: 'abc' }] }],
  ])('rejects a recorded policy with %s', (_label, harness) => {
    expect(() =>
      workflowLaunchSchema.parse({
        entrypoint: '/w.ts',
        tsconfig: null,
        policy: { harness, waitMode: 'suspend' },
      }),
    ).toThrow();
  });
});

describe('inheritHarnessSelection', () => {
  it('rebuilds recorded fixtures and keeps the invocation configuration', async () => {
    const { cwd } = await fixtureDirectory();
    const recorded = launchPolicyOf(
      await readHarnessSelection(['fixture:f.json', 'third=fixture:third.json'], undefined, cwd),
      'suspend',
    );
    if (!recorded) throw new Error('expected a policy');
    const invocation = await readHarnessSelection(
      'cli',
      '{"maxOutputBytes":2048,"harnesses":{"third":{"token":"t"}}}',
      cwd,
    );
    const warnings: string[] = [];
    const inherited = await inheritHarnessSelection(invocation, recorded.harness, (message) =>
      warnings.push(message),
    );
    expect(inherited).toMatchObject({
      kind: 'fixture',
      config: { maxOutputBytes: 2048 },
      configurations: { third: { token: 't' } },
      fixtures: { version: 1, calls: [{ step: 'call', text: 'fixed' }] },
      named: { third: { version: 1, calls: [{ step: 'third-call', text: 'fixed' }] } },
    });
    expect(launchPolicyOf(inherited, 'suspend')).toEqual(recorded);
    expect(harnessConfigDigest(inherited)).toBe(harnessConfigDigest(invocation));
    expect(warnings).toEqual([]);
    // No invocation selection at all inherits onto the default configuration.
    const bare = await inheritHarnessSelection(undefined, recorded.harness, () => undefined);
    expect(harnessConfigDigest(bare)).toBe(harnessConfigDigest());
    expect(bare.kind).toBe('fixture');
  });

  it('warns about a changed fixture and records its new digest', async () => {
    const { cwd } = await fixtureDirectory();
    const recorded = launchPolicyOf(
      await readHarnessSelection('fixture:f.json', undefined, cwd),
      'block',
    );
    if (!recorded) throw new Error('expected a policy');
    const edited = fixtureText('edited');
    await writeFile(join(cwd, 'f.json'), edited);
    const warnings: string[] = [];
    const inherited = await inheritHarnessSelection(undefined, recorded.harness, (message) =>
      warnings.push(message),
    );
    const before = recorded.harness.fixtures?.[0]?.sha256 ?? '';
    expect(warnings).toEqual([
      expect.stringContaining(
        `Fixture ${join(cwd, 'f.json')} changed since the run last executed (sha256 ${before.slice(0, 12)}, now ${sha256(edited).slice(0, 12)})`,
      ),
    ]);
    expect(inherited.fixtures?.calls[0]?.step).toBe('edited');
    expect(launchPolicyOf(inherited, 'block')?.harness.fixtures).toEqual([
      { path: join(cwd, 'f.json'), sha256: sha256(edited) },
    ]);
  });

  it('fails on a missing recorded fixture, naming the path and --harness', async () => {
    const { cwd } = await fixtureDirectory();
    const recorded = launchPolicyOf(
      await readHarnessSelection('fixture:f.json', undefined, cwd),
      'suspend',
    );
    if (!recorded) throw new Error('expected a policy');
    await rm(join(cwd, 'f.json'));
    const failure = inheritHarnessSelection(undefined, recorded.harness, () => undefined);
    await expect(failure).rejects.toThrow(join(cwd, 'f.json'));
    await expect(failure).rejects.toThrow(/ENOENT.*pass --harness explicitly/u);
  });
});

describe('command fixtures in named fixture files', () => {
  it('refuses exec rules or a commands mode in a named file, pointing to the global file', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'choir-selection-'));
    directories.push(cwd);
    await writeFile(
      join(cwd, 'g.json'),
      '{"version":1,"calls":[],"exec":[{"step":"x","stdout":""}]}',
    );
    await writeFile(
      join(cwd, 'n.json'),
      '{"version":1,"calls":[],"exec":[{"step":"x","stdout":""}]}',
    );
    await writeFile(join(cwd, 'm.json'), '{"version":1,"calls":[],"commands":"fixture"}');
    const global = await readHarnessSelection('fixture:g.json', undefined, cwd);
    expect(global.fixtures?.exec).toEqual([{ step: 'x', stdout: '' }]);
    for (const file of ['n.json', 'm.json'])
      await expect(
        readHarnessSelection(['fixture:g.json', `claude=fixture:${file}`], undefined, cwd),
      ).rejects.toThrow(
        `Named fixture file ${join(cwd, file)} for harness claude has exec rules or a commands mode; commands are not per-harness, so put them in the global --harness fixture:FILE.`,
      );
  });
});
